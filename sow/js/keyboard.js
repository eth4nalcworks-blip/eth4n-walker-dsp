// The playing surface under the editor: an on-screen keyboard (mouse / touch),
// the computer keyboard (A W S E D F T G Y H U J K O L P ; -- Z / X shift the
// octave, C / V velocity), Web MIDI input, and the strips that drive SIREN's
// hidden PitchBend (and, where the engine has it, ModWheel) parameters.

const PITCH_BEND = 110, MOD_WHEEL = 111;
const PC_KEYS = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ',
  'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon'];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);

export class Keyboard {
  constructor(el, { onNote, onParam, strips = ['bend', 'mod'] }) {
    this.el = el;
    this.onNote = onNote;          // (pitch, velocity 0..1; 0 = off)
    this.onParam = onParam;        // (id, normalized)
    this.strips = strips;
    this.low = 36;                 // C2
    this.high = 96;                // C7
    this.pcOctave = 4;             // computer keys start at C4 (MIDI 60)... shifted by Z / X
    this.velocity = 0.8;
    this.held = new Map();         // source -> pitch
    this.count = new Map();        // pitch -> number of sources holding it
    this.keyEls = new Map();
    this.build();
    this.installPc();
  }

  // fewer octaves on a narrow strip, so the keys stay playable on a phone
  fitWidth(px) {
    const oct = Math.max(2, Math.min(5, Math.round(px / 200)));
    const low = oct >= 4 ? 36 : 48;
    const high = low + oct * 12;
    if (low === this.low && high === this.high) return;
    this.releaseAll();
    this.low = low;
    this.high = high;
    this.keyEls.clear();
    this.build();
  }

  build() {
    const el = this.el;
    el.innerHTML = '';
    el.classList.add('kb');

    const left = document.createElement('div');
    left.className = 'kb-side';
    if (this.strips.includes('bend')) left.append(this.strip('BEND', PITCH_BEND, true));
    if (this.strips.includes('mod')) left.append(this.strip('MOD', MOD_WHEEL, false));

    const keys = document.createElement('div');
    keys.className = 'kb-keys';
    const whites = [];
    for (let p = this.low; p <= this.high; p++) if (!isBlack(p)) whites.push(p);
    const ww = 100 / whites.length;
    let wi = 0;
    for (let p = this.low; p <= this.high; p++) {
      const k = document.createElement('div');
      k.dataset.pitch = p;
      if (isBlack(p)) {
        k.className = 'key black';
        k.style.left = `calc(${wi * ww}% - ${ww * 0.3}%)`;
        k.style.width = `${ww * 0.6}%`;
      } else {
        k.className = 'key white';
        k.style.left = `${wi * ww}%`;
        k.style.width = `${ww}%`;
        if (p % 12 === 0) {
          const lab = document.createElement('span');
          lab.textContent = 'C' + (Math.floor(p / 12) - 1);
          k.appendChild(lab);
        }
        wi++;
      }
      keys.appendChild(k);
      this.keyEls.set(p, k);
    }
    // black keys on top
    for (const k of [...keys.children]) if (k.classList.contains('black')) keys.appendChild(k);

    const right = document.createElement('div');
    right.className = 'kb-side kb-info';
    this.info = document.createElement('div');
    this.info.className = 'kb-text';
    this.midiBtn = document.createElement('button');
    this.midiBtn.className = 'kb-btn';
    this.midiBtn.textContent = 'MIDI';
    this.midiBtn.title = 'Use a MIDI keyboard';
    this.midiBtn.addEventListener('click', () => this.enableMidi());
    right.append(this.info, this.midiBtn);
    this.updateInfo();

    el.append(left, keys, right);
    this.installPointer(keys);
  }

  strip(label, id, spring) {
    const wrap = document.createElement('div');
    wrap.className = 'kb-strip';
    const track = document.createElement('div');
    track.className = 'kb-track';
    const fill = document.createElement('div');
    fill.className = 'kb-fill';
    const thumb = document.createElement('div');
    thumb.className = 'kb-thumb';
    track.append(fill, thumb);
    const lab = document.createElement('div');
    lab.className = 'kb-label';
    lab.textContent = label;
    wrap.append(track, lab);
    const set = (v) => {
      v = Math.min(1, Math.max(0, v));
      thumb.style.bottom = `calc(${v * 100}% - ${v * 10}px)`;
      if (spring) {
        fill.style.bottom = `${Math.min(v, 0.5) * 100}%`;
        fill.style.height = `${Math.abs(v - 0.5) * 100}%`;
      } else {
        fill.style.bottom = '0';
        fill.style.height = `${v * 100}%`;
      }
      this.onParam(id, v);
    };
    set(spring ? 0.5 : 0);
    const fromEvent = (ev) => {
      const r = track.getBoundingClientRect();
      return 1 - (ev.clientY - r.top) / r.height;
    };
    track.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      track.setPointerCapture(ev.pointerId);
      set(fromEvent(ev));
      const move = (e) => set(fromEvent(e));
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
        if (spring) set(0.5);
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
    if (id === PITCH_BEND) this.setBend = set; else this.setMod = set;
    return wrap;
  }

