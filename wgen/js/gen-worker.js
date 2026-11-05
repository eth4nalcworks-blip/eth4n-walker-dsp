// The generator, off the page's thread: web/gen/morph_gen (engine/gen_api.cpp).
//
// Edits arrive faster than tables can be made while a knob is being dragged,
// so only the newest patch is generated: whatever was queued behind it is
// dropped. The play pyramid costs more than the table, so it is built only once
// no newer patch is waiting -- the preview runs a beat behind the display,
// never the display behind the knob (the app's Document does the same).
//
// In:  { t: 'patch', mph, drag }      generate (drag: skip the pyramid)
//      { t: 'analyze', frame, id }    harmonic magnitudes of one frame
//      { t: 'random', modules, seed, spectral, id }
//      { t: 'import', bytes?, samples?, rate?, id }   a file to work from
//      { t: 'range', begin, end, frames, method, id } cut the held file
//      { t: 'source-clear' }
//      { t: 'export', id }
// Out: { t: 'ready', modules, presets }
//      { t: 'table', data, frames, masks, error, errorSlot, serial }
//      { t: 'play', levels, frames, serial }
//      { t: 'reply', id, ... }

import createModule from '../gen/morph_gen.mjs';

let M = null;
let latest = null;     // the newest patch not yet generated
let busy = false;
let serial = 0;
const early = [];

const str = (p) => M.UTF8ToString(p);
function withString(s, fn) {
  const n = M.lengthBytesUTF8(s) + 1;
  const p = M._malloc(n);
  M.stringToUTF8(s, p, n);
  try { return fn(p); } finally { M._free(p); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function pump() {
  if (busy) return;
  busy = true;
  while (latest) {
    const job = latest;
    latest = null;
    const s = ++serial;
    withString(job.mph, (p) => M._gen_set_patch(p));
    const frames = M._gen_run();
    const data = M.HEAPF32.slice(M._gen_table_ptr() >> 2, (M._gen_table_ptr() >> 2) + frames * 2048);
    const nm = M._gen_mask_count();
    const masks = Array.from(M.HEAPU32.subarray(M._gen_masks() >> 2, (M._gen_masks() >> 2) + nm));
    postMessage({ t: 'table', data, frames, masks, error: str(M._gen_error()), errorSlot: M._gen_error_slot(), serial: s }, [data.buffer]);
    await tick();   // lets queued edits land in `latest`
    if (latest || job.drag) continue;
    M._gen_build_play();
    const levels = [];
    for (let l = 0; l < M._gen_play_levels(); l++) {
      const ptr = M._gen_play_level(l) >> 2;
      levels.push(M.HEAPF32.slice(ptr, ptr + frames * M._gen_play_size(l)));
    }
    postMessage({ t: 'play', levels, frames, serial: s }, levels.map((a) => a.buffer));
    await tick();
  }
  busy = false;
}

function reply(id, body, transfer) { postMessage({ t: 'reply', id, ...body }, transfer || []); }

function handle(m) {
  switch (m.t) {
    case 'patch':
      latest = m;
      pump();
      break;
    case 'analyze': {
      const ptr = M._gen_analyze(m.frame) >> 2;
      const mags = M.HEAPF32.slice(ptr, ptr + M._gen_harmonics());
      reply(m.id, { mags }, [mags.buffer]);
      break;
    }
    case 'random': {
      withString(m.mph, (p) => M._gen_set_patch(p));
      reply(m.id, { mph: str(M._gen_randomize(m.modules ? 1 : 0, m.seed, m.spectral ? 1 : 0)) });
      break;
    }
    case 'import': {
      let n;
      if (m.bytes) {
        const b = new Uint8Array(m.bytes);
        const p = M._gen_alloc(b.length);
        M.HEAPU8.set(b, p);
        n = M._gen_import_wav(p, b.length);
        M._gen_free(p);
      } else {
        const p = M._gen_import_buffer(m.samples.length, m.rate) >> 2;
        M.HEAPF32.set(m.samples, p);
        n = m.samples.length;
      }
      if (n < 0) { reply(m.id, { error: str(M._gen_error()) }); break; }
      const sp = M._gen_import_samples() >> 2;
      const samples = M.HEAPF32.slice(sp, sp + n);
      const tr = M._gen_import_trim() >> 3;
      reply(m.id, { samples, rate: M._gen_import_rate(), clm: M._gen_import_clm(), trim: [M.HEAPF64[tr], M.HEAPF64[tr + 1]] }, [samples.buffer]);
      break;
    }
    case 'range': {
      const frames = M._gen_import_apply(m.begin, m.end, m.frames, m.method);
      reply(m.id, { frames, method: M._gen_import_method(), hz: M._gen_import_hz() });
      break;
    }
    case 'source-clear':
      M._gen_source_clear();
      break;
    case 'export': {
      withString(m.mph, (p) => M._gen_set_patch(p));
      M._gen_run();
      const n = M._gen_export_wav();
      if (!n) { reply(m.id, { error: str(M._gen_error()) }); break; }
      const bytes = M.HEAPU8.slice(M._gen_export_ptr(), M._gen_export_ptr() + n);
      reply(m.id, { bytes }, [bytes.buffer]);
      break;
    }
  }
}

onmessage = (e) => (M ? handle(e.data) : early.push(e.data));

createModule().then((mod) => {
  M = mod;
  const modules = JSON.parse(str(M._gen_modules_json()));
  const presets = [];
  for (let i = 0; i < M._gen_preset_count(); i++) presets.push(str(M._gen_preset_mph(i)));
  postMessage({ t: 'ready', modules, presets });
  for (const m of early) handle(m);
  early.length = 0;
});
