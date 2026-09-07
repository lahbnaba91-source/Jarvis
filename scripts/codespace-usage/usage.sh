#!/usr/bin/env bash
# Codespaces usage for the current billing cycle (Luis's personal account, Free plan).
#
# Why this exists: the injected Codespaces GITHUB_TOKEN cannot read personal
# billing (403 on every /settings/billing endpoint). This uses a dedicated
# fine-grained PAT with "Plan: read-only" and nothing else, stashed in
# .state/gh-billing-token (gitignored).
#
# Free-plan allowances (reset on the 1st): 120 compute core-hours, 15 GB-month storage.
# A 2-core Codespace burns 2 core-hours per wall-clock hour.

set -euo pipefail

USER_LOGIN="lahbnaba91-source"
TOKEN_FILE="$(dirname "$0")/.state/gh-billing-token"
COMPUTE_ALLOWANCE_COREHRS=120
STORAGE_ALLOWANCE_GBMONTH=15

[ -r "$TOKEN_FILE" ] || { echo "missing token: $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

MONTH="$(date -u +%Y-%m)"   # billing rows are dated the 1st of the cycle month

json="$(GH_TOKEN="$TOKEN" gh api "/users/${USER_LOGIN}/settings/billing/usage" 2>&1)" || {
  echo "billing API call failed:" >&2; echo "$json" >&2; exit 1;
}

echo "$json" | jq -r --arg m "$MONTH" \
  --argjson callow "$COMPUTE_ALLOWANCE_COREHRS" \
  --argjson stalow "$STORAGE_ALLOWANCE_GBMONTH" '
  [ .usageItems[] | select(.product == "codespaces" and (.date | startswith($m))) ] as $rows
  | ( [ $rows[] | select(.sku | test("compute")) | .quantity ] | add // 0 )      as $runhrs
  | ( [ $rows[] | select(.sku | test("storage")) | .quantity ] | add // 0 )      as $gbhrs
  | ( [ $rows[] | .netAmount ] | add // 0 )                                       as $net
  | ($runhrs * 2)          as $corehrs
  | ($gbhrs / 730)         as $gbmonth
  | "Codespaces usage — cycle " + $m + "-01 (Free plan)\n" +
    "\n" +
    "  Compute:  " + ($runhrs | . * 100 | round / 100 | tostring) + " runtime hrs" +
    "  =  " + ($corehrs | . * 100 | round / 100 | tostring) + " / " + ($callow | tostring) + " core-hrs" +
    "  (" + ($corehrs / $callow * 100 | round | tostring) + "% used, " +
    (($callow - $corehrs) / 2 | . * 10 | round / 10 | tostring) + " runtime hrs left)\n" +
    "  Storage:  " + ($gbmonth | . * 1000 | round / 1000 | tostring) + " / " + ($stalow | tostring) + " GB-month" +
    "  (" + ($gbmonth / $stalow * 100 | . * 10 | round / 10 | tostring) + "% used)\n" +
    "  Net cost: $" + ($net | tostring)
  '