  // ---- notes (reference-counted: mouse, PC keys and MIDI may overlap)
  press(src, pitch, vel) {
    if (this.held.has(src)) this.release(src);
    this.held.set(src, pitch);
    const n = (this.count.get(pitch) || 0) + 1;
    this.count.set(pitch, n);
    if (n === 1) this.onNote(pitch, vel);
    this.paint(pitch);
  }
  release(src) {
    const pitch = this.held.get(src);
    if (pitch === undefined) return;
    this.held.delete(src);
    const n = (this.count.get(pitch) || 1) - 1;
    if (n <= 0) { this.count.delete(pitch); this.onNote(pitch, 0); }
    else this.count.set(pitch, n);
    this.paint(pitch);
  }
  releaseAll() { for (const src of [...this.held.keys()]) this.release(src); }
  paint(pitch) {
    const k = this.keyEls.get(pitch);
    if (k) k.classList.toggle('on', this.count.has(pitch));
  }

  installPointer(keys) {
    const pitchAt = (ev) => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      return t && t.dataset && t.dataset.pitch ? Number(t.dataset.pitch)
        : t && t.parentElement && t.parentElement.dataset.pitch ? Number(t.parentElement.dataset.pitch) : null;
    };
    keys.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      keys.setPointerCapture(ev.pointerId);
      const p = pitchAt(ev);
      // lower on the key = louder, as on SIREN's own test keyboards
      const k = p !== null ? this.keyEls.get(p) : null;
      let vel = this.velocity;
      if (k) {
        const r = k.getBoundingClientRect();
        vel = Math.min(1, Math.max(0.2, 0.35 + 0.65 * (ev.clientY - r.top) / r.height));
      }
      if (p !== null) this.press('ptr' + ev.pointerId, p, vel);
    });
    keys.addEventListener('pointermove', (ev) => {
      const src = 'ptr' + ev.pointerId;
      if (!this.held.has(src)) return;
      const p = pitchAt(ev);
      if (p !== null && p !== this.held.get(src)) this.press(src, p, this.velocity);
    });
    const up = (ev) => this.release('ptr' + ev.pointerId);
    keys.addEventListener('pointerup', up);
    keys.addEventListener('pointercancel', up);
  }

  installPc() {
    const typing = (ev) => {
      const t = ev.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (ev) => {
      if (typing(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.code === 'KeyZ' && !ev.repeat) { this.pcOctave = Math.max(0, this.pcOctave - 1); this.updateInfo(); return; }
      if (ev.code === 'KeyX' && !ev.repeat) { this.pcOctave = Math.min(8, this.pcOctave + 1); this.updateInfo(); return; }
      if (ev.code === 'KeyC' && !ev.repeat) { this.velocity = Math.max(0.1, Math.round((this.velocity - 0.1) * 10) / 10); this.updateInfo(); return; }
      if (ev.code === 'KeyV' && !ev.repeat) { this.velocity = Math.min(1, Math.round((this.velocity + 0.1) * 10) / 10); this.updateInfo(); return; }
      const i = PC_KEYS.indexOf(ev.code);
      if (i < 0) return;
      ev.preventDefault();
      if (ev.repeat) return;
      const pitch = (this.pcOctave + 1) * 12 + i;
      if (pitch <= 127) this.press('pc' + ev.code, pitch, this.velocity);
    });
    window.addEventListener('keyup', (ev) => {
      if (PC_KEYS.includes(ev.code)) this.release('pc' + ev.code);
    });
    window.addEventListener('blur', () => this.releaseAll());
  }

  updateInfo() {
    const lo = NAMES[0] + (this.pcOctave);
    this.info.innerHTML = `<b>A–;</b> ${lo}〜 &nbsp; <b>Z X</b> octave &nbsp; <b>C V</b> vel ${Math.round(this.velocity * 127)}`;
  }

  async enableMidi() {
    if (this.midi) return;
    if (!navigator.requestMIDIAccess) { this.midiBtn.textContent = 'NO MIDI'; return; }
    try {
      this.midi = await navigator.requestMIDIAccess();
    } catch {
      this.midiBtn.textContent = 'MIDI ✕';
      return;
    }
    const hook = () => {
      let n = 0;
      for (const input of this.midi.inputs.values()) { input.onmidimessage = (m) => this.onMidi(m.data); n++; }
      this.midiBtn.textContent = n ? `MIDI ${n}` : 'MIDI 0';
      this.midiBtn.classList.toggle('on', n > 0);
    };
    this.midi.onstatechange = hook;
    hook();
  }

  onMidi(d) {
    const st = d[0] & 0xf0;
    if (st === 0x90 && d[2] > 0) this.press('midi' + d[1], d[1], d[2] / 127);
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) this.release('midi' + d[1]);
    else if (st === 0xe0) { if (this.setBend) this.setBend(((d[2] << 7) | d[1]) / 16383); }
    else if (st === 0xb0 && d[1] === 1) { if (this.setMod) this.setMod(d[2] / 127); }
    else if (st === 0xb0 && (d[1] === 123 || d[1] === 120)) this.releaseAll();
  }
}
