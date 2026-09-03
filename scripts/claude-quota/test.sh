#!/usr/bin/env bash
# claude-quota hook logic tests. Fully offline and deterministic:
#   - all state (creds, accounts, cache, markers) is redirected to a temp dir
#   - `curl` is stubbed, so no real usage-endpoint calls are made
# Never touches the real ~/.claude/.credentials.json.
#
#   scripts/claude-quota/test.sh

set -uo pipefail
QQ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export CLAUDE_CREDS="$T/live.json"
export QC_ACCOUNTS_DIR="$T/accounts"
export QC_CACHE="$T/cache.json"
export QC_STATE_DIR="$T/state"
mkdir -p "$QC_ACCOUNTS_DIR" "$QC_STATE_DIR"

# --- stubbed curl: answers only the OAuth endpoints, keyed off the token ---
#   ALT-TOKEN-OK  -> healthy usage (3%)      | anything else -> HTTP failure
curl() {
  local args="$*" tok=""
  case "$args" in
    *"Bearer ALT-TOKEN-OK"*) tok=ok ;;
  esac
  case "$args" in
    *"/api/oauth/profile"*) echo '{"account":{"email":"stub@example.com"}}'; return 0 ;;
    *"/api/oauth/usage"*)
      [ "$tok" = ok ] || return 7   # simulate unreachable / unauthorised
      echo '{"five_hour":{"utilization":3.0,"resets_at":"2026-01-01T00:00:00+00:00","locked_reason":null},
             "seven_day":{"utilization":1.0,"resets_at":"2026-01-08T00:00:00+00:00","locked_reason":null},
             "limits":[]}'
      return 0 ;;
  esac
  return 0
}
export -f curl

# live creds: a token the stub treats as NOT ok, so the live account never
# resolves via network — tests drive it purely through $QC_CACHE.
echo '{"claudeAiOauth":{"accessToken":"LIVE-TOKEN","refreshToken":"LIVE-REFRESH","refreshTokenExpiresAt":0}}' > "$CLAUDE_CREDS"
cp "$CLAUDE_CREDS" "$T/live.orig"

new_alt() {  # $1 = "ok" to make its probe succeed, else it's unverifiable
  local t="ALT-TOKEN-BAD"; [ "${1:-}" = ok ] && t="ALT-TOKEN-OK"
  echo "{\"claudeAiOauth\":{\"accessToken\":\"$t\",\"refreshToken\":\"ALT-REFRESH\",\"refreshTokenExpiresAt\":0}}" > "$QC_ACCOUNTS_DIR/main.json"
  echo '{"main":{"email":"main@example.com","saved_at":"2026-01-01T00:00:00"}}' > "$QC_ACCOUNTS_DIR/registry.json"
}

mkcache() {  # $1 = utilization, $2 = locked_reason ("" for none)
  local lj="null"; [ -n "$2" ] && lj="\"$2\""
  cat > "$QC_CACHE" <<EOF
{"five_hour":{"utilization":$1,"resets_at":"2026-01-01T12:00:00+00:00","locked_reason":$lj},
 "seven_day":{"utilization":5.0,"resets_at":"2026-01-08T12:00:00+00:00","locked_reason":null},
 "limits":[{"kind":"session","severity":"warning","is_active":true,"locked_reason":$lj}]}
EOF
}
reset_state() { rm -f "$QC_STATE_DIR"/.quota-* ; cp "$T/live.orig" "$CLAUDE_CREDS"; }
live_is_alt() { grep -q 'ALT-TOKEN' "$CLAUDE_CREDS" && echo yes || echo no; }

FAILED=0
run() {  # label phase want_exit [want_swap: yes|no]
  local label="$1" phase="$2" want="$3" want_swap="${4:-}"
  set +e; out="$("$QQ/hook.sh" "$phase" </dev/null 2>&1)"; rc=$?; set -e
  local ok="PASS"
  [ "$rc" -eq "$want" ] || { ok="FAIL"; FAILED=1; }
  if [ -n "$want_swap" ]; then
    [ "$(live_is_alt)" = "$want_swap" ] || { ok="FAIL"; FAILED=1; }
  fi
  printf '[%s] %-26s phase=%-7s exit=%s(want %s)%s\n' \
    "$ok" "$label" "$phase" "$rc" "$want" \
    "${want_swap:+  swapped=$(live_is_alt)(want $want_swap)}"
  [ -n "$out" ] && sed 's/^/       | /' <<<"$out"
  return 0
}

echo "=== GREEN (cache says 10%) ==="
new_alt ok; reset_state; mkcache 10.0 ""
run "green"                 session 0 no
run "green"                 tool    0 no

echo; echo "=== AMBER 92% -> swap to verified-healthy alt, no interrupt ==="
reset_state; mkcache 92.0 ""
run "amber-verified"        tool    0 yes

echo; echo "=== RED 99% -> swap + hard block; session can't block ==="
reset_state; mkcache 99.0 ""
run "red"                   tool    2 yes
reset_state; mkcache 99.0 ""
run "red"                   prompt  2 yes
reset_state; mkcache 99.0 ""
run "red-session"           session 0 yes

echo; echo "=== LOCKED, alt unverifiable -> blind-swap anyway + block ==="
new_alt bad; reset_state; mkcache 100.0 "usage_limit_reached"
run "locked-blindswap"      tool    2 yes

echo; echo "=== AMBER 92%, alt unverifiable -> do NOT blind-swap, no interrupt ==="
new_alt bad; reset_state; mkcache 92.0 ""
run "amber-no-blindswap"    tool    0 no

echo; echo "=== RED, no alternate saved at all -> still hard-stop ==="
rm -f "$QC_ACCOUNTS_DIR/main.json"; reset_state; mkcache 99.0 ""
run "red-no-alternate"      tool    2 no

echo; echo "=== swap COOLDOWN -> still hard-stops, does not re-swap ==="
new_alt ok; reset_state; mkcache 99.0 ""
touch "$QC_STATE_DIR/.quota-swapped"
run "red-cooldown"          tool    2 no

echo; echo "=== fast-path: recent green marker -> instant exit 0 ==="
reset_state; mkcache 99.0 ""; echo 5 > "$QC_STATE_DIR/.quota-hook-checked"
run "fastpath-green"        tool    0

echo
[ "$FAILED" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
