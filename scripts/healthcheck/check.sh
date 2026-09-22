#!/bin/bash
# Jarvis health check (2026-09-22). Automates the runbook in
# HQ/07 - Systems Status/Health Check Procedure.md: runs every check that
# can be verified from a shell and prints PASS / WARN / FAIL / SKIP per
# check, each with the evidence it saw. Writes the results to
# HQ/07 - Systems Status/Health Check Report.md (overwritten every run).
#
# Usage:
#   scripts/healthcheck/check.sh               # full run (non-costly checks)
#   scripts/healthcheck/check.sh --deep        # + voice round trip (one real
#                                              #   Claude call) + next-app build
#   scripts/healthcheck/check.sh --quick       # skip the ~30s vault-sync dry run
#   scripts/healthcheck/check.sh --quiet-if-clean   # print only non-PASS lines
#   scripts/healthcheck/check.sh --no-write    # don't write the vault report
#
# Env overrides (mostly for testing): VOICE_URL, FACE_URL, HANDS_URL,
# JARVIS_ROOT, JARVIS_VAULT.
#
# Exit: 0 = no FAIL, 1 = at least one FAIL. WARN/SKIP never fail the run.
# Read-only against the systems it checks: it never restarts, pushes or
# edits anything except its own report and vault-audit's report (the same
# file the audit's SessionStart hook rewrites); --no-write suppresses both.
# --deep also rebuilds next-app's production .next output, as check 11 does.
set -uo pipefail

DEEP=0 QUICK=0 QUIET=0 WRITE=1
for a in "$@"; do
  case "$a" in
    --deep) DEEP=1 ;;
    --quick) QUICK=1 ;;
    --quiet-if-clean) QUIET=1 ;;
    --no-write) WRITE=0 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# The live stack and its gitignored runtime state (logs, cues, tokens, the
# HQ vault) always sit in the main checkout, even when this script runs
# from a worktree — so resolve the main tree via git's common dir.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${JARVIS_ROOT:-}" ]; then
  common="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  JARVIS_ROOT="$(dirname "${common:-$HERE/../../.git}")"
fi
ROOT="$JARVIS_ROOT"
VAULT="${JARVIS_VAULT:-$ROOT/HQ}"
REPORT="$VAULT/07 - Systems Status/Health Check Report.md"
VOICE_URL="${VOICE_URL:-http://127.0.0.1:8791}"
FACE_URL="${FACE_URL:-http://127.0.0.1:8790}"
HANDS_URL="${HANDS_URL:-http://127.0.0.1:8794}"

NAMES=() STATES=() DETAILS=()
rec() { NAMES+=("$1"); STATES+=("$2"); DETAILS+=("$3"); }

