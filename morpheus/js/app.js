// MORPHEUS for the web: the page. Holds the patch (as js/mph.js objects), sends
// it to the generator worker on every edit, shows what comes back, and plays it
// through the preview synth in an AudioWorklet. Undo / redo and A / B work on
// patch snapshots, as model/document.h does.
//
// Everything the desktop app does except saving presets: build, play, import
// audio, download the WAV (the app's RENDER), open a .mph.
//
// ?embed: shown inside the site's MORPHEUS tab (an iframe). No title, and the
// page tells the parent how tall it is ({ morpheus: 'height', h }).

import * as mph from './mph.js';
import { Knob, dragMode } from './knob.js';
import { WaveView, TableView, RangeView, FRAME } from './views.js';
import { Keyboard, noteName } from './keyboard.js';

const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.classList.add('embed');
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

//=============================================================================
// the generator worker

class Gen {
  constructor() {
    this.w = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' });
    this.calls = new Map();
    this.next = 1;
    this.handlers = {};
    this.ready = new Promise((res, rej) => {
      this.w.onerror = (e) => rej(new Error(e.message || 'the generator could not start'));
      this.w.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'ready') { res(m); return; }
        if (m.t === 'reply') { const f = this.calls.get(m.id); this.calls.delete(m.id); f?.(m); return; }
        this.handlers[m.t]?.(m);
      };
    });
  }
  on(t, fn) { this.handlers[t] = fn; }
  post(m, transfer) { this.w.postMessage(m, transfer || []); }
  call(m, transfer) {
    const id = this.next++;
    return new Promise((res) => { this.calls.set(id, res); this.post({ ...m, id }, transfer); });
  }
}

//=============================================================================
// the preview synth

class Audio {
  constructor() { this.ctx = null; this.node = null; this.play = null; this.params = null; this.onPos = null; }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  async start() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const base = new URL('..', import.meta.url);
    await ctx.audioWorklet.addModule(new URL('morph-worklet.js', base));
    const wasm = await (await fetch(new URL('gen/morph_synth.wasm', base))).arrayBuffer();
    const node = new AudioWorkletNode(ctx, 'morpheus-preview', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm },
    });
    node.port.onmessage = (e) => { if (e.data.t === 'pos') this.onPos?.(e.data); };
    node.connect(ctx.destination);
    this.node = node;
    if (this.params) node.port.postMessage({ t: 'params', v: this.params });
    if (this.play) this.sendPlay(this.play);
    await ctx.resume();
  }
  setParams(v) { this.params = v; this.node?.port.postMessage({ t: 'params', v }); }
  // the pyramid is kept (not transferred) so a later start() can hand it over
  setPlay(p) { this.play = p; if (this.node) this.sendPlay(p); }
  sendPlay(p) { this.node.port.postMessage({ t: 'play', levels: p.levels.map((a) => a.slice()), frames: p.frames }); }
  note(n, vel, on) { this.node?.port.postMessage({ t: 'note', n, vel, on }); }
  off() { this.node?.port.postMessage({ t: 'off' }); }
}

//=============================================================================

class App {
  async init() {
    this.gen = new Gen();
    this.audio = new Audio();
    const ready = await this.gen.ready;
    this.modules = [ready.modules.time, ready.modules.spectral];
    this.counts = [this.modules[0].length, this.modules[1].length];
    this.presets = ready.presets.map((t) => mph.load(t, this.counts));

    this.patch = mph.clone(this.presets[0]);
    this.patch.preview = mph.defaultPreview();
    this.other = mph.clone(this.patch);
    this.onB = false;
    this.undo = [];
    this.redo = [];
    this.edited = false;
    this.table = null;
    this.frames = 1;
    this.sel = 0;
    this.masks = [];
    this.error = '';
    this.errorSlot = -1;
    this.open = new Set();    // custom slots whose formula editor is open
    this.source = null;       // { name, samples, rate, begin, end, frames, method, asTable }

    this.wave = new WaveView($('wave'));
    this.tableView = new TableView($('table'), (f) => this.pick(f));
    $('wave').addEventListener('click', () => this.toggleWave());

    this.gen.on('table', (m) => this.onTable(m));
    this.gen.on('play', (m) => this.audio.setPlay({ levels: m.levels, frames: m.frames }));
    this.audio.onPos = (m) => this.onPos(m);

    this.keyboard = new Keyboard($('keys'), {
      onNote: (n, vel) => this.noteEvent(n, vel),
      getBase: () => this.patch.preview.baseNote,
      onOctave: (d) => this.setPreview('baseNote', clamp(this.patch.preview.baseNote + d, 12, 108), true),
    });
    $('midi').addEventListener('click', () => { this.ensureAudio(); this.keyboard.enableMidi($('midi')); });

    this.installBar();
    this.installPost();
    this.installDrop();
    this.buildPreview();
    this.renderAll();
    this.regen();
    this.installEmbed();
    this.status('Ready. Knobs: drag = both ends, Alt = end, Ctrl/⌘ = start, right-click = lock.');
  }

