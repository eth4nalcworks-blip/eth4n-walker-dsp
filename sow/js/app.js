// SOW (SIREN ON WEB), SIREN Lite: wires the lite engine (AudioWorklet), the
// lite controller (wasm), the editor built from gen/layout.json, and the
// playing surface.

import { SowAudio } from './audio.js';
import { Ctl, Dirty } from './ctl.js';
import { Root, screenImage } from './gui/core.js';
import { buildView } from './gui/build.js';
import { OptionsView } from './gui/overlays.js';
import { Keyboard } from './keyboard.js';

const VERSION = 'SIREN Lite  (SIREN v0.16.0)';
const PITCH_BEND = 110;
// parameters the header readout ignores (Controller::updateReadout)
const NO_READOUT = new Set([PITCH_BEND, 121]);
// ?embed: shown inside the site's SOW tab (an iframe). No header, the editor
// fills the frame's width, and the page tells the parent how tall it is.
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.classList.add('embed');

function loadImage(src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}
const stem = (name) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

class App {
  async init() {
    const base = new URL('..', import.meta.url);
    this.audio = new SowAudio();
    const [ctl, ui] = await Promise.all([
      Ctl.create(this.audio),
      fetch(new URL('gen/layout.json', base)).then((r) => r.json()),
    ]);
    this.ctl = ctl;
    [this.W, this.H] = ui.size;
    const images = {};
    await Promise.all(Object.entries(ui.bitmaps).map(async ([name, file]) => {
      const hi = file.replace(/\.png$/, '_2.0x.png');
      const im = (await loadImage(new URL('gen/img/' + hi, base))) || (await loadImage(new URL('gen/img/' + file, base)));
      images[name] = im ? screenImage(im) : null;
    }));

    this.env = {
      ctl, audio: this.audio, ui, images, app: this,
      knobs: new Set(), lfoEditors: new Set(),
      readout: null, meter: null, partialView: null,
    };

    const canvas = document.getElementById('editor');
    this.root = new Root(canvas, this.W, this.H);
    this.root.domLayer = document.getElementById('dom-layer');
    this.root.add(buildView(this.env, ui.templates.view));

    ctl.onAnyParam((id, n) => this.updateReadout(id, n));
    ctl.onDirty((bits) => { if (bits & Dirty.rings) for (const k of this.env.knobs) k.refreshRing(); });
    this.audio.onMessage((m) => this.onEngine(m));

    this.keyboard = new Keyboard(document.getElementById('keyboard'), {
      onNote: (p, v) => { this.ensureAudio(); this.audio.note(p, v); },
      onParam: (id, v) => ctl.set(id, v),
      strips: ['bend'],
    });

    this.fit();
    window.addEventListener('resize', () => this.fit());
    // From the site around the frame: its tab was left (let go of anything still
    // held), or the computer keys, which the site passes in while the focus is
    // on its own page (the tab button just clicked, say) and not in here.
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window.parent || !m) return;
      if (m.sow === 'hide') this.keyboard.releaseAll();
      // a note may have to start the audio, which takes a gesture: Chrome counts the
      // site's key press for this frame too, a browser that doesn't would leave
      // start() waiting, so there the keys play only once the audio runs
      else if (m.sow === 'keydown') {
        if (this.audio.running || navigator.userActivation?.isActive) this.keyboard.pcDown(m.code, m.repeat);
      }
      else if (m.sow === 'keyup') this.keyboard.pcUp(m.code);
      else if (m.sow === 'keys-lost') this.keyboard.releasePc();
    });
    this.loop();
    this.installStart();
  }

  // ---- layout: the editor scales to the window, the keyboard sits below
  fit() {
    const { W, H } = this;
    const wrap = document.getElementById('stage-wrap');
    const stage = document.getElementById('stage');
    const kbH = document.getElementById('keyboard').offsetHeight || 0;
    const head = document.querySelector('header');
    const headH = head ? head.offsetHeight : 0;
    const pad = parseFloat(getComputedStyle(document.body).paddingLeft) || 0;
    const availW = Math.max(200, document.documentElement.clientWidth - 2 * pad);
    const availH = Math.max(200, window.innerHeight - kbH - headH - 40);
    let s = Math.min(availW / W, availH / H);
    if (EMBED || availW / W < 0.75) s = availW / W;   // embedded / narrow: fill the width
    s = Math.max(0.2, Math.min(EMBED ? 1.2 : 1.6, s));
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    stage.style.transform = `scale(${s})`;
    wrap.style.width = W * s + 'px';
    wrap.style.height = H * s + 'px';
    document.getElementById('keyboard').style.width = W * s + 'px';
    this.keyboard.fitWidth(W * s);
    this.root.setScale(s);
    if (EMBED && window.parent !== window) {
      // the content's own height (scrollHeight never drops below the frame's)
      const h = Math.ceil(document.body.getBoundingClientRect().height);
      if (h !== this.sentHeight) {
        this.sentHeight = h;
        window.parent.postMessage({ sow: 'height', h }, '*');
      }
    }
  }

  loop() {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.ctl.tick(now / 1000, dt);
      const ph = this.ctl.animPhase();
      for (const v of this.env.lfoEditors) v.setPlayhead(ph);
      for (const k of this.env.knobs) {
        if (k.tag < 0) continue;
        if (this.ctl.liveUsed(k.tag)) k.setLive(this.ctl.liveOffset(k.tag), true);
        else k.setLive(0, false);
      }
      this.root.frame(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- audio start (needs a gesture)
  installStart() {
    const ov = document.getElementById('start');
    ov.addEventListener('click', (ev) => { ev.stopPropagation(); this.ensureAudio(); });
    // any first gesture on the page also wakes the audio
    const once = () => { this.ensureAudio(); };
    window.addEventListener('pointerdown', once, { once: true, capture: true });
    window.addEventListener('keydown', once, { once: true, capture: true });
  }
  async ensureAudio() {
    if (this.audio.running) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        await this.audio.start();
        document.getElementById('start').classList.add('hidden');
      } catch (e) {
        console.error(e);
        document.querySelector('#start .msg').textContent = 'Audio could not start: ' + e.message;
      }
      this.starting = null;
    })();
    return this.starting;
  }

  // ---- engine -> views (Controller::notify)
  onEngine(m) {
    if (m.t !== 'ui') return;
    const env = this.env;
    if (env.meter) env.meter.setPeaks(m.pkL, m.pkR);
    if (env.partialView) {
      if (m.count > 0) env.partialView.setSnapshot(m.freq, m.amp, m.count, m.f0);
      else env.partialView.clear();
    }
    this.ctl.live(m.lfo, performance.now() / 1000);
  }

  updateReadout(id, n) {
    const r = this.env.readout;
    if (!r || NO_READOUT.has(id)) return;
    const p = this.ctl.info(id);
    if (!p) return;
    let val = this.ctl.string(id, n);
    if (p.unit) val += ' ' + p.unit;
    r.set(p.title, val);
  }

  // SirenTextButton actions (the LFO RANDOM button)
  onAction(id) { this.ctl.action(id); }

  openOptions() {
    if (this.optionsView) return;
    this.optionsView = new OptionsView(this.root, VERSION);
    this.optionsView.onClose = () => { this.optionsView = null; };
    this.root.addOverlay(this.optionsView);
  }

  // a WAV dropped on the oscillator: analysed into its wavetable
  async loadWavFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.ctl.loadWav(bytes, stem(file.name));
  }
}

const app = new App();
window.sowApp = app;
app.init().catch((e) => {
  console.error(e);
  const m = document.querySelector('#start .msg');
  if (m) m.textContent = 'SOW could not start: ' + e.message;
});