# http_code URL [curl args...] -> prints the status code ("000" if unreachable)
http_code() { local u="$1"; shift; curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" "$u"; }
listening() { ss -tln 2>/dev/null | grep -q ":$1 "; }

# ── 1. jarvis-voice ──────────────────────────────────────────────────────
check_voice() {
  local port="${VOICE_URL##*:}"; port="${port%%/*}"
  local log="$ROOT/jarvis-voice/tmp/server.log"
  local code; code=$(http_code "$VOICE_URL/logs")
  if [ "$code" != 200 ]; then
    # Warming = the process is up but hasn't logged "ready" yet (the log is
    # truncated on every start, so a "ready" line means THIS process).
    if pgrep -f "\.venv/bin/python server.py" >/dev/null && ! listening "$port" \
       && ! grep -q "jarvis-voice ready" "$log" 2>/dev/null; then
      rec "jarvis-voice" WARN "process alive but :$port not listening yet — still warming models (~72s cold start)"
    else
      rec "jarvis-voice" FAIL "GET /logs -> $code; not running — scripts/start-all.sh"
    fi
    return
  fi
  if ! grep -q "jarvis-voice ready" "$log" 2>/dev/null; then
    rec "jarvis-voice" WARN "GET /logs 200 but no 'jarvis-voice ready' in $log"
    return
  fi
  if [ "$DEEP" = 0 ]; then
    rec "jarvis-voice" PASS "GET /logs 200, 'jarvis-voice ready' in log (round trip: --deep)"
    return
  fi
  # Deep: synthetic round trip — espeak -> webm -> /listening -> /stop.
  local tmp; tmp=$(mktemp -d)
  if ! { espeak-ng -w "$tmp/q.wav" "Jarvis, this is a health check. Reply with one word." \
         && ffmpeg -loglevel error -y -i "$tmp/q.wav" -c:a libopus "$tmp/q.webm"; } 2>/dev/null; then
    rec "jarvis-voice" FAIL "round trip: couldn't synthesize test audio (espeak-ng/ffmpeg)"
    rm -rf "$tmp"; return
  fi
  curl -s --max-time 5 -X POST "$VOICE_URL/listening" >/dev/null
  curl -s --max-time 120 -X POST --data-binary "@$tmp/q.webm" \
       -H 'Content-Type: audio/webm' "$VOICE_URL/stop" > "$tmp/r.json"
  local verdict
  verdict=$(python3 - "$tmp/r.json" <<'PY'
import base64, json, sys
try:
    r = json.load(open(sys.argv[1]))
    if not isinstance(r, dict):
        raise ValueError(f"expected an object, got {type(r).__name__}")
    text, reply, audio = r.get("text", ""), r.get("reply", ""), r.get("audio_b64", "")
    wav = bool(audio) and base64.b64decode(audio)[:4] == b"RIFF"
except Exception as e:
    print(f"FAIL|/stop returned an unusable response ({e})"); sys.exit()
if text and reply and wav:
    print(f"PASS|round trip ok — heard {text[:40]!r}, replied {reply[:40]!r}, WAV returned")
else:
    print(f"FAIL|round trip incomplete — text={bool(text)} reply={bool(reply)} wav={wav} err={r.get('error', '')}")
PY
)
  case "$verdict" in
    PASS\|*|FAIL\|*) rec "jarvis-voice" "${verdict%%|*}" "${verdict#*|}" ;;
    *) rec "jarvis-voice" FAIL "round trip: response parser crashed" ;;
  esac
  rm -rf "$tmp"
}

# ── 2. ai-visualizer ─────────────────────────────────────────────────────
check_face() {
  local s c l
  s=$(http_code "$FACE_URL/state"); c=$(http_code "$FACE_URL/config"); l=$(http_code "$FACE_URL/logs")
  if [ "$s" != 200 ] || [ "$c" != 200 ]; then
    rec "ai-visualizer" FAIL "/state $s, /config $c — not running? scripts/start-all.sh"
  elif [ "$l" != 200 ]; then
    rec "ai-visualizer" WARN "/state+/config 200, but voice proxy /logs -> $l (jarvis-voice down?)"
  else
    rec "ai-visualizer" PASS "/state 200, /config 200, voice proxy /logs 200"
  fi
}

# ── 3. barehands ─────────────────────────────────────────────────────────
check_hands() {
  local port="${HANDS_URL##*:}"; port="${port%%/*}"
  local orb; orb=$(curl -s --max-time 5 "$HANDS_URL/orb")
  local st; st=$(printf '%s' "$orb" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))' 2>/dev/null)
  if [ -z "$st" ]; then
    rec "barehands" FAIL "GET /orb gave no state — not running? scripts/start-all.sh"; return
  fi
  if ! ss -tln 2>/dev/null | grep -qE "(0\.0\.0\.0|\*|\[::\]):$port "; then
    rec "barehands" FAIL "/orb ok (state=$st) but :$port not bound to 0.0.0.0 — phone can't reach it"; return
  fi
  local self; self=$(bash "$ROOT/scripts/barehands-selftest.sh" "$HANDS_URL" 2>&1)
  if printf '%s' "$self" | grep -q "all green"; then
    rec "barehands" PASS "/orb state=$st, bound 0.0.0.0:$port, self-test all green"
  else
    rec "barehands" WARN "/orb state=$st, bound 0.0.0.0, self-test: $(printf '%s' "$self" | grep -c FAIL) FAIL — run scripts/barehands-selftest.sh"
  fi
}

