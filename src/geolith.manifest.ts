import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { GEOLITH_OPTIONS_SCHEMA } from './geolith.options.js';

export const manifest: EngineManifest = {
  id: 'geolith',
  version: '0.1.0',
  name: 'Geolith (WebAssembly)',
  description:
    'Geolith — a highly accurate SNK Neo Geo AES/MVS emulator — compiled to WebAssembly. Loads TerraOnion .neo cartridge images plus a MAME-format BIOS zip.',
  artifacts: {
    wasm: 'geolith/geolith.wasm',
    js: 'geolith/geolith.js',
  },
  assets: [
    {
      key: 'rom',
      mountPath: '/rom.neo',
      required: true,
      accept: ['.neo', '.zip'],
      description:
        'Neo Geo cartridge in TerraOnion NeoSD .neo format (convert MAME sets with NeoBuilder), or — for the experimental CD systems — a zip of the disc image (.cue + .bin).',
    },
    {
      key: 'bios',
      mountPath: '/bios.zip',
      required: true,
      accept: ['.zip'],
      description:
        'MAME-format BIOS zip: neogeo.zip for MVS/Universe BIOS mode, aes.zip for AES console mode, neocd.zip / neocdz.zip for the CD systems.',
    },
    {
      key: 'bios2',
      mountPath: '/bios2.zip',
      required: false,
      accept: ['.zip'],
      description:
        'Auxiliary BIOS zip: neocdz.zip when system is cdf/cdt (supplies 000-lo.lo), or irrmaze.zip for The Irritating Maze.',
    },
  ],
  input: 'geolith',
  video: { baseWidth: 304, baseHeight: 224, aspect: '4:3' },
  options: GEOLITH_OPTIONS_SCHEMA,
  capabilities: { saveStates: true, sram: true, coreSelectable: false },
};

export default manifest;
