// The preview keyboard: keys on screen (mouse / touch), the computer keyboard
// laid out on the home row the way the app does it (app/main_view.h
// keyToSemitone), and Web MIDI input.
//
//        T  Y     I  O  P        black
//     F  G  H  J  K  L  ;  :     white, F being the base note
//     Z / X                      an octave down / up

const PC = { KeyF: 0, KeyT: 1, KeyG: 2, KeyY: 3, KeyH: 4, KeyJ: 5, KeyI: 6, KeyK: 7, KeyO: 8, KeyL: 9, KeyP: 10, Semicolon: 11, Quote: 12 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (n) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
export const noteName = (n) => NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

export class Keyboard {
  // onNote (note, velocity 1..127 | 0 = off), getBase () -> base note, onOctave (delta)
  constructor(el, { onNote, getBase, onOctave, onMidi }) {
    this.el = el;
    this.onNote = onNote;
    this.getBase = getBase;
    this.onOctave = onOctave;
    this.onMidi = onMidi;
    this.held = new Map();    // source -> note
    this.count = new Map();   // note -> sources holding it
    this.octaves = 4;
    this.first = -1;
    new ResizeObserver(() => this.layout()).observe(el);
    this.installPointer();
    this.installPc();
  }

  layout() {
    const w = this.el.clientWidth;
    const oct = Math.max(2, Math.min(4, Math.round(w / 240)));
    const first = Math.floor(this.getBase() / 12) * 12;   // the C of the base note's octave
    if (oct === this.octaves && first === this.first && this.el.childElementCount) return;
    this.octaves = oct;
    this.first = first;
    this.build();
  }

  build() {
    const el = this.el;
    el.innerHTML = '';
    this.keys = new Map();
    const lo = this.first, hi = lo + this.octaves * 12;
    const whites = [];
    for (let n = lo; n <= hi; n++) if (!isBlack(n)) whites.push(n);
    const ww = 100 / whites.length;
    let wi = 0;
    const blacks = [];
    for (let n = lo; n <= hi; n++) {
      const k = document.createElement('div');
      k.dataset.note = n;
      if (isBlack(n)) {
        k.className = 'key black';
        k.style.left = `calc(${wi * ww}% - ${ww * 0.3}%)`;
        k.style.width = `${ww * 0.6}%`;
        blacks.push(k);
      } else {
        k.className = 'key white';
        k.style.left = `${wi * ww}%`;
        k.style.width = `${ww}%`;
        if (n % 12 === 0 || n === this.getBase()) {
          const s = document.createElement('span');
          s.textContent = noteName(n);
          k.appendChild(s);
        }
        wi++;
        el.appendChild(k);
      }
      this.keys.set(n, k);
    }
    for (const k of blacks) el.appendChild(k);
    for (const n of this.count.keys()) this.paint(n);
  }

  press(src, note, vel) {
    if (this.held.has(src)) this.release(src);
    note = Math.min(127, Math.max(0, note));
    this.held.set(src, note);
    const c = (this.count.get(note) || 0) + 1;
    this.count.set(note, c);
    if (c === 1) this.onNote(note, vel);
    this.paint(note);
  }
  release(src) {
    const note = this.held.get(src);
    if (note === undefined) return;
    this.held.delete(src);
    const c = (this.count.get(note) || 1) - 1;
    if (c <= 0) { this.count.delete(note); this.onNote(note, 0); } else this.count.set(note, c);
    this.paint(note);
  }
  releaseAll() { for (const s of [...this.held.keys()]) this.release(s); }
  paint(n) { this.keys?.get(n)?.classList.toggle('on', this.count.has(n)); }

  installPointer() {
    const noteAt = (e) => {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const k = t && (t.dataset?.note ? t : t.parentElement);
      return k && k.dataset && k.dataset.note !== undefined && this.el.contains(k) ? Number(k.dataset.note) : null;
    };
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      const n = noteAt(e);
      if (n === null) return;
      const k = this.keys.get(n), r = k.getBoundingClientRect();
      // lower on the key = louder
      const vel = Math.round(127 * Math.min(1, Math.max(0.25, 0.4 + (0.6 * (e.clientY - r.top)) / r.height)));
      this.press('p' + e.pointerId, n, vel);
    });
    this.el.addEventListener('pointermove', (e) => {
      const src = 'p' + e.pointerId;
      if (!this.held.has(src)) return;
      const n = noteAt(e);
      if (n !== null && n !== this.held.get(src)) this.press(src, n, 100);
    });
    const up = (e) => this.release('p' + e.pointerId);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  // A computer key (from this page, or passed in by the site around it).
  // True when it belongs to the keyboard, so the page keeps it to itself.
  pcDown(code, repeat) {
    if (code === 'KeyZ' || code === 'KeyX') {
      if (!repeat) this.onOctave(code === 'KeyX' ? 12 : -12);
      return true;
    }
    if (!(code in PC)) return false;
    if (!repeat) this.press('k' + code, this.getBase() + PC[code], 100);
    return true;
  }
  pcUp(code) { if (code in PC) this.release('k' + code); }
  releasePc() { for (const s of [...this.held.keys()]) if (s.startsWith('k')) this.release(s); }

  installPc() {
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    window.addEventListener('keydown', (e) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.pcDown(e.code, e.repeat)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.pcUp(e.code));
    window.addEventListener('blur', () => this.releasePc());
  }

  async enableMidi(btn) {
    if (this.midi) return;
    if (!navigator.requestMIDIAccess) { btn.textContent = 'No MIDI'; return; }
    try {
      this.midi = await navigator.requestMIDIAccess();
    } catch {
      btn.textContent = 'MIDI ✕';
      return;
    }
    const hook = () => {
      let n = 0;
      for (const input of this.midi.inputs.values()) { input.onmidimessage = (m) => this.midiIn(m.data); n++; }
      btn.textContent = `MIDI ${n}`;
      btn.setAttribute('aria-pressed', String(n > 0));
    };
    this.midi.onstatechange = hook;
    hook();
  }
  midiIn(d) {
    const st = d[0] & 0xf0;
    if (st === 0x90 && d[2] > 0) this.press('m' + d[1], d[1], d[2]);
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) this.release('m' + d[1]);
    else if (st === 0xb0 && (d[1] === 123 || d[1] === 120)) this.releaseAll();
  }
}