  //--- the patch ----------------------------------------------------------------

  // Before a change, not after: the snapshot is the state to come back to.
  snapshot() {
    this.undo.push(mph.clone(this.patch));
    if (this.undo.length > 64) this.undo.shift();
    this.redo = [];
    this.markEdited();
  }
  markEdited() {
    this.edited = true;
    this.updateBar();
  }
  regen(drag = false) {
    this.gen.post({ t: 'patch', mph: mph.save(this.patch), drag });
  }
  // a structural edit: snapshot, change, redraw the stack, regenerate
  edit(fn) {
    this.snapshot();
    fn(this.patch);
    this.renderStack();
    this.renderPost();
    this.regen();
  }
  replacePatch(p, name, keepPreview = true) {
    this.undo.push(mph.clone(this.patch));
    this.redo = [];
    const pv = this.patch.preview;
    this.patch = mph.clone(p);
    if (keepPreview) this.patch.preview = pv;
    this.patch.name = name ?? this.patch.name;
    this.edited = false;
    this.open.clear();
    this.renderAll();
    this.regen();
  }

  moduleDef(s) { return this.modules[s.domain][clamp(s.module, 0, this.counts[s.domain] - 1)]; }
  applyDefaults(s) {
    const d = this.moduleDef(s);
    s.k = s.k.map((k, i) => ({ start: i < d.knobs.length ? d.knobs[i].def : 0.5, end: i < d.knobs.length ? d.knobs[i].def : 0.5, link: true, lock: k.lock }));
    if (s.module === 0 && !s.amp) s.amp = s.domain === 0 ? 'sin(tau*x)' : '1/n';
  }

  //--- results ------------------------------------------------------------------

  onTable(m) {
    this.table = m.data;
    this.frames = m.frames;
    this.sel = Math.min(this.sel, m.frames - 1);
    const masksChanged = JSON.stringify(m.masks) !== JSON.stringify(this.masks);
    this.masks = m.masks;
    const errChanged = m.error !== this.error || m.errorSlot !== this.errorSlot;
    this.error = m.error;
    this.errorSlot = m.errorSlot;
    if (masksChanged || errChanged) this.renderStack(true);
    this.tableView.setTable(m.data, m.frames);
    this.tableView.setSelected(this.sel);
    $('table-info').textContent = `${m.frames} frame${m.frames > 1 ? 's' : ''} × 2048`;
    this.showFrame();
  }
  pick(f) {
    this.sel = f;
    this.tableView.setSelected(f);
    this.showFrame();
  }
  showFrame() {
    if (!this.table) return;
    $('frame-no').textContent = `Frame ${this.sel + 1} / ${this.frames}`;
    this.wave.setFrame(this.table.subarray(this.sel * FRAME, this.sel * FRAME + FRAME));
    if (this.wave.mode === 'harm') this.analyze();
  }
  async analyze() {
    const want = this.sel;
    if (this.analyzing) { this.analyzeAgain = true; return; }
    this.analyzing = true;
    const r = await this.gen.call({ t: 'analyze', frame: want });
    this.analyzing = false;
    this.wave.setMags(r.mags);
    if (this.analyzeAgain) { this.analyzeAgain = false; this.analyze(); }
  }
  toggleWave() {
    this.wave.mode = this.wave.mode === 'wave' ? 'harm' : 'wave';
    $('wave-cap').textContent = this.wave.mode === 'wave' ? 'Waveform' : 'Harmonics';
    if (this.wave.mode === 'harm') this.analyze(); else this.wave.draw();
  }
  onPos(m) {
    if (!m.active) { this.tableView.setLive(-1); $('live-pos').textContent = ''; return; }
    const f = Math.round(clamp(m.pos, 0, 1) * (this.frames - 1));
    this.tableView.setLive(f);
    $('live-pos').textContent = `Pos ${Math.round(m.pos * 100)}%`;
  }

  //--- toolbar ------------------------------------------------------------------

