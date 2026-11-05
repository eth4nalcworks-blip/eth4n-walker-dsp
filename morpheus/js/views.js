// The displays, on canvas: one frame as a waveform or as harmonic bars
// (views/wave_view.h), the whole table as a stack of frames (views/table_view.h),
// and the import range picker's overview (views/import_view.h).

const C = { bg: '#1a1a1a', grid: '#262626', line: '#3a3a3a', dim: '#7a7a7a', fg: '#d9d9d9', accent: '#ff6b1a', ink: '#0d0d0d' };
export const FRAME = 2048;

function fit(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h, dpr, ctx: cv.getContext('2d') };
}

//-----------------------------------------------------------------------------
export class WaveView {
  constructor(cv) {
    this.cv = cv;
    this.mode = 'wave';
    this.frame = null;     // Float32Array(2048)
    this.mags = null;      // Float32Array(1025)
    new ResizeObserver(() => this.draw()).observe(cv);
  }
  setFrame(f) { this.frame = f; if (this.mode === 'wave') this.draw(); }
  setMags(m) { this.mags = m; if (this.mode === 'harm') this.draw(); }

  draw() {
    const { w, h, dpr, ctx } = fit(this.cv);
    ctx.clearRect(0, 0, w, h);
    const pad = 6 * dpr;
    ctx.lineWidth = dpr;
    if (this.mode === 'wave') {
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(0, Math.round(h / 2) + 0.5); ctx.lineTo(w, Math.round(h / 2) + 0.5); ctx.stroke();
      for (let q = 1; q < 4; q++) {
        const x = Math.round((w * q) / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      if (!this.frame) return;
      const f = this.frame;
      let peak = 1e-9;
      for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
      const g = peak > 1 ? 1 / peak : 1;
      const mid = h / 2, amp = h / 2 - pad;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        // min / max per pixel column, so a dense frame does not alias into lies
        const a = Math.floor((x / w) * f.length), b = Math.max(a + 1, Math.floor(((x + 1) / w) * f.length));
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < b; i++) { lo = Math.min(lo, f[i]); hi = Math.max(hi, f[i]); }
        const y0 = mid - hi * g * amp, y1 = mid - lo * g * amp;
        if (x === 0) ctx.moveTo(x, y0); else ctx.lineTo(x, y0);
        if (y1 - y0 > 1) ctx.lineTo(x, y1);
      }
      ctx.stroke();
    } else {
      // harmonic bars on a log axis, the same drawing as the site's Home spectrum
      const m = this.mags;
      const N = 1024, FLOOR = -60;
      const xOf = (n) => pad + (Math.log(n) / Math.log(N)) * (w - 2 * pad);
      ctx.strokeStyle = C.grid;
      ctx.fillStyle = C.dim;
      ctx.font = `${9 * dpr}px "Geist Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      const axis = 16 * dpr, base = h - axis;
      for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
        const x = Math.round(xOf(n)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, base); ctx.stroke();
        ctx.fillText(String(n), x, h - 4 * dpr);
      }
      if (!m) return;
      let top = 1e-9;
      for (let n = 1; n <= N; n++) top = Math.max(top, m[n]);
      ctx.strokeStyle = C.accent;
      let prevX = -Infinity;
      for (let n = 1; n <= N; n++) {
        const db = 20 * Math.log10(Math.max(m[n] / top, 1e-6));
        const k = (db - FLOOR) / -FLOOR;
        if (k <= 0) continue;
        const x = Math.round(xOf(n)) + 0.5;
        ctx.globalAlpha = (0.35 + 0.65 * k) * Math.min(1, (x - prevX) / (3 * dpr));
        prevX = x;
        ctx.lineWidth = (n <= 4 ? 3 : 1) * dpr;
        ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - k * (base - pad)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}

//-----------------------------------------------------------------------------
// The table as a receding stack of frames, front = frame 1. The selected frame
// is drawn in orange; while a note plays, the frame it is reading is lit too.
export class TableView {
  constructor(cv, onPick) {
    this.cv = cv;
    this.data = null;
    this.frames = 1;
    this.sel = 0;
    this.live = -1;
    this.onPick = onPick;
    new ResizeObserver(() => this.draw()).observe(cv);
    const pick = (e) => {
      if (!this.data) return;
      const r = cv.getBoundingClientRect();
      const g = this.geom(r.width, r.height, 1);
      // nearest frame by its baseline
      const t = (g.y0 - (e.clientY - r.top)) / (g.y0 - g.y1);
      const f = Math.round(Math.min(1, Math.max(0, t)) * (this.frames - 1));
      this.onPick?.(f);
    };
    let down = false;
    cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); pick(e); });
    cv.addEventListener('pointermove', (e) => { if (down) pick(e); });
    cv.addEventListener('pointerup', () => { down = false; });
    cv.addEventListener('pointercancel', () => { down = false; });
  }
  setTable(data, frames) { this.data = data; this.frames = frames; this.sel = Math.min(this.sel, frames - 1); this.draw(); }
  setSelected(f) { this.sel = f; this.draw(); }
  setLive(f) { if (f !== this.live) { this.live = f; this.draw(); } }

  geom(w, h, dpr) {
    const pad = 8 * dpr;
    const depthX = w * 0.18, depthY = h * 0.5;
    const fw = w - 2 * pad - depthX;
    const amp = (h - 2 * pad - depthY) * 0.5;
    const x0 = pad, y0 = h - pad - amp;          // front frame's baseline
    return { pad, depthX, depthY, fw, amp, x0, y0, y1: y0 - depthY };
  }

  draw() {
    const { w, h, dpr, ctx } = fit(this.cv);
    ctx.clearRect(0, 0, w, h);
    if (!this.data) return;
    const g = this.geom(w, h, dpr);
    const F = this.frames;
    let peak = 1e-9;
    for (let i = 0; i < this.data.length; i += 7) peak = Math.max(peak, Math.abs(this.data[i]));
    const gain = peak > 1 ? 1 / peak : 1;
    // at most ~48 lines, always including the first and last frames
    const lines = Math.min(F, 48);
    const idx = new Set();
    for (let j = 0; j < lines; j++) idx.add(lines > 1 ? Math.round((j * (F - 1)) / (lines - 1)) : 0);
    idx.add(this.sel);
    if (this.live >= 0) idx.add(this.live);
    const order = [...idx].sort((a, b) => b - a);   // back to front
    const cols = Math.max(64, Math.min(512, Math.round(g.fw / dpr)));
    for (const f of order) {
      const t = F > 1 ? f / (F - 1) : 0;
      const ox = g.x0 + t * g.depthX, oy = g.y0 - t * g.depthY;
      const frame = this.data.subarray(f * FRAME, f * FRAME + FRAME);
      const hot = f === this.sel || f === this.live;
      ctx.strokeStyle = f === this.sel ? C.accent : f === this.live ? C.fg : C.line;
      ctx.globalAlpha = hot ? 1 : 0.35 + 0.65 * (1 - t);
      ctx.lineWidth = (hot ? 1.6 : 1) * dpr;
      // fill under the line in the plate colour, so nearer frames hide farther ones
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const i = Math.min(FRAME - 1, Math.floor((c / cols) * FRAME));
        const x = ox + (c / cols) * g.fw, y = oy - frame[i] * gain * g.amp;
        if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (!hot && lines > 8) {
        ctx.save();
        ctx.lineTo(ox + g.fw, oy + g.amp);
        ctx.lineTo(ox, oy + g.amp);
        ctx.closePath();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.bg;
        ctx.fill();
        ctx.restore();
        // redraw the line itself over its own fill
        ctx.beginPath();
        for (let c = 0; c <= cols; c++) {
          const i = Math.min(FRAME - 1, Math.floor((c / cols) * FRAME));
          const x = ox + (c / cols) * g.fw, y = oy - frame[i] * gain * g.amp;
          if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

//-----------------------------------------------------------------------------
// The import range picker's overview: the file's envelope, the selection
// between two handles, and where the frames will be cut from.
export class RangeView {
  constructor(cv, onChange) {
    this.cv = cv;
    this.samples = null;
    this.begin = 0;
    this.end = 1;
    this.onChange = onChange;
    new ResizeObserver(() => this.draw()).observe(cv);
    let grab = null;
    const at = (e) => {
      const r = cv.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const x = at(e);
      grab = Math.abs(x - this.begin) < Math.abs(x - this.end) ? 'begin' : 'end';
      this.move(grab, x);
    });
    cv.addEventListener('pointermove', (e) => { if (grab) this.move(grab, at(e)); });
    const up = () => { if (grab) { grab = null; this.onChange?.(this.begin, this.end, true); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }
  move(which, x) {
    const gap = 0.002;
    if (which === 'begin') this.begin = Math.min(x, this.end - gap);
    else this.end = Math.max(x, this.begin + gap);
    this.draw();
    this.onChange?.(this.begin, this.end, false);
  }
  set(samples, begin, end) { this.samples = samples; this.begin = begin; this.end = end; this.draw(); }

  draw() {
    const { w, h, dpr, ctx } = fit(this.cv);
    ctx.clearRect(0, 0, w, h);
    const s = this.samples;
    if (!s || !s.length) return;
    let peak = 1e-9;
    for (let i = 0; i < s.length; i += 16) peak = Math.max(peak, Math.abs(s[i]));
    const mid = h / 2, amp = h / 2 - 6 * dpr;
    const bx = this.begin * w, ex = this.end * w;
    ctx.fillStyle = 'rgba(255,107,26,.10)';
    ctx.fillRect(bx, 0, ex - bx, h);
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * s.length), b = Math.max(a + 1, Math.floor(((x + 1) / w) * s.length));
      let lo = 0, hi = 0;
      const step = Math.max(1, Math.floor((b - a) / 64));
      for (let i = a; i < b; i += step) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); }
      ctx.fillStyle = x >= bx && x <= ex ? C.accent : C.line;
      ctx.fillRect(x, mid - (hi / peak) * amp, 1, Math.max(1, ((hi - lo) / peak) * amp));
    }
    ctx.fillStyle = C.fg;
    ctx.fillRect(Math.round(bx) - dpr, 0, 2 * dpr, h);
    ctx.fillRect(Math.round(ex) - dpr, 0, 2 * dpr, h);
  }
}
