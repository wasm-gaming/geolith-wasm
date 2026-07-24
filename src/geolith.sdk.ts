import type {
  AssetData,
  EngineConfig,
  EngineEvent,
  EngineInstance,
  InputPreset,
  KeyMap,
} from '@wasm-gaming/engine-specs';
import { manifest } from './geolith.manifest.js';
import {
  DEFAULT_GEOLITH_OPTIONS,
  GEOLITH_INPUT_MODE_IDS,
  GEOLITH_REGION_IDS,
  GEOLITH_SYSTEM_IDS,
  type GeolithOptions,
  type GeolithSystem,
} from './geolith.options.js';

export { manifest };

/**
 * Shape of the Emscripten module produced by scripts/build-geolith.sh
 * (`-sMODULARIZE -sEXPORT_NAME=createGeolithModule`, heap views + ccall
 * exported). All engine entry points are flat C exports from
 * shim/geo_shim.c — no SDL, no main loop, no ASYNCIFY: the SDK drives one
 * `_geowasm_exec()` per emulated frame.
 */
type GeolithModule = {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _geowasm_setup(system: number, region: number, samplerate: number, unihw: number): void;
  _geowasm_load_bios(ptr: number, size: number): number;
  _geowasm_load_bios_aux(ptr: number, size: number): number;
  _geowasm_load_rom(ptr: number, size: number): number;
  _geowasm_neo_flags(): number;
  _geowasm_disc_unzip(ptr: number, size: number): number;
  _geowasm_disc_open_auto(): number;
  _geowasm_reset(hard: number): void;
  _geowasm_exec(): number;
  _geowasm_audio_ptr(): number;
  _geowasm_skip_render(skip: number): void;
  _geowasm_frame_rgba(x: number, y: number, w: number, h: number): number;
  _geowasm_input(port: number, mask: number): void;
  _geowasm_input_sys(mask: number): void;
  _geowasm_input_axis(dx: number, dy: number): void;
  _geowasm_set_input_mode(mode: number): void;
  _geowasm_set_dips(freeplay: number, settingmode: number): void;
  _geowasm_set_memcard(inserted: number, wp: number): void;
  _geowasm_set_palette(raw: number): void;
  _geowasm_set_adpcm_wrap(wrap: number): void;
  _geowasm_set_overclock(oc: number): void;
  _geowasm_state_size(): number;
  _geowasm_state_save(): number;
  _geowasm_state_load(ptr: number): number;
  _geowasm_savedata_ptr(type: number): number;
  _geowasm_savedata_size(): number;
  _geowasm_savedata_restore(type: number, ptr: number, size: number): number;
  _geowasm_cartram_present(): number;
};

type GeolithModuleFactory = (
  overrides: Record<string, unknown>,
) => Promise<GeolithModule>;

// geo.h framerates: MVS/UNI run at the MVS rate; AES and the CD systems at
// the AES rate (matches geo_mixer_init()).
const FRAMERATE_AES = 59.599484;
const FRAMERATE_MVS = 59.185606;

// geo_neo.h database flags for special-controller games.
const DB_MAHJONG = 0x01;
const DB_IRRMAZE = 0x02;
const DB_VLINER = 0x04;

// geo.h geo_memtype values for battery-backed regions we persist.
const MEMTYPE_NVRAM = 4;
const MEMTYPE_CARTRAM = 5;
const MEMTYPE_MEMCARD = 7;
const MEMTYPE_CDBRAM = 9;

const SAVEDATA_FILES: Array<{ type: number; file: string }> = [
  { type: MEMTYPE_NVRAM, file: 'nvram.bin' },
  { type: MEMTYPE_CARTRAM, file: 'cartram.bin' },
  { type: MEMTYPE_MEMCARD, file: 'memcard.bin' },
  { type: MEMTYPE_CDBRAM, file: 'cdbram.bin' },
];

// The active input device, resolved after ROM load (mirrors the shim's
// shim_params_input decision).
type InputDevice = 'js' | 'mahjong' | 'vliner' | 'irrmaze';

/**
 * Default keyboard bindings (KeyboardEvent.code → control), following the
 * MAME/FBNeo arcade conventions: 1/2 start, 5/6 coin, 9 service, F2 test.
 */
