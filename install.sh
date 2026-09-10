#!/bin/bash
# Jarvis — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lahbnaba91-source/Jarvis/main/install.sh | bash
#
# Downloads a pinned Jarvis release (never `main`), unpacks it, and hands off to
# the setup wizard. Linux (Debian/Ubuntu, best-effort Fedora/Arch) and macOS.
#
# Flags (after `| bash -s --` when piped):
#   --dir PATH        install location            (default: ~/jarvis, or $JARVIS_HOME)
#   --version vX.Y.Z  release to install          (default: latest)
#   --core-only       skip the optional-module step
#   --with a,b,c      enable modules non-interactively
#   --yes             assume yes / defaults for every prompt
set -euo pipefail

REPO="lahbnaba91-source/Jarvis"
DIR="${JARVIS_HOME:-$HOME/jarvis}"
VERSION="latest"
WIZ_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        shift; DIR="${1:?--dir needs a path}" ;;
    --dir=*)      DIR="${1#*=}" ;;
    --version)    shift; VERSION="${1:?--version needs a tag}" ;;
    --version=*)  VERSION="${1#*=}" ;;
    --core-only)  WIZ_ARGS+=(--core-only) ;;
    --with)       shift; WIZ_ARGS+=(--with "${1:?}") ;;
    --with=*)     WIZ_ARGS+=(--with "${1#*=}") ;;
    --yes|-y)     WIZ_ARGS+=(--yes) ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '==> %s\n' "$1"; }
die()  { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

# --- preflight --------------------------------------------------------
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "unsupported OS $(uname -s) — Linux or macOS only (Windows: use WSL)" ;;
esac
for c in curl tar; do command -v "$c" >/dev/null 2>&1 || die "need '$c' on PATH"; done
command -v git >/dev/null 2>&1 || say "note: git not found — the wizard will install it"

PY=python3; command -v "$PY" >/dev/null 2>&1 || PY=python
if command -v "$PY" >/dev/null 2>&1; then
  "$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)' \
    || say "note: python < 3.10 detected — some tooling may complain"
fi

# --- resolve the release --------------------------------------------
api="https://api.github.com/repos/$REPO/releases"
if [ "$VERSION" = latest ]; then
  url_base="https://github.com/$REPO/releases/latest/download"
  TAG="$(curl -fsSL "$api/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
else
  url_base="https://github.com/$REPO/releases/download/$VERSION"
  TAG="$VERSION"
fi
[ -n "${TAG:-}" ] || die "could not resolve a release tag (no releases published yet?)"
say "Installing Jarvis $TAG to $DIR"

tarball="jarvis-dist-$TAG.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading $tarball"
curl -fSL --progress-bar -o "$tmp/$tarball" "$url_base/$tarball" \
  || die "download failed: $url_base/$tarball"

if curl -fsSL -o "$tmp/$tarball.sha256" "$url_base/$tarball.sha256" 2>/dev/null; then
  say "Verifying checksum"
  ( cd "$tmp" && awk '{print $1"  '"$tarball"'"}' "$tarball.sha256" | sha256sum -c - ) \
    || die "checksum mismatch — refusing to install"
else
  say "no .sha256 published for this release — skipping checksum"
fi

# --- unpack + hand off ---------------------------------------------
mkdir -p "$DIR"
[ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR is not empty — pass --dir to pick an empty location"
tar -xzf "$tmp/$tarball" -C "$DIR" --strip-components=1

[ -f "$DIR/bootstrap/wizard.sh" ] || die "release layout unexpected — no bootstrap/wizard.sh"
say "Starting the setup wizard"
# Re-attach a terminal so the wizard can prompt even when we were piped.
if [ ! -t 0 ] && [ -e /dev/tty ]; then exec < /dev/tty; fi
exec bash "$DIR/bootstrap/wizard.sh" --dir "$DIR" "${WIZ_ARGS[@]}"
