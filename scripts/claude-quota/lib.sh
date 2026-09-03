#!/usr/bin/env bash
# claude-quota shared library. `source` this — do not execute it directly.
#
# Ground truth comes from Anthropic's OAuth usage endpoint (the same data the
# in-CLI `/usage` screen shows): per-window utilization as a 0-100 percent plus
# an exact `resets_at` timestamp, and a `locked_reason` when a window is capped.

set -uo pipefail

QQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- defaults; config.env overrides ---
WARN_PCT=80; SWAP_PCT=90; BLOCK_PCT=97; CACHE_TTL=60; CURL_TIMEOUT=8
# shellcheck disable=SC1091
[ -f "$QQ_DIR/config.env" ] && . "$QQ_DIR/config.env"

# QC_* overrides exist only so the suite can redirect state to a scratch dir.
CREDS="${CLAUDE_CREDS:-$HOME/.claude/.credentials.json}"
ACCOUNTS_DIR="${QC_ACCOUNTS_DIR:-$HOME/.claude/quota-accounts}"
REGISTRY="$ACCOUNTS_DIR/registry.json"
PREV="$ACCOUNTS_DIR/.prev"
CACHE="${QC_CACHE:-$HOME/.claude/quota-cache.json}"

USAGE_URL="https://api.anthropic.com/api/oauth/usage"
PROFILE_URL="https://api.anthropic.com/api/oauth/profile"
OAUTH_BETA="oauth-2025-04-20"

# access token out of a creds file ($1, default live). Empty string on failure.
qc_token() {
  local f="${1:-$CREDS}"
  [ -f "$f" ] || return 1
  jq -r '.claudeAiOauth.accessToken // empty' "$f" 2>/dev/null
}

# short, non-reversible fingerprint of a creds file's refresh token, so two
# account files can be compared without ever exposing the secret.
qc_token_fp() {
  local f="${1:-$CREDS}"
  [ -f "$f" ] || return 1
  jq -r '.claudeAiOauth.refreshToken // empty' "$f" 2>/dev/null | sha256sum | cut -c1-12
}

# hit the usage endpoint with a given token ($1). Prints JSON on success only.
qc_fetch_usage() {
  local tok="$1" body
  [ -n "$tok" ] || return 1
  body="$(curl -sS --max-time "$CURL_TIMEOUT" \
      -H "Authorization: Bearer $tok" \
      -H "anthropic-beta: $OAUTH_BETA" \
      "$USAGE_URL" 2>/dev/null)" || return 1
  printf '%s' "$body" | jq -e 'type == "object" and has("five_hour")' >/dev/null 2>&1 || return 1
  printf '%s' "$body"
}

qc_cache_fresh() {
  [ -f "$CACHE" ] || return 1
  local mt now
  now="$(date +%s)"
  mt="$(stat -c %Y "$CACHE" 2>/dev/null || echo 0)"
  [ $(( now - mt )) -lt "$CACHE_TTL" ]
}

# usage JSON for the LIVE account: fresh cache, else fetch (and cache), else
# stale cache as a last resort. Nonzero only if there is nothing at all.
qc_usage() {
  if qc_cache_fresh; then cat "$CACHE"; return 0; fi
  local tok js
  tok="$(qc_token)" || tok=""
  if js="$(qc_fetch_usage "$tok")"; then
    printf '%s' "$js" > "$CACHE.tmp.$$" 2>/dev/null && mv "$CACHE.tmp.$$" "$CACHE" 2>/dev/null
    printf '%s' "$js"; return 0
  fi
  [ -f "$CACHE" ] && { cat "$CACHE"; return 0; }
  return 1
}

# reads usage JSON on stdin, prints an integer 0..100 = ceil(max(5h, 7d))
qc_pct() {
  jq -r '[ (.five_hour.utilization // 0), (.seven_day.utilization // 0) ]
         | max | (. + 0.9999) | floor' 2>/dev/null
}

# reads usage JSON on stdin, prints a locked_reason if any window is capped
qc_locked() {
  jq -r '[ .five_hour.locked_reason, .seven_day.locked_reason,
           (.limits[]? | .locked_reason) ]
         | map(select(. != null and . != "")) | .[0] // empty' 2>/dev/null
}

# reads usage JSON on stdin, prints the worst active severity ("normal" if none)
qc_severity() {
  jq -r '[ .limits[]? | select(.is_active == true) | .severity ]
         | map(select(. != "normal")) | .[0] // "normal"' 2>/dev/null
}

# $1 = ISO8601 timestamp -> "2h 11m" / "5d 3h" / "now" / "?"
qc_reset_human() {
  local iso="$1" tgt now diff d h m
  [ -n "$iso" ] || { echo "?"; return; }
  tgt="$(date -d "$iso" +%s 2>/dev/null)" || { echo "?"; return; }
  now="$(date +%s)"; diff=$(( tgt - now ))
  [ "$diff" -le 0 ] && { echo "now"; return; }
  d=$(( diff / 86400 )); h=$(( (diff % 86400) / 3600 )); m=$(( (diff % 3600) / 60 ))
  if   [ "$d" -gt 0 ]; then echo "${d}d ${h}h"
  elif [ "$h" -gt 0 ]; then echo "${h}h ${m}m"
  else echo "${m}m"; fi
}

# $1 = pct -> 20-cell bar
qc_bar() {
  local p="${1:-0}" fill i out=""
  case "$p" in ''|*[!0-9]*) p=0;; esac
  [ "$p" -gt 100 ] && p=100
  fill=$(( p / 5 ))
  for ((i=0; i<20; i++)); do
    if [ "$i" -lt "$fill" ]; then out+="#"; else out+="-"; fi
  done
  printf '%s' "$out"
}

# account email for a creds file ($1, default live). Slow (network); not for hooks.
qc_profile_email() {
  local tok
  tok="$(qc_token "${1:-$CREDS}")" || { echo "unknown"; return; }
  [ -n "$tok" ] || { echo "unknown"; return; }
  curl -sS --max-time "$CURL_TIMEOUT" \
    -H "Authorization: Bearer $tok" -H "anthropic-beta: $OAUTH_BETA" \
    "$PROFILE_URL" 2>/dev/null \
    | jq -r '.account.email // .organization.name // "unknown"' 2>/dev/null \
    || echo "unknown"
}
