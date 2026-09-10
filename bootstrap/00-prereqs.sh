#!/bin/bash
# Wizard step 0 — everything the Jarvis stack needs that isn't guaranteed to be
# on a fresh machine: system packages, uv, gh, the Claude Code CLI.
#
# Portable: Debian/Ubuntu (apt) and macOS (brew) are fully supported; Fedora
# (dnf) and Arch (pacman) are best-effort; anything else prints the shortfall
# and stops. Idempotent — every step self-skips when already satisfied.
#
# Usage: bash bootstrap/00-prereqs.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=bootstrap/lib.sh
. ./lib.sh
detect_platform

say "Platform: $JARVIS_OS (pkg: $JARVIS_PKG, wsl: $JARVIS_WSL)"
[ "$JARVIS_OS" = unknown ] && die "unsupported OS ($(uname -s)). Linux or macOS only."
if [ "$JARVIS_PKG" = none ]; then
  warn "no apt/dnf/pacman/brew found — you'll have to install system packages by hand."
fi

# --- system packages ---------------------------------------------------
say "System packages (git, curl, ffmpeg, espeak-ng, python3, pip)"
pkg_install git curl ffmpeg espeak-ng python3 python3-pip || \
  warn "some system packages could not be installed automatically — see the list above"

# --- uv ---------------------------------------------------------------
say "uv (Python package/venv manager)"
if command -v uv >/dev/null 2>&1; then
  skip "uv already installed ($(uv --version 2>/dev/null))"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # uv drops itself in ~/.local/bin; make it usable for the rest of this run.
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v uv >/dev/null 2>&1 \
    && say "uv installed — open a new shell later if a fresh terminal can't find it" \
    || warn "uv install ran but 'uv' still isn't on PATH — check ~/.local/bin"
fi

# --- gh -------------------------------------------------------------
say "gh (GitHub CLI)"
if command -v gh >/dev/null 2>&1; then
  skip "gh already installed"
else
  case "$JARVIS_PKG" in
    brew)   brew install gh ;;
    dnf)    sudo dnf install -y -q gh || warn "gh not in dnf repos — see cli.github.com" ;;
    pacman) sudo pacman -Sy --noconfirm --needed github-cli ;;
    apt)
      (type -p wget >/dev/null || sudo apt-get install -y -qq wget) \
        && sudo mkdir -p -m 755 /etc/apt/keyrings \
        && wget -nv -O /tmp/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        && sudo cp /tmp/githubcli.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
        && sudo apt-get update -qq && sudo apt-get install -y -qq gh ;;
    none)   warn "install gh yourself: https://github.com/cli/cli#installation" ;;
  esac
fi

say "gh auth"
if gh auth status >/dev/null 2>&1; then
  skip "already logged into gh"
else
  echo "    not logged in — run 'gh auth login' when you want GitHub access (optional for core)"
fi

# --- Claude Code CLI --------------------------------------------------
say "Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  skip "claude already installed ($(claude --version 2>/dev/null))"
else
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null 2>&1 \
    && say "claude installed" \
    || warn "claude install ran but 'claude' isn't on PATH yet — open a new shell"
fi

echo
echo "Prereqs done. Next: bootstrap/wizard.sh runs the rest (or 'make wizard')."
