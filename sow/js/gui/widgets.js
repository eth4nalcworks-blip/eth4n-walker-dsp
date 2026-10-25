// The standard VSTGUI controls SIREN's uidesc uses (CTextLabel, CCheckBox,
// CSegmentButton, COptionMenu / SirenMenu, UIViewSwitchContainer,
// CViewContainer) plus SIREN's basic custom views (card, knob, text button,
// logo, readout, meter, mod tabs). Drawing follows the VSTGUI / SIREN source
// line by line; numbers are theirs.

import {
  View, Container, theme, rgba, font, drawText, drawTextAt, textWidth, roundRectPath, arc, line, strokeRect, fillRect,
  fillEllipse, strokeEllipse,
} from './core.js';

// ---------------------------------------------------------------------------
// uidesc helpers

export function rectOf(a) {
  const [x, y] = (a.origin || '0, 0').split(',').map(Number);
  const [w, h] = (a.size || '0, 0').split(',').map(Number);
  return [x, y, w, h];
}
export function colorOf(env, name, fallback = 'transparent') {
  if (!name) return fallback;
  const c = env.ui.colors[name];
  if (c) return rgba(c);
  if (name.startsWith('#')) return rgba(name);
  return fallback;
}
export function fontOf(env, name, fallback = 'small') {
  const f = env.ui.fonts[name] || env.ui.fonts[fallback];
  return font(f.size, f.bold);
}
export function fontSizeOf(env, name, fallback = 'small') {
  return (env.ui.fonts[name] || env.ui.fonts[fallback]).size;
}
const bool = (v, d = false) => (v === undefined ? d : v === 'true');

// Arial cap height / size (VSTGUI uses the platform font's cap height)
const CAP = 0.716;

// ---------------------------------------------------------------------------
// base for parameter-bound controls

export class Control extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.attrs = a;
    const tagName = a['control-tag'];
    this.tag = tagName !== undefined && env.ui.tags[tagName] !== undefined ? env.ui.tags[tagName] : -1;
    this.param = this.tag >= 0 ? env.ctl.info(this.tag) : null;
  }
  get ctl() { return this.env.ctl; }
  get norm() { return this.tag >= 0 ? this.ctl.get(this.tag) : 0; }
  // stepped (list) parameters: VST3Editor gives the control the plain range and
  // writes back the integer entry, so the control always shows a whole step
  get isList() { return !!this.param && this.param.kind === 'list'; }
  get count() {
    if (!this.param) return 0;
    if (this.param.kind === 'sw') return 2;
    return this.param.count;
  }
  get shownNorm() {
    if (this.isList && this.count > 1) return this.ctl.step(this.tag) / (this.count - 1);
    return this.norm;
  }
  get defaultNorm() { return this.param ? this.param.def : 0; }
  edit(n) { if (this.tag >= 0) this.ctl.set(this.tag, n); }
  attached() {
    if (this.tag >= 0) this.unsub = this.ctl.onParam(this.tag, () => this.paramChanged());
  }
  removed() { if (this.unsub) { this.unsub(); this.unsub = null; } }
  paramChanged() { this.invalid(); }
  // entry names for list / switch parameters (VST3Editor fills menus and
  // segment buttons from getParamStringByValue)
  entryNames() {
    const n = this.count;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.ctl.string(this.tag, n > 1 ? i / (n - 1) : 0));
    return out;
  }
}

// ---------------------------------------------------------------------------
// containers

export class ViewContainer extends Container {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    const bg = a['background-color'];
    this.background = bg && bg !== 'transp' ? colorOf(env, bg, null) : null;
  }
}

// SirenCard: rounded gradient panel + hairline edge + optional title with tick
export class SirenCard extends Container {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.title = a['card-title'] || '';
    this.accentBar = bool(a['accent-bar'], true);
  }
  draw(ctx) {
    const x = 0.5, y = 0.5, w = this.w - 1, h = this.h - 1;
    roundRectPath(ctx, x, y, w, h, 6);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, theme.cardTop);
    g.addColorStop(1, theme.cardBot);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = theme.cardEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (this.title) {
      if (this.accentBar) fillRect(ctx, x + 8, y + 8, 3, 8, theme.accent);
      const l = x + (this.accentBar ? 16 : 8);
      drawText(ctx, this.title, l, y + 6, w - 6 - l, 12, 'left', font(9, true), theme.dim);
    }
  }
}

