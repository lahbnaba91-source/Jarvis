#!/bin/bash
# barehands diagnostics watch (2026-09-09). Follows the /diag event
# stream (state/diag.jsonl) and prints a compact rolling line per event,
# so a debugging session can see exactly what the phone's hand/face
# pipelines are doing without the phone's console. Run detached:
#   scripts/barehands-watch.sh &
# Ctrl-C to stop. Reads nothing it shouldn't; pure tail + format.
# See barehands/DIAGNOSTICS.md.
set -u
BASE="${1:-http://localhost:8794}"
DIAG="/workspaces/Jarvis/barehands/state/diag.jsonl"

echo "══ barehands watch — $(date '+%H:%M:%S') ══"
echo "health snapshot:"
curl -s --max-time 5 "$BASE/health" | python3 -m json.tool 2>/dev/null | sed 's/^/  /' \
  || echo "  (server not answering /health)"
echo "── following $DIAG (Ctrl-C to stop) ──"

mkdir -p "$(dirname "$DIAG")"; touch "$DIAG"

tail -n 3 -F "$DIAG" 2>/dev/null | while IFS= read -r line; do
  printf '%s\n' "$line" | python3 -c '
import sys, json, time
try:
    e = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
k = e.get("kind", "?")
src = e.get("src", "?")
when = time.strftime("%H:%M:%S", time.localtime(e.get("t", time.time())))
skip = {"kind", "t", "ip", "seq", "src"}
# keep the informative fields first, in a stable order
order = ["state", "stage", "detail", "mode", "delegate", "msg", "err",
         "blockedURI", "violatedDirective", "effectiveDirective",
         "reason", "ok", "ready", "busy", "frames", "results", "fps",
         "detectorOk", "hands", "everSawHand", "pts", "hasBlend",
         "moduleWorker", "createImageBitmap", "wasmSIMD", "webgl2", "ua"]
keys = [x for x in order if x in e] + [x for x in e if x not in skip and x not in order]
body = "  ".join(f"{x}={e[x]}" for x in keys)
print(f"{when}  {src:6} {k:20} {body}")
'
done
