# barehands — divergence from upstream

**Upstream:** [github.com/jaredrhod/barehands](https://github.com/jaredrhod/barehands), `barehands.md` version 1.0, by Jared Rhodenizer (@jaredrhod). AGPL-3.0-or-later.

**How it lives here:** a full vendored copy, tracked file-for-file inside the
Jarvis monorepo — **not** a git submodule, not a checkout that `update.sh`
re-clones. Every file in this directory is a real tracked file in the Jarvis
repo and every Jarvis-specific change is a real commit here.

## Why it's tracked directly (read before you "clean this up")

barehands used to be excluded from the Jarvis repo entirely, on the theory
that `update.sh` would always re-vendor a clean upstream copy and our
customizations lived in a separate local `barehands/` git repo. That local
repo **had no remote**. A fresh codespace cloned Jarvis, ran the barehands
installer, and got vanilla upstream with **none** of the gesture / Hubspace /
Spotify / light-show work — which only existed as uncommitted edits on one
machine's disk. Luis restored it from a personal backup on 2026-08-30.
`ai-visualizer` lost its voice-proxy patch the same way, same day.

**The rule that came out of that:**

1. **Never leave a change to a file in this directory as an uncommitted local
   edit.** If you change `server.py`, `stage.html`, `gestures.js`, etc., it
   gets committed into the Jarvis repo in the same session, with a
   `feat(barehands):` / `fix(barehands):` message. A daily-note mention is not
   a substitute for the commit.
2. **The Jarvis repo is the source of truth for this code**, not upstream and
   not any local sidecar repo. There is no other copy with our history.
3. If you must `mv`/rename a vendored file, fix references by hand — the same
   wikilink-rename caveat the vault has.

## What diverges from upstream

Jarvis-specific work, newest first (see `git log -- barehands/` for the full
diffs):

| Commit prefix | What |
|---|---|
| `feat(barehands): CALIBRATE rework, gesture lab, light orb` | second-device remote-driven calibration capture (`/dev/arm`, `/dev/capture`), gesture-take playback + confusion matrix in `dev.html`, open-palm-summoned Hubspace light orb |
| `feat(barehands): dev dashboard` | `dev.html` / `dev.js` — second-device live gesture-tuning cockpit, `/dev/telemetry` + `/dev/stream` |
| `feat(barehands): COAST` | predict-through-dropout Kalman filter for occluded landmarks (`smoothing.js`) |
| `fix(barehands): lower default capture res` + swipe-scroll + gesture SFX | |
| `feat(barehands): GAME dock toggle` | rock-paper-scissors behind a session-local toggle |
| `feat(barehands): shush-to-pause, RPS, pile deck` | |
| `feat(barehands): options dock, 60fps capture, spin-catch, depth push/pull` | |

Plus, in `server.py` specifically, Jarvis endpoints not in upstream:
`/light/*` (Hubspace), `/spotify/*`, `/show/*` (ROCK ON light show),
`/config` gesture persistence, `/dev/*`, `/tree` + `/note` (vault notes orb,
jailed read-only).

Runtime-only, never committed (see `.gitignore`): `barehands.json`,
`state/*`, `state/gesture_log.jsonl`.

## Pulling upstream fixes

`update.sh` pulls from upstream. It will collide with the divergence above —
reconcile by hand, commit the merge as
`chore(barehands): sync upstream fixes from jaredrhod/barehands` (see
`09a2424` for the pattern), and re-run the tests in `test/`.
