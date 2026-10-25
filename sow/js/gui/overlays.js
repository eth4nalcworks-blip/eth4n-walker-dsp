// The options panel (port of options_view.h), opened by clicking the logo:
// a modal overlay over the whole editor.

import { View, theme, font, drawText, roundRectPath, line, fillRect } from './core.js';

const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function drawX(c, r, col = theme.dim) {
  c.lineCap = 'butt';
  line(c, r.x + 4, r.y + 4, r.x + r.w - 4, r.y + r.h - 4, col, 1.6);
  line(c, r.x + r.w - 4, r.y + 4, r.x + 4, r.y + r.h - 4, col, 1.6);
}

class Overlay extends View {
  constructor(root) {
    super(0, 0, root.w, root.h);
    this.modal = true;
  }
  hit() { return true; }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
    if (this.root) this.root.removeOverlay(this);
  }
}

// ---------------------------------------------------------------------------

export class OptionsView extends Overlay {
  constructor(root, version) {
    super(root);
    this.version = version;
    this.hover = -1;
  }
  get panel() { return { x: (this.w - 500) / 2, y: (this.h - 210) / 2, w: 500, h: 210 }; }
  get xRect() { const p = this.panel; return { x: p.x + p.w - 36, y: p.y + 16, w: 20, h: 20 }; }
  draw(c) {
    fillRect(c, 0, 0, this.w, this.h, 'rgba(0,0,0,0.745)');
    const p = this.panel;
    roundRectPath(c, p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, 8);
    c.fillStyle = theme.panel;
    c.fill();
    c.strokeStyle = theme.cardEdge;
    c.lineWidth = 1;
    c.stroke();
    fillRect(c, p.x + 20, p.y + 20, 3, 14, theme.accent);
    drawText(c, 'OPTIONS', p.x + 32, p.y + 16, p.w - 72, 22, 'left', font(15, true), theme.ink);
    drawText(c, this.version, p.x + 24, p.y + 60, p.w - 48, 24, 'left', font(11), theme.dim);
    drawText(c, 'Walker dsp', p.x + 24, p.y + 88, p.w - 48, 22, 'left', font(11), theme.accentDim);
    drawText(c, 'SOW (SIREN ON WEB) runs the plug-in’s own engine in this page.', p.x + 24, p.y + 140, p.w - 48, 18, 'left', font(11), theme.dim);
    drawText(c, 'Presets and audio export are not included.', p.x + 24, p.y + 160, p.w - 48, 18, 'left', font(11), theme.dim);
    drawX(c, this.xRect, this.hover === 1 ? theme.ink : theme.dim);
  }
  onHover(e) {
    const h = inside(this.xRect, e.x, e.y) ? 1 : -1;
    if (h !== this.hover) { this.hover = h; this.root.invalidRect(0, 0, this.w, this.h); }
  }
  onMouseDown(e) {
    if (e.right) return true;
    if (inside(this.xRect, e.x, e.y) || !inside(this.panel, e.x, e.y)) this.close();
    return true;
  }
}
