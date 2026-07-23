#!/usr/bin/env bash
set -euo pipefail

# Local wrapper: run the Geolith WASM build inside Docker (emscripten/emsdk).

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="/workspace/scripts/build-geolith.sh"

echo "Building Geolith WASM via Docker..."
docker run --rm \
    -v "$PROJECT_DIR:/workspace" \
    -w /workspace \
    emscripten/emsdk:latest \
    bash -c "
      set -euo pipefail
      test -x $BUILD_SCRIPT || chmod +x $BUILD_SCRIPT
      $BUILD_SCRIPT
    "
