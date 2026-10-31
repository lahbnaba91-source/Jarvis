#!/bin/bash
# Starts jarvis-mcp on :8795 using the jarvis-voice venv (claude-agent-sdk is
# already there), makes the port public so Sesame can reach it, and prints the
# URL to paste into Sesame. Safe to re-run: skips if already listening.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${JARVIS_MCP_PORT:-8795}"
PY="$ROOT/jarvis-voice/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "jarvis-voice venv missing — run: cd $ROOT/jarvis-voice && uv sync" >&2
  exit 1
fi

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "jarvis-mcp already running on :$PORT"
else
  (cd "$HERE" && nohup "$PY" server.py > "$HERE/server.log" 2>&1 &)
  echo "jarvis-mcp starting on :$PORT (log: $HERE/server.log)"
  sleep 2
fi

# Sesame's servers must reach this port, so it has to be public. The OAuth
# password gate is what protects it.
if [ -n "${CODESPACE_NAME:-}" ] && command -v gh >/dev/null; then
  gh codespace ports visibility "$PORT:public" -c "$CODESPACE_NAME" >/dev/null 2>&1 \
    && echo "port $PORT set to public" \
    || echo "couldn't set port public automatically — Ports tab → $PORT → Port Visibility → Public"
  echo
  echo "Paste this into Sesame:"
  echo "  https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/mcp"
fi

if [ -z "${JARVIS_MCP_PASSWORD:-}" ] && [ -f "$HERE/.state/password" ]; then
  echo
  echo "Connect password (generated): $(cat "$HERE/.state/password")"
fi
