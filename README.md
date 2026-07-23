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
package ships a small custom C shim ([shim/geo_shim.c](shim/geo_shim.c))
instead of an Emscripten SDL layer: **no ASYNCIFY, no SDL, no emulated GL**.
The JS SDK drives one `geo_exec()` per frame, blits the framebuffer to a 2D
canvas, and streams audio through an `AudioWorklet` ring buffer. Emulation is
**audio-clocked**: frames are produced to keep ~90 ms of audio queued, which
locks speed to the audio hardware with no resampling drift.

## ROM format

Geolith loads **TerraOnion NeoSD `.neo` files only** (one file per game).
Convert MAME-format Neo Geo ROM sets with
[NeoBuilder](https://wiki.terraonion.com/index.php/Neobuilder_Guide). A
MAME-format BIOS zip is also required:

| System (`options.system`) | BIOS asset |
|---------------------------|-----------|
| `mvs` (arcade, default)   | `neogeo.zip` |
| `uni` (Universe BIOS)     | `neogeo.zip` (with `uni-bios.rom` inside) |
| `aes` (home console)      | `aes.zip` |

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/geolith-wasm';

const engine = await load({
  canvasEl: canvas,               // or attachTo: containerEl
  assets: {
    rom: neoFileBytes,            // TerraOnion .neo cartridge image
    bios: neogeoZipBytes,         // MAME-format neogeo.zip / aes.zip
  },
  options: { system: 'mvs', region: 'us' },
  onEvent: (e) => console.log(e),
});
engine.start();
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `system` | `mvs` | `aes` (console), `mvs` (arcade), `uni` (Universe BIOS). |
| `region` | `us` | `us`, `jp`, `as`, `eu`. |
| `renderFilter` | `pixelated` | `pixelated` (crisp) or `smooth` (linear). |
| `overscanMask` | `8` | Pixels masked per edge; 8 → standard 304×224 picture. |
| `freeplay` | `false` | MVS freeplay DIP switch (no coins needed). |
| `settingMode` | `false` | MVS setting-mode DIP (hardware menu at boot). |
| `memcard` | `true` | Emulate an inserted memory card. |
| `volume` | `1.0` | Master audio volume. |

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