const DEFAULT_KEYMAP: Record<string, string> = {
  'p1.up': 'ArrowUp',
  'p1.down': 'ArrowDown',
  'p1.left': 'ArrowLeft',
  'p1.right': 'ArrowRight',
  'p1.a': 'KeyZ',
  'p1.b': 'KeyX',
  'p1.c': 'KeyC',
  'p1.d': 'KeyV',
  'p1.start': 'Digit1',
  'p1.select': 'Digit3',
  'p2.up': 'KeyI',
  'p2.down': 'KeyK',
  'p2.left': 'KeyJ',
  'p2.right': 'KeyL',
  'p2.a': 'KeyG',
  'p2.b': 'KeyH',
  'p2.c': 'KeyB',
  'p2.d': 'KeyN',
  'p2.start': 'Digit2',
  'p2.select': 'Digit4',
  'sys.coin1': 'Digit5',
  'sys.coin2': 'Digit6',
  'sys.service': 'Digit9',
  'sys.test': 'F2',
};

/** Mahjong panel: tiles A–N on their letter keys, calls on the row above. */
const MAHJONG_KEYMAP: Record<string, string> = {
  'p1.pon': 'KeyO',
  'p1.chi': 'KeyP',
  'p1.kan': 'BracketLeft',
  'p1.reach': 'BracketRight',
  'p1.ron': 'Backslash',
  'p1.start': 'Digit1',
  'p1.select': 'Digit3',
  'sys.coin1': 'Digit5',
  'sys.coin2': 'Digit6',
  'sys.service': 'Digit9',
  'sys.test': 'F2',
};
for (let i = 0; i < 14; i++) {
  const letter = String.fromCharCode(65 + i); // A..N
  MAHJONG_KEYMAP[`p1.mj${letter.toLowerCase()}`] = `Key${letter}`;
}

const VLINER_KEYMAP: Record<string, string> = {
  'p1.up': 'ArrowUp',
  'p1.down': 'ArrowDown',
  'p1.left': 'ArrowLeft',
  'p1.right': 'ArrowRight',
  'p1.big': 'KeyZ',
  'p1.small': 'KeyX',
  'p1.dup': 'KeyC',
  'p1.start': 'Digit1',
  'p1.operator': 'KeyO',
  'p1.clearcredit': 'KeyP',
  'p1.hopperout': 'KeyU',
  'sys.coin1': 'Digit5',
  'sys.coin2': 'Digit6',
  'sys.service': 'Digit9',
  'sys.test': 'F2',
};

/** Trackball movement comes from the mouse; buttons on the keyboard. */
const IRRMAZE_KEYMAP: Record<string, string> = {
  'p1.lefta': 'KeyZ',
  'p1.leftb': 'KeyX',
  'p1.righta': 'KeyC',
  'p1.rightb': 'KeyV',
  'p1.start': 'Digit1',
  'sys.coin1': 'Digit5',
  'sys.coin2': 'Digit6',
  'sys.service': 'Digit9',
  'sys.test': 'F2',
};

/** Extra P3/P4 bindings layered on top of DEFAULT_KEYMAP in 4-player mode. */
const FOURP_EXTRA_KEYMAP: Record<string, string> = {
  'p3.up': 'KeyT',
  'p3.down': 'KeyF',
  'p3.left': 'KeyR',
  'p3.right': 'KeyY',
  'p3.a': 'Digit7',
  'p3.b': 'Digit8',
  'p3.start': 'F3',
  'p4.up': 'Numpad8',
  'p4.down': 'Numpad5',
  'p4.left': 'Numpad4',
  'p4.right': 'Numpad6',
  'p4.a': 'Numpad1',
  'p4.b': 'Numpad2',
  'p4.start': 'F4',
};

// Extra codes always accepted on top of the active map (QoL aliases).
const KEYMAP_ALIASES: Record<string, string> = {
  Enter: 'p1.start',
  ShiftRight: 'p1.select',
};

