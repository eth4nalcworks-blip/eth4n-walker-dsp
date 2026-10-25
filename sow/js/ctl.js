// Page side of the SIREN Lite controller (gen/lite_ctl.mjs). It owns the
// parameter values; every edit goes through here so the controller's side
// effects run (waveform display, LFO preset curves, mod rings, dropped WAV ->
// wavetable) and whatever it produces is forwarded: parameter edits and the
// wavetable / LFO curve to the audio engine, value changes and "dirty" bits to
// the GUI.

import createCtl from '../gen/lite_ctl.mjs';

// dirty bits (lite_ctl.cpp, enum Dirty)
export const Dirty = {
  oscWave: 1 << 0,
  lfo: 1 << 5,
  wtName: 1 << 8,
  rings: 1 << 11,
};

export class Ctl {
  static async create(audio) {
    const M = await createCtl();
    return new Ctl(M, audio);
  }

  constructor(M, audio) {
    this.M = M;
    this.audio = audio;
    M._ctl_init();
    this.params = new Map();
    for (const p of JSON.parse(this.str(M._ctl_params_json()))) this.params.set(p.id, p);
    this.norm = new Float64Array(1001);
    for (const id of this.params.keys()) this.norm[id] = M._ctl_get(id);
    this.paramListeners = new Map();   // id -> Set(fn)
    this.anyListeners = new Set();     // fn(id, n)
    this.dirtyListeners = new Set();   // fn(bits)
    // the engine starts from the controller's defaults
    for (const [id, p] of this.params) if (!p.hidden) audio.param(id, this.norm[id]);
    this.drain();
  }

  // ---- wasm helpers
  str(ptr) { return ptr ? this.M.UTF8ToString(ptr) : ''; }
  withCString(s, fn) {
    const M = this.M;
    const n = M.lengthBytesUTF8(s) + 1;
    const p = M._malloc(n);
    M.stringToUTF8(s, p, n);
    try { return fn(p); } finally { M._free(p); }
  }
  floats(ptr, len) { return ptr && len > 0 ? this.M.HEAPF32.slice(ptr >> 2, (ptr >> 2) + len) : new Float32Array(0); }

  // ---- parameters
  info(id) { return this.params.get(id); }
  get(id) { return this.norm[id] || 0; }
  toPlain(id, n) { return this.M._ctl_to_plain(id, n === undefined ? this.get(id) : n); }
  toNorm(id, v) { return this.M._ctl_to_norm(id, v); }
  string(id, n) { return this.str(this.M._ctl_string(id, n === undefined ? this.get(id) : n)); }
  // list parameters: entry index of a normalized value (VST3 StringListParameter::toPlain)
  step(id, n) {
    const p = this.params.get(id);
    const v = n === undefined ? this.get(id) : n;
    if (!p || p.count < 2) return Math.round(v);
    return Math.min(p.count - 1, Math.floor(v * p.count));
  }
  stepNorm(id, idx) {
    const p = this.params.get(id);
    return p && p.count > 1 ? idx / (p.count - 1) : idx;
  }

  // a GUI edit (beginEdit / performEdit): controller side effects, engine, views
  set(id, n) {
    if (!this.params.has(id)) return;
    n = Math.min(1, Math.max(0, n));
    this.M._ctl_set(id, n);
    this.norm[id] = this.M._ctl_get(id);
    this.audio.param(id, this.norm[id]);
    this.emit(id, this.norm[id]);
    this.drain();
  }

  onParam(id, fn) {
    if (!this.paramListeners.has(id)) this.paramListeners.set(id, new Set());
    this.paramListeners.get(id).add(fn);
    return () => this.paramListeners.get(id).delete(fn);
  }
  onAnyParam(fn) { this.anyListeners.add(fn); return () => this.anyListeners.delete(fn); }
  onDirty(fn) { this.dirtyListeners.add(fn); return () => this.dirtyListeners.delete(fn); }

  emit(id, n) {
    const ls = this.paramListeners.get(id);
    if (ls) for (const fn of [...ls]) fn(n);
    for (const fn of this.anyListeners) fn(id, n);
  }

  // forward what the controller queued: parameter edits it made itself
  // (editParam), the wavetable / LFO curve for the engine, and dirty bits
  drain() {
    const M = this.M;
    for (let guard = 0; guard < 8; guard++) {
      const ne = M._ctl_edit_count();
      const no = M._ctl_out_count();
      if (!ne && !no) break;
      const edits = [];
      for (let i = 0; i < ne; i++) edits.push(M._ctl_edit_id(i));
      M._ctl_edit_clear();
      const outs = [];
      for (let i = 0; i < no; i++) outs.push({ kind: M._ctl_out_kind(i), data: this.floats(M._ctl_out_data(i), M._ctl_out_len(i)) });
      M._ctl_out_clear();
      for (const id of edits) {
        this.norm[id] = M._ctl_get(id);
        this.audio.param(id, this.norm[id]);
        this.emit(id, this.norm[id]);
      }
      for (const o of outs) {
        if (o.kind === 0) this.audio.table(o.data);
        else this.audio.lfoShape(o.data);
      }
    }
    const bits = M._ctl_take_dirty();
    if (bits) for (const fn of this.dirtyListeners) fn(bits);
  }

  // ---- oscillator display / wavetable
  oscPreview() { return this.floats(this.M._ctl_osc_preview(), this.M._ctl_osc_preview_len()); }
  wtName() { return this.str(this.M._ctl_wt_name()); }
  hasTable() { return !!this.M._ctl_has_table(); }
  loadWav(bytes, name) {
    const M = this.M;
    const p = M._ctl_alloc_bytes(bytes.length);
    M.HEAPU8.set(bytes, p);
    this.withCString(name || '', (np) => M._ctl_load_wav(p, bytes.length, np));
    M._ctl_free_bytes(p);
    this.drain();
  }

  // ---- live modulation (LFO1 phase from the engine, 60 fps tick)
  live(phase, now) { this.M._ctl_live(phase, now); }
  tick(now, dt) { this.M._ctl_tick(now, dt); this.drain(); }
  animPhase() { return this.M._ctl_anim_phase(); }
  liveUsed(id) { return !!this.M._ctl_live_used(id); }
  liveOffset(id) { return this.M._ctl_live_offset(id); }

  // ---- mod rings / drag-assign
  ring(id) {
    const M = this.M;
    return { depth: M._ctl_ring_depth(id), active: !!M._ctl_ring_active(id), focus: !!M._ctl_ring_focus(id) };
  }
  tabCount(i) { return this.M._ctl_tab_count(i); }
  assignMod(id, src) { this.M._ctl_assign_mod(id, src); this.drain(); }
  clearMods(id) { this.M._ctl_clear_mods(id); this.drain(); }
  nudgeMod(id, d) { this.M._ctl_nudge_mod(id, d); this.drain(); }

  // ---- LFO curve (packed LfoShape)
  lfoPack() {
    const p = this.M._ctl_alloc_floats(128);
    const n = this.M._ctl_lfo_pack(p);
    const out = this.floats(p, n);
    this.M._ctl_free_floats(p);
    return out;
  }
  lfoEdited(packed) {
    const p = this.M._ctl_alloc_floats(packed.length);
    this.M.HEAPF32.set(packed, p >> 2);
    this.M._ctl_lfo_edited(p, packed.length);
    this.M._ctl_free_floats(p);
    this.drain();
  }
  lfoEval(x) { return this.M._ctl_lfo_eval(x); }

  action(id) { this.M._ctl_action(id); this.drain(); }
}
