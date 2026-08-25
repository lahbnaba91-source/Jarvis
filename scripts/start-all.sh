#!/bin/bash
# Starts ai-visualizer (8790), jarvis-voice (8791), and barehands (8794).
# Skips any service whose port is already listening. None of these survive
# a codespace restart, so this is the "bring the stack back up" command.
set -uo pipefail

start() {
  local name="$1" port="$2" dir="$3" cmd="$4" log="$5"
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    echo "$name already running on :$port — skipping"
    return
  fi
  (cd "$dir" && nohup $cmd > "$log" 2>&1 &)
  echo "$name starting on :$port (log: $log)"
}

start "ai-visualizer" 8790 /workspaces/Jarvis/ai-visualizer "python3 server.py --no-open" /workspaces/Jarvis/.voice-bus/server.log
start "jarvis-voice"  8791 /workspaces/Jarvis/jarvis-voice ".venv/bin/python server.py" /workspaces/Jarvis/jarvis-voice/tmp/server.log
start "barehands"     8794 /workspaces/Jarvis/barehands "python3 server.py" state/server.log

echo "jarvis-voice takes a few seconds to warm models — tail tmp/server.log for 'jarvis-voice ready'."
