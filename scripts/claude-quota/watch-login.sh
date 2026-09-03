#!/usr/bin/env bash
# One-shot login watcher for the two-account setup.
#
# Run this, THEN in Claude Code: /logout -> /login into the OTHER account.
# When it sees the live credential file change to a different account it saves
# a snapshot named after that account's email prefix (and also as "main" if no
# 'main' is saved yet), then keeps watching so a second switch is caught too.
#
# Stops itself after WATCH_MINUTES, or on Ctrl-C, or when both a 'main' and a
# 'secondary' snapshot exist.
#
#   scripts/claude-quota/watch-login.sh [minutes]

set -uo pipefail
QQ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$QQ/lib.sh"

WATCH_MINUTES="${1:-20}"
POLL=3
deadline=$(( $(date +%s) + WATCH_MINUTES * 60 ))

fp_of()   { jq -r '.claudeAiOauth.refreshToken // empty' "$1" 2>/dev/null | sha256sum | cut -c1-12; }
saved_fps() {
  local f
  for f in "$ACCOUNTS_DIR"/*.json; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = "registry.json" ] && continue
    fp_of "$f"
  done
}
have_snap() { [ -f "$ACCOUNTS_DIR/$1.json" ]; }

mkdir -p "$ACCOUNTS_DIR"; chmod 700 "$ACCOUNTS_DIR" 2>/dev/null || true

start_fp="$(fp_of "$CREDS")"
echo "watch-login: current account fingerprint ${start_fp:-none}"
echo "watch-login: now do  /logout  then  /login  into the other account."
echo "watch-login: watching for up to ${WATCH_MINUTES} min (Ctrl-C to stop early)..."

last_seen="$start_fp"

while :; do
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    echo "watch-login: time's up — stopping. $("$QQ/account.sh" list 2>/dev/null | sed 's/^/  /')"
    exit 0
  fi

  cur_fp="$(fp_of "$CREDS")"
  if [ -n "$cur_fp" ] && [ "$cur_fp" != "$last_seen" ]; then
    # the live creds just changed to an account we haven't reacted to
    already=0
    for s in $(saved_fps); do [ "$s" = "$cur_fp" ] && already=1; done

    email="$(qc_profile_email "$CREDS")"
    slug="$(printf '%s' "$email" | sed 's/@.*//; s/[^A-Za-z0-9._-]/_/g')"
    [ -z "$slug" ] && slug="account$(date +%s)"

    if [ "$already" -eq 1 ]; then
      echo "watch-login: switched to $email — already have a snapshot for it."
    else
      cp "$CREDS" "$ACCOUNTS_DIR/$slug.json"; chmod 600 "$ACCOUNTS_DIR/$slug.json"
      jq -e . "$REGISTRY" >/dev/null 2>&1 || echo '{}' > "$REGISTRY"
      tmp="$(mktemp)"; jq --arg n "$slug" --arg e "$email" --arg t "$(date -Is)" \
        '.[$n] = {email:$e, saved_at:$t}' "$REGISTRY" > "$tmp" && mv "$tmp" "$REGISTRY"
      echo "watch-login: saved snapshot '$slug'  ($email)"

      if ! have_snap main; then
        cp "$CREDS" "$ACCOUNTS_DIR/main.json"; chmod 600 "$ACCOUNTS_DIR/main.json"
        tmp="$(mktemp)"; jq --arg e "$email" --arg t "$(date -Is)" \
          '.main = {email:$e, saved_at:$t}' "$REGISTRY" > "$tmp" && mv "$tmp" "$REGISTRY"
        echo "watch-login: also saved it as 'main' (no 'main' existed yet)"
      fi
    fi

    last_seen="$cur_fp"

    if have_snap main && have_snap secondary; then
      echo "watch-login: both 'main' and 'secondary' snapshots exist — done."
      "$QQ/account.sh" list 2>/dev/null | sed 's/^/  /'
      echo "watch-login: now /login back into your normal account and restart \`claude\`."
      exit 0
    fi
  fi

  sleep "$POLL"
done
