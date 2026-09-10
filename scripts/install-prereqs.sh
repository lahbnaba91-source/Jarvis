#!/bin/bash
# Back-compat shim. The prereqs step now lives in bootstrap/00-prereqs.sh
# (portable: apt/brew/dnf/pacman). Old muscle memory and the disaster-recovery
# checklist still call this path.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/bootstrap/00-prereqs.sh" "$@"