// Control-name → bit index within a player's active-high mask, per device.
// Port -1 marks system buttons (coin/service/test).
const JS_BITS: Record<string, number> = {
  up: 0, down: 1, left: 2, right: 3,
  a: 4, b: 5, c: 6, d: 7,
  start: 8, select: 9,
};
const MAHJONG_BITS: Record<string, number> = {
  mja: 0, mjb: 1, mjc: 2, mjd: 3, mje: 4, mjf: 5, mjg: 6,
  mjh: 7, mji: 8, mjj: 9, mjk: 10, mjl: 11, mjm: 12, mjn: 13,
  pon: 14, chi: 15, kan: 16, reach: 17, ron: 18,
  select: 19, start: 20,
};
const VLINER_BITS: Record<string, number> = {
  up: 0, down: 1, left: 2, right: 3,
  big: 4, small: 5, dup: 6, start: 7,
  operator: 8, clearcredit: 9, hopperout: 10,
};
const IRRMAZE_BITS: Record<string, number> = {
  lefta: 0, leftb: 1, righta: 2, rightb: 3, start: 4,
};
const SYS_BITS: Record<string, number> = {
  coin1: 0, coin2: 1, service: 2, test: 3,
};

const DEVICE_BITS: Record<InputDevice, Record<string, number>> = {
  js: JS_BITS,
  mahjong: MAHJONG_BITS,
  vliner: VLINER_BITS,
  irrmaze: IRRMAZE_BITS,
};

const DEVICE_KEYMAPS: Record<InputDevice, Record<string, string>> = {
  js: DEFAULT_KEYMAP,
  mahjong: MAHJONG_KEYMAP,
  vliner: VLINER_KEYMAP,
  irrmaze: IRRMAZE_KEYMAP,
};

/** AudioWorklet processor: a simple SPSC float ring fed int16 chunks. */
const WORKLET_SOURCE = `
class GeolithSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 32768; // frames
    this.buf = new Float32Array(this.cap * 2);
    this.r = 0;
    this.w = 0;
    this.consumed = 0;
    this.lastPost = 0;
    this.port.onmessage = (e) => {
      const s = e.data; // Int16Array, interleaved stereo
      const frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.w - this.r >= this.cap) break; // full: drop excess
        const idx = (this.w % this.cap) * 2;
        this.buf[idx] = s[i * 2] / 32768;
        this.buf[idx + 1] = s[i * 2 + 1] / 32768;
        this.w++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    for (let i = 0; i < n; i++) {
      if (this.r < this.w) {
        const idx = (this.r % this.cap) * 2;
        L[i] = this.buf[idx];
        R[i] = this.buf[idx + 1];
        this.r++;
      } else {
        L[i] = 0;
        R[i] = 0;
      }
    }
    this.consumed += n;
    if (this.consumed - this.lastPost >= 1024) {
      this.port.postMessage(this.consumed);
      this.lastPost = this.consumed;
    }
    return true;
  }
}
registerProcessor('geolith-sink', GeolithSink);
`;

const scriptLoadCache = new Map<string, Promise<void>>();

function loadClassicScriptOnce(src: string): Promise<void> {
  const cached = scriptLoadCache.get(src);
  if (cached) return cached;

  const p = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`geolith: failed to load script: ${src}`));
    document.head.appendChild(script);
  });

  scriptLoadCache.set(src, p);
  return p;
}

function toUint8(x: AssetData | undefined | unknown): Uint8Array | null {
  if (x == null) return null;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('geolith: asset must be Uint8Array | ArrayBuffer | string');
}

/**
 * Read the member names out of a zip's central directory. Names are all that
 * is needed to tell one MAME BIOS set from another, so nothing is inflated
 * here — the core's miniz still does the real extraction.
 */
