// W GEN, the web page built on the MORPHEUS engine. Three things: Random rolls
// a whole stack (dsp/randomize.h with modules: 1-8 slots, a generator first;
// ONLY SPECTRAL keeps every slot spectral), the table is shown, and Download WAV
// writes it the way the app's RENDER does. The keyboard plays it through the
// preview synth at its default settings. Nothing on the page edits a module.
//
// ?embed: shown inside the site's W GEN tab (an iframe). No title, and the
// page tells the parent how tall it is ({ morpheus: 'height', h }).

import * as mph from './mph.js';
import { TableView, FRAME } from './views.js';
import { Keyboard } from './keyboard.js';

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

// The worklet, the synth's wasm and the table are all loaded when the page
// opens, into a context that waits suspended. The first note then only has to
// resume it -- the one step that needs a gesture -- instead of waiting for a
// module load, a fetch, a compile and a 10 MB table. (Starting all of that on
// the first key press is what made the first note late.)
//
// Everything for the synth goes through one queue, in order, whether the node
// exists yet or not: a note-off sent while its note-on is still waiting must
// not be dropped or overtake it, or the note never stops.
class Audio {
  constructor() { this.ctx = null; this.node = null; this.queue = []; this.onPos = null; this.loading = null; }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  load() {
    if (this.loading) return this.loading;
    // created here, synchronously, so a gesture that comes before the load is
    // done can still resume it inside its own event handler (Safari asks that)
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.loading = (async () => {
      const base = new URL('..', import.meta.url);
      const [, wasm] = await Promise.all([
        ctx.audioWorklet.addModule(new URL('morph-worklet.js', base)),
        fetch(new URL('gen/morph_synth.wasm', base)).then((r) => r.arrayBuffer()),
      ]);
      const node = new AudioWorkletNode(ctx, 'morpheus-preview', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm },
      });
      node.port.onmessage = (e) => { if (e.data.t === 'pos') this.onPos?.(e.data); };
      node.connect(ctx.destination);
      this.node = node;
      for (const [m, transfer] of this.queue) node.port.postMessage(m, transfer);
      this.queue = [];
    })();
    return this.loading;
  }
  // call from inside the gesture's handler
  resume() { if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume(); }
  send(m, transfer = []) {
    if (this.node) { this.node.port.postMessage(m, transfer); return; }
    // only the newest settings and the newest table are worth delivering later
    if (m.t === 'params' || m.t === 'play') this.queue = this.queue.filter(([q]) => q.t !== m.t);
    this.queue.push([m, transfer]);
  }
  setParams(v) { this.send({ t: 'params', v }); }
  // handed over, not copied: the page has no use for the pyramid itself
  setPlay(levels, frames) { this.send({ t: 'play', levels, frames }, levels.map((a) => a.buffer)); }
  note(n, vel, on) { this.send({ t: 'note', n, vel, on }); }
  off() { this.send({ t: 'off' }); }
}

//=============================================================================

class App {
  async init() {
    this.gen = new Gen();
    this.audio = new Audio();
    const ready = await this.gen.ready;
    this.counts = [ready.modules.time.length, ready.modules.spectral.length];
    this.patch = mph.load(ready.presets[0], this.counts);
    this.patch.preview = mph.defaultPreview();
    this.frames = 1;

    this.audio.load().catch((e) => {
      console.error(e);
      this.status('Audio could not start: ' + e.message, true);
    });
    for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, () => this.wake(), true);

    this.tableView = new TableView($('table'));
    this.gen.on('table', (m) => this.onTable(m));
    this.gen.on('play', (m) => this.audio.setPlay(m.levels, m.frames));
    this.audio.onPos = (m) => this.tableView.setLive(m.active ? Math.round(clamp(m.pos, 0, 1) * (this.frames - 1)) : -1);
    this.sendParams();

    this.keyboard = new Keyboard($('keys'), {
      onNote: (n, vel) => this.noteEvent(n, vel),
      getBase: () => this.patch.preview.baseNote,
      onOctave: (d) => {
        this.patch.preview.baseNote = clamp(this.patch.preview.baseNote + d, 12, 108);
        this.keyboard.layout();
        this.sendParams();
      },
    });
    $('midi').addEventListener('click', () => this.keyboard.enableMidi($('midi')));   // the click wakes the audio
    $('random').addEventListener('click', () => this.roll());
    // remembered per viewer; it applies from the next Random
    this.spectralOnly = false;
    try { this.spectralOnly = localStorage.getItem('wgen.spectralOnly') === '1'; } catch {}
    $('spectral').setAttribute('aria-pressed', String(this.spectralOnly));
    $('spectral').addEventListener('click', () => {
      this.spectralOnly = !this.spectralOnly;
      $('spectral').setAttribute('aria-pressed', String(this.spectralOnly));
      try { localStorage.setItem('wgen.spectralOnly', this.spectralOnly ? '1' : '0'); } catch {}
    });
    $('download').addEventListener('click', () => this.download());
    this.installEmbed();
    await this.roll();   // open on something worth hearing rather than a sine
  }

  sendParams() {
    this.audio.setParams(Float32Array.from(mph.PREVIEW_KEYS.map((k) => this.patch.preview[k])));
  }

  async roll() {
    const r = await this.gen.call({ t: 'random', mph: mph.save(this.patch), modules: true, spectral: this.spectralOnly, seed: Math.floor(Math.random() * 2 ** 32) });
    const p = mph.load(r.mph, this.counts);
    p.preview = this.patch.preview;
    this.patch = p;
    this.gen.post({ t: 'patch', mph: mph.save(this.patch), drag: false });
  }

  onTable(m) {
    this.frames = m.frames;
    this.tableView.setTable(m.data, m.frames);
    const n = this.patch.slots.length;
    $('info').textContent = `${n} slot${n > 1 ? 's' : ''} · ${m.frames} frames × 2048`;
  }

  // sent at once, in order; the queue holds it if the synth is not there yet
  noteEvent(n, vel) {
    if (vel > 0) this.wake();
    this.audio.note(n, vel, vel > 0);
  }
  // Any gesture on the page resumes the audio, so even the first note sounds
  // on time. Called inside the gesture's handler, not after an await.
  wake() {
    const p = this.audio.resume();
    p?.catch((e) => this.status('Audio could not start: ' + e.message, true));
  }

  async download() {
    const btn = $('download');
    btn.disabled = true;
    const r = await this.gen.call({ t: 'export', mph: mph.save(this.patch) });
    btn.disabled = false;
    if (r.error) { this.status('Could not render: ' + r.error, true); return; }
    const name = `W-GEN_${stamp()}.wav`;
    const url = URL.createObjectURL(new Blob([r.bytes], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.status(`${name} — ${this.frames} frames × 2048, 32 bit float (Serum / Vital / Wavetable)`);
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

const stamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

function showFailure(e) {
  const s = $('start');
  s.hidden = false;
  s.querySelector('.msg').textContent = `W GEN を起動できませんでした（${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : e}）`;
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
