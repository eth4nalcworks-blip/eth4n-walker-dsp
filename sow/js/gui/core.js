// GUI core: a small VSTGUI-like view system on one canvas.
//
//   View        rect in parent coordinates, draw(ctx), mouse handlers, invalid()
//   Container   children, background colour
//   Root        the 1200x760 frame: owns the canvas, redraws the dirty region,
//               routes pointer / wheel / keyboard, hosts overlays (popups,
//               browsers) and the in-app drag used for modulation assignment.
//
// Coordinates are editor points (the plug-in's own 1200x760 space). The canvas
// backing store is sized to the on-screen scale * devicePixelRatio, so the whole
// editor stays crisp at any window size.

// ---------------------------------------------------------------------------
// Colour. VSTGUI on macOS hands its CColor values to CoreGraphics in the main
// display's colour space, untouched: on a Mac display (P3 primaries, ~2.2 gamma)
// SIREN's #2a8a82 is the display's own 42/138/130 -- deeper than the same hex in
// a browser, which treats it as sRGB. To look like the plug-in on that screen,
// every colour is re-expressed as the P3 colour the display would show for the
// raw value: P3 primaries, the 2.2 curve re-encoded with sRGB's transfer
// function (which is what CSS display-p3 uses). Without a display-p3 canvas it
// falls back to the same colour converted (and clipped) to sRGB.
//
// The CSS colour alone is not enough: Firefox parses color(display-p3 ...) but
// has no display-p3 canvas, and its ImageData takes no settings argument (it
// reads new ImageData(w, h, {...}) as the (data, w, h) form and throws), so the
// canvas itself is asked.
function canvasP3() {
  try {
    if (!(typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', 'color(display-p3 0 0 0)'))) return false;
    const x = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    if (!x || !x.getContextAttributes || x.getContextAttributes().colorSpace !== 'display-p3') return false;
    return new ImageData(1, 1, { colorSpace: 'display-p3' }).colorSpace === 'display-p3';
  } catch {
    return false;
  }
}
export const P3 = canvasP3();
const srgbEnc = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const lin22 = (v) => Math.pow(v / 255, 2.2);
const P3_TO_SRGB = [[1.2249, -0.2247, 0], [-0.0420, 1.0419, 0], [-0.0197, -0.0786, 1.0979]];

// raw display value (0..255 per channel) -> [r, g, b] in 0..1 for the output space
export function screenRgb(r, g, b) {
  const l = [lin22(r), lin22(g), lin22(b)];
  if (P3) return l.map(srgbEnc);
  return P3_TO_SRGB.map((row) => srgbEnc(Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))));
}

const cache = new Map();
const back = new Map();   // css string -> '#rrggbb' (so rgba(theme.x, a) works)
function css(r, g, b, a) {
  const key = (r << 16 | g << 8 | b) * 256 + a;
  let s = cache.get(key);
  if (s) return s;
  const [x, y, z] = screenRgb(r, g, b).map((v) => v.toFixed(4));
  const al = (a / 255).toFixed(4);
  s = P3 ? `color(display-p3 ${x} ${y} ${z} / ${al})` : `rgba(${Math.round(x * 255)},${Math.round(y * 255)},${Math.round(z * 255)},${al})`;
  cache.set(key, s);
  return s;
}

// '#rrggbb' / '#rrggbbaa' (or a colour returned by this module) + optional
// 0..255 alpha override -> canvas / CSS colour
export function rgba(c, a) {
  const hex = c.startsWith('#') ? c : back.get(c);
  if (!hex) return c;
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const al = a !== undefined ? a : h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  const s = css(r, g, b, Math.round(al));
  if (!back.has(s)) back.set(s, '#' + h.slice(0, 6));
  return s;
}
export const rgb = (r, g, b) => rgba('#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));

const RAW = {
  bg: '#0e0f13', field: '#0b0c10', panel: '#14161c', panelHi: '#1b1e27', grid: '#23262e',
  ink: '#e8eaf0', dim: '#696f7c', accent: '#45e0d2', accentDim: '#2a8a82', off: '#3a3f4a',
  mod: '#ff9f43', modDim: '#8a5c28',
  cardTop: '#212530', cardBot: '#14161d', cardEdge: '#333845', knob: '#0f1116', knobEdge: '#303540',
  track: '#2e333e',
};
export const theme = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, rgba(v)]));
export const themeHex = RAW;

