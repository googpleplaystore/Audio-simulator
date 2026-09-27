#!/usr/bin/env bash
# One-command install of AudioSpace on Arch Linux and derivatives
# (EndeavourOS, Manjaro, CachyOS, …). Builds a proper pacman package
# (audiospace-git) with makepkg and installs it, so `sudo pacman -R
# audiospace-git` removes it cleanly.
#
# From a clone:     ./packaging/arch/install.sh
# Straight from Git (uses your git credentials, works for private repos):
#   git clone https://github.com/googpleplaystore/Audio-simulator.git /tmp/audiospace && bash /tmp/audiospace/packaging/arch/install.sh
# If the repository is public:
#   curl -fsSL https://raw.githubusercontent.com/googpleplaystore/Audio-simulator/HEAD/packaging/arch/install.sh | bash
#
# Environment: AUDIOSPACE_REPO=<git url> to clone from elsewhere (e.g. an SSH URL).
set -euo pipefail

REPO="${AUDIOSPACE_REPO:-https://github.com/googpleplaystore/Audio-simulator.git}"

say() { printf '\033[1;35m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pacman >/dev/null 2>&1 || die "pacman not found — this installer is for Arch Linux and derivatives."
[[ $EUID -ne 0 ]] || die "run this as your normal user (makepkg refuses to run as root); sudo is used when needed."
command -v sudo >/dev/null 2>&1 || die "sudo is required to install packages."

say "Installing build tools (base-devel, git, go)…"
sudo pacman -S --needed --noconfirm base-devel git go

work="$(mktemp -d -t audiospace-install.XXXXXX)"
trap 'rm -rf "$work"' EXIT

# Build from the checkout this script lives in, or clone the repository.
src=""
here="${BASH_SOURCE[0]:-}"
if [[ -n "$here" && -f "$here" ]]; then
  candidate="$(cd "$(dirname "$here")/../.." && pwd)"
  if [[ -f "$candidate/desktop/main.go" && -d "$candidate/.git" ]]; then
    src="$candidate"
  fi
fi
if [[ -z "$src" ]]; then
  say "Cloning $REPO…"
  git clone --quiet "$REPO" "$work/src"
  src="$work/src"
elif [[ -n "$(git -C "$src" status --porcelain 2>/dev/null)" ]]; then
  say "Note: uncommitted changes in $src are not included — the package is built from the last commit."
fi
commit="$(git -C "$src" rev-parse HEAD)"

say "Building AudioSpace ($(git -C "$src" rev-parse --short HEAD))…"
mkdir -p "$work/build"
cp "$src/packaging/arch/PKGBUILD" "$work/build/"
sed -i "s|^source=.*|source=(\"\$_pkgname::git+file://$src#commit=$commit\")|" "$work/build/PKGBUILD"
(cd "$work/build" && makepkg --syncdeps --install --noconfirm --needed)

say "AudioSpace is installed."
echo "   Start it from your application menu or run:  audiospace"
echo "   Uninstall with:                              sudo pacman -R audiospace-git"
if ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v brave >/dev/null 2>&1 && ! command -v microsoft-edge-stable >/dev/null 2>&1; then
  echo "   Tip: for a standalone app window install Chromium:  sudo pacman -S chromium"
  echo "        (otherwise AudioSpace opens in your default browser)"
fi
