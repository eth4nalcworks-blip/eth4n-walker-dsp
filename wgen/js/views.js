// The display: the whole table as a stack of frames (views/table_view.h).

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
// The table as a receding stack of frames, front = frame 1. The selected frame
// is drawn in orange; while a note plays, the frame it is reading is lit too.
export class TableView {
  constructor(cv) {
    this.cv = cv;
    this.data = null;
    this.frames = 1;
    this.sel = 0;
    this.live = -1;
    new ResizeObserver(() => this.draw()).observe(cv);
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
