#!/bin/bash
# Starts ai-visualizer (8790), jarvis-voice (8791), and barehands (8794).
# Skips any service whose port is already listening. None of these survive
# a codespace restart, so this is the "bring the stack back up" command.
set -uo pipefail

# Repo root: honour an explicit JARVIS_ROOT, else self-locate from this script.
ROOT="${JARVIS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

start() {
  local name="$1" port="$2" dir="$3" cmd="$4" log="$5"
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    echo "$name already running on :$port — skipping"
    return
  fi
  (cd "$dir" && mkdir -p "$(dirname "$log")" && nohup $cmd > "$log" 2>&1 &)
  echo "$name starting on :$port (log: $log)"
}

start "ai-visualizer" 8790 "$ROOT/ai-visualizer" "python3 server.py --no-open" "$ROOT/.voice-bus/server.log"
start "jarvis-voice"  8791 "$ROOT/jarvis-voice" ".venv/bin/python server.py" "$ROOT/jarvis-voice/tmp/server.log"
start "barehands"     8794 "$ROOT/barehands" "python3 server.py" state/server.log

echo "jarvis-voice takes a few seconds to warm models — tail tmp/server.log for 'jarvis-voice ready'."

# barehands self-test: confirms the board, the face-mesh worker asset and
# the MediaPipe CDN deps are all reachable, and prints the live /health
# snapshot. Backgrounded so it never delays the stack; prints when ready.
( sleep 3; bash "$(cd "$(dirname "$0")" && pwd)/barehands-selftest.sh" ) &
