#!/bin/bash
# Step 0 of a rebuild, before scripts/bootstrap.sh: installs everything the
# Jarvis stack needs that ISN'T guaranteed to already be on the machine --
# system packages, gh CLI, uv, and Claude Code itself. On a GitHub Codespace
# using the stock Universal image, most of this is already present and each
# step skips itself; on a bare machine/different image, this does the work.
#
# Idempotent: safe to re-run.
#
# Usage: bash scripts/install-prereqs.sh
set -uo pipefail

say()  { echo "==> $1"; }
skip() { echo "    skip: $1"; }

say "System packages (git, curl, ffmpeg, espeak-ng, python3)"
need_apt=()
for pkg_bin in "git:git" "curl:curl" "ffmpeg:ffmpeg" "espeak-ng:espeak-ng" "python3:python3" "pip3:python3-pip"; do
  bin="${pkg_bin%%:*}" pkg="${pkg_bin##*:}"
  command -v "$bin" >/dev/null 2>&1 || need_apt+=("$pkg")
done
if [ "${#need_apt[@]}" -eq 0 ]; then
  skip "all present"
else
  sudo apt-get update -qq && sudo apt-get install -y -qq "${need_apt[@]}"
fi

say "uv (Python package/venv manager)"
if command -v uv >/dev/null 2>&1; then
  skip "uv already installed"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  echo "    installed uv -- open a new shell or re-source your profile if 'uv' isn't found next"
fi

say "gh (GitHub CLI)"
if command -v gh >/dev/null 2>&1; then
  skip "gh already installed"
else
  (type -p wget >/dev/null || sudo apt-get install -y -qq wget) \
    && sudo mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /tmp/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && sudo cp /tmp/githubcli.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
    && sudo apt-get update -qq && sudo apt-get install -y -qq gh
fi

say "gh auth"
if gh auth status >/dev/null 2>&1; then
  skip "already logged into gh"
else
  echo "    not logged in -- run 'gh auth login' interactively, this can't be scripted"
fi

say "Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  skip "claude already installed ($(claude --version 2>/dev/null))"
else
  curl -fsSL https://claude.ai/install.sh | bash
  echo "    installed -- open a new shell if 'claude' isn't found next"
fi

echo
echo "Next steps (can't be scripted):"
echo "  1. gh auth login        # if the gh auth check above said you're not logged in"
echo "  2. claude login         # authenticate Claude Code against your Anthropic account"
echo "  3. bash scripts/bootstrap.sh   # the actual Jarvis-specific setup (Parts 2-5 of the rebuild checklist)"
