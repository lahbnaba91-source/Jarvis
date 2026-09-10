# Install Jarvis

One command stands up the full core stack on your own machine — your own empty
vault, your own name for the assistant, your own secrets. Nothing of anyone
else's comes with it.

```sh
curl -fsSL https://github.com/lahbnaba91-source/Jarvis/releases/latest/download/install.sh | bash
```

That downloads a **pinned release** (never `main`), unpacks it to `~/jarvis`, and
runs the setup wizard.

## Requirements

- **Linux** (Debian/Ubuntu fully supported; Fedora/Arch best-effort) or **macOS**.
  Windows: run it inside **WSL**.
- `curl`, `tar`. The wizard installs everything else it needs (`git`, `python3`,
  `node`/`uv`, `gh`, the Claude Code CLI, `ffmpeg`, `espeak-ng`).
- A free **Anthropic account** for Claude Code. You'll run `claude login` once at
  the end.

## Options

Pass flags after `| bash -s --`:

```sh
curl -fsSL .../install.sh | bash -s -- --dir ~/work/jarvis --core-only
```

| Flag | Effect |
| --- | --- |
| `--dir PATH` | Install location (default `~/jarvis`, or `$JARVIS_HOME`). Must be empty. |
| `--version vX.Y.Z` | Install a specific release instead of the latest. |
| `--core-only` | Skip the optional-module step entirely. |
| `--with a,b,c` | Enable optional modules without prompting (`all` for every one). |
| `--yes` | Assume "yes"/defaults for every prompt. |

## What "core" is

Always installed: the vault system + your rendered `CLAUDE.md`, **barehands**
(the hand-tracked glass board, `:8794`), **ai-visualizer** (the talking-head
face, `:8790`), **jarvis-voice** (Whisper + Kokoro, `:8791` internal — first run
downloads ~1GB of models), the Claude Code session hooks, and the skills.

## Optional modules

Prompted for one at a time at the end, each skippable, each re-runnable later
with `bash bootstrap/30-modules.sh`:

- **spotify** — playback control (needs a Spotify Developer app)
- **hubspace** — smart-lamp control (needs the lamp's account)
- **groq** — a free-tier terminal chat agent (needs a Groq API key)
- **site-analyzer** — the Next.js 3D terrain/solar tool (needs a free Cesium ion token)
- **badge** — the aviation cosmic-radiation dose engine (builds a native driver)
- **claude-quota** — auto-swap to a second Anthropic account near the rate cap
- **vault-sync** — connect your local vault to your own private GitHub repo for
  Obsidian-mobile sync

## Updating

Re-run the installer into a fresh directory with a newer `--version` (or just
`latest`), then copy your `HQ/` vault and your secret files across. In-place
upgrades aren't supported yet.

## After it finishes

```sh
cd ~/jarvis
claude login      # if you haven't
claude            # start a session
```

Open `~/jarvis/HQ/VAULT-INDEX.md` in Obsidian and fill in the profile stubs.
