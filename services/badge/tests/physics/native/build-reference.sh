#!/usr/bin/env bash
# Compiles the PARMA reference dose generator for the BADGE cross-check.
# Links the same vendor PARMA sources as engine/native/build.sh. The binary
# lands in the PARMA vendor root because PARMA resolves input/ and dcc/ by
# relative path at runtime.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$here/../../../vendor/PARMA"

if [ ! -f "$vendor/subroutines.cpp" ]; then
  echo "PARMA sources missing at $vendor" >&2
  exit 1
fi

g++ -O2 -std=c++17 -o "$vendor/parma_reference" "$here/parma_reference.cpp" "$vendor/subroutines.cpp"
echo "built $vendor/parma_reference"
