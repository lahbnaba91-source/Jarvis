#!/bin/bash
# Back-compat shim. The setup flow now lives in bootstrap/ as a numbered,
# portable wizard. This path is kept because the disaster-recovery checklist
# and old muscle memory point at it.
#
#   bash scripts/bootstrap.sh [--core-only] [--with a,b,c] [--yes]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/bootstrap/wizard.sh" "$@"
