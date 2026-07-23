#!/usr/bin/env bash
set -euo pipefail

# Build Geolith (Neo Geo AES/MVS emulator) to WebAssembly with Emscripten.
#
# Unlike FBNeo/BlastEm, Geolith needs no upstream-makefile surgery: the core
# is pure C11 with vendored deps (miniz, speex resampler) and a pre-generated
# m68kops.c, so we compile the enumerated source list directly with emcc and
# link our shim (shim/geo_shim.c) in place of the Jolly Good frontend (jg.c).
#
# Outputs: dist/geolith/geolith.js (MODULARIZE factory `createGeolithModule`)
#          dist/geolith/geolith.wasm

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${PROJECT_DIR}/.tmp/geolith-build"
SRC_DIR="${BUILD_DIR}/geolith"
OUT_DIR="${PROJECT_DIR}/dist/geolith"

GEOLITH_REPO="${GEOLITH_REPO:-https://gitlab.com/jgemu/geolith.git}"
# Geolith 0.4.2 (2026-07-07)
GEOLITH_REF="${GEOLITH_REF:-4c0db390fdda159bd0e3e2298e006e6ff076daef}"

OPT="${GEOLITH_OPT:--O2}"

mkdir -p "${BUILD_DIR}" "${OUT_DIR}"

# --- Fetch pinned source ----------------------------------------------------
if [ ! -d "${SRC_DIR}/.git" ]; then
    echo "Cloning geolith..."
    git clone "${GEOLITH_REPO}" "${SRC_DIR}"
fi
git -C "${SRC_DIR}" fetch --quiet origin "${GEOLITH_REF}" || true
git -C "${SRC_DIR}" checkout --quiet "${GEOLITH_REF}"

cd "${SRC_DIR}"

# --- Source list (mirrors CSRCS in upstream Makefile, CHD disabled) ---------
CORE_SRCS=(
    src/m68k/m68kcpu.c
    src/m68k/m68kops.c
    src/ymfm/ymfm_adpcm.c
    src/ymfm/ymfm_opn.c
    src/ymfm/ymfm_ssg.c
    src/z80/z80.c
    src/geo.c
    src/geo_cd.c
    src/geo_cue.c
    src/geo_disc.c
    src/geo_lc8951.c
    src/geo_lspc.c
    src/geo_m68k.c
    src/geo_memcard.c
    src/geo_mixer.c
    src/geo_neo.c
    src/geo_rtc.c
    src/geo_serial.c
    src/geo_ymfm.c
    src/geo_z80.c
    deps/miniz/miniz.c
    deps/speex/resample.c
)

CFLAGS=(
    "${OPT}"
    -std=c11
    -Isrc
    -Ideps           # <speex/speex_resampler.h>
    -Ideps/miniz     # <miniz.h>
    -Ideps/dr        # dr_flac.h (CD audio, unused but compiled)
)

EXPORTED_FUNCS='_malloc,_free'

LDFLAGS=(
    "${OPT}"
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_NAME=createGeolithModule
    -sENVIRONMENT=web,node  # node: enables the headless smoke test harness
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=134217728   # 128MB: biggest .neo carts are ~96MB
    -sMAXIMUM_MEMORY=536870912
    -sSTACK_SIZE=1048576
    -sFILESYSTEM=0
    -sEXPORTED_FUNCTIONS="${EXPORTED_FUNCS}"
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU32
)

echo "Compiling Geolith core + shim with emcc..."
emcc \
    "${CFLAGS[@]}" \
    "${CORE_SRCS[@]}" \
    "${PROJECT_DIR}/shim/geo_shim.c" \
    "${LDFLAGS[@]}" \
    -o "${OUT_DIR}/geolith.js"

echo "Built artifacts:"
ls -lh "${OUT_DIR}/geolith.js" "${OUT_DIR}/geolith.wasm"
