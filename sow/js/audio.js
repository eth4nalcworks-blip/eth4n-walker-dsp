// Page side of the audio engine: creates the AudioContext and the SIREN Lite
// worklet, forwards parameters / notes / the wavetable / the LFO curve to it,
// and hands the display data it sends back to whoever listens.

export class SowAudio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.listeners = new Set();
    this.ready = false;
    // what the engine must hold, kept so start() can replay it: the page edits
    // parameters and loads a wavetable before any sound is allowed
    this.state = { params: new Map(), table: null, lfo: null };
  }

  // Must run from a user gesture (browsers keep audio suspended until then).
  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const base = new URL('..', import.meta.url);
    await ctx.audioWorklet.addModule(new URL('sow-worklet.js', base));
    const wasm = await (await fetch(new URL('gen/lite_dsp.wasm', base))).arrayBuffer();
    const node = new AudioWorkletNode(ctx, 'siren-lite', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm },
    });
    node.port.onmessage = (e) => {
      if (e.data.t === 'ready') this.ready = true;
      for (const fn of this.listeners) fn(e.data);
    };
    node.connect(ctx.destination);
    this.node = node;
    for (const [id, v] of this.state.params) this.post({ t: 'p', id, v });
    if (this.state.table) this.post(this.state.table);
    if (this.state.lfo) this.post(this.state.lfo);
    await ctx.resume();
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  post(msg) {
    if (this.node) this.node.port.postMessage(msg);
  }

  param(id, v) { this.state.params.set(id, v); this.post({ t: 'p', id, v }); }
  note(pitch, velocity) { this.post({ t: 'n', p: pitch, v: velocity }); }
  table(data) { this.state.table = { t: 'table', data }; this.post(this.state.table); }
  lfoShape(data) { this.state.lfo = { t: 'lfo', data }; this.post(this.state.lfo); }
}
