#!/usr/bin/env bash
#
# Dirigible firmware build script.
#
# Pipeline:
#   1. Generate the ESP-IDF project from screenschema.yaml
#      (the YAML's `build:` section pulls in dirigible-core and
#       dirigible-esp32 as extra components)
#   2. Replace the generated handlers.cpp stub with the authoritative
#      copy from this directory
#   3. Build with idf.py
#
# Usage: ./build.sh [idf-target]   (default: esp32s3)
#
# Environment overrides:
#   IDF_PATH         — ESP-IDF installation
#                       (default: <repo>/../../hardware/esp-idf)
#   SCREENSCHEMA_DIR — ScreenSchema component parent directory
#                       (default: dirigible/third_party/screenschema/screenschema)

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRIGIBLE_DIR="$(cd "$APP_DIR/.." && pwd)"
GEN_DIR="$APP_DIR/build/generated"
IDF_TARGET="${1:-esp32s3}"

echo "==> dirigible: codegen from screenschema.yaml"
PYTHONPATH="$DIRIGIBLE_DIR/third_party/screenschema" \
    python3 -m screenschema.cli build "$APP_DIR/screenschema.yaml" --out "$GEN_DIR"

echo "==> dirigible: install authoritative handlers.cpp"
cp "$APP_DIR/handlers.cpp" "$GEN_DIR/main/handlers.cpp"

echo "==> dirigible: idf.py set-target $IDF_TARGET && idf.py build"
cd "$GEN_DIR"
source "${IDF_PATH:-$DIRIGIBLE_DIR/../../hardware/esp-idf}/export.sh" >/dev/null 2>&1
idf.py set-target "$IDF_TARGET"
idf.py build

echo "==> dirigible: build complete"
echo "    Firmware: $GEN_DIR/build/screenschema_lilygo_t_deck.bin"
echo "    Flash:    cd $GEN_DIR && idf.py -p /dev/ttyACM0 flash monitor"
