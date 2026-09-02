#!/usr/bin/env bash
# Compiles the BADGE point-dose driver against the vendored PARMA 4.10 sources.
# The binary lands inside the PARMA vendor root because PARMA resolves its
# input databases by relative path at runtime.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$here/../../vendor/PARMA"

if [ ! -f "$vendor/subroutines.cpp" ]; then
  echo "PARMA sources missing at $vendor" >&2
  exit 1
fi

g++ -O2 -std=c++17 -o "$vendor/route_dose" "$here/route_dose.cpp" "$vendor/subroutines.cpp"
echo "built $vendor/route_dose"
