#!/usr/bin/env bash
# Copy the files the web app needs at runtime into the desktop launcher's
# embed directory (desktop/webapp), replacing whatever was staged before.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/desktop/webapp}"

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
for f in index.html manifest.webmanifest sw.js; do
  cp "$ROOT/$f" "$DEST/"
done
for d in assets css src; do
  cp -R "$ROOT/$d" "$DEST/"
done
echo "staged web app into $DEST ($(find "$DEST" -type f | wc -l) files)"
