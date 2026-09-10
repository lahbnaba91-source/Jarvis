#!/bin/bash
# Wizard step 1 — stand up the core stack in $JARVIS_ROOT:
#   * .jarvis-env         (JARVIS_ROOT for every script that self-locates)
#   * CLAUDE.md            (rendered from templates/CLAUDE.md.tmpl + your answers)
#   * .claude/settings.json (rendered from .claude/settings.json.tmpl)
#   * a fresh HQ/ vault    (from templates/vault-skeleton/, only if HQ/ is empty)
#   * jarvis-voice venv, service configs, the barehands media airlock, skills
#
# Idempotent. Persona answers come from prompts, or from env for non-interactive
# runs: JARVIS_ASSISTANT_NAME, JARVIS_USER_NAME, JARVIS_ADDRESS_TERMS,
# JARVIS_TIMEZONE, JARVIS_WELCOME_LINE.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=bootstrap/lib.sh
. ./lib.sh
jarvis_resolve_root
cd "$JARVIS_ROOT" || die "JARVIS_ROOT ($JARVIS_ROOT) is not a directory"
export PATH="$HOME/.local/bin:$PATH"

# --- .jarvis-env -----------------------------------------------------
say ".jarvis-env"
if [ -f .jarvis-env ] && grep -q "^JARVIS_ROOT=" .jarvis-env; then
  skip ".jarvis-env already written"
else
  printf 'JARVIS_ROOT=%s\n' "$JARVIS_ROOT" > .jarvis-env
  echo "    wrote $JARVIS_ROOT/.jarvis-env"
fi

# --- persona -> CLAUDE.md ------------------------------------------
say "CLAUDE.md (identity + rules)"
if [ -f CLAUDE.md ] && ! grep -q '@@ASSISTANT_NAME@@' CLAUDE.md; then
  skip "CLAUDE.md already rendered (no placeholders left)"
elif [ ! -f templates/CLAUDE.md.tmpl ]; then
  warn "templates/CLAUDE.md.tmpl missing — cannot render CLAUDE.md"
else
  a_name="${JARVIS_ASSISTANT_NAME:-$(ask 'Assistant name' 'Jarvis')}"
  u_name="${JARVIS_USER_NAME:-$(ask 'Your name (what it calls you)' 'boss')}"
  tz="${JARVIS_TIMEZONE:-$(ask 'Your timezone (IANA, e.g. America/Los_Angeles)' 'America/Los_Angeles')}"
  welcome="${JARVIS_WELCOME_LINE:-$(ask 'First-line greeting each session' "All systems online. What are we working on?")}"
  tone="${JARVIS_TONE:-Be direct and plain-spoken, with a bit of wit. Skip corporate hedging and filler; every response, including the factual ones.}"
  render_template templates/CLAUDE.md.tmpl CLAUDE.md \
    "ASSISTANT_NAME=$a_name" \
    "USER_NAME=$u_name" \
    "TONE=$tone" \
    "ADDRESS_LINE=Call me \"$u_name\"." \
    "MAKE_IT_YOURS=Call me \"$u_name\" — keep it that informal." \
    "BOARD_CLIENT=a phone's browser" \
    "VAULT_PATH=$JARVIS_ROOT/HQ" \
    "JARVIS_ROOT=$JARVIS_ROOT" \
    "TIMEZONE=$tz" \
    "WELCOME_LINE=$welcome" \
    "MULTISESSION_TAIL=."
  echo "    rendered CLAUDE.md for '$a_name'"
fi

# --- .claude/settings.json --------------------------------------
say ".claude/settings.json (session hooks)"
if [ -f .claude/settings.json.tmpl ]; then
  if [ -f .claude/settings.json ] && ! grep -q '@@JARVIS_ROOT@@' .claude/settings.json \
     && grep -q "$JARVIS_ROOT" .claude/settings.json; then
    skip "settings.json already points at $JARVIS_ROOT"
  else
    render_template .claude/settings.json.tmpl .claude/settings.json \
      "JARVIS_ROOT=$JARVIS_ROOT"
    echo "    rendered .claude/settings.json"
  fi
