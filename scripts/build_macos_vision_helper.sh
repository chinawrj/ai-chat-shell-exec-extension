#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$ROOT_DIR/native/macos_vision_helper.swift"
OUT_DIR="$ROOT_DIR/.state/bin"
OUT="$OUT_DIR/macos-vision-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'macOS vision helper can only be built on macOS.\n' >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  printf 'swiftc not found. Install Xcode command line tools first.\n' >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
swiftc \
  -framework AppKit \
  -framework Carbon \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ImageIO \
  -framework Vision \
  "$SOURCE" \
  -o "$OUT"

chmod 755 "$OUT"
printf 'Built %s\n' "$OUT"
