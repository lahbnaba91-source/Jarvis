#!/bin/bash
# Regenerate ./CLAUDE.md from templates/CLAUDE.md.tmpl + ./CLAUDE.vars
#
# CLAUDE.md is gitignored (it holds personal identity/tone values). The tracked
# artefacts are the template and — for this machine only — CLAUDE.vars, which is
# also gitignored. Run this after editing either one.
#
#   CLAUDE.vars  (KEY=value, one per line, # comments ok, KEY= deletes the tag):
#     ASSISTANT_NAME=Jarvis
#     USER_NAME=Luis
#     TONE=Talk to me like a guy friend at a bar: ...
#     ADDRESS_LINE=Call me **"boss" or "Luis"** — ...
#     MAKE_IT_YOURS=Call me "boss" or "Luis" — never anything more formal ...
#     VAULT_PATH=/workspaces/Jarvis/HQ
#     JARVIS_ROOT=/workspaces/Jarvis
#     TIMEZONE=Pacific — Pacific/Tijuana
#     WELCOME_LINE=All systems online, boss. What are we working on today?
#     MULTISESSION_TAIL=; this cost real recovery work on 2026-09-04.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMPL="templates/CLAUDE.md.tmpl"
VARS="${1:-CLAUDE.vars}"
OUT="CLAUDE.md"

[ -f "$TMPL" ] || { echo "missing $TMPL" >&2; exit 1; }
[ -f "$VARS" ] || { echo "missing $VARS — copy CLAUDE.vars.example and fill it in" >&2; exit 1; }

tmp="$(mktemp)"
cp "$TMPL" "$tmp"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  esc="$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')"
  sed -i "s|@@${key}@@|${esc}|g" "$tmp"
done < "$VARS"

if grep -q '@@[A-Z_]*@@' "$tmp"; then
  echo "WARN: unresolved placeholders remain:" >&2
  grep -o '@@[A-Z_]*@@' "$tmp" | sort -u >&2
fi

mv "$tmp" "$OUT"
echo "wrote $OUT from $TMPL + $VARS"
