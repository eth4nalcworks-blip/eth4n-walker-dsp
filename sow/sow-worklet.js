// AudioWorklet side of SOW: hosts the SIREN Lite engine (gen/lite_dsp.mjs) and
// renders one 128-frame quantum per process() call. The page hands the .wasm
// bytes in through processorOptions (the worklet scope cannot fetch), and the
// module instantiates them synchronously.
//
// Messages in (port):
//   { t: 'p', id, v }       parameter, normalized
//   { t: 'n', p, v }        note on (v > 0) / off (v = 0)
//   { t: 'table', data }    analysed wavetable (WaveTable::pack)
//   { t: 'lfo', data }      drawn LFO curve (LfoShape::pack)
// Messages out:
//   { t: 'ready' }
//   { t: 'ui', ... }        ~30 Hz: partial snapshot, output peaks, LFO1 phase,
//                           DSP load

import createModule from './gen/lite_dsp.mjs';

const UI_INTERVAL = 1 / 30;

class SirenLiteProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.M = null;
    this.pending = [];
    this.lastSerial = -1;
    this.uiClock = 0;
    this.busyMs = 0;
    this.load = 0;
    this.port.onmessage = (e) => (this.M ? this.apply(e.data) : this.pending.push(e.data));
    createModule({ wasmBinary: options.processorOptions.wasm }).then((M) => {
      M._lite_create(sampleRate);
      M._lite_display(1);
      this.M = M;
      for (const m of this.pending) this.apply(m);
      this.pending = [];
      this.port.postMessage({ t: 'ready' });
    });
  }

  floats(data) {
    const M = this.M;
    const p = M._lite_alloc_floats(data.length);
    M.HEAPF32.set(data, p >> 2);
    return p;
  }

  apply(m) {
    const M = this.M;
    switch (m.t) {
      case 'p': M._lite_param(m.id, m.v); break;
      case 'n': M._lite_note(m.p, m.v); break;
      case 'table': {
        const p = this.floats(m.data);
        M._lite_table(p, m.data.length);
        M._lite_free_floats(p);
        break;
      }
      case 'lfo': {
        const p = this.floats(m.data);
        M._lite_lfo_shape(p, m.data.length);
        M._lite_free_floats(p);
        break;
      }
    }
  }

  postUi() {
    const M = this.M;
    const serial = M._lite_ui_serial();
    if (serial === this.lastSerial) return;
    this.lastSerial = serial;
    const H = M.HEAPF32;
    const count = M._lite_ui_count();
    const msg = {
      t: 'ui',
      load: this.load,
      count,
      f0: M._lite_ui_f0(),
      freq: H.slice(M._lite_ui_freq() >> 2, (M._lite_ui_freq() >> 2) + count),
      amp: H.slice(M._lite_ui_amp() >> 2, (M._lite_ui_amp() >> 2) + count),
      pkL: M._lite_ui_take_peak(0),
      pkR: M._lite_ui_take_peak(1),
      lfo: M._lite_ui_lfo_phase(),
    };
    this.port.postMessage(msg, [msg.freq.buffer, msg.amp.buffer]);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.M || !out || out.length < 2) return true;
    const M = this.M;
    const n = out[0].length;
    const t0 = Date.now();
    M._lite_process(n);
    this.busyMs += Date.now() - t0;
    const H = M.HEAPF32;
    out[0].set(H.subarray(M._lite_out_l() >> 2, (M._lite_out_l() >> 2) + n));
    out[1].set(H.subarray(M._lite_out_r() >> 2, (M._lite_out_r() >> 2) + n));
    this.uiClock += n / sampleRate;
    if (this.uiClock >= UI_INTERVAL) {
      // DSP load over the interval (share of the real time it covered)
      this.load = this.busyMs / (this.uiClock * 1000);
      this.busyMs = 0;
      this.uiClock = 0;
      this.postUi();
    }
    return true;
  }
}

registerProcessor('siren-lite', SirenLiteProcessor);