function listZipNames(zip: Uint8Array): Set<string> {
  const names = new Set<string>();
  if (zip.length < 22) return names;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // The end-of-central-directory record trails a comment of up to 64 KiB.
  let eocd = -1;
  const limit = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= limit; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return names;

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count && off + 46 <= zip.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break; // central file header
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    names.add(decoder.decode(zip.subarray(off + 46, off + 46 + nameLen)));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Infer the cartridge system from the BIOS zip, so dropping in neogeo.zip or
 * aes.zip works without also setting `options.system`.
 *
 * `sfix.sfix` + `sm1.sm1` are the MVS-only ROMs that separate an arcade set
 * from a console one. The Universe BIOS needs them too (geo.c treats
 * SYSTEM_UNI as MVS-class), so `uni` can only win on an MVS set — every
 * aes.zip also ships uni-bios_*.rom, and those alone are not enough to boot.
 *
 * Returns null for anything else (CD sets, unrecognised zips); the caller
 * then keeps its configured default.
 */
function detectCartSystem(bios: Uint8Array): GeolithSystem | null {
  const names = listZipNames(bios);
  if (names.has('sfix.sfix') && names.has('sm1.sm1')) {
    return names.has('uni-bios_4_0.rom') ? 'uni' : 'mvs';
  }
  if (names.has('neo-epo.bin') || names.has('neo-po.bin')) return 'aes';
  return null;
}

function resolveCanvas(config: EngineConfig): HTMLCanvasElement {
  const c =
    (config as { canvasEl?: HTMLCanvasElement }).canvasEl ??
    (config as { canvas?: HTMLCanvasElement }).canvas;
  if (c) return c;

  const attachTo = (config as { attachTo?: HTMLElement }).attachTo;
  if (attachTo) {
    const existing = attachTo.querySelector('canvas');
    if (existing) return existing;
    const created = document.createElement('canvas');
    attachTo.appendChild(created);
    return created;
  }
  throw new Error('geolith: config.canvasEl or config.attachTo is required');
}

async function opfsDir(
  namespace: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const engineDir = await root.getDirectoryHandle('geolith', { create });
    return await engineDir.getDirectoryHandle(namespace, { create });
  } catch {
    return null;
  }
}

