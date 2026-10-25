// SIREN's display views in the lite edition: partial bars, envelope curve,
// oscillator waveform, wavetable slot and the LFO editor. Ported from
// source/views/*.h; numbers are SIREN's.

import { View, theme, rgba, font, drawText, line, strokeRect, fillRect, fillEllipse, strokeEllipse, snap } from './core.js';
import { rectOf, OptionMenu } from './widgets.js';
import { Dirty } from '../ctl.js';

const OSC_WAVE = 201, OSC_SOURCE = 209;
const envId = (k) => 600 + k;
const LFO_GRID = 656;

// subscribe to a set of parameters + dirty bits; returns an unsubscribe
function watch(view, ids, bits, fn) {
  const ctl = view.env.ctl;
  const us = ids.map((id) => ctl.onParam(id, fn));
  if (bits) us.push(ctl.onDirty((b) => { if (b & bits) fn(); }));
  return () => us.forEach((u) => u());
}

// ---------------------------------------------------------------------------
// PartialDisplayView: the oscillator's post-PRISM partials on a log axis

export class PartialDisplay extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.count = 0;
    this.freq = null;
    this.amp = null;
    this.f0 = 0;
    this.dropActive = false;
  }
  attached() { this.env.partialView = this; }
  removed() { if (this.env.partialView === this) this.env.partialView = null; }
  setSnapshot(freq, amp, count, f0) {
    this.freq = freq; this.amp = amp; this.count = count; this.f0 = f0;
    this.invalid();
  }
  clear() { if (this.count) { this.count = 0; this.invalid(); } }
  draw(ctx) {
    fillRect(ctx, 0, 0, this.w, this.h, theme.panel);
    const W = this.w, H = this.h - 18;
    const fMin = 20, fMax = 20000;
    const xOf = (hz) => Math.log(Math.min(fMax, Math.max(fMin, hz)) / fMin) / Math.log(fMax / fMin) * W;
    for (let f = 31.25; f < fMax; f *= 2) line(ctx, xOf(f), 0, xOf(f), H, theme.grid, 1);
    const lf = [100, 1000, 10000], lt = ['100', '1k', '10k'];
    for (let i = 0; i < 3; i++) drawText(ctx, lt[i], xOf(lf[i]) - 16, H + 2, 32, this.h - H - 2, 'center', font(9), theme.dim);
    if (this.f0 > 20) line(ctx, xOf(this.f0), 0, xOf(this.f0), H, theme.accentDim, 1);
    for (let pass = 0; pass < 2; pass++) {
      const off = pass === 0 ? 0.5 : 0;   // odd integer width -> half-point shift
      ctx.beginPath();
      for (let i = 0; i < this.count; i++) {
        const a = Math.abs(this.amp[i]);
        if (a < 1e-5) continue;
        const h = Math.min(1, Math.max(0, (20 * Math.log10(a) + 66) / 66));
        if (h <= 0) continue;
        const x = xOf(this.freq[i]);
        const [x0, y0] = snap(ctx, x, H), [, y1] = snap(ctx, x, H * (1 - h));
        ctx.moveTo(x0 + off, y0 + off);
        ctx.lineTo(x0 + off, y1 + off);
      }
      ctx.strokeStyle = pass === 0 ? rgba(theme.accent, 40) : theme.accent;
      ctx.lineWidth = pass === 0 ? 3 : 1.2;
      ctx.lineCap = 'butt';
      ctx.stroke();
    }
    drawText(ctx, 'OSC', 8, 4, 82, 12, 'left', font(9), theme.dim);
    if (this.dropActive) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(2, 2, this.w - 4, this.h - 4);
      drawText(ctx, 'DROP WAV -> LOAD AS WAVETABLE', 0, this.h - 26, this.w, 14, 'center', font(9), theme.accent);
    }
  }
  // a dropped WAV becomes the oscillator's wavetable
  acceptsFiles() { return true; }
  fileDragEnter() { this.dropActive = true; this.invalid(); }
  fileDragLeave() { this.dropActive = false; this.invalid(); }
  fileDrop(file) { this.env.app.loadWavFile(file); }
}

// ---------------------------------------------------------------------------
// EnvCurveView: ADSR shape

