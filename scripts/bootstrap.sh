#!/bin/bash
# Automated version of HQ/05 - Resources/Full Rebuild (disaster recovery).md
# Parts 2-5: everything that can run unattended, once the Jarvis repo itself
# exists in this Codespace (repo creation and opening the Codespace stay
# manual — nothing here can bootstrap from a shell that doesn't exist yet).
#
# Idempotent: safe to re-run. Each step checks whether it's already done
# and skips it rather than redoing work or asking twice.
#
# Usage: bash scripts/bootstrap.sh
set -uo pipefail

JARVIS_ROOT="/workspaces/Jarvis"
cd "$JARVIS_ROOT" || { echo "ERROR: expected to run from $JARVIS_ROOT" >&2; exit 1; }

say()  { echo "==> $1"; }
skip() { echo "    skip: $1"; }
warn() { echo "    WARN: $1" >&2; }

ask() {
  # ask "prompt" "default" -> echoes the answer
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply
    echo "$reply"
  fi
}

confirm() {
  # confirm "prompt" -> 0 (yes) or 1 (no), default no
  local reply
  read -r -p "$1 [y/N]: " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "Jarvis bootstrap — automating Full Rebuild Parts 2-5"
echo "Full checklist: HQ/05 - Resources/Full Rebuild (disaster recovery).md"
echo

# ---------------------------------------------------------------------------
# Part 2.4 — system dependencies
# ---------------------------------------------------------------------------
say "System dependencies (espeak-ng, ffmpeg)"
if command -v espeak-ng >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  skip "espeak-ng and ffmpeg already installed"
else
  sudo apt-get update -qq && sudo apt-get install -y -qq espeak-ng ffmpeg
fi

# ---------------------------------------------------------------------------
# Part 2.3 — vendored repos
# ---------------------------------------------------------------------------
say "ai-visualizer (vendored)"
if [ -d ai-visualizer/.git ] || [ -d ai-visualizer ]; then
  skip "ai-visualizer/ already present"
else
  git clone -q https://github.com/jaredrhod/ai-visualizer ai-visualizer
  echo "    cloned ai-visualizer"
fi

say "barehands (vendored, but may carry real local history)"
if [ -d barehands/.git ]; then
  skip "barehands/.git already present — has its own local repo, leaving it alone"
elif [ -d barehands ]; then
  skip "barehands/ already present"
else
  backup_path=$(ask "Path to a barehands/ backup with its own .git (blank = none, fresh-vendor and accept history loss)" "")
  if [ -n "$backup_path" ] && [ -d "$backup_path/.git" ]; then
    cp -a "$backup_path" barehands
    echo "    restored barehands/ from backup, local git history intact"
  else
    [ -n "$backup_path" ] && warn "no .git found at '$backup_path' — falling back to fresh vendor"
    git clone -q https://github.com/jaredrhod/barehands barehands
    (cd barehands && rm -rf .git) # start-clean; barehands' own update.sh re-inits if needed
    echo "    cloned barehands fresh (no prior local history)"
  fi
fi

# ---------------------------------------------------------------------------
# Part 2.5 — python venvs
# ---------------------------------------------------------------------------
say "jarvis-voice venv"
if [ -x jarvis-voice/.venv/bin/python ]; then
  skip "jarvis-voice/.venv already exists"
elif [ -d jarvis-voice ]; then
  (cd jarvis-voice && uv sync) && echo "    jarvis-voice venv synced (first run also downloads Whisper + Kokoro models, ~1GB)"
else
  warn "jarvis-voice/ not found — skipping venv (restore first-party code first if this is a from-scratch rebuild)"
fi

say "hubspace venv"
if [ -x scripts/hubspace/.venv/bin/python ]; then
  skip "scripts/hubspace/.venv already exists"
elif [ -f scripts/hubspace/requirements.txt ]; then
  python3 -m venv scripts/hubspace/.venv
  scripts/hubspace/.venv/bin/pip install -q -r scripts/hubspace/requirements.txt
  echo "    hubspace venv created"
else
  warn "scripts/hubspace/requirements.txt not found — skipping"
fi

say "groq-agent dependency (requests)"
if python3 -c "import requests" >/dev/null 2>&1; then
  skip "requests already importable"
elif [ -d scripts/groq-agent ]; then
  pip install -q --user requests && echo "    installed requests --user"
else
  skip "scripts/groq-agent/ not found"
fi

# ---------------------------------------------------------------------------
# Part 2.6 — Claude Code auth
# ---------------------------------------------------------------------------
say "Claude Code"
if command -v claude >/dev/null 2>&1; then
  if claude --version >/dev/null 2>&1; then
    skip "claude CLI installed — verify you're logged into the right account (claude login if not)"
  fi
else
  warn "claude CLI not found on PATH — install it, then run 'claude login' before continuing. Nothing else here runs without it."
fi

# ---------------------------------------------------------------------------
# Part 3 — hq-vault, cloned straight into HQ/ for in-codespace access
# ---------------------------------------------------------------------------
say "hq-vault -> HQ/"
if [ -d HQ ] && [ -n "$(ls -A HQ 2>/dev/null)" ]; then
  skip "HQ/ already has content"
else
  vault_owner=$(ask "hq-vault GitHub owner" "lalp070125")
  vault_repo=$(ask "hq-vault repo name" "hq-vault")
  vault_token="${HQVAULT_TOKEN:-}"
  if [ -z "$vault_token" ]; then
    read -r -s -p "    HQVAULT_TOKEN (fine-grained PAT, Contents: Read/write on $vault_repo, input hidden): " vault_token
    echo
  fi
  if [ -z "$vault_token" ]; then
    warn "no token given — skipping hq-vault clone. Obsidian's own sync (Part 3) can still bring the vault down separately."
  else
    git clone -q "https://x-access-token:${vault_token}@github.com/${vault_owner}/${vault_repo}" /tmp/hq-vault-clone \
      && rm -rf /tmp/hq-vault-clone/.git \
      && mkdir -p HQ \
      && cp -a /tmp/hq-vault-clone/. HQ/ \
      && rm -rf /tmp/hq-vault-clone \
      && echo "    HQ/ populated from $vault_owner/$vault_repo (plain copy, not a git checkout — push-hq-vault.py owns pushing back)"
    # Persist for later steps and this shell; still needs to become a real
    # Codespaces secret (below) to survive a rebuild of this same Codespace.
    export HQVAULT_TOKEN="$vault_token"
  fi
fi

# ---------------------------------------------------------------------------
# Part 4 — secrets
# ---------------------------------------------------------------------------
say "Secrets"

if [ -n "${HQVAULT_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  # HQVAULT_TOKEN is a USER-level Codespaces secret (survives a rebuild on
  # any codespace under this account), not repo-scoped -- `gh secret list
  # --app codespaces` alone checks repo scope and will never find it here.
  if gh secret list -u 2>/dev/null | grep -q '^HQVAULT_TOKEN'; then
    skip "HQVAULT_TOKEN already set as a user-level Codespaces secret"
  elif confirm "Save HQVAULT_TOKEN as a user-level Codespaces secret so it survives a rebuild of any codespace on this account?"; then
    gh secret set HQVAULT_TOKEN -u --body "$HQVAULT_TOKEN" \
      && echo "    saved. Any token pasted into a chat session is still burned per HQ Vault Sync's own rule — regenerate if this one ever was."
  fi
fi

if confirm "Set up Hubspace (lamp control) now?"; then
  hb_email=$(ask "HUBSPACE_EMAIL" "")
  read -r -s -p "    HUBSPACE_PASSWORD (input hidden): " hb_pass; echo
  if [ -n "$hb_email" ] && [ -n "$hb_pass" ] && [ -x scripts/hubspace/.venv/bin/python ]; then
    (cd scripts/hubspace && HUBSPACE_EMAIL="$hb_email" HUBSPACE_PASSWORD="$hb_pass" .venv/bin/python hubspace_light.py status) || \
      warn "first-login flow didn't run cleanly — do it manually per Jarvis Hands (barehands)'s Hubspace section; refresh_token then lives at scripts/hubspace/.state/refresh_token"
  else
    skip "missing email/password or venv — do this manually later"
  fi
else
  skip "Hubspace setup"
fi

if confirm "Set up Spotify control now?"; then
  echo "    client_id/client_secret go in scripts/spotify/.state/creds.json (gitignored) — from a Spotify Developer app registration."
  echo "    The refresh token is minted via a one-time browser OAuth login at /spotify/login once the server is up (Part 5 below)."
  mkdir -p scripts/spotify/.state
  if [ -f scripts/spotify/.state/creds.json ]; then
    skip "scripts/spotify/.state/creds.json already exists"
  else
    sp_id=$(ask "Spotify client_id (blank to skip and do this by hand later)" "")
    if [ -n "$sp_id" ]; then
      sp_secret=$(ask "Spotify client_secret" "")
      printf '{"client_id": "%s", "client_secret": "%s"}\n' "$sp_id" "$sp_secret" > scripts/spotify/.state/creds.json
      echo "    wrote scripts/spotify/.state/creds.json"
    fi
  fi
else
  skip "Spotify setup"
fi

# ---------------------------------------------------------------------------
# Part 5 — .claude/settings.local.json hooks
# ---------------------------------------------------------------------------
say "Claude Code hooks (.claude/settings.local.json)"
if [ -f .claude/settings.local.json ]; then
  skip ".claude/settings.local.json already exists"
else
  warn ".claude/settings.local.json is missing (gitignored, never backed up in git) — the three state-sync hooks that drive Jarvis Face/Hands need restoring from a backup or rebuilding by hand. See Jarvis Face (ai-visualizer)'s 'Where it lives' section for the exact hook commands."
fi

# ---------------------------------------------------------------------------
# Part 5 — bring the stack up
# ---------------------------------------------------------------------------
say "Bringing the stack up"
bash scripts/start-all.sh

echo
echo "Next steps (manual — can't be scripted):"
echo "  1. Forward ports 8790 and 8794 in the Codespaces Ports tab (8791 stays internal)."
echo "  2. Run the Health Check Procedure end to end: HQ/07 - Systems Status/Health Check Procedure.md"
echo "  3. If Obsidian mobile/desktop needs setting up, follow Part 3 of the Full Rebuild checklist"
echo "     (GitHub Gitless Sync + Dataview + Tasks — plugin installs can't be scripted from here)."
