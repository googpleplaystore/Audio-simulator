#!/usr/bin/env bash
# Build the AudioSpace desktop launcher and the Windows installer.
#
#   packaging/build-desktop.sh            Linux binary, Windows portable exe, Windows installer
#   packaging/build-desktop.sh --linux    Linux binary only (no NSIS needed)
#
# Requirements: Go ≥ 1.22; for Windows also NSIS (makensis) — e.g.
# `apt install nsis`, `pacman -S nsis` or `winget install NSIS.NSIS`.
# Outputs go to dist/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
LINUX_ONLY=0
[[ "${1:-}" == "--linux" ]] && LINUX_ONLY=1

VERSION="${VERSION:-$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n1)}"
BASE="${VERSION%%[-+]*}"                   # 1.2.3 from 1.2.3-beta+abc
VIVERSION="$BASE.0"                        # Windows wants four numbers
LDFLAGS="-s -w -X main.version=$VERSION"
GOWINRES="github.com/tc-hib/go-winres@v0.3.3"

mkdir -p "$DIST"
"$ROOT/packaging/stage-webapp.sh"

cd "$ROOT/desktop"
go test ./...

echo "==> Linux x86-64"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o "$DIST/audiospace-linux-x64" .

if [[ $LINUX_ONLY == 1 ]]; then
  echo "done: $DIST/audiospace-linux-x64"
  exit 0
fi

echo "==> Windows x64 (portable exe with icon and version info)"
go run "$GOWINRES" simply \
  --arch amd64 \
  --icon "$ROOT/packaging/icons/audiospace.ico" \
  --manifest gui \
  --file-version "$VIVERSION" --product-version "$VIVERSION" \
  --file-description "AudioSpace" --product-name "AudioSpace" \
  --copyright "MIT License, AudioSpace contributors" \
  --original-filename "AudioSpace.exe"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS -H=windowsgui" -o "$DIST/AudioSpace-$VERSION-portable.exe" .
rm -f rsrc_windows_*.syso

echo "==> Windows installer"
makensis -V2 \
  -DVERSION="$VERSION" -DVIVERSION="$VIVERSION" \
  -DEXE="$DIST/AudioSpace-$VERSION-portable.exe" \
  -DICON="$ROOT/packaging/icons/audiospace.ico" \
  -DLICENSE="$ROOT/LICENSE" \
  -DOUTFILE="$DIST/AudioSpace-Setup-$VERSION.exe" \
  "$ROOT/packaging/windows/installer.nsi"

cd "$DIST"
sha256sum "AudioSpace-Setup-$VERSION.exe" "AudioSpace-$VERSION-portable.exe" audiospace-linux-x64 > SHA256SUMS
ls -lh "$DIST"
