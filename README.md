# Jarvis

Personal chief-of-staff system: an operating stack plus the knowledge vault that
drives it. Runs in a GitHub Codespace, or on any Linux/macOS machine via the
installer.

Licensed **PolyForm Noncommercial 1.0.0** — free for personal and hobby use, no
commercial use. See [LICENSE](LICENSE).

## Install (fresh machine)

```sh
curl -fsSL https://github.com/lahbnaba91-source/Jarvis/releases/latest/download/install.sh | bash
```

Downloads a pinned release (never `main`), unpacks to `~/jarvis`, and runs the
setup wizard — fresh empty vault, your own assistant name, your own secrets.
Full details and flags in [INSTALL.md](INSTALL.md).

## Layout

| Path | What it is | Runs on |
| --- | --- | --- |
| `CLAUDE.md` | Jarvis boot config — identity + the rules that can't lapse. Loads every session. Generated (gitignored) from `templates/CLAUDE.md.tmpl` + `CLAUDE.vars`; regen with `scripts/render-claude-md.sh`. | — |
| `install.sh`, `bootstrap/` | The public one-line installer and the setup wizard it runs (`bootstrap/wizard.sh`). | — |
| `templates/` | `CLAUDE.md.tmpl` and `vault-skeleton/` — what a fresh install is built from. | — |
| `HQ/` | The Obsidian vault: Jarvis's memory and formation. **Not tracked here** — own repo (`hq-vault`), synced separately, kept on disk for the local session. Start at `HQ/VAULT-INDEX.md`. | — |
| `barehands/` | Hand-tracked glass board — second-screen gesture cockpit, viewed from a phone. Vendored from `jaredrhod/barehands` plus local gesture/customization work — see `barehands/DIVERGENCE.md`. | `:8794` |
| `ai-visualizer/` | Jarvis Face — the talking-head visualizer. Vendored from `jaredrhod/ai-visualizer` plus a voice-proxy patch + bind fix — see `ai-visualizer/DIVERGENCE.md`. | `:8790` |
| `jarvis-voice/` | Voice server — Whisper (STT) + Kokoro (TTS). Python, managed with `uv`. First run downloads ~1GB of models. | `:8791` (internal) |
| `next-app/` | **Site Analyzer** — free 3D building / terrain / solar-analysis tool. Next.js + Cesium + OSM. Needs a (free) Cesium ion token in `next-app/.env.local`. | `:3000` (dev) |
| `services/badge/` | **BADGE** — aviation cosmic-radiation dose engine. Native PARMA driver (C++), cross-checked to floating-point rounding against EXPACS/PARMA reference. Zero npm dependencies. `vendor/` provenance in `services/badge/vendor/PROVENANCE.md`. | — |
| `scripts/` | Operational tooling — see below. | — |
| `.claude/` | Claude Code settings, hooks, and skills that ship with the clone. | — |
| `tests/` | Cross-cutting Python tests (currently the vault tooling). Per-project suites live under each project. | — |

### `scripts/`

| Path | Purpose |
| --- | --- |
| `install-prereqs.sh` | Back-compat shim → `bootstrap/00-prereqs.sh` (system packages, `uv`, `gh`, Claude Code). |
| `bootstrap.sh` | Back-compat shim → `bootstrap/wizard.sh` (the full interactive setup). |
| `render-claude-md.sh` | Regenerate `CLAUDE.md` from `templates/CLAUDE.md.tmpl` + `CLAUDE.vars`. |
| `start-all.sh` | Bring the stack up (`ai-visualizer`, `jarvis-voice`, `barehands`). Skips anything already listening. |
| `session/guard.sh` | SessionStart hook — warns when another Jarvis session shares the working tree. |
| `session/worktree.sh` | Make a private worktree + branch for isolated work. |
| `vault-lookup/lookup.py` | Deterministic note resolution for the vault. `CLAUDE.md` tells every session to run this first. |
| `vault-audit/audit.py` | Read-only vault structural-drift detector. SessionStart hook. |
| `claude-quota/` | Watches Claude usage; swaps credentials to a fallback account near the cap. |
| `codespace-usage/usage.sh` | Terminal check for GitHub Codespaces free-allowance usage. |
| `spotify/`, `hubspace/`, `lightshow/` | Playback / smart-light / light-show control. |
| `groq-agent/`, `gesture-classifier/` | Groq chat agent; MLP training pipeline for barehands gestures. |
| `pull-hq-vault.py`, `push-hq-vault.py` | Sync `HQ/` against the `hq-vault` repo. |

## Bringing it up from a checkout

```sh
make wizard          # bootstrap/wizard.sh — prereqs, core stack, module menu
claude login         # interactive, when the wizard tells you to
```

Or the individual steps: `bash bootstrap/00-prereqs.sh` (deps) → `gh auth login`
→ `claude login` → `bash bootstrap/wizard.sh`. In a Codespace,
`.devcontainer/devcontainer.json` runs the prereqs step on create; the rest is
run by hand because it prompts for secrets. See `HQ/05 - Resources/Vault
Tooling/Full Rebuild (disaster recovery).md` for the disaster-recovery checklist.

## Common tasks

```sh
make help      # list targets
make test      # run every fast test suite (same commands CI runs)
make lint      # ruff + shellcheck  (eslint needs `npm ci` in next-app/)
make dev       # start-all.sh
```

## CI / releases

`.github/workflows/ci.yml` runs the BADGE, Site Analyzer, barehands, Python, and
shell suites on every push. It never touches `HQ/` or the always-on services.

`.github/workflows/release.yml` fires on a `vX.Y.Z` tag: it builds
`jarvis-dist-<tag>.tar.gz` from the tracked tree (no vault, no local state,
placeholder `CLAUDE.md`) and publishes it as a GitHub Release with `install.sh`
attached. `make release VERSION=vX.Y.Z` cuts the tag.