else
  warn ".claude/settings.json.tmpl missing — hooks not wired"
fi

# --- fresh vault -------------------------------------------------
say "HQ/ vault"
if [ -d HQ ] && [ -n "$(ls -A HQ 2>/dev/null)" ]; then
  skip "HQ/ already has content — leaving it alone"
elif [ -d templates/vault-skeleton ]; then
  mkdir -p HQ
  cp -a templates/vault-skeleton/. HQ/
  # stamp real paths into any skeleton note that carries a placeholder
  grep -rl '@@\(VAULT_PATH\|JARVIS_ROOT\)@@' HQ 2>/dev/null | while read -r f; do
    sed -i -e "s|@@VAULT_PATH@@|$JARVIS_ROOT/HQ|g" -e "s|@@JARVIS_ROOT@@|$JARVIS_ROOT|g" "$f"
  done
  echo "    seeded HQ/ from templates/vault-skeleton/ (empty starter vault)"
else
  warn "templates/vault-skeleton/ missing — no starter vault created"
fi

# --- jarvis-voice venv ----------------------------------------
say "jarvis-voice venv"
if [ "${JARVIS_SKIP_VOICE:-0}" = 1 ]; then
  skip "JARVIS_SKIP_VOICE=1 — not building the voice venv (no model download)"
elif [ -x jarvis-voice/.venv/bin/python ]; then
  skip "jarvis-voice/.venv already exists"
elif [ -d jarvis-voice ] && command -v uv >/dev/null 2>&1; then
  (cd jarvis-voice && uv sync) \
    && echo "    synced (first server start also pulls Whisper + Kokoro models, ~1GB)" \
    || warn "uv sync failed in jarvis-voice/ — re-run 'cd jarvis-voice && uv sync' by hand"
else
  warn "jarvis-voice/ or uv missing — skipping voice venv"
fi

# --- service configs ---------------------------------------
say "Service configs"
if [ -f ai-visualizer/ai-visualizer.json.example ] && [ ! -f ai-visualizer/ai-visualizer.json ]; then
  BUS="$JARVIS_ROOT/.voice-bus" python3 - <<'PY'
import json, os
p = "ai-visualizer/ai-visualizer.json.example"
d = json.load(open(p))
d["bus_dir"] = os.environ["BUS"]
json.dump(d, open("ai-visualizer/ai-visualizer.json", "w"), indent=2)
PY
  echo "    wrote ai-visualizer/ai-visualizer.json"
else
  skip "ai-visualizer.json present or no example"
fi
if [ -f barehands/barehands.json.example ] && [ ! -f barehands/barehands.json ]; then
  cp barehands/barehands.json.example barehands/barehands.json
  # point the Notes orb at the real vault
  python3 - <<PY
import json
p = "barehands/barehands.json"
d = json.load(open(p))
for orb in d.get("orbs", []):
    if orb.get("kind") == "notes":
        orb["path"] = "$JARVIS_ROOT/HQ"
json.dump(d, open(p, "w"), indent=2)
PY
  echo "    wrote barehands/barehands.json (Notes orb -> HQ/)"
else
  skip "barehands.json present or no example"
fi

# --- barehands media airlock ------------------------------
say "barehands media airlock"
if [ -d barehands ]; then
  mkdir -p barehands/media/misc barehands/media/models
  skip "barehands/media/{misc,models} present"
else
  skip "barehands/ not found"
fi

# --- skills ---------------------------------------------
say "Claude Code skills"
if [ -d .claude/skills ] && [ -n "$(ls -A .claude/skills 2>/dev/null)" ]; then
  skip ".claude/skills already populated"
elif [ -f skills-lock.json ] && command -v claude >/dev/null 2>&1; then
  echo "    skills ship out of band — run 'claude' once, then re-fetch from"
  echo "    the marketplace named in skills-lock.json if any skill is missing."
else
  skip "no skills-lock.json or claude CLI — skipping"
fi

echo
echo "Core stack laid out under $JARVIS_ROOT."
