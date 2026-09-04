#!/usr/bin/env bash
# Spin up an isolated git worktree so a second Jarvis session gets its own
# working tree and its own checked-out branch, instead of fighting the first
# session over the shared one.
#
# Usage:
#   scripts/session/worktree.sh <name> [base-ref]
#
#   <name>      short label, e.g. "barehands" or "voice"
#   [base-ref]  what to branch from (default: current HEAD)
#
# Creates:  <parent-of-repo>/Jarvis.wt/<name>   on branch  session/<name>
# Then launch the other session with:  cd <that path> && claude

set -euo pipefail

name="${1:?usage: worktree.sh <name> [base-ref]}"
case "$name" in *[!A-Za-z0-9_-]*) echo "name must be [A-Za-z0-9_-] only" >&2; exit 2;; esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
base="${2:-$(git -C "$root" rev-parse --abbrev-ref HEAD)}"

wt_parent="$(dirname "$root")/Jarvis.wt"
dest="$wt_parent/$name"
branch="session/$name"

if [ -e "$dest" ]; then
  echo "already exists: $dest" >&2
  echo "launch with:  cd $dest && claude" >&2
  exit 0
fi

mkdir -p "$wt_parent"

if git -C "$root" show-ref --quiet --verify "refs/heads/$branch"; then
  git -C "$root" worktree add "$dest" "$branch"
else
  git -C "$root" worktree add -b "$branch" "$dest" "$base"
fi

cat <<EOF

worktree ready
  path    $dest
  branch  $branch  (from $base)

Launch the other session there:
  cd $dest && claude

It shares the same .git object store (cheap) but has its own working tree and
its own branch checkout — the two sessions can no longer collide on files,
stashes, or branch refs. Merge back with a normal PR / cherry-pick when done.
Remove later with:  git -C "$root" worktree remove "$dest"
EOF
