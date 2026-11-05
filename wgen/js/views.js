// The display: the whole table as a stack of frames (views/table_view.h).

const C = { bg: '#1a1a1a', line: '#3a3a3a', fg: '#d9d9d9', accent: '#ff6b1a' };
export const FRAME = 2048;

//-----------------------------------------------------------------------------
// The table as a receding stack of frames, front = frame 1, which is drawn in
// orange; while a note plays, the frame it is reading is lit too.
//
// The stack itself only changes with the table or the size, so it is drawn once
// into a layer of its own. Following a note then costs one copy of that layer
// and one line, not ~48 filled frames redrawn thirty times a second, and every
// redraw waits for the next animation frame, so a burst of updates draws once.
export class TableView {
  constructor(cv) {
    this.cv = cv;
    this.ctx = cv.getContext('2d');
    this.base = document.createElement('canvas');
    this.data = null;
    this.frames = 1;
    this.live = -1;
    this.stale = true;   // the layer needs drawing again
    this.queued = 0;
    new ResizeObserver(() => { this.stale = true; this.invalidate(); }).observe(cv);
  }

  setTable(data, frames) {
    this.data = data;
    this.frames = frames;
    let peak = 1e-9;
    for (let i = 0; i < data.length; i += 7) peak = Math.max(peak, Math.abs(data[i]));
    this.gain = peak > 1 ? 1 / peak : 1;
    this.stale = true;
    this.invalidate();
  }
  setLive(f) {
    if (f === this.live) return;
    this.live = f;
    this.invalidate();
  }
  invalidate() {
    if (!this.queued) this.queued = requestAnimationFrame(() => { this.queued = 0; this.draw(); });
  }

  geom(w, h, dpr) {
    const pad = 8 * dpr;
    const depthX = w * 0.18, depthY = h * 0.5;
    const fw = w - 2 * pad - depthX;
    const amp = (h - 2 * pad - depthY) * 0.5;
    const x0 = pad, y0 = h - pad - amp;          // front frame's baseline
    return { dpr, pad, depthX, depthY, fw, amp, x0, y0 };
  }

  // one frame's line, as a path that can be both filled and stroked
  trace(f, g) {
    const t = this.frames > 1 ? f / (this.frames - 1) : 0;
    const ox = g.x0 + t * g.depthX, oy = g.y0 - t * g.depthY;
    const frame = this.data.subarray(f * FRAME, f * FRAME + FRAME);
    const cols = this.cols, at = this.colIndex, k = this.gain * g.amp;
    const p = new Path2D();
    p.moveTo(ox, oy - frame[at[0]] * k);
    for (let c = 1; c <= cols; c++) p.lineTo(ox + (c / cols) * g.fw, oy - frame[at[c]] * k);
    return { p, t, ox, oy };
  }

  drawBase(w, h, g) {
    const b = this.base;
    if (b.width !== w || b.height !== h) { b.width = w; b.height = h; }
    const ctx = b.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const F = this.frames;
    const cols = Math.max(64, Math.min(512, Math.round(g.fw / g.dpr)));
    if (cols !== this.cols) {
      this.cols = cols;
      this.colIndex = Int32Array.from({ length: cols + 1 }, (_, c) => Math.min(FRAME - 1, Math.floor((c / cols) * FRAME)));
    }
    // at most ~48 lines, always including the first and last frames, back to front
    const lines = Math.min(F, 48);
    const idx = new Set();
    for (let j = 0; j < lines; j++) idx.add(lines > 1 ? Math.round((j * (F - 1)) / (lines - 1)) : 0);
    const order = [...idx].sort((a, b) => b - a);
    for (const f of order) {
      const { p, t, ox, oy } = this.trace(f, g);
      const front = f === 0;
      if (!front && lines > 8) {
        // filled under the line in the plate colour, so nearer frames hide farther ones
        const area = new Path2D(p);
        area.lineTo(ox + g.fw, oy + g.amp);
        area.lineTo(ox, oy + g.amp);
        area.closePath();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.bg;
        ctx.fill(area);
      }
      ctx.strokeStyle = front ? C.accent : C.line;
      ctx.globalAlpha = front ? 1 : 0.35 + 0.65 * (1 - t);
      ctx.lineWidth = (front ? 1.6 : 1) * g.dpr;
      ctx.stroke(p);
    }
    ctx.globalAlpha = 1;
    this.stale = false;
  }

  draw() {
    const cv = this.cv, ctx = this.ctx;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; this.stale = true; }
    ctx.clearRect(0, 0, w, h);
    if (!this.data) return;
    const g = this.geom(w, h, dpr);
    if (this.stale) this.drawBase(w, h, g);
    ctx.drawImage(this.base, 0, 0);
    if (this.live > 0 && this.live < this.frames) {
      ctx.strokeStyle = C.fg;
      ctx.lineWidth = 1.6 * dpr;
      ctx.stroke(this.trace(this.live, g).p);
    }
  }
}
