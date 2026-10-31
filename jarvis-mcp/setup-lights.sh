#!/bin/bash
# One-time setup so Sesame can control the Hubspace lamp through jarvis-mcp.
#   1. copies scripts/hubspace/ from the Jarvis repo (if not already here)
#   2. gives it its own venv with aioafero
#   3. logs in to Hubspace once (password is used once and not saved; only
#      the refresh token is cached in scripts/hubspace/.state/, gitignored)
#   4. restarts jarvis-mcp so Sesame sees the new control_light tool
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
JARVIS_SRC="${JARVIS_SRC:-https://github.com/lahbnaba91-source/Jarvis.git}"
HS="$ROOT/scripts/hubspace"
cd "$ROOT"

if [ ! -f "$HS/hubspace_light.py" ]; then
  echo "-> copying the Hubspace script from Jarvis"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git clone -q --depth 1 "$JARVIS_SRC" "$tmp/jv"
  mkdir -p "$ROOT/scripts"
  cp -r "$tmp/jv/scripts/hubspace" "$ROOT/scripts/"
fi

touch .gitignore
for p in scripts/hubspace/.state/ scripts/hubspace/.venv/; do
  grep -qxF "$p" .gitignore || echo "$p" >> .gitignore
done

if [ ! -x "$HS/.venv/bin/python3" ]; then
  echo "-> installing Hubspace library (about a minute)"
  python3 -m venv "$HS/.venv"
  "$HS/.venv/bin/pip" install -q -r "$HS/requirements.txt"
fi

if [ ! -f "$HS/.state/refresh_token" ]; then
  echo "-> one-time Hubspace login (the app you use for the lamp)"
  read -rp "   Hubspace email: " HUBSPACE_EMAIL
  read -rsp "   Hubspace password (hidden): " HUBSPACE_PASSWORD; echo
  export HUBSPACE_EMAIL HUBSPACE_PASSWORD
fi

echo "-> checking the lamp"
(cd "$HS" && "$HS/.venv/bin/python3" hubspace_light.py status)
unset HUBSPACE_PASSWORD

echo "-> restarting jarvis-mcp"
pkill -f "python.*server.py" 2>/dev/null || true
sleep 2
bash "$HERE/start.sh"
echo
echo "Done. In Sesame, remove and re-add the Jarvis connection (or start a new call),"
echo "then say: \"Turn my lamp blue.\""
