#!/bin/bash
# barehands self-test (2026-09-09). Runs on every barehands start via
# start-all.sh, and any time by hand. Confirms:
#   - the board page + the face-mesh worker asset are served
#   - /health and /diag are alive
#   - the MediaPipe CDN deps the face mesh needs are reachable
#   - prints the live /health snapshot (hand + face tracking status)
# Never blocks: prints PASS/FAIL per check, always exits 0.
# See barehands/DIAGNOSTICS.md.
set -u
BASE="${1:-http://localhost:8794}"
FAILED=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }

echo "── barehands self-test $(date '+%Y-%m-%d %H:%M:%S') ── $BASE"

for path in /stage.html /face-mesh-worker.js /health "/diag"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$BASE$path")
  [ "$code" = 200 ] && ok "GET $path ($code)" || bad "GET $path ($code)"
done

# the three external URLs the face mesh pulls (module, wasm loader, model)
while read -r label url; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url")
  [ "$code" = 200 ] && ok "CDN $label ($code)" || bad "CDN $label ($code) — $url"
done <<'EOF'
tasks-vision-module https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs
tasks-vision-wasm https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js
face-landmarker-model https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
EOF

echo "  /health:"
curl -s --max-time 8 "$BASE/health" | python3 -m json.tool 2>/dev/null | sed 's/^/    /' \
  || echo "    (no JSON — server not up yet?)"

if [ "$FAILED" = 0 ]; then
  echo "  => all green"
else
  echo "  => some checks failed (above). Face mesh not loading? open $BASE/diag?html=1"
fi
exit 0
