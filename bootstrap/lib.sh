#!/bin/bash
# Shared helpers for the bootstrap wizard (bootstrap/*.sh) and install.sh.
# Source this, don't execute it:  . "$(dirname "$0")/lib.sh"
#
# Nothing here has side effects on load beyond defining functions and, if not
# already set, JARVIS_ROOT / JARVIS_NONINTERACTIVE / JARVIS_ASSUME_YES.

# --- output -----------------------------------------------------------------
say()  { printf '==> %s\n' "$1"; }
skip() { printf '    skip: %s\n' "$1"; }
warn() { printf '    WARN: %s\n' "$1" >&2; }
die()  { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# --- root resolution ------------------------------------------------------
# Every script that sources this can rely on JARVIS_ROOT afterwards. Order of
# preference: caller-exported env, a .jarvis-env next to the bootstrap tree,
# then self-location two levels up from this file.
jarvis_resolve_root() {
  if [ -n "${JARVIS_ROOT:-}" ] && [ -d "$JARVIS_ROOT" ]; then
    return 0
  fi
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -f "$here/.jarvis-env" ]; then
    # shellcheck disable=SC1091
    . "$here/.jarvis-env"
  fi
  JARVIS_ROOT="${JARVIS_ROOT:-$here}"
  export JARVIS_ROOT
}

# --- prompts (tty-aware) ------------------------------------------------
# In non-interactive mode (piped with no /dev/tty, or --yes) these never block:
# ask() returns its default, confirm() returns the assumed answer.
_have_tty() { [ -e /dev/tty ] && [ "${JARVIS_NONINTERACTIVE:-0}" != "1" ]; }

ask() {
  # ask "prompt" "default" -> echoes the answer
  local prompt="$1" default="${2:-}" reply
  if ! _have_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply < /dev/tty
    printf '%s\n' "${reply:-$default}"
  else
    read -r -p "$prompt: " reply < /dev/tty
    printf '%s\n' "$reply"
  fi
}

ask_secret() {
  # ask_secret "prompt" -> echoes the answer, input hidden, no echo of chars
  local prompt="$1" reply
  if ! _have_tty; then
    printf '\n'
    return 0
  fi
  read -r -s -p "    $prompt (input hidden): " reply < /dev/tty
  printf '\n' >&2
  printf '%s\n' "$reply"
}

confirm() {
  # confirm "prompt" -> 0 (yes) / 1 (no). Default no, unless --yes was passed.
  local reply
  if [ "${JARVIS_ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if ! _have_tty; then return 1; fi
  read -r -p "$1 [y/N]: " reply < /dev/tty
  [[ "$reply" =~ ^[Yy]$ ]]
}

# --- platform detection ---------------------------------------------------
# Sets JARVIS_OS (linux|macos), JARVIS_PKG (apt|dnf|pacman|brew|none),
# JARVIS_WSL (0|1). Safe to call more than once.
detect_platform() {
  JARVIS_WSL=0
  case "$(uname -s)" in
    Darwin) JARVIS_OS=macos ;;
    Linux)
      JARVIS_OS=linux
      grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && JARVIS_WSL=1
      ;;
    *) JARVIS_OS=unknown ;;
  esac

  if [ "$JARVIS_OS" = macos ]; then
    JARVIS_PKG=brew
  elif command -v apt-get >/dev/null 2>&1; then
    JARVIS_PKG=apt
  elif command -v dnf >/dev/null 2>&1; then
    JARVIS_PKG=dnf
  elif command -v pacman >/dev/null 2>&1; then
    JARVIS_PKG=pacman
  else
    JARVIS_PKG=none
  fi
  export JARVIS_OS JARVIS_PKG JARVIS_WSL
}

# --- package install ----------------------------------------------------
# pkg_install <generic-name>...  — maps generic names to this platform's
# package names and installs the ones whose command is missing. Returns 1 and
# prints the shortfall if the platform has no known package manager.
_pkg_map() {
  # _pkg_map <pkg-manager> <generic> -> platform package name (or generic)
  local pm="$1" g="$2"
  case "$g:$pm" in
    espeak-ng:apt|espeak-ng:dnf) printf 'espeak-ng\n' ;;
    espeak-ng:pacman)            printf 'espeak-ng\n' ;;
    espeak-ng:brew)              printf 'espeak\n' ;;
    python3-pip:apt)             printf 'python3-pip\n' ;;
    python3-pip:dnf)             printf 'python3-pip\n' ;;
    python3-pip:pacman)          printf 'python-pip\n' ;;
    python3-pip:brew)            printf 'python\n' ;;
    *)                           printf '%s\n' "$g" ;;
  esac
}

_pkg_cmd_for() {
  # command a generic package should provide, for the "is it present?" check
  case "$1" in
    python3-pip) printf 'pip3\n' ;;
    *)           printf '%s\n' "$1" ;;
  esac
}

pkg_install() {
  detect_platform
  local generic pkgs=() missing=()
  for generic in "$@"; do
    command -v "$(_pkg_cmd_for "$generic")" >/dev/null 2>&1 && continue
    missing+=("$generic")
    pkgs+=("$(_pkg_map "$JARVIS_PKG" "$generic")")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    skip "already present: $*"
    return 0
  fi
  case "$JARVIS_PKG" in
    apt)    sudo apt-get update -qq && sudo apt-get install -y -qq "${pkgs[@]}" ;;
    dnf)    sudo dnf install -y -q "${pkgs[@]}" ;;
    pacman) sudo pacman -Sy --noconfirm --needed "${pkgs[@]}" ;;
    brew)   brew install "${pkgs[@]}" ;;
    none)
      warn "no supported package manager found. Install these yourself and re-run:"
      printf '        %s\n' "${pkgs[@]}" >&2
      return 1
      ;;
  esac
}

# --- template rendering -------------------------------------------------
# render_template <src> <dst> KEY=VALUE ...  — copies src to dst with every
# @@KEY@@ replaced by VALUE. Values are treated literally (sed-escaped).
render_template() {
  local src="$1" dst="$2"; shift 2
  [ -f "$src" ] || die "template not found: $src"
  local tmp; tmp="$(mktemp)"
  cp "$src" "$tmp"
  local pair key val esc
  for pair in "$@"; do
    key="${pair%%=*}"; val="${pair#*=}"
    esc="$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')"
    sed -i "s|@@${key}@@|${esc}|g" "$tmp"
  done
  mkdir -p "$(dirname "$dst")"
  mv "$tmp" "$dst"
}