// UIViewSwitchContainer: shows one template, chosen by a control's value; the
// outgoing template's views are destroyed (as in VSTGUI) and the new one fades in
export class ViewSwitch extends Container {
  constructor(env, a, build) {
    super(...rectOf(a));
    this.env = env;
    this.build = build;
    this.names = (a['template-names'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const tn = a['template-switch-control'];
    this.tag = tn !== undefined && env.ui.tags[tn] !== undefined ? env.ui.tags[tn] : -1;
    this.animMs = a['animation-style'] === 'fade' ? Number(a['animation-time'] || 120) : 0;
    this.index = -1;
    this.alpha = 1;
  }
  attached() {
    if (this.tag >= 0) this.unsub = this.env.ctl.onParam(this.tag, () => this.update(true));
    this.update(false);
  }
  removed() { if (this.unsub) this.unsub(); this.stopFade(); }
  currentIndex() {
    const ctl = this.env.ctl;
    const p = ctl.info(this.tag);
    let v = ctl.get(this.tag);
    if (p && p.kind === 'list' && p.count > 1) v = ctl.step(this.tag) / (p.count - 1);
    const n = this.names.length;
    return Math.max(0, Math.min(n - 1, Math.floor(v * (n - 1) + 0.5)));
  }
  update(animate) {
    const i = this.currentIndex();
    if (i === this.index) return;
    this.index = i;
    this.removeAll();
    // the template's own root (a card, a plain container ...) sits at 0,0
    const t = this.env.ui.templates[this.names[i]];
    const v = t ? this.build(t) : null;
    if (v) { v.x = 0; v.y = 0; this.add(v); }
    if (animate && this.animMs > 0) this.startFade();
    this.invalid();
  }
  startFade() {
    const root = this.root;
    if (!root) return;
    this.stopFade();
    const t0 = performance.now();
    this.alpha = 0;
    this.fadeFn = (now) => {
      this.alpha = Math.min(1, (now - t0) / this.animMs);
      this.invalid();
      if (this.alpha >= 1) this.stopFade();
    };
    root.timers.add(this.fadeFn);
  }
  stopFade() {
    if (this.fadeFn && this.root) this.root.timers.delete(this.fadeFn);
    this.fadeFn = null;
    this.alpha = 1;
  }
}

// ---------------------------------------------------------------------------
// CTextLabel

export class TextLabel extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.text = a.title || '';
    this.font = fontOf(env, a.font);
    this.color = colorOf(env, a['font-color'], theme.ink);
    this.align = a['text-alignment'] || 'center';
    this.mouseEnabled = false;
  }
  draw(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.clip();
    drawText(ctx, this.text, 0, 0, this.w, this.h, this.align, this.font, this.color);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// CCheckBox (no bitmap, cross box)

export class CheckBox extends Control {
  constructor(env, a) {
    super(env, a);
    this.title = a.title || '';
    this.fontName = a.font || 'small';
    this.font = fontOf(env, this.fontName);
    this.fontColor = colorOf(env, a['font-color'], theme.ink);
    this.boxFrame = colorOf(env, a['boxframe-color'], theme.ink);
    this.boxFill = colorOf(env, a['boxfill-color'], theme.knob);
    this.checkColor = colorOf(env, a['checkmark-color'], theme.accent);
    this.cross = bool(a['draw-crossbox']);
    this.frameWidth = Number(a['frame-width'] || 1);
    this.radius = Number(a['round-rect-radius'] || 0);
    this.highlight = false;
  }
  box() {
    const size = Math.floor(fontSizeOf(this.env, this.fontName) * CAP + 2.5);
    return { x: 1, y: Math.ceil((this.h - size) / 2), s: size };
  }
  draw(ctx) {
    const on = this.norm > 0.5;
    const { x, y, s } = this.box();
    const lw = this.frameWidth;
    roundRectPath(ctx, x, y, s, s, this.radius);
    ctx.fillStyle = this.boxFill;
    ctx.fill();
    ctx.strokeStyle = this.boxFrame;
    ctx.lineWidth = lw;
    ctx.stroke();
    if (this.highlight) {
      roundRectPath(ctx, x + lw, y + lw, s - 2 * lw, s - 2 * lw, this.radius);
      ctx.strokeStyle = this.boxFrame.replace(/[\d.]+\)$/, (m) => (parseFloat(m) / 2).toFixed(3) + ')');
      ctx.stroke();
    }
    if (on) {
      const i = 2;
      ctx.lineCap = 'butt';
      if (this.cross) {
        line(ctx, x + i, y + i, x + s - i, y + s - i, this.checkColor, 2);
        line(ctx, x + i, y + s - i, x + s - i, y + i, this.checkColor, 2);
      } else {
        ctx.beginPath();
        ctx.moveTo(x + i, y + s / 2); ctx.lineTo(x + s / 2, y + s - i); ctx.lineTo(x + s + 1, y - 1);
        ctx.strokeStyle = this.checkColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    if (this.title) drawTextAt(ctx, this.title, x + s + 5, y + s - 1, this.font, this.fontColor);
  }
  onMouseDown(e) {
    if (e.right) return false;
    this.highlight = true;
    this.invalid();
    return true;
  }
  onMouseMove(e) {
    const h = this.hit(e.x, e.y);
    if (h !== this.highlight) { this.highlight = h; this.invalid(); }
  }
  onMouseUp(e) {
    this.highlight = false;
    if (this.hit(e.x, e.y)) this.edit(this.norm > 0.5 ? 0 : 1);
    this.invalid();
  }
}

// ---------------------------------------------------------------------------
// CSegmentButton (horizontal, single selection)

export class SegmentButton extends Control {
  constructor(env, a) {
    super(env, a);
    this.font = fontOf(env, a.font);
    this.textColor = colorOf(env, a['text-color'], theme.ink);
    this.textColorHi = colorOf(env, a['text-color-highlighted'], theme.ink);
    this.frameColor = colorOf(env, a['frame-color'], theme.grid);
    this.frameWidth = Number(a['frame-width'] || 1);
    this.radius = Number(a['round-radius'] || 0);
    const g = env.ui.gradients;
    this.grad = g[a.gradient] ? rgba(g[a.gradient][0].rgba) : null;
    this.gradHi = g[a['gradient-highlighted']] ? rgba(g[a['gradient-highlighted']][0].rgba) : null;
    this.names = (a['segment-names'] || '').split(',');
    if (this.param && this.count > 1) this.names = this.entryNames();
  }
  selected() {
    const n = this.names.length;
    if (this.isList) return Math.min(n - 1, this.ctl.step(this.tag));
    return Math.min(n - 1, Math.max(0, Math.round(this.norm * (n - 1))));
  }
  segRect(i) {
    const w = this.w / this.names.length;
    return { x: i * w, y: 0, w, h: this.h };
  }
  draw(ctx) {
    const lw = this.frameWidth;
    const path = () => roundRectPath(ctx, lw / 2, lw / 2, this.w - lw, this.h - lw, this.radius);
    if (this.grad) { path(); ctx.fillStyle = this.grad; ctx.fill(); }
    const sel = this.selected();
    for (let i = 0; i < this.names.length; i++) {
      const r = this.segRect(i);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      if (i === sel && this.gradHi) { path(); ctx.fillStyle = this.gradHi; ctx.fill(); }
      drawText(ctx, this.names[i], r.x, r.y, r.w, r.h, 'center', this.font, i === sel ? this.textColorHi : this.textColor);
      ctx.restore();
    }
    if (lw > 0) {
      path();
      for (let i = 1; i < this.names.length; i++) {
        const r = this.segRect(i);
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x, r.y + r.h);
      }
      ctx.strokeStyle = this.frameColor;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }
  segmentAt(x) { return Math.max(0, Math.min(this.names.length - 1, Math.floor(x / (this.w / this.names.length)))); }
  select(i) {
    const n = this.names.length;
    this.edit(n > 1 ? i / (n - 1) : 0);
  }
  onMouseDown(e) {
    if (e.right) return false;
    this.select(this.segmentAt(e.x));
    return true;
  }
}

// SirenModTabs: ENV/LFO tabs that are also drag handles for mod assignment
export class SirenModTabs extends SegmentButton {
  constructor(env, a) {
    super(env, a);
    this.counts = [0, 0, 0, 0, 0, 0];
  }
  attached() {
    super.attached();
    this.unsubDirty = this.ctl.onDirty((bits) => { if (bits & (1 << 11)) this.refreshCounts(); });
    this.refreshCounts();
  }
  removed() { super.removed(); if (this.unsubDirty) this.unsubDirty(); }
  refreshCounts() {
    let changed = false;
    for (let i = 0; i < 6; i++) {
      const c = this.ctl.tabCount(i);
      if (c !== this.counts[i]) { this.counts[i] = c; changed = true; }
    }
    if (changed) this.invalid();
  }
  draw(ctx) {
    super.draw(ctx);
    for (let i = 0; i < this.names.length && i < 6; i++) {
      if (this.counts[i] <= 0) continue;
      const r = this.segRect(i);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      drawText(ctx, this.names[i], r.x, r.y, r.w, r.h, 'center', this.font, theme.mod);
      ctx.restore();
      const n = String(this.counts[i]);
      const lw = textWidth(ctx, this.names[i], this.font);
      const cx = r.x + r.w * 0.5;
      const supW = 5 * n.length + 2;
      let supX = cx + lw * 0.5 + 1;
      if (supX + supW > r.x + r.w - 1) supX = r.x + r.w - 1 - supW;
      drawText(ctx, n, supX, r.y + 1, supW, 10, 'left', font(8, true), theme.mod);
    }
  }
  onMouseDown(e) {
    if (e.right) return false;
    this.pressSeg = this.segmentAt(e.x);
    this.select(this.pressSeg);
    this.press = { x: e.x, y: e.y };
    return true;
  }
  onMouseMove(e) {
    if (this.press && Math.abs(e.x - this.press.x) + Math.abs(e.y - this.press.y) > 4) {
      this.press = null;
      if (this.pressSeg >= 1) {
        const root = this.root;
        root.startDrag({ modsrc: this.pressSeg }, this.names[this.pressSeg],
          { x: this.absX() + e.x, y: this.absY() + e.y });
      }
    }
  }
  onMouseUp() { this.press = null; }
}

// ---------------------------------------------------------------------------
// COptionMenu / SirenMenu: a parameter display that pops a list

export class OptionMenu extends Control {
  constructor(env, a) {
    super(env, a);
    this.font = fontOf(env, a.font);
    this.fontColor = colorOf(env, a['font-color'], theme.ink);
    this.backColor = colorOf(env, a['back-color'], theme.knob);
    this.frameColor = colorOf(env, a['frame-color'], theme.cardEdge);
    this.frameWidth = Number(a['frame-width'] || 1);
    this.align = a['text-alignment'] || 'center';
    this.popupStyle = bool(a['menu-popup-style']);
    this.checkStyle = bool(a['menu-check-style']);
    this.inPopup = false;
    this.wheelAcc = 0;
  }
  entries() { return this.param ? this.entryNames() : []; }
  current() { return this.isList ? this.ctl.step(this.tag) : Math.round(this.norm * Math.max(1, this.count - 1)); }
  displayText() {
    const e = this.entries();
    return e[this.current()] || '';
  }
  drawBack(ctx) {
    const lw = this.frameWidth;
    fillRect(ctx, lw / 2, lw / 2, this.w - lw, this.h - lw, this.backColor);
    strokeRect(ctx, 0, 0, this.w, this.h, this.frameColor, lw);
  }
  draw(ctx) {
    this.drawBack(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.clip();
    drawText(ctx, this.displayText(), 0, 0, this.w, this.h, this.align, this.font, this.fontColor);
    ctx.restore();
  }
  onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return false;
    this.openPopup();
    return true;
  }
  openPopup() {
    const entries = this.entries();
    if (!entries.length) return;
    popupMenu(this, entries, this.current(), (i) => {
      const n = this.count;
      this.edit(n > 1 ? i / (n - 1) : 0);
    }, { popupStyle: this.popupStyle, check: this.checkStyle });
  }
  // SIREN steps the value on the wheel. Counted in notches here, so a trackpad
  // does not race through the list (one step per notch, as on a mouse).
  onWheel(e) {
    const n = this.count;
    if (n > 1 && e.deltaY !== 0) {
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) >= 1 || Math.abs(e.deltaY) >= 1) {
        const dir = this.wheelAcc > 0 ? 1 : -1;
        this.wheelAcc = 0;
        const idx = Math.max(0, Math.min(n - 1, this.current() + dir));
        this.edit(idx / (n - 1));
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// VSTGUI's generic option menu (SIREN themes it: Arial 12, panel / accentDim)

const MENU_FONT = 12;
const MENU_ROW = Math.ceil(MENU_FONT + 8);
const MENU_CHECK = MENU_FONT * 1.6;

export class PopupMenu extends View {
  constructor(root, items, current, onPick, opts) {
    super(0, 0, root.w, root.h);
    this.items = items;           // strings; '-' = separator; {title, disabled, header}
    this.current = current;
    this.onPick = onPick;
    this.opts = opts || {};
    this.transient = true;
    this.modal = true;
    this.hover = -1;
    this.scroll = 0;
    this.alpha = 0;
  }
  layout(anchor) {
    const ctx = this.root.ctx;
    ctx.font = font(MENU_FONT);
    let maxTitle = 0;
    for (const it of this.items) maxTitle = Math.max(maxTitle, ctx.measureText(this.title(it)).width);
    const maxW = maxTitle + MENU_CHECK * 2;
    let x = anchor.x, y = anchor.y + anchor.h, w = Math.max(anchor.w, maxW);
    if (this.opts.popupStyle) y = anchor.y - this.current * MENU_ROW;
    let h = this.items.length * MENU_ROW;
    const F = { x: 6, y: 6, r: this.w - 6, b: this.h - 6 };
    if (y + h > F.b) y -= y + h - F.b;
    if (y < F.y) y = F.y;
    if (x + w > F.r) x -= x + w - F.r;
    if (x < F.x) x = F.x;
    h = Math.min(h, F.b - y);
    w = Math.min(w, F.r - x);
    this.box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    this.maxTitle = w - MENU_CHECK * 2;
    this.contentH = this.items.length * MENU_ROW;
    if (this.current >= 0) {   // makeRowVisible
      const top = this.current * MENU_ROW;
      if (top + MENU_ROW > this.box.h) this.scroll = Math.min(this.contentH - this.box.h, top + MENU_ROW - this.box.h / 2);
    }
  }
  title(it) { return typeof it === 'string' ? it : it.title; }
  attached() {
    const t0 = performance.now();
    this.fade = (now) => {
      this.alpha = Math.min(1, (now - t0) / 120);
      this.root.invalidRect(this.box.x - 2, this.box.y - 2, this.box.w + 4, this.box.h + 4);
      if (this.alpha >= 1) this.root.timers.delete(this.fade);
    };
    this.root.timers.add(this.fade);
  }
  removed() { if (this.fade && this.root) this.root.timers.delete(this.fade); }
  draw(ctx) {
    const b = this.box;
    ctx.save();
    ctx.globalAlpha = 1 - Math.pow(1 - this.alpha, 3);
    // decor: 1 px darker frame around the list
    strokeRect(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, rgba('#0e0f14'), 1);
    fillRect(ctx, b.x, b.y, b.w, b.h, rgba(theme.panel, 254));
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.font = font(MENU_FONT);
    const first = Math.max(0, Math.floor(this.scroll / MENU_ROW));
    for (let i = first; i < this.items.length; i++) {
      const ry = b.y + i * MENU_ROW - this.scroll;
      if (ry > b.y + b.h) break;
      const it = this.items[i];
      const t = this.title(it);
      if (t === '-') {
        fillRect(ctx, b.x, Math.floor(ry + MENU_ROW / 2), b.w, 1, theme.grid);
        continue;
      }
      const header = typeof it === 'object' && it.header;
      const sel = i === this.hover && !header && !(typeof it === 'object' && it.disabled);
      if (sel) fillRect(ctx, b.x, ry, b.w, MENU_ROW, theme.accentDim);
      if (this.opts.check && i === this.current) {
        const s = MENU_ROW * 0.4;
        const cx = b.x + (MENU_CHECK - s) / 2, cy = ry + (MENU_ROW - s) / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy + s / 2);
        ctx.lineTo(cx + s / 3, cy + s);
        ctx.lineTo(cx + s, cy);
        ctx.strokeStyle = theme.ink;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.save();
      const tx = header ? b.x : b.x + MENU_CHECK;
      const tw = header ? b.w : this.maxTitle;
      ctx.beginPath();
      ctx.rect(tx, ry, tw, MENU_ROW);
      ctx.clip();
      drawText(ctx, t, tx, ry, tw, MENU_ROW, header ? 'center' : 'left', font(MENU_FONT, header),
        header ? theme.dim : (typeof it === 'object' && it.disabled ? theme.dim : theme.ink));
      ctx.restore();
    }
    // overlay scrollbar
    if (this.contentH > b.h) {
      const th = Math.max(20, b.h * b.h / this.contentH);
      const ty = b.y + (b.h - th) * (this.scroll / (this.contentH - b.h));
      roundRectPath(ctx, b.x + b.w - 8, ty + 1, 6, th - 2, 3);
      ctx.fillStyle = rgba(theme.ink, 120);
      ctx.fill();
    }
    ctx.restore();
  }
  rowAt(x, y) {
    const b = this.box;
    if (x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) return -1;
    return Math.floor((y - b.y + this.scroll) / MENU_ROW);
  }
  hit() { return true; }
  onHover(e) {
    const r = this.rowAt(e.x, e.y);
    if (r !== this.hover) { this.hover = r; this.invalid(); }
  }
  onLeave() { if (this.hover !== -1) { this.hover = -1; this.invalid(); } }
  onMouseDown(e) {
    const r = this.rowAt(e.x, e.y);
    if (r < 0) { this.close(); return true; }
    this.pressRow = r;
    return true;
  }
  onMouseMove(e) { this.onHover(e); }
  onMouseUp(e) {
    const r = this.rowAt(e.x, e.y);
    if (r >= 0 && r === this.pressRow) {
      const it = this.items[r];
      const t = this.title(it);
      if (t !== '-' && !(typeof it === 'object' && (it.disabled || it.header))) {
        this.close();
        this.onPick(r);
        return;
      }
    }
  }
  onWheel(e) {
    const b = this.box;
    if (this.contentH > b.h) {
      this.scroll = Math.max(0, Math.min(this.contentH - b.h, this.scroll - e.deltaY * MENU_ROW));
      this.invalid();
    }
    return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const r = this.root;
    if (r) r.removeOverlay(this);
    if (this.opts.onClose) this.opts.onClose();
  }
  invalid() { if (this.root && this.box) this.root.invalidRect(this.box.x - 2, this.box.y - 2, this.box.w + 4, this.box.h + 4); }
}

// open a popup list under a view (editor coordinates)
export function popupMenu(view, items, current, onPick, opts = {}) {
  const root = view.root;
  const m = new PopupMenu(root, items, current, onPick, opts);
  m.parent = root;
  m.layout({ x: view.absX(), y: view.absY(), w: view.w, h: view.h });
  if (view instanceof OptionMenu) {
    view.inPopup = true;
    const prev = opts.onClose;
    m.opts.onClose = () => { view.inPopup = false; view.invalid(); if (prev) prev(); };
  }
  root.addOverlay(m);
  root.capture = null;
  return m;
}

// popup at an arbitrary editor point (context menus)
export function popupAt(root, x, y, items, current, onPick, opts = {}) {
  const m = new PopupMenu(root, items, current, onPick, opts);
  m.parent = root;
  m.layout({ x, y, w: 0, h: 0 });
  root.addOverlay(m);
  return m;
}

// ---------------------------------------------------------------------------
// SirenKnob

export class SirenKnob extends Control {
  constructor(env, a) {
    super(env, a);
    this.bipolar = bool(a.bipolar);
    this.zoom = Number(a['zoom-factor'] || 1);
    this.wheelInc = Number(a['wheel-inc-value'] || 0.1);
    this.mod = { depth: 0, active: false, focus: false };
    this.live = { offset: 0, active: false };
    this.dropActive = false;
    this.range = 200;
  }
  attached() {
    super.attached();
    this.env.knobs.add(this);
    this.refreshRing();
  }
  removed() { super.removed(); this.env.knobs.delete(this); }
  refreshRing() {
    if (this.tag < 0) return;
    const r = this.ctl.ring(this.tag);
    if (r.depth !== this.mod.depth || r.active !== this.mod.active || r.focus !== this.mod.focus) {
      this.mod = r;
      this.invalid();
    }
  }
  setLive(offset, active) {
    const l = this.live;
    if (active === l.active && (!active || Math.abs(offset - l.offset) < 0.002)) return;
    l.offset = offset; l.active = active;
    this.invalid();
  }
  geom() {
    const cx = this.w * 0.5, cy = this.h * 0.5;
    const rad = Math.min(this.w, this.h) * 0.5 - 5.5;
    return { cx, cy, rad, bodyR: rad * 0.72 };
  }
  draw(ctx) {
    const { cx, cy, rad, bodyR } = this.geom();
    const PI = Math.PI;
    fillEllipse(ctx, cx - bodyR, cy - bodyR, 2 * bodyR, 2 * bodyR, theme.knob);
    strokeEllipse(ctx, cx - bodyR, cy - bodyR, 2 * bodyR, 2 * bodyR, theme.knobEdge, 1);
    arc(ctx, cx, cy, bodyR * 0.86, PI * 1.15, PI * 1.85, rgba(theme.ink, 26), 1.6);

    const a0 = PI * 0.75, range = 1.5 * PI, a1 = a0 + range;
    const v = Math.min(1, Math.max(0, this.shownNorm));
    const va = a0 + range * v;
    const vEff = Math.min(1, Math.max(0, v + (this.live.active ? this.live.offset : 0)));
    const vaEff = a0 + range * vEff;
    arc(ctx, cx, cy, rad, a0, a1, theme.track, 2.5);
    let from = a0, to = vaEff;
    if (this.bipolar) from = a0 + range * 0.5;
    if (Math.abs(to - from) > 1e-3) {
      arc(ctx, cx, cy, rad, Math.min(from, to), Math.max(from, to), rgba(theme.accent, 55), 6);
      arc(ctx, cx, cy, rad, Math.min(from, to), Math.max(from, to), theme.accent, 3);
    }
    const c = Math.cos(va), s = Math.sin(va);
    ctx.lineCap = 'butt';
    line(ctx, cx + c * bodyR * 0.30, cy + s * bodyR * 0.30, cx + c * bodyR * 0.92, cy + s * bodyR * 0.92, theme.ink, 2.2);

    if (this.mod.active) {
      const rr = rad + 2.5;
      const vEnd = a0 + range * Math.min(1, Math.max(0, v + this.mod.depth));
      if (this.mod.focus) {
        arc(ctx, cx, cy, rr, a0, a1, rgba(theme.mod, 45), 1.4);
        if (Math.abs(vEnd - va) > 1e-3) {
          arc(ctx, cx, cy, rr, Math.min(va, vEnd), Math.max(va, vEnd), rgba(theme.mod, 70), 6);
          arc(ctx, cx, cy, rr, Math.min(va, vEnd), Math.max(va, vEnd), theme.mod, 2.6);
        }
        const hx = cx + Math.cos(vEnd) * rr, hy = cy + Math.sin(vEnd) * rr;
        fillEllipse(ctx, hx - 2, hy - 2, 4, 4, theme.mod);
      } else {
        arc(ctx, cx, cy, rr, a0, a1, rgba(theme.mod, 16), 1.2);
        if (Math.abs(vEnd - va) > 1e-3)
          arc(ctx, cx, cy, rr, Math.min(va, vEnd), Math.max(va, vEnd), rgba(theme.mod, 70), 1.8);
      }
    }
    if (this.dropActive) strokeEllipse(ctx, cx - rad - 3, cy - rad - 3, 2 * rad + 6, 2 * rad + 6, theme.mod, 1.5);
  }
  onModRing(x, y) {
    const { cx, cy, rad } = this.geom();
    const d = Math.hypot(x - cx, y - cy);
    return d >= rad - 1 && d <= rad + 7;
  }
  // knob value in its own (control) units: list knobs run on entry indices
  ctrlValue() { return this.isList ? this.ctl.step(this.tag) / (this.count - 1) : this.norm; }
  onMouseDown(e) {
    this.ringDrag = false;
    if (e.right) {
      if (this.mod.active) { this.ctl.clearMods(this.tag); return true; }
      return true;
    }
    if (this.mod.focus && this.onModRing(e.x, e.y)) {
      this.ringDrag = true;
      this.lastY = e.y;
      return true;
    }
    if (e.doubleClick) { this.edit(this.defaultNorm); this.drag = null; return true; }
    this.drag = {
      first: { x: e.x, y: e.y }, entry: this.ctrlValue(), shift: e.shift,
      range: this.range * (e.shift ? this.zoom : 1), circular: e.alt,
    };
    this.drag.coef = 1 / this.drag.range;
    this.env.editStart && this.env.editStart(this);
    return true;
  }
  onMouseMove(e) {
    if (this.ringDrag) {
      const dy = e.y - this.lastY;
      this.lastY = e.y;
      if (dy) this.ctl.nudgeMod(this.tag, -dy * 0.006);
      return;
    }
    const d = this.drag;
    if (!d) return;
    let v;
    if (d.circular) {
      const { cx, cy } = this.geom();
      let a = Math.atan2(e.y - cy, e.x - cx);
      let rel = a - Math.PI * 0.75;
      while (rel < 0) rel += 2 * Math.PI;
      v = Math.min(1, Math.max(0, rel / (1.5 * Math.PI)));
    } else {
      const diff = (d.first.y - e.y) + (e.x - d.first.x);
      if (e.shift !== d.shift) {
        const range2 = this.range * (e.shift ? this.zoom : 1);
        const coef2 = 1 / range2;
        d.entry += diff * (d.coef - coef2);
        d.coef = coef2;
        d.shift = e.shift;
      }
      v = Math.min(1, Math.max(0, d.entry + diff * d.coef));
    }
    if (v !== d.last) { d.last = v; this.edit(v); }
  }
  onMouseUp() { this.drag = null; this.ringDrag = false; }
  onWheel(e) {
    let v = this.ctrlValue();
    v += (e.shift ? 0.1 : 1) * e.deltaY * this.wheelInc;
    this.edit(Math.min(1, Math.max(0, v)));
    return true;
  }
  // modulation drop target
  acceptsDrag(p) { return p && p.modsrc !== undefined && this.param && this.param.modDst > 0; }
  dragEnter() { this.dropActive = true; this.invalid(); }
  dragLeave() { this.dropActive = false; this.invalid(); }
  drop(p) { this.ctl.assignMod(this.tag, p.modsrc); }
}

// ---------------------------------------------------------------------------
// SirenTextButton

export class SirenTextButton extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.label = a['btn-label'] || '?';
    this.action = Number(a['action-id'] || 0);
    this.pressed = false;
  }
  draw(ctx) {
    fillRect(ctx, 0, 0, this.w, this.h, this.pressed ? theme.accentDim : theme.panelHi);
    strokeRect(ctx, 0, 0, this.w, this.h, theme.accentDim, 1);
    drawText(ctx, this.label, 0, 0, this.w, this.h, 'center', font(9, true), theme.ink);
  }
  onMouseDown(e) {
    if (e.right) return false;
    this.pressed = true;
    this.invalid();
    return true;
  }
  onMouseUp(e) {
    this.pressed = false;
    this.invalid();
    if (this.hit(e.x, e.y)) this.env.app.onAction(this.action);
  }
}

// ---------------------------------------------------------------------------
// SirenLogo: the header bitmap, drawn 1:1 into the view (the @2x file on hi-dpi)

export class SirenLogo extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.img = env.images[a['logo-bitmap']];
    this.clickable = bool(a.clickable);
  }
  draw(ctx) {
    if (this.img) ctx.drawImage(this.img, 0, 0, this.w, this.h);
  }
  cursorAt() { return this.clickable ? 'pointer' : 'default'; }
  onMouseDown(e) {
    if (!this.clickable || e.right) return false;
    this.env.app.openOptions();
    return true;
  }
}

// ---------------------------------------------------------------------------
// header HUD: readout + meter

export class Readout extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.name = '';
    this.value = '';
    env.readout = this;
  }
  set(name, value) { this.name = name || ''; this.value = value || ''; this.invalid(); }
  draw(ctx) {
    fillRect(ctx, 0, 0, this.w, this.h, theme.field);
    if (!this.name) {
      drawText(ctx, 'SIREN READY', 0, 0, this.w, this.h, 'right', font(9), theme.dim);
    } else {
      drawText(ctx, this.name, 0, 0, this.w, 13, 'right', font(9), theme.dim);
      drawText(ctx, this.value, 0, 13, this.w, this.h - 13, 'right', font(15, true), theme.accent);
    }
  }
}

