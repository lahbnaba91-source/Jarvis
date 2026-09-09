# ai-visualizer — divergence from upstream

**Upstream:** [github.com/jaredrhod/ai-visualizer](https://github.com/jaredrhod/ai-visualizer), by Jared Rhodenizer (@jaredrhod). AGPL-3.0-or-later.

**How it lives here:** a full vendored copy, tracked file-for-file inside the
Jarvis monorepo — **not** a submodule, not a checkout `run.sh` re-clones.

## Why it's tracked directly

Same incident as `barehands/DIVERGENCE.md`: this used to be excluded from the
Jarvis repo, the Jarvis-specific voice-proxy patch and bind fix lived only as
uncommitted edits on one machine's disk, and a fresh codespace on 2026-08-30
came up with vanilla upstream and no proxy — the `ai-visualizer` face
couldn't reach `jarvis-voice`. Rebuilt on top of current upstream that day.

**The rule:** never leave a change to a file in this directory as an
uncommitted local edit. Commit it into the Jarvis repo the same session with
a `feat(ai-visualizer):` / `fix(ai-visualizer):` message. The Jarvis repo is
the source of truth for this code — there is no other copy with our history.

## What diverges from upstream

In `server.py` (see `git log -- ai-visualizer/` for diffs):

- **Bind `0.0.0.0` instead of `127.0.0.1`** (`server.py` ~L296) — Codespaces'
  port-forward auto-detection needs a non-loopback bind to list the port.
  `jarvis-voice` on 8791 deliberately stays loopback-only.
- **`do_POST` voice proxy** (~L215) — forwards `/listening`, `/chunk`,
  `/stop`, `/demo` to `http://127.0.0.1:8791` (the `jarvis-voice` service);
  404s anything else; 502 + JSON error if `jarvis-voice` is unreachable.
- **`_proxy_get` for `GET /logs`** (~L190) — same forward, so the face page
  can show turn history from `jarvis-voice`.

Other Jarvis commits: `a02df8f` (static "THE HANDS" card linking to
barehands' `stage.html`, `H` shortcut, hostname URL fallback), `f013b00`
(the Hands card), `29dba0c` (synced upstream disconnect handling).

Runtime-only, never committed (see `.gitignore`): `ai-visualizer.json`,
`.voice_state`, `.voice_waveform`, `.voice_loading_pid`, `.voice_alert`.

## Pulling upstream fixes

`update.sh` / `run.sh` pull from upstream and will collide with the proxy
patch. Reconcile by hand, commit as
`fix(ai-visualizer): sync upstream ... from jaredrhod/ai-visualizer`
(pattern: `29dba0c`), and verify the `/listening`→`/stop` round trip through
this server still reaches `jarvis-voice`.