export class EnvCurve extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.mouseEnabled = false;
  }
  attached() {
    const ids = [0, 1, 2, 3].map(envId);
    this.unsub = watch(this, ids, 0, () => this.invalid());
  }
  removed() { this.unsub(); }
  draw(ctx) {
    const ctl = this.env.ctl;
    const P = (k) => ctl.toPlain(envId(k));
    const a = P(0), d = P(1), s = P(2), r = P(3);
    fillRect(ctx, 0, 0, this.w, this.h, theme.panel);
    const pad = 6, W = this.w - 2 * pad, H = this.h - 2 * pad;
    const x0 = pad, y0 = this.h - pad;
    const seg = (ms) => Math.log10(1 + ms) + 0.15;
    const wa = seg(a), wd = seg(d), wr = seg(r);
    const ws = (wa + wd + wr) * 0.35;
    const tot = wa + wd + ws + wr;
    const xa = x0 + W * wa / tot, xd = xa + W * wd / tot, xs = xd + W * ws / tot;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + (xa - x0) * 0.4, y0 - H * 0.9, xa, y0 - H, xa, y0 - H);
      ctx.bezierCurveTo(xa + (xd - xa) * 0.3, y0 - H * (0.95 * s + 0.05), xd, y0 - H * s, xd, y0 - H * s);
      ctx.lineTo(xs, y0 - H * s);
      ctx.bezierCurveTo(xs + (x0 + W - xs) * 0.3, y0 - H * s * 0.2, x0 + W, y0, x0 + W, y0);
    };
    path();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    path();
    ctx.lineTo(x0, y0);
    ctx.closePath();
    ctx.fillStyle = rgba(theme.accent, 26);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// OscWaveView: one cycle through the oscillator build + PRISM (the engine's code)

export class OscWave extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.preview = new Float32Array(0);
    this.dropActive = false;
  }
  get ctl() { return this.env.ctl; }
  attached() {
    this.unsub = watch(this, [OSC_WAVE, OSC_SOURCE], Dirty.oscWave, () => this.refresh());
    this.refresh();
  }
  removed() { this.unsub(); }
  refresh() {
    this.preview = this.ctl.oscPreview();
    this.invalid();
  }
  get source() { return this.ctl.step(OSC_SOURCE); }
  get wave() { return this.ctl.step(OSC_WAVE); }
  draw(ctx) {
    fillRect(ctx, 0, 0, this.w, this.h, theme.knob);
    strokeRect(ctx, 0, 0, this.w, this.h, this.dropActive ? theme.accent : theme.cardEdge, this.dropActive ? 2 : 1);
    const W = this.w, H = this.h, midY = H * 0.5;
    line(ctx, 4, midY, W - 4, midY, theme.grid, 1);
    const N = 256;
    const y = new Float64Array(N);
    const pn = this.preview.length;
    if (pn) for (let i = 0; i < N; i++) y[i] = this.preview[Math.floor(i / N * pn) % pn];
    else if (this.source === 0) for (let i = 0; i < N; i++) y[i] = builtin(this.wave, i / N);
    else return;   // Wavetable with nothing dropped yet: the empty box
    const amp = H * 0.40;
    ctx.beginPath();
    ctx.moveTo(4, midY);
    for (let i = 0; i < N; i++) ctx.lineTo(4 + (W - 8) * i / (N - 1), midY - y[i] * amp);
    ctx.lineTo(W - 4, midY);
    ctx.closePath();
    ctx.fillStyle = rgba(theme.accent, 30);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const px = 4 + (W - 8) * i / (N - 1), py = midY - y[i] * amp;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'miter';
    ctx.stroke();
  }
  acceptsFiles() { return true; }
  fileDragEnter() { this.dropActive = true; this.invalid(); }
  fileDragLeave() { this.dropActive = false; this.invalid(); }
  fileDrop(file) { this.env.app.loadWavFile(file); }
}

function builtin(wave, ph) {
  switch (wave) {
    default:
    case 0: return 1 - 2 * ph;
    case 1: return ph < 0.5 ? 1 : -1;
    case 2: return 1 - 4 * Math.abs(ph - 0.5);
    case 3: return Math.sin(2 * Math.PI * ph);
  }
}

