#!/bin/bash
# Wizard step 3 — optional modules. None of these are needed for the core stack
# (vault + voice + face + board). Each is a yes/no gate followed by its own
# secret prompts, and every one is safe to skip now and set up later by
# re-running this script.
#
# Non-interactive: set JARVIS_MODULES="spotify,groq,badge" (or "all" / "none")
# to pick without prompts; --yes alone enables nothing here on its own.
#
# Usage: bash bootstrap/30-modules.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=bootstrap/lib.sh
. ./lib.sh
jarvis_resolve_root
cd "$JARVIS_ROOT" || die "JARVIS_ROOT ($JARVIS_ROOT) is not a directory"

# want <module> -> 0 if it should be set up
want() {
  local m="$1"
  case ",${JARVIS_MODULES:-}," in
    ,all,)  return 0 ;;
    ,none,) return 1 ;;
    *",$m,"*) return 0 ;;
    ,,)     confirm "Set up '$m' now?" ;;
    *)      return 1 ;;
  esac
}

# --- private vault sync (github-gitless-sync style) --------------------
if want vault-sync; then
  say "Private vault sync"
  echo "    Core installs a LOCAL vault at HQ/. This connects it to your own"
  echo "    private GitHub repo so Obsidian mobile can sync it."
  owner=$(ask "vault repo owner (GitHub user)" "")
  repo=$(ask "vault repo name" "hq-vault")
  if [ -n "$owner" ]; then
    tok=$(ask_secret "fine-grained PAT, Contents: Read/write on $repo")
    if [ -n "$tok" ] && command -v gh >/dev/null 2>&1; then
      gh secret set HQVAULT_TOKEN -u --body "$tok" 2>/dev/null \
        && echo "    saved HQVAULT_TOKEN as a user-level secret" \
        || warn "could not set the secret via gh — store the PAT wherever your sync tool reads it"
    fi
    echo "    Then point your Obsidian GitHub sync plugin at $owner/$repo."
  fi
else
  skip "vault-sync"
fi

# --- Hubspace (smart lamp) -------------------------------------------
if want hubspace; then
  say "Hubspace lamp control"
  if [ ! -x scripts/hubspace/.venv/bin/python ] && [ -f scripts/hubspace/requirements.txt ]; then
    python3 -m venv scripts/hubspace/.venv \
      && scripts/hubspace/.venv/bin/pip install -q -r scripts/hubspace/requirements.txt \
      && echo "    hubspace venv created"
  fi
  hb_email=$(ask "HUBSPACE_EMAIL" "")
  hb_pass=$(ask_secret "HUBSPACE_PASSWORD")
  if [ -n "$hb_email" ] && [ -n "$hb_pass" ] && [ -x scripts/hubspace/.venv/bin/python ]; then
    (cd scripts/hubspace && HUBSPACE_EMAIL="$hb_email" HUBSPACE_PASSWORD="$hb_pass" \
      .venv/bin/python hubspace_light.py status) \
      || warn "first login didn't run clean — refresh token lives at scripts/hubspace/.state/ once it does"
  fi
else
  skip "hubspace"
fi

# --- Spotify -----------------------------------------------------
if want spotify; then
  say "Spotify control"
  mkdir -p scripts/spotify/.state
  if [ -f scripts/spotify/.state/creds.json ]; then
    skip "scripts/spotify/.state/creds.json already exists"
  else
    sp_id=$(ask "Spotify client_id (from a Spotify Developer app; blank to skip)" "")
    if [ -n "$sp_id" ]; then
      sp_secret=$(ask_secret "Spotify client_secret")
      printf '{"client_id": "%s", "client_secret": "%s"}\n' "$sp_id" "$sp_secret" \
        > scripts/spotify/.state/creds.json
      echo "    wrote creds.json — mint the refresh token via /spotify/login once the board is up"
    fi
  fi
else
  skip "spotify"
fi

# --- Groq terminal agent -------------------------------------------
if want groq; then
  say "Groq terminal agent"
  python3 -c "import requests" >/dev/null 2>&1 || pip install -q --user requests
  gk=$(ask_secret "GROQ_API_KEY (free from console.groq.com)")
  if [ -n "$gk" ] && command -v gh >/dev/null 2>&1; then
    gh secret set GROQ_API_KEY --body "$gk" 2>/dev/null \
      && echo "    saved GROQ_API_KEY" \
      || warn "could not set GROQ_API_KEY via gh — export it in your shell profile instead"
  fi
else
  skip "groq"
fi

# --- Site Analyzer (next-app) -------------------------------------
if want site-analyzer; then
  say "Site Analyzer (next-app)"
  if [ ! -d next-app ]; then
    skip "next-app/ not in this build"
  elif [ -f next-app/.env.local ]; then
    skip "next-app/.env.local already exists"
  else
    cp next-app/.env.local.example next-app/.env.local
    ces=$(ask "Cesium ion token (free, ion.cesium.com; blank to fill in later)" "")
    if [ -n "$ces" ]; then
      CES="$ces" python3 - <<'PY'
import os
p = "next-app/.env.local"
tok = os.environ["CES"]
lines = open(p).read().splitlines()
open(p, "w").write("\n".join(
    "NEXT_PUBLIC_CESIUM_ION_TOKEN=" + tok if l.startswith("NEXT_PUBLIC_CESIUM_ION_TOKEN=") else l
    for l in lines) + "\n")
PY
      echo "    wrote next-app/.env.local"
    fi
    echo "    run 'cd next-app && npm install && npm run dev' when you want it (heavy, not run here)"
  fi
else
  skip "site-analyzer"
fi

# --- BADGE dose engine -------------------------------------------
if want badge; then
  say "BADGE (aviation radiation dose engine)"
  if [ -d services/badge ]; then
    (cd services/badge && bash engine/native/build.sh) \
      && echo "    native PARMA driver built — 'cd services/badge && npm test' to verify" \
      || warn "build failed — needs g++; install it and re-run"
  else
    skip "services/badge/ not in this build"
  fi
else
  skip "badge"
fi

# --- claude-quota fallback account -----------------------------
if want claude-quota; then
  say "claude-quota fallback account"
  qa_dir="$HOME/.claude/quota-accounts"
  if [ -f "$qa_dir/main.json" ] && [ -f "$qa_dir/secondary.json" ]; then
    skip "both quota-account snapshots present"
  else
    echo "    Needs the live Claude Code session — can't be scripted here:"
    echo "      1. run:  scripts/claude-quota/watch-login.sh   (leave running)"
    echo "      2. in Claude Code:  /logout  then  /login  into the OTHER account"
    echo "      3. the watcher saves it; /login back, restart claude"
  fi
else
  skip "claude-quota"
fi

echo
echo "Module setup done. Re-run this script any time to add more."
