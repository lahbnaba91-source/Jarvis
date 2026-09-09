# barehands diagnostics

The board runs headless on a phone whose browser console nobody can see.
This wiring makes the hand/face pipelines report their own state to the
server, where it's readable.

## What reports

`stage.html` and `face-mesh-worker.js` `POST /diag` on:

- **boot-probe** — one event on page load: UA, secure-context, module-worker
  support, `createImageBitmap`, `OffscreenCanvas`, WASM + SIMD, WebGL2,
  device memory / cores, DPR, the chosen `?facemesh` mode/delegate.
- **csp-violation** — any Content-Security-Policy block (the Codespaces
  proxy can inject one that stops the worker importing from the CDN).
- **error / unhandledrejection** — every uncaught page error.
- **facemesh-state** — every transition of the mesh pipeline:
  `start-requested → loading model → ready → first-frame-capture →
  first-frame-sent → tracking / no face in frame / error → stopped`.
- **facemesh-worker** — the worker's own stages: `boot → import-start →
  import-ok → fileset-start → fileset-ok → model-start → model-ok`, then
  `first-frame-received → first-result`, plus `init-fail` /
  `inference-error` / `global-error` with the message.
- **hands-heartbeat** — every 5s: `detectorOk`, `fps`, hands in frame,
  `everSawHand`, whether SKELETON is on, the hand delegate.
- **server-start** — written by `server.py` on boot.

## How to read it

- **On the phone**: a fixed status strip across the top —
  `hands:ok 24fps | faceMesh[worker]:tracking f31/r29`. Hide with
  `?diag=0` (events still POST).
- **`GET /health`** — latest of each kind folded into one JSON snapshot.
- **`GET /diag`** — raw event list (JSON). **`GET /diag?html=1`** — a
  readable page, newest first.
- **`scripts/barehands-watch.sh &`** — tails `state/diag.jsonl` live,
  one compact line per event.
- **`scripts/barehands-selftest.sh`** — runs on every barehands start
  (via `start-all.sh`) and by hand: checks the board, the worker asset,
  `/health`, `/diag`, and the three MediaPipe CDN URLs, then prints
  `/health`.

Events: last 300 in memory, all appended to `state/diag.jsonl`
(gitignored).

## Ways to attack a broken face mesh

URL switches on `stage.html`:

| switch | effect |
|---|---|
| `?facemesh=worker` | default — 478-pt mesh in a module Web Worker |
| `?facemesh=main` | run the same model on the **main thread** — bisects worker / module-worker / CSP problems |
| `?facemesh=off` | disable the mesh entirely |
| `?facemesh-delegate=gpu` | GPU delegate instead of CPU/WASM (worker or main) |
| `?diag=0` | hide the on-screen strip |

If **csp-violation** fires against `cdn.jsdelivr.net` or
`storage.googleapis.com`, the fix is to **self-host** the MediaPipe wasm
bundle + the `face_landmarker.task` model from this server (same origin,
no CSP/CORS/CDN-in-worker). Stage the files under
`barehands/vendor/tasks-vision/` and point `face-mesh-worker.js` +
`startFaceMeshMain()` at the local paths.

Other levers once it loads but costs FPS:
- raise `FACE_MESH_EVERY_MS` (inference cadence) in `stage.html`
- lower `FACE_MESH_MAXDIM` (frame size handed to the model)
- draw a contour set (`FACE_LANDMARKS_FACE_OVAL` / `_LIPS` / `_LEFT_EYE`
  …, ~130 pts) instead of `FACE_LANDMARKS_TESSELATION` (~2600 edges)