// bitmaps get the same treatment: their pixels are raw display values as well
export function screenImage(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const opts = P3 ? { colorSpace: 'display-p3' } : undefined;
  const x = c.getContext('2d', opts);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sx = src.getContext('2d');
  sx.drawImage(img, 0, 0);
  const d = sx.getImageData(0, 0, w, h).data;
  const lut = new Array(256);
  const out = P3 ? new ImageData(w, h, { colorSpace: 'display-p3' }) : new ImageData(w, h);
  const o = out.data;
  if (P3) for (let v = 0; v < 256; v++) lut[v] = Math.round(srgbEnc(lin22(v)) * 255);
  for (let i = 0; i < d.length; i += 4) {
    if (P3) { o[i] = lut[d[i]]; o[i + 1] = lut[d[i + 1]]; o[i + 2] = lut[d[i + 2]]; }
    else {
      const [r, g, b] = screenRgb(d[i], d[i + 1], d[i + 2]);
      o[i] = r * 255; o[i + 1] = g * 255; o[i + 2] = b * 255;
    }
    o[i + 3] = d[i + 3];
  }
  x.putImageData(out, 0, 0);
  return c;
}

export const FONT_FAMILY = 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif';
export function font(size, bold) {
  return `${bold ? 'bold ' : ''}${size}px ${FONT_FAMILY}`;
}

// VSTGUI's drawString(text, rect, align): vertically centred on the rect using
// the font's cap height, horizontally left / centre / right.
// ---------------------------------------------------------------------------
// VSTGUI's CoreGraphics context (integral mode, the default) snaps the points of
// lines, rects, ellipses and text to device pixels, and shifts strokes of an odd
// integer width by half a point so they land on whole pixels. Graphics paths in
// anti-aliasing mode (cards, round rects, arcs) are drawn where they are.

// a local point snapped to the device pixel grid of the current transform
export function snap(ctx, x, y) {
  const m = ctx.getTransform();
  return [(Math.round(m.a * x + m.e) - m.e) / m.a, (Math.round(m.d * y + m.f) - m.f) / m.d];
}
function snapRect(ctx, x, y, w, h) {
  const m = ctx.getTransform();
  const x0 = Math.round(m.a * x + m.e), y0 = Math.round(m.d * y + m.f);
  return [(x0 - m.e) / m.a, (y0 - m.f) / m.d, Math.round(m.a * w) / m.a, Math.round(m.d * h) / m.d];
}
const oddWidth = (w) => Number.isInteger(w) && w % 2 === 1;

// drawString(text, rect, align): baseline at the rect's middle + half the cap
// height, left / centre / right, the start point snapped to the pixel grid
export function drawText(ctx, text, x, y, w, h, align = 'center', fontSpec, color) {
  if (fontSpec) ctx.font = fontSpec;
  if (color) ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const cap = capHeight(ctx);
  const by = y + h / 2 + cap / 2;
  const tw = ctx.measureText(text).width;
  let tx = x;
  if (align === 'center') tx = x + (w - tw) / 2;
  else if (align === 'right') tx = x + w - tw;
  const [px, py] = snap(ctx, tx, by);
  ctx.fillText(text, px, py);
  return tw;
}
const capCache = new Map();
function capHeight(ctx) {
  let c = capCache.get(ctx.font);
  if (c === undefined) {
    const m = ctx.measureText('X');
    c = m.actualBoundingBoxAscent || parseFloat(ctx.font.replace('bold ', '')) * 0.716;
    capCache.set(ctx.font, c);
  }
  return c;
}

// drawString(text, point): baseline at the point
export function drawTextAt(ctx, text, x, y, fontSpec, color) {
  if (fontSpec) ctx.font = fontSpec;
  if (color) ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const [px, py] = snap(ctx, x, y);
  ctx.fillText(text, px, py);
}

