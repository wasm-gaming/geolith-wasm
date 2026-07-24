# @wasm-gaming/geolith-wasm

[Geolith](https://gitlab.com/jgemu/geolith) — a highly accurate SNK **Neo Geo
AES/MVS** emulator by Rupert Carmichael — compiled to WebAssembly via
Emscripten and packaged as a wasm-gaming engine SDK.

This subproject follows the same engine-package approach used by fbneo-wasm,
jgenesis-wasm, blastem-wasm, and rsdkv*:

- typed `manifest`
- typed `options`
- `load(config)` engine SDK surface
- Makefile-driven build (`build-sdk`, `build-wasm`, `preview`)

It conforms to the [`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs)
contract (`EngineSDK` = `{ manifest, load }`).

Unlike the SDL-based ports, Geolith's core is frontend-free pure C11, so this
package ships a small custom C shim ([scripts/shim/geo_shim.c](scripts/shim/geo_shim.c))
instead of an Emscripten SDL layer: **no ASYNCIFY, no SDL, no emulated GL**.
The JS SDK drives one `geo_exec()` per frame, blits the framebuffer to a 2D
canvas, and streams audio through an `AudioWorklet` ring buffer. Emulation is
**audio-clocked**: frames are produced to keep ~90 ms of audio queued, which
locks speed to the audio hardware with no resampling drift.

## ROM format

Geolith loads **TerraOnion NeoSD `.neo` files** for cartridge systems (one
file per game). Convert MAME-format Neo Geo ROM sets with
[NeoBuilder](https://wiki.terraonion.com/index.php/Neobuilder_Guide). For the
experimental CD systems, pass a **zip of the disc image** (`.cue` + `.bin`)
as the `rom` asset. A MAME-format BIOS zip is always required:

| System (`options.system`) | BIOS assets |
|---------------------------|-------------|
| `uni` (Universe BIOS)     | `bios`: neogeo.zip (with `uni-bios_4_0.rom` inside) |
| `mvs` (arcade)            | `bios`: neogeo.zip |
| `aes` (home console)      | `bios`: aes.zip |
| `cdf` / `cdt` (Neo Geo CD, experimental) | `bios`: neocd.zip, `bios2`: neocdz.zip |
| `cdz` / `cdu` (CDZ, experimental) | `bios`: neocdz.zip |

The Irritating Maze additionally takes `bios2`: irrmaze.zip.

For the cartridge systems `options.system` may be left unset — it is inferred
from the BIOS zip: neogeo.zip → `uni` (or `mvs` if it has no
`uni-bios_4_0.rom`), aes.zip → `aes`. Setting it explicitly always wins, and
is required for the CD systems.

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/geolith-wasm';

const engine = await load({
  canvasEl: canvas,               // or attachTo: containerEl
  assets: {
    rom: neoFileBytes,            // TerraOnion .neo cartridge image
    bios: neogeoZipBytes,         // MAME-format neogeo.zip / aes.zip
  },
  options: { system: 'uni', region: 'us' },
  onEvent: (e) => console.log(e),
});
engine.start();
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `system` | auto | Detected from the BIOS zip (see above); set explicitly to override. `aes`, `mvs`, `uni`, or (experimental) `cdf`/`cdt`/`cdz`/`cdu`. |
| `region` | `us` | `us`, `jp`, `as`, `eu`. |
| `unihw` | `mvs` | Hardware the Universe BIOS should detect (`uni` only). |
| `inputMode` | `auto` | `auto` (game-database controllers), `joystick`, `mahjong`, `4p` (NEO-FTC1B; MVS + JP/AS only). |
| `renderFilter` | `pixelated` | `pixelated` (crisp) or `smooth` (linear). |
| `overscanMask` | `8` | Pixels masked per edge; 8 → standard 304×224 picture. |
| `freeplay` | `false` | MVS freeplay DIP switch (no coins needed). |
| `settingMode` | `false` | MVS setting-mode DIP (hardware menu at boot). |
| `memcard` | `true` | Emulate an inserted memory card. |
| `memcardWriteProtect` | `false` | Write-protect the memory card. |
| `rawPalette` | `false` | Raw palette instead of the resistor network. |
| `adpcmWrap` | `true` | ADPCM wrap; disable to fix SFX in Ganryu etc. |
| `overclock` | `false` | Disable the 68K clock divider. |
| `volume` | `1.0` | Master audio volume. |
| `gamepads` | `true` | Poll gamepads (standard mapping) each frame. |

### Capabilities

- **Save states**: `saveState()` / `loadState()` via the core's raw state API.
- **SRAM persistence**: NVRAM, cartridge SRAM, and memory card are persisted
  to OPFS (`geolith/<storageNamespace>/`) on pause/destroy and every 15 s;
  `purgeStorage()` removes the active namespace.
- **Screenshots**: `screenshot()` returns a PNG blob.

### Default controls

| Control | P1 | P2 |
|---------|----|----|
| D-pad | Arrow keys | I/K/J/L |
| A / B / C / D | Z / X / C / V | G / H / B / N |
| Start | 1 (or Enter) | 2 |
| Select | 3 (or Right Shift) | 4 |
| Coin 1 / Coin 2 | 5 | 6 |
| Service / Test | 9 | F2 |

Gamepads (standard mapping) are polled automatically: d-pad/left stick,
face buttons → A/B/C/D, Start → start, Back/Select → coin, LB → select.

Special controllers are wired automatically for games that need them
(`inputMode: 'auto'`): the **mahjong panel** (tiles A–N on the letter keys,
Pon/Chi/Kan/Reach/Ron on O/P/[/]/\\), **V-Liner** buttons, and the
**Irritating Maze trackball** (mouse movement over the canvas, Z/X/C/V
buttons). `inputMode: '4p'` adds P3 (R/F/T/Y + 7/8, F3) and P4 (numpad,
F4) for the NEO-FTC1B 4-player board.

Rebind via `engine.setInput({ 'p1.a': 'KeyJ', ... })` (KeyboardEvent codes).

## Build

```sh
make build        # Full build: WASM (Docker/Emscripten) + TypeScript SDK
make build-sdk    # TypeScript only (SDK + manifest + demo shell)
make build-wasm   # Geolith WASM only (via Docker)
make preview      # Serve dist/ at :8028 with COOP/COEP headers
```

The WASM build clones a pinned Geolith revision and compiles the enumerated
core sources directly with `emcc` — no upstream-makefile patching is needed
(the core is pure C11 with vendored miniz/speex and a pre-generated 68K core).

## WASM artifacts

| File | Description |
|------|-------------|
| `geolith.js` | Emscripten module loader (`createGeolithModule`). |
| `geolith.wasm` | Compiled Geolith core + shim. |

No SharedArrayBuffer or COOP/COEP headers are required at runtime (the
preview server sets them anyway for parity with sibling engines).

See [CORE.md](CORE.md) for the mapping between upstream Geolith capabilities
and what this wrapper exposes.
