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
      accept: ['.neo'],
      description:
        'Neo Geo cartridge in TerraOnion NeoSD .neo format (one file per game; convert MAME sets with NeoBuilder).',
    },
    {
      key: 'bios',
      mountPath: '/bios.zip',
      required: true,
      accept: ['.zip'],
      description:
        'MAME-format BIOS zip: neogeo.zip for MVS/Universe BIOS mode, aes.zip for AES console mode.',
    },
  ],
  input: 'geolith',
  video: { baseWidth: 304, baseHeight: 224, aspect: '4:3' },
  options: GEOLITH_OPTIONS_SCHEMA,
  capabilities: { saveStates: true, sram: true, coreSelectable: false },
};

export default manifest;
