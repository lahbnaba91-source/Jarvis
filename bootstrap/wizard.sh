#!/bin/bash
# The Jarvis setup wizard. Runs the numbered steps in order; each is idempotent
# and safe to re-run. install.sh calls this after unpacking a release; you can
# also run it directly from a checkout ('make wizard').
#
#   bootstrap/wizard.sh [--core-only] [--with a,b,c] [--yes] [--dir PATH]
#
#   --core-only   skip the optional-module step entirely
#   --with LIST   comma-separated modules to enable non-interactively
#                 (spotify,hubspace,groq,site-analyzer,badge,claude-quota,vault-sync
#                  or 'all'); implies the module step runs without prompts
#   --yes         assume "yes" for confirm prompts, "default" for the rest
#   --dir PATH    install root (default: this checkout's top level)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bootstrap/lib.sh
. "$HERE/lib.sh"

CORE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --core-only) CORE_ONLY=1 ;;
    --with)      shift; export JARVIS_MODULES="${1:-}" ;;
    --with=*)    export JARVIS_MODULES="${1#*=}" ;;
    --yes|-y)    export JARVIS_ASSUME_YES=1 ;;
    --dir)       shift; export JARVIS_ROOT="${1:-}" ;;
    --dir=*)     export JARVIS_ROOT="${1#*=}" ;;
    --non-interactive) export JARVIS_NONINTERACTIVE=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done

# Resolve the install root: --dir/env wins, else the checkout wrapping this file.
if [ -z "${JARVIS_ROOT:-}" ]; then
  JARVIS_ROOT="$(cd "$HERE/.." && pwd)"
fi
export JARVIS_ROOT
[ -d "$JARVIS_ROOT" ] || die "install root does not exist: $JARVIS_ROOT"

# If the wizard tree isn't already inside JARVIS_ROOT, copy the checkout there.
if [ "$(cd "$HERE/.." && pwd)" != "$JARVIS_ROOT" ]; then
  say "Copying Jarvis into $JARVIS_ROOT"
  mkdir -p "$JARVIS_ROOT"
  cp -a "$HERE/../." "$JARVIS_ROOT/"
fi

echo "Jarvis wizard — installing to $JARVIS_ROOT"
echo

bash "$JARVIS_ROOT/bootstrap/00-prereqs.sh"
# Re-source PATH-affecting installs for the rest of this process.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
bash "$JARVIS_ROOT/bootstrap/10-core.sh"
bash "$JARVIS_ROOT/bootstrap/20-claude.sh"
if [ "$CORE_ONLY" -eq 1 ]; then
  say "Skipping optional modules (--core-only)"
else
  bash "$JARVIS_ROOT/bootstrap/30-modules.sh"
fi
bash "$JARVIS_ROOT/bootstrap/99-up.sh"
