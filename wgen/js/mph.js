// The patch on the page: the .mph text format (source/dsp/patch_io.h), read
// into a plain object and written back. The worker parses the same text with
// the app's own reader, so this file only has to agree with savePatch.
//
// patch = {
//   name, frames, post: { norm, dc, lock, limit },
//   preview: { baseNote, cents, volume, posSource, pos, posRate, posAmount,
//              uniVoices, uniDetune, uniWidth, filterType, cutoff, reso,
//              filterEnv, attack, decay, sustain, release },
//   slots: [{ on, domain (0 time, 1 spectral), module, amp, phase,
//             k: [{ start, end, link, lock } x 8] }]
// }

export const KNOBS = 8;
export const MAX_SLOTS = 16;
export const MAX_FRAMES = 256;

export const PREVIEW_KEYS = ['baseNote', 'cents', 'volume', 'posSource', 'pos', 'posRate', 'posAmount',
  'uniVoices', 'uniDetune', 'uniWidth', 'filterType', 'cutoff', 'reso', 'filterEnv',
  'attack', 'decay', 'sustain', 'release'];

// dsp::PreviewState's defaults
export function defaultPreview() {
  return {
    baseNote: 29, cents: 0, volume: 0.45,
    posSource: 2, pos: 0, posRate: 0.55, posAmount: 1,
    uniVoices: 1, uniDetune: 0.2, uniWidth: 0.5,
    filterType: 0, cutoff: 1, reso: 0.1, filterEnv: 0,
    attack: 0.005, decay: 0.6, sustain: 0.75, release: 0.25,
  };
}

export function newKnob(v = 0.5) { return { start: v, end: v, link: true, lock: false }; }

export function newSlot() {
  return { on: true, domain: 0, module: 0, amp: 'sin(tau*x)', phase: '', k: Array.from({ length: KNOBS }, () => newKnob()) };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// C locale, nine significant digits: what num() in patch_io.h writes
const num = (v) => String(Number(Number(v).toPrecision(9)));

export function save(p) {
  const o = [];
  o.push('MORPHEUS 1');
  o.push('name ' + (p.name || 'INIT'));
  o.push('frames ' + p.frames);
  o.push(`post ${p.post.norm} ${p.post.dc ? 1 : 0} ${p.post.lock ? 1 : 0} ${p.post.limit}`);
  const v = p.preview;
  o.push('preview ' + PREVIEW_KEYS.map((k) => (['baseNote', 'posSource', 'uniVoices', 'filterType'].includes(k) ? String(Math.round(v[k])) : num(v[k]))).join(' '));
  for (const s of p.slots) {
    o.push(`slot ${s.on ? 1 : 0} ${s.domain} ${s.module}`);
    o.push('amp ' + (s.amp || ''));
    if (s.phase) o.push('phase ' + s.phase);
    for (const k of s.k) o.push(`knob ${num(k.start)} ${num(k.end)} ${k.link ? 1 : 0} ${k.lock ? 1 : 0}`);
  }
  return o.join('\n') + '\n';
}

// null when the text is not a patch; unknown keys are skipped, as in the app.
// `counts` = [time module count, spectral module count] for clamping.
export function load(text, counts = [64, 64]) {
  const lines = String(text).split('\n');
  if (!lines.length || !lines[0].replace(/[\r ]+$/, '').startsWith('MORPHEUS')) return null;
  const p = { name: 'INIT', frames: 256, post: { norm: 2, dc: true, lock: false, limit: 0 }, preview: defaultPreview(), slots: [] };
  let ki = 0;
  const rest = (line, key) => (line.length <= key.length + 1 ? '' : line.slice(key.length + 1));
  const nums = (s) => s.trim().split(/\s+/).map(Number);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/[\r\n ]+$/, '');
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const r = rest(line, key);
    if (key === 'name') p.name = r;
    else if (key === 'frames') p.frames = clamp(parseInt(r, 10) || 1, 1, MAX_FRAMES);
    else if (key === 'post') {
      const [norm = 2, dc = 1, lock = 0, limit = 0] = nums(r);
      p.post = { norm: clamp(norm | 0, 0, 2), dc: dc !== 0, lock: lock !== 0, limit: clamp(limit | 0, 0, 1024) };
    } else if (key === 'preview') {
      const v = nums(r);
      PREVIEW_KEYS.forEach((k, j) => { if (Number.isFinite(v[j])) p.preview[k] = v[j]; });
      const pv = p.preview;
      pv.baseNote = clamp(Math.round(pv.baseNote), 0, 127);
      pv.posSource = clamp(Math.round(pv.posSource), 0, 4);
      pv.uniVoices = clamp(Math.round(pv.uniVoices), 1, 7);
      pv.filterType = clamp(Math.round(pv.filterType), 0, 2);
    } else if (key === 'slot') {
      if (p.slots.length >= MAX_SLOTS) continue;
      const [on = 1, domain = 0, module = 0] = nums(r);
      const s = newSlot();
      s.on = on !== 0;
      s.domain = domain === 0 ? 0 : 1;
      s.module = clamp(module | 0, 0, counts[s.domain] - 1);
      s.amp = '';
      p.slots.push(s);
      ki = 0;
    } else if (key === 'amp' && p.slots.length) p.slots[p.slots.length - 1].amp = r;
    else if (key === 'phase' && p.slots.length) p.slots[p.slots.length - 1].phase = r;
    else if (key === 'knob' && p.slots.length) {
      if (ki >= KNOBS) continue;
      const [start = 0.5, end = 0.5, link = 1, lock = 0] = nums(r);
      p.slots[p.slots.length - 1].k[ki++] = { start: clamp(start, 0, 1), end: clamp(end, 0, 1), link: link !== 0, lock: lock !== 0 };
    }
  }
  if (!p.slots.length) p.slots.push(newSlot());
  return p;
}

export const clone = (p) => JSON.parse(JSON.stringify(p));