/** Copy bytes into the WASM heap; returns the pointer (caller frees). */
function heapAlloc(mod: GeolithModule, bytes: Uint8Array): number {
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

export async function load(config: EngineConfig): Promise<EngineInstance> {
  const { assets, onEvent } = config;

  const emit = (e: EngineEvent): void => {
    try {
      onEvent?.(e);
    } catch {
      // host callback must not break the engine runtime
    }
  };

  const romBytes = toUint8(assets?.rom ?? assets?.data);
  if (!romBytes) {
    throw new Error(
      'geolith: no ROM provided — pass assets.rom (a .neo cartridge image, or a zip of .cue/.bin for the CD systems)',
    );
  }
  const biosBytes = toUint8(assets?.bios);
  if (!biosBytes) {
    throw new Error(
      'geolith: no BIOS provided — pass assets.bios (MAME neogeo.zip for MVS/Universe, aes.zip for AES, neocd.zip/neocdz.zip for CD)',
    );
  }

  // An explicit options.system always wins; otherwise the BIOS zip picks the
  // system, since a set that cannot supply the required ROMs would only fail
  // in the core. DEFAULT_GEOLITH_OPTIONS.system is the last resort.
  const requested = config.options as GeolithOptions | undefined;
  const opts: Required<GeolithOptions> = {
    ...DEFAULT_GEOLITH_OPTIONS,
    ...requested,
    system:
      requested?.system ??
      detectCartSystem(biosBytes) ??
      DEFAULT_GEOLITH_OPTIONS.system,
  };

  const isCd = GEOLITH_SYSTEM_IDS[opts.system] >= 3;

  // Arcade-board features (trackball, 4-player NEO-FTC1B) key off the board,
  // not the BIOS: the Universe BIOS also runs on MVS hardware when it is told
  // to detect it. Same test the shim uses to idle the coin 3/4 status bits.
  const isMvsHw =
    opts.system === 'mvs' || (opts.system === 'uni' && opts.unihw === 'mvs');

  const bios2Bytes = toUint8(assets?.bios2);
  if (isCd && (opts.system === 'cdf' || opts.system === 'cdt') && !bios2Bytes) {
    throw new Error(
      'geolith: the CD front/top loaders also need assets.bios2 = neocdz.zip (supplies 000-lo.lo)',
    );
  }

  // Visible crop: the LSPC's active picture is 320x240 at y=16 inside a
  // 320x264 buffer; masking `m` pixels per edge yields the standard
  // 304x224 picture at m=8 (mirrors upstream overscan settings).
  const m = Math.max(0, Math.min(16, opts.overscanMask));
  const crop = { x: m, y: 16 + m, w: 320 - 2 * m, h: 240 - 2 * m };

  const canvas = resolveCanvas(config);
  canvas.width = crop.w;
  canvas.height = crop.h;
  canvas.style.imageRendering = opts.renderFilter === 'pixelated' ? 'pixelated' : 'auto';
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('geolith: could not acquire a 2d canvas context');
  const imageData = ctx2d.createImageData(crop.w, crop.h);

  // ---------------------------------------------------------------- audio
  const audioCtx = new AudioContext();
  const sampleRate = Math.round(audioCtx.sampleRate);
  const framerate =
    opts.system === 'mvs' || opts.system === 'uni' ? FRAMERATE_MVS : FRAMERATE_AES;
  const framesPerExec = sampleRate / framerate;

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
  );
  await audioCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const sink = new AudioWorkletNode(audioCtx, 'geolith-sink', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const gain = audioCtx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, opts.volume));
  sink.connect(gain).connect(audioCtx.destination);

  let enqueuedFrames = 0;
  let consumedFrames = 0;
  sink.port.onmessage = (e: MessageEvent<number>) => {
    consumedFrames = e.data;
  };

  // --------------------------------------------------------------- module
  const jsUrl = config.jsUrl ?? new URL('./geolith.js', import.meta.url).href;
  const wasmUrl = config.wasmUrl ?? new URL('./geolith.wasm', jsUrl).href;

  await loadClassicScriptOnce(jsUrl);

  const g = globalThis as { createGeolithModule?: GeolithModuleFactory };
  if (typeof g.createGeolithModule !== 'function') {
    throw new Error('geolith: unable to initialize runtime module from geolith.js');
  }
  const mod = await g.createGeolithModule({
    locateFile(path: string): string {
      if (path.endsWith('.wasm')) return wasmUrl;
      return new URL(path, jsUrl).href;
    },
  });

  // ----------------------------------------------------------------- boot
  mod._geowasm_setup(
    GEOLITH_SYSTEM_IDS[opts.system],
    GEOLITH_REGION_IDS[opts.region],
    sampleRate,
    GEOLITH_SYSTEM_IDS[opts.unihw],
  );
  mod._geowasm_set_input_mode(GEOLITH_INPUT_MODE_IDS[opts.inputMode]);
  mod._geowasm_set_dips(opts.freeplay ? 1 : 0, opts.settingMode ? 1 : 0);
  mod._geowasm_set_memcard(opts.memcard ? 1 : 0, opts.memcardWriteProtect ? 1 : 0);
  mod._geowasm_set_palette(opts.rawPalette ? 1 : 0);
  mod._geowasm_set_adpcm_wrap(opts.adpcmWrap ? 1 : 0);
  mod._geowasm_set_overclock(opts.overclock ? 1 : 0);

  const biosPtr = heapAlloc(mod, biosBytes);
  const biosOk = mod._geowasm_load_bios(biosPtr, biosBytes.length);
  mod._free(biosPtr);
  if (!biosOk) {
    const expected = isCd
      ? opts.system === 'cdf' || opts.system === 'cdt' ? 'neocd.zip' : 'neocdz.zip'
      : opts.system === 'aes' ? 'aes.zip' : 'neogeo.zip';
    throw new Error(
      `geolith: BIOS load failed — expecting a MAME-format ${expected} (with correct ROM names/CRCs inside)`,
    );
  }

  let neoFlags = 0;
  if (isCd) {
    // CD front/top loaders take 000-lo.lo from the auxiliary neocdz.zip.
    if (bios2Bytes && (opts.system === 'cdf' || opts.system === 'cdt')) {
      const auxPtr = heapAlloc(mod, bios2Bytes);
      const auxOk = mod._geowasm_load_bios_aux(auxPtr, bios2Bytes.length);
      mod._free(auxPtr);
      if (!auxOk) throw new Error('geolith: auxiliary BIOS (neocdz.zip) load failed');
    }
    // Unzip the disc image into MEMFS and open its cue sheet.
    const discPtr = heapAlloc(mod, romBytes);
    const files = mod._geowasm_disc_unzip(discPtr, romBytes.length);
    mod._free(discPtr);
    if (!files) throw new Error('geolith: disc image unzip failed — pass a zip of .cue/.bin');
    if (!mod._geowasm_disc_open_auto()) {
      throw new Error('geolith: disc open failed — the zip must contain a .cue and its .bin(s)');
    }
  } else {
    // The core aliases ROM regions directly into this buffer; never freed.
    const romPtr = heapAlloc(mod, romBytes);
    if (!mod._geowasm_load_rom(romPtr, romBytes.length)) {
      throw new Error('geolith: ROM load failed — is this a valid .neo file?');
    }
    neoFlags = mod._geowasm_neo_flags();
    // The Irritating Maze wants its own aux BIOS (irrmaze.zip) on MVS.
    if (neoFlags & DB_IRRMAZE && bios2Bytes) {
      const auxPtr = heapAlloc(mod, bios2Bytes);
      mod._geowasm_load_bios_aux(auxPtr, bios2Bytes.length);
      mod._free(auxPtr);
    }
  }

  // ---------------------------------------------------------- persistence
  const persistEnabled = config.persist !== null && typeof navigator !== 'undefined';
  const namespace = config.storageNamespace ?? 'default';

  const restoreSavedata = async (): Promise<void> => {
    if (!persistEnabled) return;
    const dir = await opfsDir(namespace, false);
    if (!dir) return;
    for (const { type, file } of SAVEDATA_FILES) {
      try {
        const handle = await dir.getFileHandle(file);
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        const ptr = heapAlloc(mod, bytes);
        mod._geowasm_savedata_restore(type, ptr, bytes.length);
        mod._free(ptr);
      } catch {
        // absent file or unsupported region: nothing to restore
      }
    }
  };

  const persistSavedata = async (): Promise<void> => {
    if (!persistEnabled) return;
    const dir = await opfsDir(namespace, true);
    if (!dir) return;
    for (const { type, file } of SAVEDATA_FILES) {
      if (type === MEMTYPE_CARTRAM && !mod._geowasm_cartram_present()) continue;
      const ptr = mod._geowasm_savedata_ptr(type);
      const size = mod._geowasm_savedata_size();
      if (!ptr || !size) continue;
      const bytes = mod.HEAPU8.slice(ptr, ptr + size);
      try {
        const handle = await dir.getFileHandle(file, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } catch {
        // persistence is best-effort
      }
    }
  };

  await restoreSavedata();

  // Power-on after BIOS+ROM are mapped (the 68K reads its vectors from ROM).
  mod._geowasm_reset(1);

  // ---------------------------------------------------------------- input
  // Resolve the active device the same way the shim does.
  const device: InputDevice = (() => {
    if (isCd) return 'js';
    if (
      opts.inputMode === 'mahjong' ||
      (opts.inputMode === 'auto' && neoFlags & DB_MAHJONG)
    )
      return 'mahjong';
    if (neoFlags & DB_IRRMAZE && isMvsHw) return 'irrmaze';
    if (neoFlags & DB_VLINER) return 'vliner';
    return 'js';
  })();
  const fourPlayer =
    device === 'js' &&
    opts.inputMode === '4p' &&
    isMvsHw &&
    (opts.region === 'jp' || opts.region === 'as');

  const keyMasks = [0, 0, 0, 0];
  const padMasks = [0, 0, 0, 0];
  let keySysMask = 0;
  let padSysMask = 0;
  const sentMasks = [-1, -1, -1, -1];
  let sentSysMask = -1;
  let codeToControl = new Map<string, { port: number; bit: number }>();

  const pushInputs = (): void => {
    for (let p = 0; p < 4; p++) {
      const mask = keyMasks[p] | padMasks[p];
      if (mask !== sentMasks[p]) {
        sentMasks[p] = mask;
        mod._geowasm_input(p, mask);
      }
    }
    const sys = keySysMask | padSysMask;
    if (sys !== sentSysMask) {
      sentSysMask = sys;
      mod._geowasm_input_sys(sys);
    }
  };

  const buildKeymap = (map: Record<string, string>): void => {
    codeToControl = new Map();
    const bits = DEVICE_BITS[device];
    const bind = (action: string, code: string): void => {
      const dot = action.indexOf('.');
      if (dot < 0 || !code) return;
      const scope = action.slice(0, dot);
      const name = action.slice(dot + 1);
      if (scope === 'sys') {
        const bit = SYS_BITS[name];
        if (bit !== undefined) codeToControl.set(code, { port: -1, bit });
        return;
      }
      const port = { p1: 0, p2: 1, p3: 2, p4: 3 }[scope];
      const bit = bits[name];
      if (port !== undefined && bit !== undefined)
        codeToControl.set(code, { port, bit });
    };
    for (const [action, code] of Object.entries(map)) bind(action, code);
    for (const [code, action] of Object.entries(KEYMAP_ALIASES)) {
      if (!codeToControl.has(code)) bind(action, code);
    }
  };
  const defaultKeymap = (): Record<string, string> =>
    fourPlayer
      ? { ...DEFAULT_KEYMAP, ...FOURP_EXTRA_KEYMAP }
      : DEVICE_KEYMAPS[device];
  buildKeymap(defaultKeymap());

  const applyKey = (code: string, down: boolean): boolean => {
    const ctl = codeToControl.get(code);
    if (!ctl) return false;
    const bit = 1 << ctl.bit;
    if (ctl.port === -1) {
      keySysMask = down ? keySysMask | bit : keySysMask & ~bit;
    } else {
      keyMasks[ctl.port] = down
        ? keyMasks[ctl.port] | bit
        : keyMasks[ctl.port] & ~bit;
    }
    pushInputs();
    return true;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (applyKey(e.code, true)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (applyKey(e.code, false)) e.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Trackball (The Irritating Maze): mouse movement over the canvas.
  let mouseDx = 0;
  let mouseDy = 0;
  const onMouseMove = (e: MouseEvent): void => {
    mouseDx += e.movementX;
    mouseDy += e.movementY;
  };
  if (device === 'irrmaze') canvas.addEventListener('mousemove', onMouseMove);
  const TRACKBALL_SCALE = 256;

  /**
   * Gamepad polling (standard mapping): d-pad/left stick → directions,
   * face buttons → A/B/C/D, start(9) → start, select(8) → coin, LB(4) →
   * select. Only wired for joystick-style devices.
   */
  const pollGamepads = (): void => {
    if (!opts.gamepads || device !== 'js' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const maxPads = fourPlayer ? 4 : 2;
    let sys = 0;
    let changed = false;
    for (let p = 0; p < maxPads; p++) {
      const pad = pads[p];
      let mask = 0;
      if (pad && pad.connected) {
        const btn = (i: number): boolean => !!pad.buttons[i]?.pressed;
        const ax = (i: number): number => pad.axes[i] ?? 0;
        if (btn(12) || ax(1) < -0.4) mask |= 0x01; // up
        if (btn(13) || ax(1) > 0.4) mask |= 0x02; // down
        if (btn(14) || ax(0) < -0.4) mask |= 0x04; // left
        if (btn(15) || ax(0) > 0.4) mask |= 0x08; // right
        if (btn(0)) mask |= 0x10; // A
        if (btn(1)) mask |= 0x20; // B
        if (btn(2)) mask |= 0x40; // C
        if (btn(3)) mask |= 0x80; // D
        if (btn(9)) mask |= 0x100; // start
        if (btn(4)) mask |= 0x200; // select (LB)
        if (btn(8)) sys |= p % 2 === 0 ? 0x01 : 0x02; // coin (back/select)
      }
      if (mask !== padMasks[p]) {
        padMasks[p] = mask;
        changed = true;
      }
    }
    if (sys !== padSysMask) {
      padSysMask = sys;
      changed = true;
    }
    if (changed) pushInputs();
  };

  // Browsers may refuse to start audio without a user gesture; retry on the
  // next interaction if the context comes up suspended.
  const resumeAudio = (): void => {
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  };
  window.addEventListener('pointerdown', resumeAudio);
  window.addEventListener('keydown', resumeAudio);

  // ------------------------------------------------------------ main loop
  // Audio-clocked pacing: keep ~90ms of audio queued ahead of the worklet's
  // consumption. While the AudioContext is suspended (no consumption), fall
  // back to wall-clock pacing so video still runs.
  const TARGET_BUFFER = Math.round(sampleRate * 0.09);
  const MAX_FRAMES_PER_TICK = 5;

  let rafId = 0;
  let running = false;
  let paused = false;
  let wallClockFrames = 0;
  let wallClockStart = 0;
  let fpsCount = 0;
  let fpsWindowStart = 0;
  let persistTimer: ReturnType<typeof setInterval> | null = null;

  const runFrames = (count: number): void => {
    for (let i = 0; i < count; i++) {
      mod._geowasm_skip_render(i < count - 1 ? 1 : 0);
      const samps = mod._geowasm_exec();
      if (samps > 0) {
        const ptr = mod._geowasm_audio_ptr();
        const chunk = mod.HEAP16.slice(ptr >> 1, (ptr >> 1) + samps);
        sink.port.postMessage(chunk, [chunk.buffer]);
        enqueuedFrames += samps >> 1;
      }
      fpsCount++;
    }
  };

  const renderFrame = (): void => {
    const ptr = mod._geowasm_frame_rgba(crop.x, crop.y, crop.w, crop.h);
    imageData.data.set(mod.HEAPU8.subarray(ptr, ptr + crop.w * crop.h * 4));
    ctx2d.putImageData(imageData, 0, 0);
  };

  const tick = (now: number): void => {
    if (!running || paused) return;
    rafId = requestAnimationFrame(tick);

    pollGamepads();
    if (device === 'irrmaze') {
      mod._geowasm_input_axis(mouseDx * TRACKBALL_SCALE, mouseDy * TRACKBALL_SCALE);
      mouseDx = 0;
      mouseDy = 0;
    }

    let frames = 0;
    if (audioCtx.state === 'running') {
      const buffered = enqueuedFrames - consumedFrames;
      const deficit = TARGET_BUFFER - buffered;
      if (deficit > 0) frames = Math.ceil(deficit / framesPerExec);
      wallClockStart = 0;
    } else {
      // Wall-clock fallback (audio blocked): accumulate at the core framerate.
      if (!wallClockStart) {
        wallClockStart = now;
        wallClockFrames = 0;
      }
      const due = Math.floor(((now - wallClockStart) / 1000) * framerate);
      frames = due - wallClockFrames;
      wallClockFrames = due;
    }

    frames = Math.max(0, Math.min(MAX_FRAMES_PER_TICK, frames));
    if (frames > 0) {
      runFrames(frames);
      renderFrame();
    }

    if (!fpsWindowStart) fpsWindowStart = now;
    if (now - fpsWindowStart >= 1000) {
      emit({ type: 'frame', fps: (fpsCount * 1000) / (now - fpsWindowStart) });
      fpsWindowStart = now;
      fpsCount = 0;
    }
  };

  const startLoop = (): void => {
    if (rafId) cancelAnimationFrame(rafId);
    wallClockStart = 0;
    rafId = requestAnimationFrame(tick);
  };

  const setInput = (map: InputPreset | KeyMap): void => {
    if (typeof map === 'string') {
      buildKeymap(defaultKeymap());
    } else {
      buildKeymap({ ...defaultKeymap(), ...map });
    }
  };

  const instance: EngineInstance = {
    start() {
      if (running) return;
      running = true;
      paused = false;
      resumeAudio();
      startLoop();
      if (persistEnabled) {
        persistTimer = setInterval(() => void persistSavedata(), 15000);
      }
      emit({ type: 'ready' });
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      cancelAnimationFrame(rafId);
      rafId = 0;
      void audioCtx.suspend();
      void persistSavedata();
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      void audioCtx.resume();
      startLoop();
    },
    reset() {
      mod._geowasm_reset(1);
    },
    setInput,
    async saveState(): Promise<Uint8Array> {
      const size = mod._geowasm_state_size();
      const ptr = mod._geowasm_state_save();
      if (!ptr || !size) throw new Error('geolith: failed to save state');
      return mod.HEAPU8.slice(ptr, ptr + size);
    },
    async loadState(data: Uint8Array): Promise<void> {
      const size = mod._geowasm_state_size();
      if (data.length !== size) {
        throw new Error(
          `geolith: state size mismatch (got ${data.length}, expected ${size})`,
        );
      }
      const ptr = heapAlloc(mod, data);
      const ok = mod._geowasm_state_load(ptr);
      mod._free(ptr);
      if (!ok) throw new Error('geolith: failed to load state');
    },
    async screenshot(): Promise<Blob> {
      renderFrame();
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('geolith: screenshot failed'));
        }, 'image/png');
      });
    },
    async purgeStorage(): Promise<{ data: boolean; settings: boolean }> {
      let data = false;
      try {
        const root = await navigator.storage.getDirectory();
        const engineDir = await root.getDirectoryHandle('geolith');
        await engineDir.removeEntry(namespace, { recursive: true });
        data = true;
      } catch {
        // nothing persisted for this namespace
      }
      return { data, settings: false };
    },
    destroy() {
      running = false;
      paused = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (persistTimer) clearInterval(persistTimer);
      persistTimer = null;
      void persistSavedata();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
      canvas.removeEventListener('mousemove', onMouseMove);
      sink.disconnect();
      gain.disconnect();
      void audioCtx.close();
      emit({ type: 'exit' });
    },
  };

  return instance;
}

export default { manifest, load };