export function textWidth(ctx, text, fontSpec) {
  if (fontSpec) ctx.font = fontSpec;
  return ctx.measureText(text).width;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// polyline arc with round caps (the knob style; a path, so not snapped)
export function arc(ctx, cx, cy, rad, a0, a1, color, w) {
  if (a1 - a0 < 1e-4) return;
  const seg = Math.max(6, Math.floor(Math.abs(a1 - a0) / (Math.PI / 48)));
  ctx.beginPath();
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (a1 - a0) * i / seg;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// CDrawContext::drawLine (butt caps unless the caller set others)
export function line(ctx, x0, y0, x1, y1, color, w = 1) {
  let [ax, ay] = snap(ctx, x0, y0);
  let [bx, by] = snap(ctx, x1, y1);
  if (oddWidth(w)) { ax += 0.5; ay += 0.5; bx += 0.5; by += 0.5; }
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

// CDrawContext::drawRect(kDrawStroked): one point smaller, snapped, odd widths +0.5
export function strokeRect(ctx, x, y, w, h, color, lw = 1) {
  let [rx, ry, rw, rh] = snapRect(ctx, x, y, w - 1, h - 1);
  if (oddWidth(lw)) { rx += 0.5; ry += 0.5; }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.strokeRect(rx, ry, rw, rh);
}

// CDrawContext::drawRect(kDrawFilled)
export function fillRect(ctx, x, y, w, h, color) {
  const [rx, ry, rw, rh] = snapRect(ctx, x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(rx, ry, rw, rh);
}

// CDrawContext::drawEllipse(rect, kDrawFilled / kDrawStroked)
export function fillEllipse(ctx, x, y, w, h, color) {
  const [rx, ry, rw, rh] = snapRect(ctx, x, y, w, h);
  ctx.beginPath();
  ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}
export function strokeEllipse(ctx, x, y, w, h, color, lw = 1) {
  let [rx, ry, rw, rh] = snapRect(ctx, x, y, w - 1, h - 1);
  if (oddWidth(lw)) { rx += 0.5; ry += 0.5; }
  ctx.beginPath();
  ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.max(0, rw / 2), Math.max(0, rh / 2), 0, 0, 2 * Math.PI);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

// ---------------------------------------------------------------------------

export class View {
  constructor(x = 0, y = 0, w = 0, h = 0) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.parent = null;
    this.visible = true;
    this.mouseEnabled = true;
  }
  get root() { let v = this; while (v.parent) v = v.parent; return v instanceof Root ? v : null; }
  // absolute (editor) position
  absX() { let x = this.x, p = this.parent; while (p) { x += p.x; p = p.parent; } return x; }
  absY() { let y = this.y, p = this.parent; while (p) { y += p.y; p = p.parent; } return y; }
  invalid() {
    const r = this.root;
    if (r && this.visible) r.invalidRect(this.absX() - 8, this.absY() - 8, this.w + 16, this.h + 16);
  }
  draw(_ctx) {}
  hit(px, py) { return px >= 0 && py >= 0 && px < this.w && py < this.h; }
  // mouse handlers get LOCAL coordinates; return true when handled
  onMouseDown(_e) { return false; }
  onMouseMove(_e) {}
  onMouseUp(_e) {}
  onHover(_e) {}
  onLeave() {}
  onWheel(_e) { return false; }
  onDoubleClick(e) { return this.onMouseDown(e); }
  attached() {}
  removed() {}
}

export class Container extends View {
  constructor(x, y, w, h) {
    super(x, y, w, h);
    this.children = [];
    this.background = null;   // css colour or null (transparent)
  }
  add(v) { v.parent = this; this.children.push(v); if (this.root) attachTree(v); return v; }
  removeAll() {
    for (const c of this.children) detachTree(c);
    this.children = [];
  }
  drawBackground(ctx) {
    if (this.background) fillRect(ctx, 0, 0, this.w, this.h, this.background);
  }
  draw(ctx) { this.drawBackground(ctx); }
}

function attachTree(v) {
  // children added by attached() itself (a view switch building its template)
  // are attached by add(); only the ones that were already there are walked
  const kids = v.children ? [...v.children] : null;
  v.attached();
  if (kids) for (const c of kids) attachTree(c);
}
function detachTree(v) {
  if (v.children) for (const c of v.children) detachTree(c);
  v.removed();
}

// ---------------------------------------------------------------------------

export class Root extends Container {
  constructor(canvas, w, h) {
    super(0, 0, w, h);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', P3 ? { colorSpace: 'display-p3' } : undefined);
    this.overlays = [];        // topmost views (popups, browsers): get events first
    this.dirty = null;         // [x0,y0,x1,y1] union of invalidated rects
    this.scale = 1;
    this.capture = null;       // view that owns the current pointer gesture
    this.hover = null;
    this.drag = null;          // in-app drag: { payload, label, x, y, target }
    this.lastClick = { t: -Infinity, x: 0, y: 0, view: null };
    this.cursor = 'default';
    this.timers = new Set();   // per-frame callbacks (VSTGUI timers)
    this.domLayer = null;      // element over the canvas for real text inputs
    this.installEvents();
    this.installFileDrop();
  }

  setScale(s) {
    const dpr = window.devicePixelRatio || 1;
    this.scale = s;
    const k = s * dpr;
    this.canvas.width = Math.round(this.w * k);
    this.canvas.height = Math.round(this.h * k);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.pixelScale = k;
    this.invalidRect(0, 0, this.w, this.h);
  }

  invalidRect(x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    if (!this.dirty) this.dirty = [x0, y0, x1, y1];
    else {
      const d = this.dirty;
      d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0);
      d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1);
    }
  }

  addOverlay(v) { v.parent = this; this.overlays.push(v); attachTree(v); this.invalidRect(0, 0, this.w, this.h); return v; }
  removeOverlay(v) {
    const i = this.overlays.indexOf(v);
    if (i >= 0) { this.overlays.splice(i, 1); detachTree(v); if (this.capture === v) this.capture = null; }
    this.invalidRect(0, 0, this.w, this.h);
  }

  // per-frame work + redraw of the dirty region
  frame(now) {
    for (const t of this.timers) t(now);
    if (!this.dirty) return;
    const [x0, y0, x1, y1] = this.dirty;
    this.dirty = null;
    const ctx = this.ctx;
    ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    this.paintTree(ctx, this, 0, 0, x0, y0, x1, y1);
    for (const o of this.overlays) this.paintTree(ctx, o, 0, 0, x0, y0, x1, y1);
    if (this.drag) this.paintDragGhost(ctx);
    ctx.restore();
  }

  paintTree(ctx, v, ox, oy, x0, y0, x1, y1) {
    if (!v.visible) return;
    const ax = ox + (v === this ? 0 : v.x), ay = oy + (v === this ? 0 : v.y);
    if (v !== this && (ax > x1 || ay > y1 || ax + v.w < x0 || ay + v.h < y0)) return;
    const alpha = v.alpha === undefined ? 1 : v.alpha;
    if (alpha <= 0) return;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha *= alpha;
    ctx.save();
    ctx.translate(ax, ay);
    v.draw(ctx);
    ctx.restore();
    if (v.children) {
      // a container clips its children to its own bounds, as VSTGUI does
      ctx.save();
      if (v !== this) { ctx.beginPath(); ctx.rect(ax, ay, v.w, v.h); ctx.clip(); }
      for (const c of v.children) this.paintTree(ctx, c, ax, ay, x0, y0, x1, y1);
      ctx.restore();
    }
    if (v.drawOverChildren) {
      ctx.save();
      ctx.translate(ax, ay);
      v.drawOverChildren(ctx);
      ctx.restore();
    }
    ctx.restore();
  }

  paintDragGhost(ctx) {
    const d = this.drag;
    if (!d.label) return;
    ctx.font = font(9, true);
    const tw = ctx.measureText(d.label).width + 12;
    const x = d.x + 10, y = d.y + 8;
    roundRectPath(ctx, x, y, tw, 16, 4);
    ctx.fillStyle = rgba(theme.mod, 90);
    ctx.fill();
    ctx.strokeStyle = theme.mod;
    ctx.lineWidth = 1;
    ctx.stroke();
    drawText(ctx, d.label, x, y, tw, 16, 'center', font(9, true), theme.ink);
  }

  // deepest view at an editor point (overlays first)
  viewAt(px, py) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i];
      if (o.visible && o.modal) return this.deepest(o, px - o.x, py - o.y) || o;
      if (o.visible && o.hit(px - o.x, py - o.y)) return this.deepest(o, px - o.x, py - o.y) || o;
    }
    return this.deepest(this, px, py);
  }
  deepest(v, lx, ly) {
    if (!v.visible) return null;
    if (v.children) {
      for (let i = v.children.length - 1; i >= 0; i--) {
        const c = v.children[i];
        if (!c.visible) continue;
        const cx = lx - c.x, cy = ly - c.y;
        if (c.hit(cx, cy)) {
          const d = this.deepest(c, cx, cy);
          if (d) return d;
        }
      }
    }
    return v.mouseEnabled && v !== this ? v : null;
  }

  toEditor(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / this.scale, y: (ev.clientY - r.top) / this.scale };
  }
  local(v, p) { return { x: p.x - v.absX(), y: p.y - v.absY() }; }
  mods(ev) {
    return { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey || ev.metaKey, meta: ev.metaKey };
  }

  // walk up from a view to the first one that handles the event
  dispatchDown(v, p, ev, dbl) {
    for (let t = v; t && t !== this; t = t.parent) {
      if (!t.mouseEnabled) continue;
      const l = this.local(t, p);
      const e = { x: l.x, y: l.y, button: ev.button, right: ev.button === 2, ...this.mods(ev), doubleClick: dbl, raw: ev };
      if (dbl ? t.onDoubleClick(e) : t.onMouseDown(e)) return t;
    }
    return null;
  }

  installEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      try { c.setPointerCapture(ev.pointerId); } catch { /* synthetic or ended pointer */ }
      const p = this.toEditor(ev);
      const v = this.viewAt(p.x, p.y);
      const now = performance.now();
      const lc = this.lastClick;
      const dbl = ev.button === 0 && v && lc.view === v && now - lc.t < 400 && Math.hypot(p.x - lc.x, p.y - lc.y) < 5;
      this.lastClick = { t: dbl ? -Infinity : now, x: p.x, y: p.y, view: v };
      this.capture = v ? this.dispatchDown(v, p, ev, dbl) : null;
      // a click outside every overlay closes the topmost transient one
      if (!this.capture) for (let i = this.overlays.length - 1; i >= 0; i--) {
        const o = this.overlays[i];
        if (o.transient) { o.close(); break; }
      }
    });
    c.addEventListener('pointermove', (ev) => {
      const p = this.toEditor(ev);
      if (this.drag) {
        this.invalidRect(this.drag.x - 4, this.drag.y - 4, 120, 40);
        this.drag.x = p.x; this.drag.y = p.y;
        const t = this.viewAt(p.x, p.y);
        const tgt = t && t.acceptsDrag && t.acceptsDrag(this.drag.payload) ? t : null;
        if (tgt !== this.drag.target) {
          if (this.drag.target) this.drag.target.dragLeave();
          this.drag.target = tgt;
          if (tgt) tgt.dragEnter(this.drag.payload);
        }
        this.invalidRect(p.x - 4, p.y - 4, 120, 40);
        return;
      }
      if (this.capture) {
        // a press that turned into a drag is not the first half of a double-click
        if (Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) >= 5) this.lastClick.t = -Infinity;
        const l = this.local(this.capture, p);
        this.capture.onMouseMove({ x: l.x, y: l.y, buttons: ev.buttons, ...this.mods(ev), raw: ev });
        return;
      }
      const v = this.viewAt(p.x, p.y);
      if (v !== this.hover) {
        if (this.hover) this.hover.onLeave();
        this.hover = v;
      }
      if (v) {
        const l = this.local(v, p);
        v.onHover({ x: l.x, y: l.y, ...this.mods(ev) });
      }
      const cur = v && v.cursorAt ? v.cursorAt(this.local(v, p)) : 'default';
      if (cur !== this.cursor) { this.cursor = cur; c.style.cursor = cur; }
    });
    const up = (ev) => {
      const p = this.toEditor(ev);
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        if (d.target) { d.target.dragLeave(); d.target.drop(d.payload); }
        this.invalidRect(0, 0, this.w, this.h);
      }
      if (this.capture) {
        const v = this.capture;
        this.capture = null;
        const l = this.local(v, p);
        v.onMouseUp({ x: l.x, y: l.y, ...this.mods(ev), raw: ev });
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover.onLeave(); this.hover = null; } });
    c.addEventListener('wheel', (ev) => {
      const p = this.toEditor(ev);
      let v = this.viewAt(p.x, p.y);
      // one notch = 1.0, like VSTGUI's deltaY on a mouse wheel; trackpads arrive
      // in pixels and are summed into notches
      let dy = -ev.deltaY;
      if (ev.deltaMode === 0) dy /= 100;
      for (; v && v !== this; v = v.parent) {
        const l = this.local(v, p);
        if (v.onWheel({ x: l.x, y: l.y, deltaY: dy, ...this.mods(ev), raw: ev })) { ev.preventDefault(); return; }
      }
    }, { passive: false });
  }

  // in-app drag (modulation sources): views with acceptsDrag/dragEnter/dragLeave/drop
  startDrag(payload, label, p) {
    this.drag = { payload, label, x: p.x, y: p.y, target: null };
    this.capture = null;
  }

  // files dragged in from the desktop (WAV): views with acceptsFiles /
  // fileDragEnter / fileDragLeave / fileDrop
  installFileDrop() {
    const c = this.canvas;
    let target = null;
    const find = (ev) => {
      const p = this.toEditor(ev);
      for (let v = this.viewAt(p.x, p.y); v && v !== this; v = v.parent) if (v.acceptsFiles && v.acceptsFiles()) return v;
      return null;
    };
    const setTarget = (t) => {
      if (t === target) return;
      if (target) target.fileDragLeave();
      target = t;
      if (target) target.fileDragEnter();
    };
    c.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
      const t = find(ev);
      setTarget(t);
      if (t) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; }
    });
    c.addEventListener('dragleave', () => setTarget(null));
    c.addEventListener('drop', (ev) => {
      const t = find(ev);
      setTarget(null);
      if (!t) return;
      ev.preventDefault();
      const f = [...ev.dataTransfer.files].find((x) => /\.wav$/i.test(x.name));
      if (f) t.fileDrop(f);
    });
  }
}
