#!/bin/bash
# Wizard final step — bring the always-on services up and print what's left.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=bootstrap/lib.sh
. ./lib.sh
jarvis_resolve_root
export PATH="$HOME/.local/bin:$PATH"

say "Starting the stack"
if [ -x "$JARVIS_ROOT/scripts/start-all.sh" ]; then
  bash "$JARVIS_ROOT/scripts/start-all.sh"
else
  warn "scripts/start-all.sh missing — cannot start services"
fi

cat <<EOF

Jarvis core is up. Ports:
  ai-visualizer (face)   http://localhost:8790
  barehands (board)      http://localhost:8794
  jarvis-voice           :8791 (internal)

Next:
  1. If you haven't:  claude login
  2. From $JARVIS_ROOT run:  claude
  3. Optional modules (Spotify, Hubspace, Site Analyzer, ...):  bash bootstrap/30-modules.sh
  4. Your vault is a fresh skeleton at $JARVIS_ROOT/HQ — open it in Obsidian and
     fill in VAULT-INDEX.md.
EOF