  installBar() {
    $('preset').addEventListener('click', (e) => this.presetMenu(e.currentTarget));
    $('undo').addEventListener('click', () => this.doUndo());
    $('redo').addEventListener('click', () => this.doRedo());
    const ab = $('ab').children;
    ab[0].addEventListener('click', () => this.setSide(false));
    ab[1].addEventListener('click', () => this.setSide(true));
    $('copy').addEventListener('click', () => {
      this.other = mph.clone(this.patch);
      this.status(this.onB ? 'Copied B to A.' : 'Copied A to B.');
    });
    const rnd = $('rand').children;
    rnd[0].addEventListener('click', () => this.randomize(false));
    rnd[1].addEventListener('click', () => this.randomize(true));
    $('import').addEventListener('click', () => { this.importAsTable = true; $('file-audio').click(); });
    $('file-audio').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.importFile(f, this.importAsTable);
    });
    $('file-mph').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const p = mph.load(await f.text(), this.counts);
      if (!p) { this.status(`${f.name} is not a MORPHEUS patch.`, true); return; }
      this.replacePatch(p, p.name || f.name.replace(/\.mph$/i, ''), false);
      this.buildPreview();
      this.status(`Opened ${f.name}.`);
    });
    $('download').addEventListener('click', () => this.download());
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.doRedo(); else this.doUndo();
      }
    });
    $('drag-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      dragMode.value = b.dataset.mode;
      for (const x of $('drag-mode').children) x.setAttribute('aria-pressed', String(x === b));
    });
    $('add-slot').addEventListener('click', () => this.edit((p) => {
      if (p.slots.length >= mph.MAX_SLOTS) return;
      // audible but inert until a knob moves: Wave Fold with FOLD at zero
      const s = mph.newSlot();
      s.module = 2;
      this.applyDefaults(s);
      p.slots.push(s);
    }));
  }
  updateBar() {
    $('preset-name').textContent = (this.patch.name || 'INIT') + (this.edited ? ' *' : '');
    $('undo').disabled = !this.undo.length;
    $('redo').disabled = !this.redo.length;
    const ab = $('ab').children;
    ab[0].setAttribute('aria-pressed', String(!this.onB));
    ab[1].setAttribute('aria-pressed', String(this.onB));
    $('add-slot').disabled = this.patch.slots.length >= mph.MAX_SLOTS;
  }
  doUndo() {
    if (!this.undo.length) return;
    this.redo.push(mph.clone(this.patch));
    this.patch = this.undo.pop();
    this.renderAll();
    this.regen();
  }
  doRedo() {
    if (!this.redo.length) return;
    this.undo.push(mph.clone(this.patch));
    this.patch = this.redo.pop();
    this.renderAll();
    this.regen();
  }
  // not undoable on purpose: the other side is where the version you did not
  // want to lose is kept
  setSide(b) {
    if (b === this.onB) return;
    [this.patch, this.other] = [this.other, this.patch];
    this.onB = b;
    this.renderAll();
    this.regen();
  }
  async randomize(modules) {
    this.snapshot();
    const r = await this.gen.call({ t: 'random', mph: mph.save(this.patch), modules, seed: Math.floor(Math.random() * 2 ** 32) });
    const p = mph.load(r.mph, this.counts);
    p.preview = this.patch.preview;
    this.patch = p;
    this.open.clear();
    this.renderAll();
    this.regen();
  }

  presetMenu(anchor) {
    const items = [{ head: 'Factory' }];
    this.presets.forEach((p, i) => items.push({ label: p.name, cur: p.name === this.patch.name && !this.edited, run: () => {
      this.replacePatch(this.presets[i], p.name);
      this.status(`Loaded ${p.name}.`);
    } }));
    items.push({ sep: true });
    items.push({ label: 'Open .mph file…', hint: 'a preset saved by the desktop MORPHEUS', run: () => $('file-mph').click() });
    menu(anchor, items);
  }

  //--- the stack ----------------------------------------------------------------

  // Rebuilt only when what the rows are made of changes; a knob drag updates its
  // own knob and nothing else (the app's "never rebuild during a drag").
  renderStack(force = false) {
    const sig = JSON.stringify(this.patch.slots.map((s) => [s.on, s.domain, s.module])) + '|' + this.masks.join(',') + '|' + this.errorSlot + '|' + [...this.open].join(',');
    if (!force && sig === this.stackSig) { this.syncKnobs(); return; }
    this.stackSig = sig;
    const ol = $('slots');
    ol.innerHTML = '';
    this.knobs = [];
    this.patch.slots.forEach((s, i) => ol.appendChild(this.slotRow(s, i)));
    this.updateBar();
  }
  syncKnobs() {
    this.patch.slots.forEach((s, i) => (this.knobs[i] || []).forEach((k) => k && k.set(s.k[k.index])));
  }

  slotRow(s, i) {
    const li = document.createElement('li');
    li.className = 'slot' + (s.on ? '' : ' off') + (this.errorSlot === i ? ' err' : '');
    const d = this.moduleDef(s);
    const custom = s.module === 0;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.title = 'ドラッグで並べ替え';
    this.installReorder(grip, li, i);

    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.setAttribute('aria-pressed', String(s.on));
    dot.title = s.on ? 'オフにする' : 'オンにする';
    dot.addEventListener('click', () => this.edit((p) => { p.slots[i].on = !p.slots[i].on; }));

    const dom = document.createElement('span');
    dom.className = 'seg small dom';
    for (const [label, val] of [['Time', 0], ['Spec', 1]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(s.domain === val));
      b.addEventListener('click', () => {
        if (s.domain === val) return;
        this.edit((p) => {
          const t = p.slots[i];
          t.domain = val;
          t.module = Math.min(t.module, this.counts[val] - 1);
          this.applyDefaults(t);
        });
      });
      dom.appendChild(b);
    }

    const mod = document.createElement('button');
    mod.className = 'mod-btn';
    mod.innerHTML = '<b></b><small></small>';
    mod.firstChild.textContent = d.name + (d.generator ? '' : '');
    mod.lastChild.textContent = custom ? (s.amp || '—') : d.hint;
    mod.title = d.generator ? 'ジェネレーター（前段を無視して書く）' : 'シェイパー（前段を加工する）';
    mod.addEventListener('click', () => this.moduleMenu(mod, i));

    const knobs = document.createElement('div');
    knobs.className = 'knobs';
    const row = [];
    const mask = this.masks[i] ?? (custom ? 0 : (1 << d.knobs.length) - 1);
    const count = custom ? 8 : d.knobs.length;
    for (let k = 0; k < count; k++) {
      if (custom && !(mask & (1 << k))) continue;
      const spec = custom ? { name: 'abcdefgh'[k].toUpperCase(), def: 0.5, bipolar: false, stops: null } : d.knobs[k];
      const kn = new Knob({
        name: spec.name, def: spec.def, bipolar: spec.bipolar, stops: spec.stops,
        onBegin: () => this.snapshot(),
        onChange: (v, final) => {
          this.patch.slots[i].k[k] = { ...v };
          if (!final) this.markEdited();
          this.regen(!final);
        },
      });
      kn.index = k;
      kn.set(s.k[k]);
      row.push(kn);
      knobs.appendChild(kn.el);
    }
    this.knobs[i] = row;

    const end = document.createElement('span');
    end.className = 'slot-end';
    if (custom) {
      const fx = document.createElement('button');
      fx.className = 'x fx';
      fx.textContent = 'f(x)';
      fx.title = '数式を編集';
      fx.setAttribute('aria-pressed', String(this.open.has(i)));
      fx.addEventListener('click', () => {
        if (this.open.has(i)) this.open.delete(i); else this.open.add(i);
        this.renderStack(true);
      });
      end.appendChild(fx);
    }
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'スロットを消す';
    x.disabled = this.patch.slots.length <= 1;
    x.addEventListener('click', () => this.edit((p) => {
      if (p.slots.length > 1) p.slots.splice(i, 1);
      this.open = new Set([...this.open].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j)));
    }));
    end.appendChild(x);

    li.append(grip, dot, dom, mod, knobs, end);
    if (custom && (this.open.has(i) || this.errorSlot === i)) li.appendChild(this.formulaEditor(s, i));
    return li;
  }

  formulaEditor(s, i) {
    const box = document.createElement('div');
    box.className = 'formula';
    const field = (label, key, placeholder) => {
      const l = document.createElement('label');
      l.innerHTML = `<span class="label"></span><input spellcheck="false" autocomplete="off">`;
      l.firstChild.textContent = label;
      const inp = l.lastChild;
      inp.value = s[key];
      inp.placeholder = placeholder;
      let snap = false;
      inp.addEventListener('input', () => {
        if (!snap) { this.snapshot(); snap = true; }
        this.patch.slots[i][key] = inp.value.replace(/[\r\n]/g, '');
        this.regen();
      });
      inp.addEventListener('change', () => { snap = false; this.renderStack(true); });
      return l;
    };
    const spectral = s.domain === 1;
    box.appendChild(field(spectral ? 'mag(n) =' : 'y(x) =', 'amp', spectral ? '1/n' : 'sin(tau*x)'));
    if (spectral) box.appendChild(field('phase(n) =', 'phase', '0'));
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = spectral
      ? 'n harmonic 1..1024 · t table position 0..1 · y the previous slot\'s magnitude · a–h become knobs'
      : 'x phase 0..1 · t table position 0..1 · y the previous slot · a–h become knobs';
    const fns = document.createElement('div');
    fns.className = 'help';
    fns.textContent = 'sin cos tan asin acos atan tanh exp log log2 sqrt abs sign floor ceil round frac tri saw sqr fold wrap hash · min max pow atan2 step pulse · clamp lerp smooth · pi tau';
    box.append(help, fns);
    if (this.errorSlot === i && this.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = this.error;
      box.appendChild(err);
    }
    return box;
  }

  moduleMenu(anchor, i) {
    const s = this.patch.slots[i];
    const list = this.modules[s.domain];
    const items = [];
    const add = (j) => items.push({
      label: list[j].name, hint: list[j].hint, cur: j === s.module,
      run: () => this.edit((p) => { p.slots[i].module = j; this.applyDefaults(p.slots[i]); if (j === 0) this.open.add(i); }),
    });
    items.push({ head: (s.domain === 0 ? 'Time' : 'Spectral') + ' · generators' });
    list.forEach((m, j) => { if (j && m.generator) add(j); });
    items.push({ head: 'Shapers' });
    list.forEach((m, j) => { if (j && !m.generator) add(j); });
    items.push({ sep: true });
    add(0);
    menu(anchor, items);
  }

  // dragging a row by its grip moves the slot; the signal flows top to bottom
  installReorder(grip, li, i) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const rows = [...$('slots').children];
      li.classList.add('dragging');
      let to = i;
      const move = (ev) => {
        rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
        to = i;
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j].getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { to = j > i ? j - 1 : j; break; }
          to = j;
        }
        const target = rows[to];
        if (to !== i && target) target.classList.add(to < i ? 'drop-before' : 'drop-after');
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        rows.forEach((r) => r.classList.remove('drop-before', 'drop-after', 'dragging'));
        if (to !== i) this.edit((p) => {
          const [s] = p.slots.splice(i, 1);
          p.slots.splice(to, 0, s);
          this.open.clear();
        });
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  //--- post ---------------------------------------------------------------------

  installPost() {
    const LIMITS = [0, 512, 256, 128, 64];
    const FRAMES = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    [...$('norm').children].forEach((b, j) => b.addEventListener('click', () => this.edit((p) => { p.post.norm = j; })));
    [...$('limit').children].forEach((b, j) => b.addEventListener('click', () => this.edit((p) => { p.post.limit = LIMITS[j]; })));
    $('dc').addEventListener('click', () => this.edit((p) => { p.post.dc = !p.post.dc; }));
    $('lock').addEventListener('click', () => this.edit((p) => { p.post.lock = !p.post.lock; }));
    const fr = $('frames').children;
    const step = (d) => this.edit((p) => {
      let j = FRAMES.findIndex((f) => f >= p.frames);
      if (j < 0) j = FRAMES.length - 1;
      if (FRAMES[j] !== p.frames && d < 0) j++;
      p.frames = FRAMES[clamp(j + d, 0, FRAMES.length - 1)];
    });
    fr[0].addEventListener('click', () => step(-1));
    fr[2].addEventListener('click', () => step(1));
    this.LIMITS = LIMITS;
  }
  renderPost() {
    const p = this.patch.post;
    [...$('norm').children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === p.norm)));
    [...$('limit').children].forEach((b, j) => b.setAttribute('aria-pressed', String(this.LIMITS[j] === p.limit)));
    $('dc').setAttribute('aria-pressed', String(p.dc));
    $('lock').setAttribute('aria-pressed', String(p.lock));
    $('dc').classList.toggle('solid', p.dc);
    $('lock').classList.toggle('solid', p.lock);
    $('frames').children[1].textContent = String(this.patch.frames);
  }

  //--- preview ------------------------------------------------------------------

  buildPreview() {
    const pv = $('pv');
    pv.innerHTML = '';
    this.pknobs = {};
    const P = () => this.patch.preview;
    const time = (n) => 0.001 * Math.pow(10000, n);
    const timeN = (t) => clamp(Math.log(Math.max(0.001, t) / 0.001) / Math.log(10000), 0, 1);
    const ms = (t) => (t < 1 ? `${Math.round(t * 1000)}ms` : `${t.toFixed(t < 10 ? 2 : 1)}s`);
    const hz = (n) => { const f = 20 * Math.pow(1000, n); return f < 1000 ? `${Math.round(f)}` : `${(f / 1000).toFixed(1)}k`; };
    // [key, name, to-knob, from-knob, text, default]
    const K = {
      cents: ['CENTS', (v) => v / 200 + 0.5, (n) => (n - 0.5) * 200, (n) => `${Math.round((n - 0.5) * 200)}`, 0.5],
      pos: ['POS', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0],
      posRate: ['RATE', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.55],
      posAmount: ['AMT', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 1],
      uniVoices: ['VOICES', (v) => (v - 1) / 6, (n) => 1 + Math.round(n * 6), (n) => `${1 + Math.round(n * 6)}`, 0],
      uniDetune: ['DETUNE', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.2],
      uniWidth: ['WIDTH', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.5],
      cutoff: ['CUTOFF', (v) => v, (n) => n, hz, 1],
      reso: ['RES', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.1],
      filterEnv: ['F.ENV', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0],
      attack: ['A', timeN, time, (n) => ms(time(n)), timeN(0.005)],
      decay: ['D', timeN, time, (n) => ms(time(n)), timeN(0.6)],
      sustain: ['S', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.75],
      release: ['R', timeN, time, (n) => ms(time(n)), timeN(0.25)],
      volume: ['VOL', (v) => v, (n) => n, (n) => `${Math.round(n * 100)}`, 0.45],
    };
    const knob = (key) => {
      const [name, to, from, text, def] = K[key];
      const kn = new Knob({
        name, def, simple: true, bipolar: key === 'cents', format: text,
        onChange: (v) => { this.setPreview(key, from(v.start)); },
      });
      kn.sync = () => { const n = to(P()[key]); kn.set({ start: n, end: n, link: true, lock: false }); };
      kn.sync();
      this.pknobs[key] = kn;
      return kn.el;
    };
    const group = (label, ...children) => {
      const g = document.createElement('div');
      g.className = 'group';
      g.innerHTML = '<span class="label"></span><div class="row"></div>';
      g.firstChild.textContent = label;
      g.lastChild.append(...children);
      pv.appendChild(g);
      return g;
    };
    const seg = (labels, key, onPick) => {
      const s = document.createElement('span');
      s.className = 'seg small';
      labels.forEach((l, j) => {
        const b = document.createElement('button');
        b.textContent = l;
        b.addEventListener('click', () => { this.setPreview(key, j); onPick?.(); });
        s.appendChild(b);
      });
      s.sync = () => [...s.children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === P()[key])));
      s.sync();
      this.pknobs['seg-' + key] = s;
      return s;
    };

    // base note
    const note = document.createElement('div');
    note.className = 'note-box';
    note.innerHTML = '<span class="stepper"><button aria-label="半音下">‹</button><span></span><button aria-label="半音上">›</button></span>';
    const nb = note.firstChild.children;
    nb[0].addEventListener('click', () => this.setPreview('baseNote', clamp(P().baseNote - 1, 0, 127), true));
    nb[2].addEventListener('click', () => this.setPreview('baseNote', clamp(P().baseNote + 1, 0, 127), true));
    note.sync = () => { nb[1].textContent = noteName(P().baseNote); };
    note.sync();
    this.pknobs.note = note;
    group('Base note', note, knob('cents'));

    const posOpts = document.createElement('div');
    posOpts.className = 'opts';
    posOpts.append(seg(['Man', 'LFO', 'Env', 'Key', 'Rnd'], 'posSource', () => this.syncPreview()));
    const posG = group('Position', posOpts, knob('pos'), knob('posRate'), knob('posAmount'));
    this.posExtras = [this.pknobs.posRate.el, this.pknobs.posAmount.el];
    group('Unison', knob('uniVoices'), knob('uniDetune'), knob('uniWidth'));
    this.uniExtras = [this.pknobs.uniDetune.el, this.pknobs.uniWidth.el];
    const fOpts = document.createElement('div');
    fOpts.className = 'opts';
    fOpts.append(seg(['LP', 'BP', 'HP'], 'filterType'));
    group('Filter', fOpts, knob('cutoff'), knob('reso'), knob('filterEnv'));
    group('Amp envelope', knob('attack'), knob('decay'), knob('sustain'), knob('release'));
    group('Out', knob('volume'));
    void posG;
    this.syncPreview();
  }
  setPreview(key, v, redraw = false) {
    this.patch.preview[key] = v;
    if (key === 'baseNote') this.keyboard.layout();
    this.sendParams();
    if (redraw || key === 'posSource' || key === 'uniVoices' || key === 'filterType') this.syncPreview();
  }
  // knobs that mean nothing in the current mode are hidden, as in the app
  syncPreview() {
    const p = this.patch.preview;
    for (const k of Object.values(this.pknobs)) k.sync?.();
    this.posExtras.forEach((el) => { el.hidden = p.posSource === 0; });
    this.uniExtras.forEach((el) => { el.hidden = p.uniVoices <= 1; });
    this.sendParams();
  }
  sendParams() {
    const p = this.patch.preview;
    this.audio.setParams(Float32Array.from(mph.PREVIEW_KEYS.map((k) => p[k])));
  }

  //--- notes --------------------------------------------------------------------

  noteEvent(n, vel) {
    if (vel > 0) this.ensureAudio().then(() => this.audio.note(n, vel, true));
    else this.audio.note(n, 0, false);
  }
  async ensureAudio() {
    if (this.audio.running) return;
    if (this.starting) return this.starting;
    this.starting = this.audio.start().catch((e) => {
      console.error(e);
      this.status('Audio could not start: ' + e.message, true);
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  //--- importing ----------------------------------------------------------------

  installDrop() {
    const targets = [[$('table-panel'), true], [$('stack-panel'), false]];
    for (const [el, asTable] of targets) {
      el.addEventListener('dragover', (e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        el.classList.add('drop');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const f = e.dataTransfer?.files?.[0];
        if (!f) return;
        e.preventDefault();
        if (/\.mph$/i.test(f.name)) {
          f.text().then((t) => {
            const p = mph.load(t, this.counts);
            if (!p) { this.status(`${f.name} is not a MORPHEUS patch.`, true); return; }
            this.replacePatch(p, p.name, false);
            this.buildPreview();
            this.status(`Opened ${f.name}.`);
          });
          return;
        }
        this.importFile(f, asTable);
      });
    }
    // a file dropped anywhere else should not navigate the page away
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    $('source-chip').addEventListener('click', () => this.source && this.rangePicker());
  }

  // As the app does it: the file becomes the wavetable itself (asTable: the
  // stack is reset to a pass-through) or the material the stack shapes.
  async importFile(file, asTable) {
    this.status(`Reading ${file.name}…`);
    const bytes = await file.arrayBuffer();
    let r = await this.gen.call({ t: 'import', bytes: bytes.slice(0) }, []);
    if (r.error) {
      // not a WAV the app's reader takes: let the browser decode it
      try {
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const buf = await ctx.decodeAudioData(bytes);
        const mono = new Float32Array(buf.length);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
        }
        r = await this.gen.call({ t: 'import', samples: mono, rate: buf.sampleRate }, [mono.buffer]);
      } catch {
        this.status(`Could not import ${file.name}: ${r.error}`, true);
        return;
      }
    }
    const before = { patch: mph.clone(this.patch), source: this.source };
    this.source = { name: file.name, samples: r.samples, rate: r.rate, begin: r.trim[0], end: r.trim[1], frames: 0, method: 0, asTable, before };
    const n = r.samples.length;
    const ready = n > 0 && n % FRAME === 0 && n / FRAME <= mph.MAX_FRAMES;
    if (ready) { this.source.begin = 0; this.source.end = 1; }
    await this.applyImport(true);
    // a file that already is a wavetable has nothing to decide
    if (!ready) this.rangePicker();
  }

  async applyImport(first) {
    const s = this.source;
    const r = await this.gen.call({ t: 'range', begin: s.begin, end: s.end, frames: s.frames, method: s.method });
    s.report = r;
    if (first) this.snapshot();
    if (s.asTable) {
      // Wave Fold with FOLD at zero passes the file straight through
      const slot = mph.newSlot();
      slot.module = 2;
      this.applyDefaults(slot);
      this.patch.slots = [slot];
      this.patch.frames = r.frames;
      this.patch.post.lock = r.method === 1;
      this.patch.post.norm = 2;
    }
    this.renderAll();
    this.regen();
    this.status(this.describeImport());
  }
  describeImport() {
    const s = this.source, r = s.report;
    const secs = s.samples.length / s.rate;
    const range = s.begin > 0.001 || s.end < 0.999 ? `  [${(s.begin * secs).toFixed(2)}–${(s.end * secs).toFixed(2)} s]` : '';
    if (r.method === 0) return `${s.name} — already a wavetable, ${r.frames} frames${range}`;
    if (r.method === 1) return `${s.name} — ${r.hz.toFixed(1)} Hz, cut into ${r.frames} cycles${range}`;
    return `${s.name} — no pitch found, ${r.frames} even slices${range}`;
  }

  // the generator holds one file; hand the earlier one back to it
  async restoreSource() {
    const s = this.source;
    await this.gen.call({ t: 'import', samples: s.samples.slice(), rate: s.rate });
    s.report = await this.gen.call({ t: 'range', begin: s.begin, end: s.end, frames: s.frames, method: s.method });
    this.renderAll();
    this.regen();
  }

  rangePicker() {
    const s = this.source;
    const back = document.createElement('div');
    back.className = 'dialog-back';
    back.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="imp-h">
        <h3 id="imp-h">Import</h3>
        <div class="meta" id="imp-meta"></div>
        <canvas id="imp-wave"></canvas>
        <div class="row">
          <span class="group"><span class="label">Range</span><button class="pill" id="imp-full">Full</button></span>
          <span class="group"><span class="label">Method</span><span class="seg small" id="imp-method"><button>Auto</button><button>Cycles</button><button>Slices</button></span></span>
          <span class="group"><span class="label">Frames</span><span class="stepper" id="imp-frames"><button aria-label="減らす">‹</button><span></span><button aria-label="増やす">›</button></span></span>
        </div>
        <div class="meta" id="imp-report"></div>
        <div class="end"><button class="pill" id="imp-cancel">Cancel</button><button class="pill" id="imp-remove">Remove source</button><button class="pill solid" id="imp-ok">Done</button></div>
      </div>`;
    document.body.appendChild(back);
    const LADDER = [0, 2, 4, 8, 16, 32, 64, 128, 256];
    const secs = s.samples.length / s.rate;
    back.querySelector('#imp-meta').textContent = `${s.name} · ${secs.toFixed(2)} s · ${s.rate} Hz · ${s.asTable ? 'becomes the wavetable' : 'the stack shapes it'}`;
    let timer = 0;
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await this.applyImport(false);
        back.querySelector('#imp-report').textContent = this.describeImport();
      }, 60);
    };
    const sync = () => {
      [...back.querySelector('#imp-method').children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === s.method)));
      back.querySelector('#imp-frames span').textContent = s.frames ? String(s.frames) : 'Auto';
    };
    const rv = new RangeView(back.querySelector('#imp-wave'), (b, e, done) => { s.begin = b; s.end = e; if (done) apply(); });
    rv.set(s.samples, s.begin, s.end);
    back.querySelector('#imp-full').addEventListener('click', () => { s.begin = 0; s.end = 1; rv.set(s.samples, 0, 1); apply(); });
    [...back.querySelector('#imp-method').children].forEach((b, j) => b.addEventListener('click', () => { s.method = j; sync(); apply(); }));
    const fb = back.querySelector('#imp-frames').children;
    const step = (d) => { const j = Math.max(0, LADDER.indexOf(s.frames)); s.frames = LADDER[clamp(j + d, 0, LADDER.length - 1)]; sync(); apply(); };
    fb[0].addEventListener('click', () => step(-1));
    fb[2].addEventListener('click', () => step(1));
    sync();
    back.querySelector('#imp-report').textContent = s.report ? this.describeImport() : '';
    const close = () => { back.remove(); window.removeEventListener('keydown', esc, true); };
    const cancel = () => {
      close();
      // put back the patch and the source from before the import
      this.patch = s.before.patch;
      this.source = s.before.source;
      if (this.source) this.restoreSource();
      else { this.gen.post({ t: 'source-clear' }); this.renderAll(); this.regen(); }
      this.status('Import cancelled.');
    };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    window.addEventListener('keydown', esc, true);
    back.querySelector('#imp-cancel').addEventListener('click', cancel);
    back.querySelector('#imp-ok').addEventListener('click', close);
    back.querySelector('#imp-remove').addEventListener('click', () => {
      close();
      this.snapshot();
      this.source = null;
      this.gen.post({ t: 'source-clear' });
      this.renderAll();
      this.regen();
      this.status('Source removed: the stack starts from a sine again.');
    });
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  }

  //--- export -------------------------------------------------------------------

  async download() {
    const btn = $('download');
    btn.disabled = true;
    const r = await this.gen.call({ t: 'export', mph: mph.save(this.patch) });
    btn.disabled = false;
    // the export regenerated the same patch; ask again so the live state is the newest
    this.regen();
    if (r.error) { this.status('Could not render: ' + r.error, true); return; }
    const name = `MORPHEUS_${(this.patch.name || 'INIT').replace(/[^\w-]+/g, '_')}_${stamp()}.wav`;
    const url = URL.createObjectURL(new Blob([r.bytes], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.status(`${name} — ${this.frames} frames × 2048, 32 bit float, ready for Serum / Vital / Wavetable.`);
  }

  //--- the rest -----------------------------------------------------------------

  renderAll() {
    this.renderStack(true);
    this.renderPost();
    this.updateBar();
    this.syncPreview?.();
    const chip = $('source-chip');
    chip.hidden = !this.source;
    if (this.source) {
      chip.innerHTML = '';
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = 'Source: ' + this.source.name;
      b.title = '範囲を選び直す';
      chip.appendChild(b);
    }
  }

  status(text, warn = false) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  installEmbed() {
    if (!EMBED || window.parent === window) return;
    let sent = 0;
    const tell = () => {
      const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (h !== sent) { sent = h; window.parent.postMessage({ morpheus: 'height', h }, '*'); }
    };
    new ResizeObserver(tell).observe(document.body);
    tell();
    // From the site around the frame: the tab was left (let go of held notes),
    // or computer keys typed while the focus is on the site's page.
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window.parent || !m) return;
      if (m.morpheus === 'hide') { this.keyboard.releaseAll(); this.audio.off(); }
      else if (m.morpheus === 'keydown') {
        if (this.audio.running || navigator.userActivation?.isActive) this.keyboard.pcDown(m.code, m.repeat);
      } else if (m.morpheus === 'keyup') this.keyboard.pcUp(m.code);
      else if (m.morpheus === 'keys-lost') this.keyboard.releasePc();
    });
  }
}

//=============================================================================
// a small popup menu: { head } { sep } { label, hint, cur, run }

function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { m.appendChild(document.createElement('hr')); continue; }
    if (it.head) { const h = document.createElement('div'); h.className = 'h label'; h.textContent = it.head; m.appendChild(h); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.cur) b.classList.add('cur');
    b.innerHTML = '<b></b>';
    b.firstChild.textContent = it.label;
    if (it.hint) { const s = document.createElement('small'); s.textContent = it.hint; b.appendChild(s); }
    b.addEventListener('click', () => { close(); it.run(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + 6 + mh > innerHeight && r.top - 6 - mh > 0 ? r.top - 6 - mh : r.bottom + 6) + 'px';
  m.querySelector('.cur, button')?.focus({ preventScroll: true });
  const close = () => { m.remove(); window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); };
  const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  setTimeout(() => { window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true); });
}

const stamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

function showFailure(e) {
  const s = $('start');
  s.hidden = false;
  s.classList.add('failed');
  s.querySelector('.msg').textContent = `MORPHEUS を起動できませんでした（${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : e}）`;
}

const app = new App();
window.morpheusApp = app;
app.init().catch((e) => { console.error(e); showFailure(e); });

// The wasm half of web/check.sh: the factory presets' fingerprints from this
// build, line for line comparable with the native ones.
window.morpheusCheck = async () => {
  const g = new Gen();
  const ready = await g.ready;
  const out = [];
  for (let i = 0; i < ready.presets.length; i++) {
    const t = await new Promise((r) => { g.on('table', r); g.post({ t: 'patch', mph: ready.presets[i], drag: true }); });
    const d = t.data, f = t.frames;
    let s2 = 0;
    for (let j = 0; j < f * FRAME; j++) s2 += d[j] * d[j];
    out.push(`${i} ${f} ${s2.toPrecision(9)} ${d[1000].toPrecision(9)} ${d[f * FRAME - 777].toPrecision(9)}`);
  }
  g.w.terminate();
  return out.join('\n');
};
