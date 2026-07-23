import type { JSONSchema } from '@wasm-gaming/engine-specs';

export type GeolithSystem = 'aes' | 'mvs' | 'uni';
export type GeolithRegion = 'us' | 'jp' | 'as' | 'eu';

export interface GeolithOptions {
  /**
   * Hardware to emulate: `aes` (home console), `mvs` (arcade cabinet) or
   * `uni` (Universe BIOS). Determines which BIOS zip the core expects:
   * aes.zip for AES, neogeo.zip for MVS/Universe.
   */
  system?: GeolithSystem;
  /** Hardware region. Affects language/censorship in many games. */
  region?: GeolithRegion;
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
  /** Master audio volume, 0.0–1.0. */
  volume?: number;
}

export const DEFAULT_GEOLITH_OPTIONS: Required<GeolithOptions> = {
  system: 'mvs',
  region: 'us',
  renderFilter: 'pixelated',
  overscanMask: 8,
  freeplay: false,
  settingMode: false,
  memcard: true,
  volume: 1.0,
};

/** Numeric ids matching the SYSTEM_ and REGION_ defines in geo.h. */
export const GEOLITH_SYSTEM_IDS: Record<GeolithSystem, number> = {
  aes: 0,
  mvs: 1,
  uni: 2,
};

export const GEOLITH_REGION_IDS: Record<GeolithRegion, number> = {
  us: 0,
  jp: 1,
  as: 2,
  eu: 3,
};

export const GEOLITH_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    system: {
      type: 'string',
      enum: ['aes', 'mvs', 'uni'],
      default: 'mvs',
      description:
        'Hardware to emulate: aes (console, needs aes.zip), mvs (arcade, needs neogeo.zip), uni (Universe BIOS, needs neogeo.zip).',
    },
    region: {
      type: 'string',
      enum: ['us', 'jp', 'as', 'eu'],
      default: 'us',
      description: 'Hardware region.',
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
    volume: {
      type: 'number',
      default: 1.0,
      minimum: 0,
      maximum: 1,
      description: 'Master audio volume.',
    },
  },
};
