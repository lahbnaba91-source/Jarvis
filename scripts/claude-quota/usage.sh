#!/usr/bin/env bash
# claude-quota — read the live account's Claude usage.
#
#   usage.sh              same as `status`
#   usage.sh status       human readout: 5h / 7d bars, %, reset countdowns
#   usage.sh check        silent + exit 0 if healthy;
#                         exit 1 + one stderr line if >= WARN_PCT / severity / locked
#   usage.sh json         raw endpoint JSON (pretty if jq can)

set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cmd="${1:-status}"

case "$cmd" in
  json)
    js="$(qc_usage)" || { echo '{"error":"usage fetch failed and no cache"}'; exit 1; }
    printf '%s\n' "$js" | jq . 2>/dev/null || printf '%s\n' "$js"
    ;;

  check)
    js="$(qc_usage)" || exit 0          # fail-open: no data => no nagging
    p="$(printf '%s' "$js" | qc_pct)"; case "$p" in ''|*[!0-9]*) p=0;; esac
    lock="$(printf '%s' "$js" | qc_locked)"
    sev="$(printf '%s' "$js" | qc_severity)"
    r5="$(printf '%s' "$js" | jq -r '.five_hour.resets_at // empty')"
    if [ -n "$lock" ]; then
      echo "claude-quota: LOCKED ($lock) — scripts/claude-quota/account.sh use <other>" >&2
      exit 1
    fi
    if [ "$p" -ge "$WARN_PCT" ] || [ "$sev" != "normal" ]; then
      echo "claude-quota: ${p}% used (5h resets in $(qc_reset_human "$r5"); severity=$sev)" >&2
      exit 1
    fi
    exit 0
    ;;

  status|"")
    js="$(qc_usage)" || { echo "claude-quota: no usage data (offline, or not logged in)"; exit 1; }
    email="$(qc_profile_email)"
    p5="$(printf '%s' "$js" | jq -r '(.five_hour.utilization // 0) | (. + 0.9999) | floor')"
    p7="$(printf '%s' "$js" | jq -r '(.seven_day.utilization // 0) | (. + 0.9999) | floor')"
    r5="$(printf '%s' "$js" | jq -r '.five_hour.resets_at // empty')"
    r7="$(printf '%s' "$js" | jq -r '.seven_day.resets_at // empty')"
    lock="$(printf '%s' "$js" | qc_locked)"
    sev="$(printf '%s' "$js" | qc_severity)"
    printf 'account    %s\n' "$email"
    printf '5-hour     [%s] %3s%%  resets in %s\n' "$(qc_bar "$p5")" "$p5" "$(qc_reset_human "$r5")"
    printf '7-day      [%s] %3s%%  resets in %s\n' "$(qc_bar "$p7")" "$p7" "$(qc_reset_human "$r7")"
    [ "$sev" != "normal" ] && printf 'severity   %s\n' "$sev"
    [ -n "$lock" ] && printf 'LOCKED     %s\n' "$lock"
    printf 'thresholds swap @ %s%%   hard-block @ %s%%\n' "$SWAP_PCT" "$BLOCK_PCT"
    ;;

  *)
    echo "usage: usage.sh [status|check|json]" >&2
    exit 2
    ;;
esac
