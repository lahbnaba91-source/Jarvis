#!/usr/bin/env bash
# claude-quota — manage the Claude Code credential file so a capped account can
# be swapped for a fresh one.
#
#   account.sh save <name>     snapshot the CURRENT live creds as <name>
#   account.sh list            saved accounts + refresh-token life left + ACTIVE
#   account.sh status          which saved account the live creds match + usage
#   account.sh use <name>      swap <name> into place (RESTART claude to load it)
#   account.sh auto            if live is capped/locked, swap to the healthiest
#                              other saved account
#   account.sh restore-prev    put back whatever `use` last replaced
#   account.sh setup           print the one-time two-account setup steps
#
# Token files live in ~/.claude/quota-accounts/ (chmod 600). They are NEVER
# copied into the vault and NEVER printed.

set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

mkdir -p "$ACCOUNTS_DIR"; chmod 700 "$ACCOUNTS_DIR" 2>/dev/null || true
[ -f "$REGISTRY" ] || echo '{}' > "$REGISTRY"

reg_set() { # <name> <email>
  local tmp; tmp="$(mktemp)"
  jq --arg n "$1" --arg e "$2" --arg t "$(date -Is)" \
     '.[$n] = {email:$e, saved_at:$t}' "$REGISTRY" > "$tmp" && mv "$tmp" "$REGISTRY"
}
reg_email() { jq -r --arg n "$1" '.[$n].email // "?"' "$REGISTRY" 2>/dev/null; }

