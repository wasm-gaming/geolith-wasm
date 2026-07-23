import type { JSONSchema } from '@wasm-gaming/engine-specs';

/**
 * Hardware variants. Cartridge systems: `aes` (home console), `mvs` (arcade),
 * `uni` (Universe BIOS). CD systems (experimental): `cdf` (front loader),
 * `cdt` (top loader), `cdz` (CDZ), `cdu` (CD Universe BIOS).
 */
export type GeolithSystem = 'aes' | 'mvs' | 'uni' | 'cdf' | 'cdt' | 'cdz' | 'cdu';
export type GeolithRegion = 'us' | 'jp' | 'as' | 'eu';
export type GeolithInputMode = 'auto' | 'joystick' | 'mahjong' | '4p';

export interface GeolithOptions {
  /**
   * Hardware to emulate. Determines which BIOS zip the core expects:
   * aes.zip (aes), neogeo.zip (mvs/uni), neocd.zip + neocdz.zip (cdf/cdt),
   * neocdz.zip (cdz/cdu).
   */
  system?: GeolithSystem;
  /** Hardware region. Affects language/censorship in many games. */
  region?: GeolithRegion;
  /**
   * Which hardware the Universe BIOS should detect (`system: 'uni'` only):
   * arcade coin slots (mvs) or console (aes).
   */
  unihw?: 'aes' | 'mvs';
  /**
   * Input devices: `auto` picks special controllers (mahjong, trackball,
   * V-Liner) from the game database; `joystick` forces standard sticks;
   * `mahjong` forces the mahjong panel; `4p` enables the NEO-FTC1B 4-player
   * board (MVS + JP/AS region only).
   */
  inputMode?: GeolithInputMode;
  /** Canvas scaling filter: `pixelated` for crisp pixels, `smooth` for linear. */
  renderFilter?: 'pixelated' | 'smooth';
  /**
   * Pixels of overscan to mask on each edge (0|4|8|12|16). The Neo Geo active
   * picture is 320x240 (with borders); the standard visible area is 304x224,
   * i.e. a mask of 8. Matches upstream's overscan_* settings.
   */
  overscanMask?: number;
  /** MVS "freeplay" DIP switch: play without coins. */
  freeplay?: boolean;
  /** MVS "setting mode" DIP switch: boot into the hardware settings menu. */
  settingMode?: boolean;
  /** Emulate an inserted memory card (AES/MVS save games). */
  memcard?: boolean;
  /** Write-protect the emulated memory card. */
  memcardWriteProtect?: boolean;
  /** Use the raw palette instead of the resistor network palette. */
  rawPalette?: boolean;
  /**
   * ADPCM accumulator wrap (upstream default on). Turning it off fixes sound
   * effects in a few buggy games (Ganryu, Nightmare in the Dark).
   */
  adpcmWrap?: boolean;
  /** Overclock: disable the 68K clock divider. */
  overclock?: boolean;
  /** Master audio volume, 0.0–1.0. */
  volume?: number;
  /** Poll connected gamepads (standard mapping) each frame. */
  gamepads?: boolean;
}

export const DEFAULT_GEOLITH_OPTIONS: Required<GeolithOptions> = {
  system: 'mvs',
  region: 'us',
  unihw: 'mvs',
  inputMode: 'auto',
  renderFilter: 'pixelated',
  overscanMask: 8,
  freeplay: false,
  settingMode: false,
  memcard: true,
  memcardWriteProtect: false,
  rawPalette: false,
  adpcmWrap: true,
  overclock: false,
  volume: 1.0,
  gamepads: true,
};

/** Numeric ids matching the SYSTEM_ and REGION_ defines in geo.h. */
export const GEOLITH_SYSTEM_IDS: Record<GeolithSystem, number> = {
  aes: 0,
  mvs: 1,
  uni: 2,
  cdf: 3,
  cdt: 4,
  cdz: 5,
  cdu: 6,
};

export const GEOLITH_REGION_IDS: Record<GeolithRegion, number> = {
  us: 0,
  jp: 1,
  as: 2,
  eu: 3,
};

/** Numeric ids matching INPUT_MODE_* in shim/geo_shim.c. */
export const GEOLITH_INPUT_MODE_IDS: Record<GeolithInputMode, number> = {
  auto: 0,
  joystick: 1,
  mahjong: 2,
  '4p': 3,
};

export const GEOLITH_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    system: {
      type: 'string',
      enum: ['aes', 'mvs', 'uni', 'cdf', 'cdt', 'cdz', 'cdu'],
      default: 'mvs',
      description:
        'Hardware to emulate: aes (console, aes.zip), mvs (arcade, neogeo.zip), uni (Universe BIOS, neogeo.zip), or the experimental CD systems cdf/cdt (neocd.zip + neocdz.zip) and cdz/cdu (neocdz.zip).',
    },
    region: {
      type: 'string',
      enum: ['us', 'jp', 'as', 'eu'],
      default: 'us',
      description: 'Hardware region.',
    },
    unihw: {
      type: 'string',
      enum: ['aes', 'mvs'],
      default: 'mvs',
      description: 'Hardware the Universe BIOS should detect (system: uni only).',
    },
    inputMode: {
      type: 'string',
      enum: ['auto', 'joystick', 'mahjong', '4p'],
      default: 'auto',
      description:
        'Input devices: auto (special controllers from the game database), joystick, mahjong, or 4p (NEO-FTC1B, MVS + JP/AS only).',
    },
    renderFilter: {
      type: 'string',
      enum: ['pixelated', 'smooth'],
      default: 'pixelated',
      description: 'Canvas scaling filter: pixelated for crisp pixels, smooth for linear filtering.',
    },
    overscanMask: {
      type: 'integer',
      enum: [0, 4, 8, 12, 16],
      default: 8,
      description: 'Pixels of overscan masked on each edge (8 = standard 304x224 picture).',
    },
    freeplay: {
      type: 'boolean',
      default: false,
      description: 'MVS freeplay DIP switch (play without coins).',
    },
    settingMode: {
      type: 'boolean',
      default: false,
      description: 'MVS setting-mode DIP switch (hardware settings menu at boot).',
    },
    memcard: {
      type: 'boolean',
      default: true,
      description: 'Emulate an inserted memory card.',
    },
    memcardWriteProtect: {
      type: 'boolean',
      default: false,
      description: 'Write-protect the emulated memory card.',
    },
    rawPalette: {
      type: 'boolean',
      default: false,
      description: 'Use the raw palette instead of the resistor network palette.',
    },
    adpcmWrap: {
      type: 'boolean',
      default: true,
      description:
        'ADPCM accumulator wrap. Disable to fix sound effects in a few buggy games (Ganryu, Nightmare in the Dark).',
    },
    overclock: {
      type: 'boolean',
      default: false,
      description: 'Overclock: disable the 68K clock divider.',
    },
    volume: {
      type: 'number',
      default: 1.0,
      minimum: 0,
      maximum: 1,
      description: 'Master audio volume.',
    },
    gamepads: {
      type: 'boolean',
      default: true,
      description: 'Poll connected gamepads (standard mapping) each frame.',
    },
  },
};