# ── 4. HQ vault sync ─────────────────────────────────────────────────────
check_sync() {
  if [ -z "${HQVAULT_TOKEN:-}" ]; then
    rec "hq-vault-sync" FAIL "HQVAULT_TOKEN not in env — codespace secret not injected"; return
  fi
  if [ "$QUICK" = 1 ]; then
    rec "hq-vault-sync" PASS "HQVAULT_TOKEN present (dry run skipped: --quick)"; return
  fi
  local out rc
  out=$(timeout 90 python3 "$ROOT/scripts/push-hq-vault.py" 2>&1); rc=$?
  if [ "$rc" = 0 ] && printf '%s' "$out" | grep -qE "Dry run only|Nothing to push"; then
    # The generated reports (this script's and vault-audit's) are rewritten
    # every run, so they'd keep this check on WARN forever — don't count them.
    local n; n=$(printf '%s\n' "$out" | grep -E '^  [~+-] ' \
      | grep -vcE '07 - Systems Status/(Health Check Report|Vault Audit)\.md$')
    if [ "$n" = 0 ]; then
      rec "hq-vault-sync" PASS "dry run ok, vault matches GitHub (generated reports aside)"
    else
      rec "hq-vault-sync" WARN "dry run ok, but $n file(s) differ from GitHub — review the plan before --apply"
    fi
  else
    rec "hq-vault-sync" FAIL "dry run rc=$rc: $(printf '%s' "$out" | tail -1)"
  fi
}

# ── 5. Spotify ───────────────────────────────────────────────────────────
check_spotify() {
  local out; out=$(curl -s --max-time 5 "$HANDS_URL/spotify/status")
  case "$out" in
    *'"authed": true'*|*'"authed":true'*) rec "spotify" PASS "/spotify/status authed (playback not tested)" ;;
    '') rec "spotify" FAIL "/spotify/status unreachable (barehands down?)" ;;
    *) rec "spotify" FAIL "/spotify/status: $out" ;;
  esac
}

# ── 6. groq-agent ────────────────────────────────────────────────────────
check_groq() {
  if [ -n "${GROQ_API_KEY:-}" ]; then
    rec "groq-agent" PASS "GROQ_API_KEY present (live call not made)"
  else
    rec "groq-agent" SKIP "GROQ_API_KEY not provisioned — parked by Luis 2026-08-29"
  fi
}

# ── 7. claude-quota ──────────────────────────────────────────────────────
check_quota() {
  local u rc l
  u=$(bash "$ROOT/scripts/claude-quota/usage.sh" 2>&1); rc=$?
  if [ "$rc" != 0 ] || ! printf '%s' "$u" | grep -q "5-hour"; then
    rec "claude-quota" FAIL "usage.sh rc=$rc: $(printf '%s' "$u" | tail -1)"; return
  fi
  l=$(bash "$ROOT/scripts/claude-quota/account.sh" list 2>&1)
  local five; five=$(printf '%s\n' "$u" | awk '/5-hour/{for(i=1;i<=NF;i++) if($i ~ /%$/) {print $i; exit}}')
  local accts; accts=$(printf '%s\n' "$l" | awk '/refresh token ~-?[0-9]+d left/{match($0,/~-?[0-9]+d/); print $1 "=" substr($0,RSTART+1,RLENGTH-2) "d"}' | paste -sd' ' -)
  local low; low=$(printf '%s\n' "$l" | grep -oE '~-?[0-9]+d left' | tr -dc -- '-0-9\n' | sort -n | head -1)
  if [ -z "$accts" ]; then
    rec "claude-quota" WARN "5h at $five, but no saved account snapshots with a known expiry"
  elif [ "${low:-0}" -lt 0 ]; then
    rec "claude-quota" FAIL "5h at $five; a saved account's refresh token has expired ($accts) — redo watch-login.sh"
  elif [ "${low:-0}" -le 5 ]; then
    rec "claude-quota" WARN "5h at $five; refresh token expiring soon ($accts) — redo watch-login.sh"
  else
    rec "claude-quota" PASS "5h at $five; accounts $accts"
  fi
}

