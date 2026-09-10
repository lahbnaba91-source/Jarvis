#!/bin/bash
# Wizard step 2 — Claude Code auth prep.
#   * confirm the CLI is on PATH
#   * pre-approve the first-run "trust this folder?" dialog (an arrow-key menu
#     that a phone/mobile-browser terminal can't navigate)
#   * point you at `claude login`
#
# It cannot run `claude login` for you — that's an interactive OAuth flow.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=bootstrap/lib.sh
. ./lib.sh
jarvis_resolve_root
export PATH="$HOME/.local/bin:$PATH"

say "Claude Code CLI"
if command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1; then
  skip "claude CLI present ($(claude --version 2>/dev/null))"
else
  warn "claude CLI not on PATH — run bootstrap/00-prereqs.sh, open a NEW terminal, then re-run."
  exit 0
fi

say "Trust-dialog pre-approval"
CJSON="$HOME/.claude.json"
if [ -f "$CJSON" ]; then
  ROOT="$JARVIS_ROOT" python3 - <<'PY' && echo "    pre-approved trust for $JARVIS_ROOT"
import json, os
p = os.path.expanduser("~/.claude.json")
d = json.load(open(p))
d.setdefault("projects", {}).setdefault(os.environ["ROOT"], {})["hasTrustDialogAccepted"] = True
json.dump(d, open(p, "w"))
PY
else
  skip "~/.claude.json doesn't exist yet — run 'claude' once, then re-run this step"
fi

say "Login"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  skip "credentials file present — verify it's the account you want (claude login to switch)"
else
  echo "    run:  claude login    (authenticates Claude Code against your Anthropic account)"
fi
