#!/usr/bin/env bash
# claude-quota enforcement hook. Wired into .claude/settings.json.
#
#   hook.sh session   SessionStart    -> print status, swap if already capped
#   hook.sh prompt    UserPromptSubmit -> block a new turn on a capped account
#   hook.sh tool      PreToolUse      -> the mid-task catch
#
# Exit 0 = proceed. Exit 2 = block (prompt/tool phases only; stderr is shown).
# Every failure path is fail-open: a network hiccup must never wedge a session.

set -uo pipefail
PHASE="${1:-tool}"
QQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$QQ_DIR/lib.sh"

QC_STATE_DIR="${QC_STATE_DIR:-$HOME/.claude}"
MARK="$QC_STATE_DIR/.quota-hook-checked"      # content: last pct; mtime: last real check
COOLDOWN="$QC_STATE_DIR/.quota-swapped"       # mtime: last auto-swap
LOCK="$QC_STATE_DIR/.quota-hook.lock"
HOOK_MIN_INTERVAL=30                          # s between real checks while green
SWAP_COOLDOWN=600                             # s before auto-swap may fire again

cat >/dev/null 2>&1 || true                   # drain the hook's JSON payload

now="$(date +%s)"

# ---- fast path: checked seconds ago and it was green (not at session start —
#      that fires once and should always print the current standing) ----
if [ "$PHASE" != "session" ] && [ -f "$MARK" ]; then
  age=$(( now - $(stat -c %Y "$MARK" 2>/dev/null || echo 0) ))
  last="$(cat "$MARK" 2>/dev/null || echo 0)"; case "$last" in ''|*[!0-9]*) last=0;; esac
  if [ "$age" -lt "$HOOK_MIN_INTERVAL" ] && [ "$last" -lt "$SWAP_PCT" ]; then
    exit 0
  fi
fi

# ---- don't let parallel tool-call hooks stampede the endpoint ----
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || exit 0
fi

js="$(qc_usage)" || { echo 0 > "$MARK" 2>/dev/null; exit 0; }   # fail-open
p="$(printf '%s' "$js" | qc_pct)"; case "$p" in ''|*[!0-9]*) p=0;; esac
lock="$(printf '%s' "$js" | qc_locked)"
r5="$(printf '%s' "$js" | jq -r '.five_hour.resets_at // empty' 2>/dev/null)"
echo "$p" > "$MARK" 2>/dev/null || true

emit() { echo "claude-quota: $*" >&2; }

in_cooldown() {
  [ -f "$COOLDOWN" ] || return 1
  [ $(( now - $(stat -c %Y "$COOLDOWN" 2>/dev/null || echo 0) )) -lt "$SWAP_COOLDOWN" ]
}

# returns 0 only if the creds file was actually swapped
do_swap() {
  if in_cooldown; then
    emit "auto-swap already fired < $((SWAP_COOLDOWN/60))m ago — not repeating. Restart \`claude\`, or use account.sh manually."
    return 1
  fi
  touch "$COOLDOWN"
  local out rc
  out="$("$QQ_DIR/account.sh" auto 2>&1)"; rc=$?
  [ -n "$out" ] && echo "$out" >&2
  if [ "$rc" -eq 0 ]; then return 0; fi
  rm -f "$COOLDOWN"        # swap didn't happen — let it retry next time
  return 1
}

# ---- GREEN ----
if [ -z "$lock" ] && [ "$p" -lt "$SWAP_PCT" ]; then
  [ "$PHASE" = "session" ] && echo "claude-quota: ${p}% used - 5h resets in $(qc_reset_human "$r5")"
  exit 0
fi

# ---- RED: locked, or at/over the hard-block line ----
if [ -n "$lock" ] || [ "$p" -ge "$BLOCK_PCT" ]; then
  emit "STOP - account at ${p}%${lock:+ (LOCKED: $lock)}."
  if do_swap; then
    emit "Creds swapped to the other account."
  else
    emit "Nothing to swap to - this account is capped until the 5h window resets in $(qc_reset_human "$r5") (set up a backup: scripts/claude-quota/account.sh save <name>)."
  fi
  # SessionStart can't block; every other phase hard-stops so the capped
  # account stops getting hit. `/exit` + reopen `claude` to move on.
  [ "$PHASE" = "session" ] && exit 0
  emit "Run \`/exit\` and reopen \`claude\`."
  exit 2
fi

# ---- AMBER: swap line reached, hard-block not yet ----
emit "${p}% used - 5h resets in $(qc_reset_human "$r5"). Pre-emptively swapping creds to the other account."
if do_swap; then
  emit "Done. This turn keeps running on the current account; when you can, \`/exit\` and reopen \`claude\` to land on the other one."
fi
exit 0