// ---------------------------------------------------------------------------
// the wavetable slot: the dropped file's name (dropping a WAV is the only way in)

export class WtMenu extends OptionMenu {
  attached() { this.unsub = this.env.ctl.onDirty((b) => { if (b & Dirty.wtName) this.invalid(); }); }
  removed() { this.unsub(); }
  draw(ctx) {
    this.drawBack(ctx);
    const name = this.env.ctl.wtName();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.clip();
    drawText(ctx, name || 'DROP A WAV FILE HERE', 0, 0, this.w, this.h, this.align, this.font, name ? this.fontColor : theme.dim);
    ctx.restore();
    if (this.dropActive) strokeRect(ctx, 0, 0, this.w, this.h, theme.accent, 2);
  }
  onMouseDown() { return true; }
  onWheel() { return true; }
  acceptsFiles() { return true; }
  fileDragEnter() { this.dropActive = true; this.invalid(); }
  fileDragLeave() { this.dropActive = false; this.invalid(); }
  fileDrop(file) { this.env.app.loadWavFile(file); }
}

// ---------------------------------------------------------------------------
// LfoEditorView: hand-drawn LFO curve with points, bend handles and playhead

const GRID_X = 16, GRID_Y = 4, MAX_POINTS = 32;

class LfoShape {
  constructor() { this.n = 2; this.x = [0, 1]; this.y = [0, 0]; this.c = [0, 0]; }
  static warp(t, c) {
    t = Math.min(1, Math.max(0, t));
    if (c > 1e-4) return Math.pow(t, 1 + c * 6);
    if (c < -1e-4) return 1 - Math.pow(1 - t, 1 - c * 6);
    return t;
  }
  eval(p) {
    p -= Math.floor(p);
    let i = 0;
    const last = this.n - 1;
    while (i < last - 1 && this.x[i + 1] <= p) ++i;
    const x0 = this.x[i], x1 = this.x[i + 1], span = x1 - x0;
    let t = span > 1e-9 ? (p - x0) / span : 1;
    t = LfoShape.warp(t, this.c[i]);
    return this.y[i] + (this.y[i + 1] - this.y[i]) * t;
  }
  sanitize() {
    this.n = Math.min(MAX_POINTS, Math.max(2, this.n));
    const { x, y, c } = this;
    x[0] = 0; x[this.n - 1] = 1;
    for (let i = 1; i < this.n; i++) {
      if (!(x[i] >= x[i - 1])) x[i] = x[i - 1];
      x[i] = Math.min(1, Math.max(0, x[i]));
    }
    x[this.n - 1] = 1;
    for (let i = 0; i < this.n; i++) {
      y[i] = Math.min(1, Math.max(-1, Number.isFinite(y[i]) ? y[i] : 0));
      c[i] = Math.min(1, Math.max(-1, Number.isFinite(c[i]) ? c[i] : 0));
    }
    x.length = y.length = c.length = this.n;
  }
  unpack(a) {
    const n = Math.min(MAX_POINTS, Math.max(2, Math.round(a[0] || 0)));
    if (a.length < 1 + n * 3) return;
    this.n = n;
    this.x = []; this.y = []; this.c = [];
    for (let i = 0; i < n; i++) { this.x.push(a[1 + i * 3]); this.y.push(a[2 + i * 3]); this.c.push(a[3 + i * 3]); }
  }
  pack() {
    const o = new Float32Array(1 + this.n * 3);
    o[0] = this.n;
    for (let i = 0; i < this.n; i++) { o[1 + i * 3] = this.x[i]; o[2 + i * 3] = this.y[i]; o[3 + i * 3] = this.c[i]; }
    return o;
  }
}