export class Meter extends View {
  constructor(env, a) {
    super(...rectOf(a));
    this.env = env;
    this.tgt = [0, 0];
    this.disp = [-60, -60];
    this.transparent = a.transparent === 'true';   // on a card: no field behind it
    env.meter = this;
  }
  setPeaks(l, r) { this.tgt[0] = Math.max(this.tgt[0], l); this.tgt[1] = Math.max(this.tgt[1], r); }
  attached() {
    let last = 0;
    this.timer = (now) => {
      if (now - last < 33) return;
      last = now;
      let moved = false;
      for (let c = 0; c < 2; c++) {
        const tgt = 20 * Math.log10(Math.max(this.tgt[c], 1e-5));
        const d = this.disp[c];
        const next = tgt > d ? tgt : Math.max(tgt, d - 1);
        if (Math.abs(next - d) > 0.05) moved = true;
        this.disp[c] = next;
      }
      this.tgt[0] = this.tgt[1] = 0;
      if (moved) this.invalid();
    };
    this.root.timers.add(this.timer);
  }
  removed() { if (this.root) this.root.timers.delete(this.timer); }
  draw(ctx) {
    if (!this.transparent) fillRect(ctx, 0, 0, this.w, this.h, theme.field);
    drawText(ctx, 'OUT', 6, 2, 34, 10, 'left', font(8), theme.dim);
    const x0 = 34, x1 = this.w - 8;
    for (let c = 0; c < 2; c++) {
      const y = 6 + c * 10;
      fillRect(ctx, x0, y, x1 - x0, 6, this.transparent ? theme.knob : theme.panelHi);
      const h01 = Math.min(1, Math.max(0, (this.disp[c] + 60) / 60));
      if (h01 > 0) fillRect(ctx, x0, y, (x1 - x0) * h01, 6, this.disp[c] > -3 ? theme.ink : theme.accent);
    }
  }
}
