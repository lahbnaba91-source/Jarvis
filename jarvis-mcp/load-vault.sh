#!/bin/bash
# Gives jarvis-mcp the same knowledge as your main Jarvis:
#   1. copies the HQ vault (lalp070125/hq-vault) into ./HQ as a plain folder
#   2. writes CLAUDE.md (Jarvis's identity + where the vault is) if missing
#   3. restarts jarvis-mcp so the next Sesame question uses it
#
# Needs HQVAULT_TOKEN: a fine-grained token with Contents: Read on hq-vault,
# saved as a Codespaces secret (github.com/settings/codespaces).
# Safe to re-run: each run refreshes HQ/ from GitHub. HQ/ is read-only here,
# so nothing local is lost; your phone and main setup stay the source of truth.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OWNER="${HQVAULT_OWNER:-lalp070125}"
REPO="${HQVAULT_REPO:-hq-vault}"
JARVIS_SRC="${JARVIS_SRC:-https://github.com/lahbnaba91-source/Jarvis.git}"
cd "$ROOT"

if [ -z "${HQVAULT_TOKEN:-}" ]; then
  echo "HQVAULT_TOKEN is not set."
  echo "  1. As $OWNER: github.com/settings/personal-access-tokens -> Generate new token"
  echo "     Only select repositories: $REPO   Permissions: Contents = Read-only"
  echo "  2. github.com/settings/codespaces -> New secret: HQVAULT_TOKEN, give it this repo"
  echo "  3. Stop and reopen this Codespace, then run this script again."
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "-> downloading $OWNER/$REPO"
git -c credential.helper= clone -q --depth 1 \
  "https://x-access-token:${HQVAULT_TOKEN}@github.com/${OWNER}/${REPO}.git" "$tmp/hq" \
  || { echo "couldn't clone $OWNER/$REPO: check the token has access to that repo" >&2; exit 1; }
snap_commit="$(git -C "$tmp/hq" rev-parse HEAD)"
rm -rf "$tmp/hq/.git"
rm -rf HQ.new && cp -a "$tmp/hq" HQ.new && rm -rf HQ && mv HQ.new HQ
# When this copy was taken, kept OUTSIDE HQ/ so it can never be pushed into
# the vault. Jarvis uses it to label local findings with their age.
printf '{"commit": "%s", "taken_at": %s, "taken_at_iso": "%s", "repo": "%s/%s"}\n' \
  "$snap_commit" "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OWNER" "$REPO" > .hq-snapshot.json
echo "   HQ/ ready: $(find HQ -name '*.md' | wc -l) notes (commit ${snap_commit:0:7})"

# evidence-backed status checks used by server.py
if [ ! -f jarvis_core/evidence.py ]; then
  echo "-> copying jarvis_core (status verification) from Jarvis"
  git clone -q --depth 1 "$JARVIS_SRC" "$tmp/jvc"
  cp -r "$tmp/jvc/jarvis_core" .
fi

# keep personal files out of this repo's git history
touch .gitignore
for p in HQ/ CLAUDE.md CLAUDE.vars jarvis-voice/.venv/ .hq-snapshot.json; do
  grep -qxF "$p" .gitignore || echo "$p" >> .gitignore
done

if [ ! -f CLAUDE.md ]; then
  echo "-> building CLAUDE.md from the Jarvis template"
  git clone -q --depth 1 "$JARVIS_SRC" "$tmp/jv"
  mkdir -p templates scripts
  cp "$tmp/jv/templates/CLAUDE.md.tmpl" templates/
  cp "$tmp/jv/scripts/render-claude-md.sh" scripts/
  cp -r "$tmp/jv/scripts/vault-lookup" scripts/ 2>/dev/null || true
  if [ ! -f CLAUDE.vars ]; then
    cat > CLAUDE.vars <<VARS
ASSISTANT_NAME=Jarvis
USER_NAME=Luis
TONE=Be direct and plain-spoken, with a bit of wit. Skip corporate hedging and filler; every response, including the factual ones.
ADDRESS_LINE=Call me "boss" or "Luis".
MAKE_IT_YOURS=Call me "boss" or "Luis" — keep it that informal.
BOARD_CLIENT=a phone's browser
VAULT_PATH=$ROOT/HQ
JARVIS_ROOT=$ROOT
TIMEZONE=America/Los_Angeles
WELCOME_LINE=All systems online, boss. What are we working on today?
MULTISESSION_TAIL=.
VARS
    echo "   wrote default CLAUDE.vars (edit it and re-run scripts/render-claude-md.sh to change tone)"
  fi
  bash scripts/render-claude-md.sh
fi

echo "-> restarting jarvis-mcp"
pkill -f "python.*server.py" 2>/dev/null || true
sleep 2
bash "$HERE/start.sh"
echo
echo "Done. Ask Sesame: \"Ask Jarvis what's on my plate this week.\""