# ── 8. vault-audit ───────────────────────────────────────────────────────
check_audit() {
  local out rc
  local nw=(); [ "$WRITE" = 0 ] && nw=(--no-write)
  out=$(python3 "$ROOT/scripts/vault-audit/audit.py" --vault "$VAULT" "${nw[@]}" --json 2>&1); rc=$?
  case "$rc" in
    0) rec "vault-audit" PASS "0 findings" ;;
    1) local n; n=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null)
       rec "vault-audit" WARN "${n:-?} finding(s) — see 07 - Systems Status/Vault Audit.md" ;;
    *) rec "vault-audit" FAIL "audit.py rc=$rc (crash or missing vault)" ;;
  esac
}

# ── 9. session guard ─────────────────────────────────────────────────────
# Uses `guard.sh list`, never the default `register` — a health check must
# not write itself into the session registry.
check_guard() {
  local out rc
  out=$(bash "$ROOT/scripts/session/guard.sh" list 2>&1); rc=$?
  if [ "$rc" != 0 ]; then
    rec "session-guard" FAIL "guard.sh list rc=$rc"; return
  fi
  if ! grep -q "guard.sh register" "$ROOT/.claude/settings.json" 2>/dev/null; then
    rec "session-guard" FAIL "guard.sh runs, but register hook missing from .claude/settings.json"; return
  fi
  # Registered sessions on the main tree, minus list's own "(this)" row and
  # jarvis-voice's bundled Agent SDK `claude` (it fires the SessionStart hooks
  # too, but it's a subprocess of the voice server, not a session).
  local pids="" pid tree
  while read -r pid tree; do
    [ "$tree" = "$ROOT" ] || continue
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q claude_agent_sdk && continue
    pids="${pids:+$pids,}$pid"
  done < <(printf '%s\n' "$out" | awk '$1=="pid" && $2 !~ /\(this\)/ {print $2, $4}')
  local n=0; [ -n "$pids" ] && n=$(printf '%s\n' "$pids" | tr ',' '\n' | wc -l)
  # A Claude session running this from the main tree is one of the sessions too.
  local self=0
  local self_cwd; self_cwd=$(readlink "/proc/${CLAUDE_PID:-0}/cwd" 2>/dev/null)
  if [ -n "$self_cwd" ] && [ "$(git -C "$self_cwd" rev-parse --show-toplevel 2>/dev/null)" = "$ROOT" ] \
     && ! printf ',%s,' "$pids" | grep -q ",$CLAUDE_PID,"; then self=1; fi
  if [ $(( n + self )) -ge 2 ]; then
    rec "session-guard" WARN "$(( n + self )) live sessions on $ROOT (pids ${pids:-none}$([ "$self" = 1 ] && printf ', plus this one')) — isolate before branch ops"
  else
    rec "session-guard" PASS "$(( n + self )) live session(s) on the main tree; registry read-only via guard.sh list"
  fi
}

# ── 10. light show ───────────────────────────────────────────────────────
check_lightshow() {
  local cue="$ROOT/scripts/lightshow/cues/shoot_to_thrill.json" n
  n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("cues",[])))' "$cue" 2>/dev/null)
  if [ -z "$n" ]; then
    rec "lightshow" FAIL "cue file missing or invalid JSON: ${cue#$ROOT/}"
  elif ! grep -q 'shoot_to_thrill.json' "$ROOT/barehands/server.py" 2>/dev/null; then
    rec "lightshow" FAIL "$n cues load, but barehands/server.py no longer points at the cue file"
  else
    rec "lightshow" PASS "$n cues load; barehands wired to the cue file (lamp not fired)"
  fi
}

# ── 11. site analyzer (next-app) ─────────────────────────────────────────
check_nextapp() {
  local env="$ROOT/next-app/.env.local"
  if ! grep -qE '^NEXT_PUBLIC_CESIUM_ION_TOKEN=.+' "$env" 2>/dev/null; then
    rec "next-app" FAIL "NEXT_PUBLIC_CESIUM_ION_TOKEN missing from next-app/.env.local"; return
  fi
  if [ "$DEEP" = 0 ]; then
    rec "next-app" PASS "Cesium token present (build gates: --deep)"; return
  fi
  # Builds in place, exactly as the runbook's check 11 does. Safe alongside a
  # running `next dev`: Next 16 keeps dev output in .next/dev, apart from the
  # production build this replaces. (A temp copy doesn't work — Turbopack
  # rejects a node_modules symlink that points outside the project root.)
  local step
  for step in "npm run typecheck" "npm run lint" "npx next build"; do
    if ! (cd "$ROOT/next-app" && $step >/dev/null 2>&1); then
      rec "next-app" FAIL "'$step' failed"; return
    fi
  done
  rec "next-app" PASS "typecheck, lint, build all green (3D scene needs a real browser)"
}

