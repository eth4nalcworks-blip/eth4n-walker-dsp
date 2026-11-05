// AudioWorklet side of MORPHEUS: the preview synth (gen/morph_synth.mjs,
// engine/synth_api.cpp), one 128-frame quantum per process() call. The page
// hands the .wasm bytes in through processorOptions (the worklet scope cannot
// fetch) and the module compiles them synchronously.
//
// In:  { t: 'play', levels, frames }   a new mip pyramid (gen-worker.js), about
//                                      10 MB: copied into the synth a slice per
//                                      block so the audio thread never stalls
//      { t: 'params', v }              18 numbers, dsp::PreviewState's order
//      { t: 'note', n, vel, on }  { t: 'midi', s, d1, d2 }  { t: 'off' }
// Out: { t: 'ready' }  { t: 'pos', pos, active }  (~30 Hz while something sounds)

import createModule from './gen/morph_synth.mjs';

const CHUNK = 1 << 18;   // samples per block: ~1 MB, well under a block's time to copy

class MorpheusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.M = null;
    this.pending = [];
    this.copy = null;
    this.commits = 0;   // tables made current, for the page's checks
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
        // a newer table replaces one still being copied: the spare is not live
        M._synth_table_begin(m.frames);
        this.copy = { levels: m.levels, l: 0, at: 0 };
        // with nothing sounding the copy cannot be heard, so it is done now --
        // which also covers a suspended context, where no blocks run at all
        if (!M._synth_active()) this.copyStep(Infinity);
        break;
      case 'params':
        M.HEAPF32.set(m.v, M._synth_param_buffer() >> 2);
        M._synth_params(M._synth_param_buffer());
        break;
      case 'note': M._synth_note(m.n, m.vel, m.on ? 1 : 0); break;
      case 'midi': M._synth_midi(m.s, m.d1, m.d2); break;
      case 'off': M._synth_all_off(); break;
      case 'probe': this.port.postMessage({ t: 'probe', active: M._synth_active(), live: M._synth_live_active(), sr: sampleRate, frames: M._synth_debug(0), levels: M._synth_debug(1), copying: !!this.copy, commits: this.commits }); break;
    }
  }

  // up to CHUNK samples of the pending table per block; commits when done
  copyStep(budget = CHUNK) {
    const c = this.copy, M = this.M;
    while (budget > 0 && c.l < c.levels.length) {
      const src = c.levels[c.l];
      const n = Math.min(budget, src.length - c.at);
      M.HEAPF32.set(src.subarray(c.at, c.at + n), (M._synth_table_level(c.l) >> 2) + c.at);
      c.at += n;
      budget -= n;
      if (c.at >= src.length) { c.l++; c.at = 0; }
    }
    if (c.l >= c.levels.length) {
      M._synth_table_commit();
      this.copy = null;
      this.commits++;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.M || !out || !out[0]) return true;
    if (this.copy) this.copyStep();
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