# saved account files, registry.json excluded
account_files() {
  shopt -s nullglob
  local f
  for f in "$ACCOUNTS_DIR"/*.json; do
    [ "$(basename "$f")" = "registry.json" ] && continue
    printf '%s\n' "$f"
  done
}

cmd="${1:-status}"; shift || true

case "$cmd" in
  save)
    name="${1:?usage: account.sh save <name>}"
    [ -f "$CREDS" ] || { echo "no live creds at $CREDS — run /login first" >&2; exit 1; }
    jq -e '.claudeAiOauth.accessToken' "$CREDS" >/dev/null 2>&1 \
      || { echo "live creds file has no access token" >&2; exit 1; }
    cp "$CREDS" "$ACCOUNTS_DIR/$name.json"; chmod 600 "$ACCOUNTS_DIR/$name.json"
    email="$(qc_profile_email "$ACCOUNTS_DIR/$name.json")"
    reg_set "$name" "$email"
    echo "saved '$name'  ($email)"
    ;;

  list)
    live_fp="$(qc_token_fp "$CREDS" 2>/dev/null || echo none)"
    mapfile -t files < <(account_files)
    [ ${#files[@]} -eq 0 ] && { echo "no saved accounts — account.sh save <name>"; exit 0; }
    for f in "${files[@]}"; do
      n="$(basename "$f" .json)"
      fp="$(qc_token_fp "$f" 2>/dev/null || echo '?')"
      active=""; [ "$fp" = "$live_fp" ] && active="  <- ACTIVE"
      rexp="$(jq -r '.claudeAiOauth.refreshTokenExpiresAt // 0' "$f" 2>/dev/null)"
      case "$rexp" in
        ''|*[!0-9]*|0) life="refresh expiry unknown" ;;
        *) days=$(( rexp/1000 - $(date +%s) )); days=$(( days / 86400 ))
           life="refresh token ~${days}d left" ;;
      esac
      printf '  %-12s %-34s %s%s\n' "$n" "$(reg_email "$n")" "$life" "$active"
    done
    ;;

  status)
    js="$(qc_usage)" || { echo "no usage data (offline?)"; exit 1; }
    live_fp="$(qc_token_fp "$CREDS" 2>/dev/null || echo none)"
    match="(unsaved)"
    while IFS= read -r f; do
      [ "$(qc_token_fp "$f" 2>/dev/null)" = "$live_fp" ] && match="$(basename "$f" .json)"
    done < <(account_files)
    p="$(printf '%s' "$js" | qc_pct)"
    lock="$(printf '%s' "$js" | qc_locked)"
    echo "active creds: $match  ($(qc_profile_email))  — ${p:-?}% used${lock:+  LOCKED: $lock}"
    ;;

  use)
    name="${1:?usage: account.sh use <name>}"
    src="$ACCOUNTS_DIR/$name.json"
    [ -f "$src" ] || { echo "no saved account '$name' (account.sh list)" >&2; exit 1; }
    jq -e '.claudeAiOauth.accessToken' "$src" >/dev/null 2>&1 \
      || { echo "'$name' creds file looks broken" >&2; exit 1; }
    [ -f "$CREDS" ] && { cp "$CREDS" "$PREV"; chmod 600 "$PREV"; }
    cp "$src" "$CREDS"; chmod 600 "$CREDS"
    rm -f "$CACHE"
    echo "swapped live creds -> '$name'  ($(reg_email "$name"))"
    echo "RESTART REQUIRED: /exit this Claude Code session and reopen \`claude\` to load it."
    ;;

  auto)
    js="$(qc_usage)" || exit 0
    p="$(printf '%s' "$js" | qc_pct)"; case "$p" in ''|*[!0-9]*) p=0;; esac
    lock="$(printf '%s' "$js" | qc_locked)"
    if [ -z "$lock" ] && [ "$p" -lt "$SWAP_PCT" ]; then exit 0; fi   # nothing to do

    live_fp="$(qc_token_fp "$CREDS" 2>/dev/null || echo none)"
    hard=0; { [ -n "$lock" ] || [ "$p" -ge "$BLOCK_PCT" ]; } && hard=1
    best=""; best_p=101            # probe-verified healthiest alternate
    fb=""; fb_saved=""            # unverifiable fallback (newest saved wins)
    while IFS= read -r f; do
      [ "$(qc_token_fp "$f" 2>/dev/null)" = "$live_fp" ] && continue
      name="$(basename "$f" .json)"
      if ! ojs="$(qc_fetch_usage "$(qc_token "$f" 2>/dev/null)")"; then
        s="$(jq -r --arg n "$name" '.[$n].saved_at // ""' "$REGISTRY" 2>/dev/null)"
        if [ -z "$fb" ] || [[ "$s" > "$fb_saved" ]]; then fb="$name"; fb_saved="$s"; fi
        continue
      fi
      [ -n "$(printf '%s' "$ojs" | qc_locked)" ] && continue
      op="$(printf '%s' "$ojs" | qc_pct)"; case "$op" in ''|*[!0-9]*) op=100;; esac
      if [ "$op" -lt "$best_p" ]; then best_p="$op"; best="$name"; fi
    done < <(account_files)

    if [ -n "$best" ]; then
      [ "$best_p" -ge "$SWAP_PCT" ] && \
        echo "claude-quota: alternate '$best' is also at ${best_p}% — swapping anyway (least-bad)." >&2
      "$0" use "$best"
    elif [ "$hard" -eq 1 ] && [ -n "$fb" ]; then
      if [ -n "$lock" ]; then why="LOCKED ($lock)"; else why="at ${p}%"; fi
      echo "claude-quota: can't reach the usage API to vet an alternate, but this account is $why — swapping to '$fb' unverified." >&2
      "$0" use "$fb"
    else
      echo "claude-quota: live account at ${p}%${lock:+ (LOCKED: $lock)} and NO usable alternate saved account." >&2
      echo "claude-quota: save a second one -> scripts/claude-quota/account.sh save <name>" >&2
      exit 3
    fi
    ;;

  restore-prev)
    [ -f "$PREV" ] || { echo "nothing to restore" >&2; exit 1; }
    cp "$PREV" "$CREDS"; chmod 600 "$CREDS"; rm -f "$CACHE"
    echo "restored the creds that 'use' last replaced. RESTART REQUIRED."
    ;;

  setup)
    cat <<'EOF'
One-time setup — save both accounts so auto-swap has somewhere to land.

  1. In THIS Claude Code:  /login   -> log into the MAIN account
  2. In a shell:           scripts/claude-quota/account.sh save main
  3. /login                        -> log back into the SECONDARY account
  4. In a shell:           scripts/claude-quota/account.sh save secondary
  5. Verify:               scripts/claude-quota/account.sh list

Token files: ~/.claude/quota-accounts/*.json (chmod 600). Never in the vault.
Note: an account left idle past its refresh-token expiry (~a few weeks) goes
stale — `account.sh list` shows the days left; re-`/login` + re-`save` to refresh.
EOF
    ;;

  *)
    echo "usage: account.sh [save <name>|list|status|use <name>|auto|restore-prev|setup]" >&2
    exit 2
    ;;
esac
