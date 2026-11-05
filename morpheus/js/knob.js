// A knob with two values: where the table starts and where it ends
// (dsp::KnobVal). Turning one end away from the other is the morph -- one knob,
// every frame in between (source/views/knob.h).
//
//   drag              both ends together (or what the stack's DRAG toggle says)
//   Alt + drag        the end only        Ctrl / Cmd + drag   the start only
//   Shift             eight times finer   double-click        the module default
//   right-click       lock (Random leaves it alone)
//   arrow keys        step, with the same modifiers
//
// The inner arc is the value at the start of the table; when the ends differ an
// outer arc shows how far the table travels, with a marker on its end.

const NS = 'http://www.w3.org/2000/svg';
const A0 = 0.75 * Math.PI, SPAN = 1.5 * Math.PI;   // 7:30 round to 4:30
const R = 15, R2 = 19.5, C = 21;

const clamp = (v) => Math.min(1, Math.max(0, v));
const pt = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
function arc(r, v0, v1) {
  const a = A0 + SPAN * Math.min(v0, v1), b = A0 + SPAN * Math.max(v0, v1);
  if (b - a < 1e-4) return '';
  const [x0, y0] = pt(r, a), [x1, y1] = pt(r, b);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export const dragMode = { value: 'both' };   // the stack's DRAG toggle

export class Knob {
  // opts: { name, bipolar, stops ('A/B/C'), def, simple (no morph, no lock),
  //         format (v -> text, simple knobs), onChange (val, final), onBegin () }
  constructor(opts) {
    this.o = opts;
    this.v = { start: opts.def ?? 0.5, end: opts.def ?? 0.5, link: true, lock: false };
    this.stops = opts.stops ? opts.stops.split('/') : null;
    const el = (this.el = document.createElement('div'));
    el.className = 'knob';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', opts.name);
    el.innerHTML = `<span class="kn"></span>`;
    el.firstChild.textContent = opts.name;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42');
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
      return n;
    };
    mk('path', { d: arc(R, 0, 1), fill: 'none', stroke: '#3a3a3a', 'stroke-width': 3, 'stroke-linecap': 'round' });
    this.pMorph = mk('path', { fill: 'none', stroke: '#ff6b1a', 'stroke-opacity': 0.55, 'stroke-width': 2, 'stroke-linecap': 'round' });
    this.pVal = mk('path', { fill: 'none', stroke: '#ff6b1a', 'stroke-width': 3, 'stroke-linecap': 'round' });
    this.pTick = mk('line', { stroke: '#d9d9d9', 'stroke-width': 2, 'stroke-linecap': 'round' });
    this.pEnd = mk('circle', { r: 2.4, fill: '#ff6b1a' });
    el.appendChild(svg);
    this.text = document.createElement('span');
    this.text.className = 'kv';
    el.appendChild(this.text);
    this.install(svg);
    this.draw();
  }

  set(v) {
    this.v = { ...v };
    this.draw();
  }

  morphing() { return !this.v.link && Math.abs(this.v.end - this.v.start) > 1e-4; }

  show(x) {
    if (this.o.format) return this.o.format(x);
    if (this.stops) return this.stops[Math.round(clamp(x) * (this.stops.length - 1))];
    return String(Math.round(this.o.bipolar ? (x - 0.5) * 200 : x * 100));
  }

  draw() {
    const { start, end } = this.v;
    const zero = this.o.bipolar ? 0.5 : 0;
    this.pVal.setAttribute('d', arc(R, zero, start));
    const a = A0 + SPAN * start;
    const [x0, y0] = pt(5, a), [x1, y1] = pt(R - 4, a);
    this.pTick.setAttribute('x1', x0); this.pTick.setAttribute('y1', y0);
    this.pTick.setAttribute('x2', x1); this.pTick.setAttribute('y2', y1);
    const m = this.morphing();
    this.pMorph.setAttribute('d', m ? arc(R2, start, end) : '');
    const [ex, ey] = pt(R2, A0 + SPAN * end);
    this.pEnd.setAttribute('cx', ex); this.pEnd.setAttribute('cy', ey);
    this.pEnd.style.display = m ? '' : 'none';
    this.text.textContent = m ? `${this.show(start)}>${this.show(end)}` : this.show(start);
    this.el.classList.toggle('locked', !!this.v.lock && !this.o.simple);
    this.el.setAttribute('aria-valuetext', this.text.textContent);
  }

  // which end a gesture moves
  target(e) {
    if (this.o.simple) return 'both';
    if (e.altKey) return 'end';
    if (e.ctrlKey || e.metaKey) return 'start';
    return dragMode.value;
  }

  nudge(which, d) {
    const v = this.v;
    if (which === 'both') {
      const gap = v.end - v.start;
      v.start = clamp(v.start + d);
      v.end = v.link ? v.start : clamp(v.start + gap);
    } else {
      v.link = false;
      if (which === 'end') v.end = clamp(v.end + d);
      else v.start = clamp(v.start + d);
    }
  }

  install(svg) {
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        if (!this.o.simple) {
          this.o.onBegin?.();
          this.v.lock = !this.v.lock;
          this.draw();
          this.o.onChange?.(this.v, true);
        }
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      this.el.focus({ preventScroll: true });
      svg.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, which: this.target(e), moved: false };
      this.o.onBegin?.();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY;
      drag.y = e.clientY;
      if (!dy) return;
      drag.moved = true;
      this.nudge(drag.which, (dy / 180) * (e.shiftKey ? 0.125 : 1));
      this.draw();
      this.o.onChange?.(this.v, false);
    });
    const up = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) this.o.onChange?.(this.v, true);
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('dblclick', () => {
      this.o.onBegin?.();
      const d = this.o.def ?? 0.5;
      this.v = { ...this.v, start: d, end: d, link: true };
      this.draw();
      this.o.onChange?.(this.v, true);
    });
    this.el.addEventListener('keydown', (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      this.o.onBegin?.();
      this.nudge(this.target(e), step * (e.shiftKey ? 0.002 : 0.01));
      this.draw();
      this.o.onChange?.(this.v, true);
    });
  }
}