export class LfoEditor extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.shape = new LfoShape();
    this.drag = 0;
    this.dragIdx = -1;
    this.hover = -1;
    this.playhead = -1;
  }
  get ctl() { return this.env.ctl; }
  get grid() { return this.ctl.get(LFO_GRID) >= 0.5; }
  attached() {
    this.loadShape();
    this.unsub = watch(this, [LFO_GRID], Dirty.lfo, () => this.loadShape());
    this.env.lfoEditors.add(this);
  }
  removed() { this.unsub(); this.env.lfoEditors.delete(this); }
  loadShape() {
    if (this.drag) return;
    this.shape.unpack(this.ctl.lfoPack());
    this.shape.sanitize();
    this.invalid();
  }
  setPlayhead(ph) {
    if (ph < 0) { if (this.playhead >= 0) { this.playhead = -1; this.invalid(); } return; }
    ph -= Math.floor(ph);
    if (this.playhead >= 0 && Math.abs(ph - this.playhead) < 1e-4) return;
    this.playhead = ph;
    this.invalid();
  }
  get pl() { return 8; } get pr() { return this.w - 8; }
  get pt() { return 8; } get pb() { return this.h - 8; }
  sx(ph) { return this.pl + ph * (this.pr - this.pl); }
  sy(v) { const ym = (this.pt + this.pb) / 2; return ym - v * (this.pb - this.pt) / 2; }
  phaseAt(x) { return Math.min(1, Math.max(0, (x - this.pl) / Math.max(1, this.pr - this.pl))); }
  valAt(y) { const ym = (this.pt + this.pb) / 2; return Math.min(1, Math.max(-1, (ym - y) / Math.max(1, (this.pb - this.pt) / 2))); }
  draw(ctx) {
    const s = this.shape;
    fillRect(ctx, 0, 0, this.w, this.h, theme.panel);
    const { pl, pr, pt, pb } = this;
    const ym = (pt + pb) / 2;
    const grid = this.grid;
    const div = grid ? GRID_X : 4, acc = grid ? GRID_X / 4 : 1;
    ctx.lineCap = 'butt';
    for (let q = 1; q < div; q++) {
      const gx = pl + (pr - pl) * q / div;
      line(ctx, gx, pt, gx, pb, q % acc === 0 ? theme.grid : rgba(theme.grid, 130), 1);
    }
    if (grid) {
      for (let h = 1 - GRID_Y; h < GRID_Y; h++) {
        if (h === 0) continue;
        const gy = ym - h / GRID_Y * (pb - pt) * 0.5;
        line(ctx, pl, gy, pr, gy, (h * 2) % GRID_Y === 0 ? theme.grid : rgba(theme.grid, 130), 1);
      }
    }
    line(ctx, pl, ym, pr, ym, rgba(theme.ink, 40), 1);
    const N = 160;
    const pts = [];
    for (let i = 0; i <= N; i++) { const ph = i / N; pts.push([pl + ph * (pr - pl), ym - s.eval(ph) * (pb - pt) * 0.5]); }
    ctx.beginPath();
    ctx.moveTo(pl, ym);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(pr, ym);
    ctx.closePath();
    ctx.fillStyle = rgba(theme.accent, 30);
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    for (let i = 0; i < s.n - 1; i++) {
      if (s.x[i + 1] - s.x[i] < 1e-3) continue;
      const mx = (s.x[i] + s.x[i + 1]) / 2;
      const hx = pl + mx * (pr - pl), hy = ym - s.eval(mx) * (pb - pt) * 0.5;
      strokeEllipse(ctx, hx - 2.5, hy - 2.5, 5, 5, rgba(theme.ink, 90), 1);
    }
    for (let i = 0; i < s.n; i++) {
      const rr = i === this.hover ? 4.5 : 3.5;
      const px = pl + s.x[i] * (pr - pl), py = ym - s.y[i] * (pb - pt) * 0.5;
      fillEllipse(ctx, px - rr, py - rr, 2 * rr, 2 * rr, theme.accent);
      strokeEllipse(ctx, px - rr, py - rr, 2 * rr, 2 * rr, theme.bg, 1);
    }
    if (this.playhead >= 0) {
      const px = pl + this.playhead * (pr - pl);
      ctx.lineCap = 'butt';
      line(ctx, px, pt, px, pb, rgba(theme.accent, 120), 1);
      const py = ym - s.eval(this.playhead) * (pb - pt) * 0.5;
      fillEllipse(ctx, px - 3, py - 3, 6, 6, theme.ink);
    }
  }
  hitPoint(x, y) {
    const s = this.shape;
    let best = -1, bd = 49;
    for (let i = 0; i < s.n; i++) {
      const dx = x - this.sx(s.x[i]), dy = y - this.sy(s.y[i]);
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  hitCurve(x, y) {
    const s = this.shape;
    for (let i = 0; i < s.n - 1; i++) {
      if (s.x[i + 1] - s.x[i] < 1e-3) continue;
      const mx = (s.x[i] + s.x[i + 1]) / 2;
      const dx = x - this.sx(mx), dy = y - this.sy(s.eval(mx));
      if (dx * dx + dy * dy < 6.5 * 6.5) return i;
    }
    return -1;
  }
  snapping(shift) { return this.grid !== shift; }
  movePoint(i, x, y, snap) {
    const s = this.shape;
    let px = this.phaseAt(x), py = this.valAt(y);
    if (snap) { px = Math.round(px * GRID_X) / GRID_X; py = Math.round(py * GRID_Y) / GRID_Y; }
    if (i === 0) s.x[0] = 0;
    else if (i === s.n - 1) s.x[i] = 1;
    else s.x[i] = Math.min(s.x[i + 1], Math.max(s.x[i - 1], px));
    s.y[i] = py;
    this.hover = i;
  }
  bendCurve(i, y) {
    const s = this.shape;
    const y0 = s.y[i], y1 = s.y[i + 1];
    if (Math.abs(y1 - y0) < 1e-3) { s.c[i] = 0; return; }
    let frac = (this.valAt(y) - y0) / (y1 - y0);
    frac = Math.min(0.97, Math.max(0.03, frac));
    const l2 = Math.log(0.5);
    const c = frac < 0.5 ? ((Math.log(frac) / l2) - 1) / 6 : (1 - (Math.log(1 - frac) / l2)) / 6;
    s.c[i] = Math.min(1, Math.max(-1, c));
  }
  addPoint(x, y, snap) {
    const s = this.shape;
    if (s.n >= MAX_POINTS) return;
    let px = this.phaseAt(x), py = this.valAt(y);
    if (snap) { px = Math.round(px * GRID_X) / GRID_X; py = Math.round(py * GRID_Y) / GRID_Y; }
    let i = 1;
    while (i < s.n && s.x[i] < px) ++i;
    s.x.splice(i, 0, px); s.y.splice(i, 0, py); s.c.splice(i, 0, 0);
    s.c[i - 1] = 0;
    s.n++;
    this.hover = i;
  }
  removePoint(i) {
    const s = this.shape;
    if (i <= 0 || i >= s.n - 1 || s.n <= 2) return;
    s.x.splice(i, 1); s.y.splice(i, 1); s.c.splice(i, 1);
    s.n--;
    this.hover = -1;
  }
  edited() {
    this.shape.sanitize();
    this.invalid();
    const d = this.drag;
    this.drag = 0;          // let the controller's echo through, then restore
    this.ctl.lfoEdited(this.shape.pack());
    this.drag = d;
  }
  onMouseDown(e) {
    const pi = this.hitPoint(e.x, e.y);
    if ((e.doubleClick && pi >= 0) || (e.right && pi >= 0)) { this.removePoint(pi); this.edited(); return true; }
    if (e.doubleClick) { this.addPoint(e.x, e.y, this.snapping(e.shift)); this.edited(); return true; }
    if (e.right) return true;
    if (pi >= 0) { this.drag = 1; this.dragIdx = pi; return true; }
    const si = this.hitCurve(e.x, e.y);
    if (si >= 0) { this.drag = 2; this.dragIdx = si; return true; }
    return true;
  }
  onHover(e) {
    const h = this.hitPoint(e.x, e.y);
    if (h !== this.hover) { this.hover = h; this.invalid(); }
  }
  onLeave() { if (this.hover !== -1) { this.hover = -1; this.invalid(); } }
  onMouseMove(e) {
    if (!this.drag) return;
    if (this.drag === 1) this.movePoint(this.dragIdx, e.x, e.y, this.snapping(e.shift));
    else this.bendCurve(this.dragIdx, e.y);
    this.edited();
  }
  onMouseUp() {
    if (!this.drag) return;
    this.drag = 0;
    this.dragIdx = -1;
    this.edited();
  }
}
