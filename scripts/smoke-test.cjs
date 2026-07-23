#!/usr/bin/env node
/* Headless smoke test: boot the WASM core in Node, run frames, verify that
   video output is non-trivial and audio sample counts match the model.

   Usage: node scripts/smoke-test.cjs [rom.neo] [bios.zip] [system] [region]
   Defaults: romset/mslug.neo romset/neogeo.zip mvs(1) us(0)
*/

const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const romPath = process.argv[2] ?? path.join(projectDir, 'romset/mslug.neo');
const biosPath = process.argv[3] ?? path.join(projectDir, 'romset/neogeo.zip');
const system = Number(process.argv[4] ?? 1); // MVS
const region = Number(process.argv[5] ?? 0); // US

const SAMPLERATE = 48000;
const FRAMES = 900; // ~15s of emulated time
const FRAMERATE = system === 0 ? 59.599484 : 59.185606;

async function main() {
  // package.json declares "type": "module", so require() the UMD loader via
  // a .cjs copy; locateFile still resolves the wasm from dist/.
  const cjsCopy = path.join(projectDir, '.tmp/geolith.smoke.cjs');
  fs.mkdirSync(path.dirname(cjsCopy), { recursive: true });
  fs.copyFileSync(path.join(projectDir, 'dist/geolith/geolith.js'), cjsCopy);
  const createGeolithModule = require(cjsCopy);
  const mod = await createGeolithModule({
    locateFile: (p) => path.join(projectDir, 'dist/geolith', p),
  });

  mod._geowasm_setup(system, region, SAMPLERATE, 1 /* unihw: MVS */);
  mod._geowasm_set_dips(0, 0);

  const bios = fs.readFileSync(biosPath);
  const biosPtr = mod._malloc(bios.length);
  mod.HEAPU8.set(bios, biosPtr);
  if (!mod._geowasm_load_bios(biosPtr, bios.length)) {
    throw new Error('BIOS load failed');
  }
  mod._free(biosPtr);

  const rom = fs.readFileSync(romPath);
  const romPtr = mod._malloc(rom.length);
  mod.HEAPU8.set(rom, romPtr);
  if (!mod._geowasm_load_rom(romPtr, rom.length)) {
    throw new Error('ROM load failed');
  }

  mod._geowasm_reset(1);

  const expectedSamps = Math.floor(SAMPLERATE / FRAMERATE) * 2;
  let sampsTotal = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i++) {
    sampsTotal += mod._geowasm_exec();
  }
  const avgSamps = sampsTotal / FRAMES;
  if (Math.abs(avgSamps - expectedSamps) > 8) {
    throw new Error(`avg audio samps/frame ${avgSamps.toFixed(1)}, expected ~${expectedSamps}`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Inspect the visible frame: count distinct colors and non-black pixels.
  const ptr = mod._geowasm_frame_rgba(8, 24, 304, 224);
  const frame = mod.HEAPU8.subarray(ptr, ptr + 304 * 224 * 4);
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const rgb = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
    colors.add(rgb);
    if (rgb !== 0) nonBlack++;
  }

  // Audio energy: sum |sample| over the last frame's buffer.
  const lastSamps = mod._geowasm_exec();
  const aptr = mod._geowasm_audio_ptr();
  const audio = mod.HEAP16.subarray(aptr >> 1, (aptr >> 1) + lastSamps);
  let energy = 0;
  for (let i = 0; i < audio.length; i++) energy += Math.abs(audio[i]);

  const fps = (FRAMES / (elapsedMs / 1000)).toFixed(0);
  console.log(`ran ${FRAMES} frames in ${elapsedMs.toFixed(0)}ms (${fps} fps headless)`);
  console.log(`audio: ${sampsTotal} int16 total, ${expectedSamps} per frame expected, energy=${energy}`);
  console.log(`video: ${colors.size} distinct colors, ${nonBlack}/${304 * 224} non-black pixels`);

  if (colors.size < 8) throw new Error('framebuffer looks blank — video pipeline broken?');
  if (sampsTotal < FRAMES * expectedSamps * 0.9) throw new Error('audio undergenerating');
  console.log('SMOKE TEST PASS');
}

main().catch((err) => {
  console.error('SMOKE TEST FAIL:', err.message);
  process.exit(1);
});