# ── 12. codespaces usage ─────────────────────────────────────────────────
check_codespace() {
  local out rc
  out=$(bash "$ROOT/scripts/codespace-usage/usage.sh" 2>&1); rc=$?
  local line; line=$(printf '%s\n' "$out" | grep -m1 "Compute:")
  if [ "$rc" != 0 ] || [ -z "$line" ]; then
    rec "codespace-usage" FAIL "usage.sh rc=$rc: $(printf '%s' "$out" | tail -1) (PAT expired?)"; return
  fi
  local pct; pct=$(printf '%s' "$line" | grep -oE '[0-9]+% used' | tr -dc '0-9')
  local brief; brief=$(printf '%s' "$line" | sed 's/^ *Compute: *//; s/  */ /g')
  if [ "${pct:-0}" -ge 80 ]; then
    rec "codespace-usage" WARN "$brief — nearing the free allowance"
  else
    rec "codespace-usage" PASS "$brief"
  fi
}

check_voice; check_face; check_hands; check_sync; check_spotify; check_groq
check_quota; check_audit; check_guard; check_lightshow; check_nextapp; check_codespace

# ── output ───────────────────────────────────────────────────────────────
STAMP="$(TZ=America/Tijuana date '+%Y-%m-%d %H:%M %Z')"
MODE="full"; [ "$QUICK" = 1 ] && MODE="quick"; [ "$DEEP" = 1 ] && MODE="deep"
declare -A COUNT=([PASS]=0 [WARN]=0 [FAIL]=0 [SKIP]=0)
for s in "${STATES[@]}"; do COUNT[$s]=$(( ${COUNT[$s]} + 1 )); done
SUMMARY="${COUNT[PASS]} pass, ${COUNT[WARN]} warn, ${COUNT[FAIL]} fail, ${COUNT[SKIP]} skip"

color() { case "$1" in PASS) printf '\033[32m';; WARN) printf '\033[33m';; FAIL) printf '\033[31m';; *) printf '\033[90m';; esac; }
clean=$(( COUNT[WARN] + COUNT[FAIL] == 0 ))
if ! { [ "$QUIET" = 1 ] && [ "$clean" = 1 ]; }; then
  echo "── Jarvis health check ($MODE) $STAMP ──"
  for i in "${!NAMES[@]}"; do
    [ "$QUIET" = 1 ] && [ "${STATES[$i]}" = PASS ] && continue
    [ "$QUIET" = 1 ] && [ "${STATES[$i]}" = SKIP ] && continue
    printf '  %s%-4s\033[0m  %-16s %s\n' "$(color "${STATES[$i]}")" "${STATES[$i]}" "${NAMES[$i]}" "${DETAILS[$i]}"
  done
  echo "  => $SUMMARY"
fi

if [ "$WRITE" = 1 ] && [ -d "$(dirname "$REPORT")" ]; then
  {
    printf -- '---\nstatus: active\nproject: meta\ntype: log\n---\n'
    printf '# Health Check Report\n\n'
    printf 'Generated by `scripts/healthcheck/check.sh` — overwritten on every run, never hand-edit. '
    printf 'Runbook: [[Health Check Procedure]]. Curated status: [[Jarvis Systems Status]].\n\n'
    printf '**Last run:** %s (%s mode) — %s\n\n' "$STAMP" "$MODE" "$SUMMARY"
    printf '| System | Result | Evidence |\n|---|---|---|\n'
    for i in "${!NAMES[@]}"; do
      printf '| %s | %s | %s |\n' "${NAMES[$i]}" "${STATES[$i]}" "${DETAILS[$i]//|/\\|}"
    done
  } > "$REPORT"
fi

[ "${COUNT[FAIL]}" = 0 ]
