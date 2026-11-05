// AudioWorklet side of MORPHEUS: the preview synth (gen/morph_synth.mjs,
// engine/synth_api.cpp), one 128-frame quantum per process() call. The page
// hands the .wasm bytes in through processorOptions (the worklet scope cannot
// fetch) and the module compiles them synchronously.
//
// In:  { t: 'play', levels, frames }   a new mip pyramid (gen-worker.js)
//      { t: 'params', v }              18 numbers, dsp::PreviewState's order
//      { t: 'note', n, vel, on }  { t: 'midi', s, d1, d2 }  { t: 'off' }
// Out: { t: 'ready' }  { t: 'pos', pos, active }  (~30 Hz while something sounds)

import createModule from './gen/morph_synth.mjs';

class MorpheusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.M = null;
    this.pending = [];
    this.clock = 0;
    this.wasActive = false;
    this.port.onmessage = (e) => {
      if (!this.M) { this.pending.push(e.data); return; }
      try { this.apply(e.data); } catch (err) { this.port.postMessage({ t: 'error', message: String(err) }); }
    };
    createModule({ wasmBinary: options.processorOptions.wasm }).then((M) => {
      M._synth_prepare(sampleRate);
      this.M = M;
      for (const m of this.pending) this.apply(m);
      this.pending = [];
      this.port.postMessage({ t: 'ready' });
    });
  }

  apply(m) {
    const M = this.M;
    switch (m.t) {
      case 'play':
        M._synth_table_begin(m.frames);
        m.levels.forEach((a, l) => M.HEAPF32.set(a, M._synth_table_level(l) >> 2));
        M._synth_table_commit();
        break;
      case 'params':
        M.HEAPF32.set(m.v, M._synth_param_buffer() >> 2);
        M._synth_params(M._synth_param_buffer());
        break;
      case 'note': M._synth_note(m.n, m.vel, m.on ? 1 : 0); break;
      case 'midi': M._synth_midi(m.s, m.d1, m.d2); break;
      case 'off': M._synth_all_off(); break;
      case 'probe': this.port.postMessage({ t: 'probe', active: M._synth_active(), live: M._synth_live_active(), sr: sampleRate, frames: M._synth_debug(0), levels: M._synth_debug(1) }); break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.M || !out || !out[0]) return true;
    const n = out[0].length;
    const p = this.M._synth_render(n, sampleRate) >> 2;
    const h = this.M.HEAPF32;
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < n; i++) {
      L[i] = h[p + 2 * i];
      R[i] = h[p + 2 * i + 1];
    }
    this.clock += n / sampleRate;
    const active = this.M._synth_live_active() !== 0;
    if ((active && this.clock >= 1 / 30) || (!active && this.wasActive)) {
      this.clock = 0;
      this.port.postMessage({ t: 'pos', pos: this.M._synth_live_pos(), active });
    }
    this.wasActive = active;
    return true;
  }
}

registerProcessor('morpheus-preview', MorpheusProcessor);
