# Geolith core ↔ wrapper mapping

Upstream: https://gitlab.com/jgemu/geolith (pinned in
[scripts/build-geolith.sh](scripts/build-geolith.sh), see `GEOLITH_REF`).

Geolith is a Jolly Good API core; upstream `jg.c` is its only frontend
binding. This port **does not compile jg.c** — [shim/geo_shim.c](shim/geo_shim.c)
re-implements the same wiring against the core's own headers (`geo.h`,
`geo_lspc.h`, `geo_mixer.h`, `geo_neo.h`) with a flat C ABI for JS.

## What is exposed

| Upstream capability | This wrapper |
|---------------------|--------------|
| Cartridge systems: AES / MVS / Universe BIOS | ✅ `options.system` (+ `unihw` for UniBIOS hardware detect) |
| Regions US/JP/AS/EU | ✅ `options.region` |
| TerraOnion `.neo` loading (`geo_neo_load`) | ✅ `assets.rom` |
| BIOS zip from memory (`geo_bios_load_mem[_aux]`, miniz) | ✅ `assets.bios` + optional `assets.bios2` |
| Video: XRGB8888 320×264 buffer, visible 304×224 | ✅ RGBA-converted crop → 2D canvas (`overscanMask`) |
| Audio: YM2610 → Speex resampler → int16 stereo | ✅ resampled to the AudioContext rate, AudioWorklet sink |
| Input: 2 Neo Geo joysticks + system buttons + DIPs | ✅ keyboard + gamepads, rebindable (`setInput`) |
| Mahjong / V-Liner / trackball (Irritating Maze) inputs | ✅ auto-selected from the `.neo` database flags (`inputMode`); trackball = mouse |
| 4-player NEO-FTC1B mode | ✅ `inputMode: '4p'` (MVS + JP/AS) |
| Save states (`geo_state_save_raw` etc.) | ✅ `saveState`/`loadState` |
| NVRAM / cart SRAM / memory card / CD backup RAM | ✅ persisted to OPFS (`geo_mem_ptr`) |
| MVS DIPs: freeplay, setting mode | ✅ options |
| Palettes: resistor network / raw | ✅ `rawPalette` |
| ADPCM wrap hack, 68K overclock (`geo_set_div68k`) | ✅ `adpcmWrap`, `overclock` |
| Neo Geo CD / CDZ (`.cue`+`.bin` zip) | ⚠️ **experimental, untested** — wired end-to-end (miniz unzip → MEMFS → `geo_disc_open` → `geo_cd_postload`) but not yet verified against a real BIOS/disc image |
| `.chd` disc images | ❌ CHD support compiled out (needs libchdr) |
| Watchdog tolerance tuning | ❌ upstream default |

## Timing model

- The core emits `samplerate / framerate` stereo frames per `geo_exec()`
  (framerate = 59.185606 MVS / 59.599484 AES). The shim passes the browser's
  actual `AudioContext.sampleRate` to `geo_mixer_set_rate()`, so produced
  audio matches consumed audio exactly at native speed.
- The SDK runs frames only when the audio ring buffer is below ~90 ms
  (audio-clocked pacing); when the AudioContext is suspended (autoplay
  policy), it falls back to wall-clock pacing so video still runs.
- Catch-up frames (max 5/tick) render with `geo_lspc_set_skip_render` to
  avoid wasted rasterization.

## Memory model

- `geo_neo_load` **aliases** ROM regions inside the passed buffer, so the SDK
  copies the `.neo` file into WASM heap once and never frees it.
- The BIOS zip is extracted to core-owned heap; the SDK frees its staging
  copy right after `geo_bios_load_mem`.
- Built with `ALLOW_MEMORY_GROWTH` + 128 MB initial heap (largest retail
  `.neo` carts are ~96 MB). Emscripten MEMFS is enabled solely for the CD
  path (disc zips are unpacked to `/disc/` in the shim); cartridge mode
  touches no filesystem.
