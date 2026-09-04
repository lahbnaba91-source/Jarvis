#!/usr/bin/env bash
# Jarvis multi-session guard.
#
# Two Claude Code sessions launched from the same directory share one working
# tree, one .git, and one set of branch refs. They then collide on checkouts,
# stashes, rebases and branch refs — this bit us hard on 2026-09-04 (one session
# switched the shared tree to `main` mid-merge, another's uncommitted edits had
# to be recovered from reflog).
#
# This script keeps a tiny live-session registry and warns at boot when another
# session is already operating in the same working tree. It does not lock — it
# makes the collision visible and prescribes the fix (isolate into a worktree,
# see scripts/session/worktree.sh).
#
# Usage:
#   guard.sh register   # SessionStart hook: prune dead entries, record self, warn
#   guard.sh list       # show all live Jarvis sessions
#   guard.sh check      # exit 1 (and explain) if another session shares this tree
#   guard.sh release    # remove this session's entry (optional; dead entries
#                       # are pruned automatically on the next register/list)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null || echo /workspaces/Jarvis)"
reg_dir="$repo_root/.claude/sessions"

# The SessionStart hook runs as a child of the Claude Code process, so $PPID is a
# stable per-session key for the lifetime of that session.
me_pid="${JARVIS_SESSION_PID:-$PPID}"

tree_of()   { git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || echo "$repo_root"; }
branch_of() { git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?"; }

prune_dead() {
  [ -d "$reg_dir" ] || return 0
  local f pid
  for f in "$reg_dir"/*; do
    [ -e "$f" ] || continue
    pid="$(basename "$f")"
    case "$pid" in *[!0-9]*) rm -f "$f"; continue;; esac
    kill -0 "$pid" 2>/dev/null || rm -f "$f"
  done
}

write_self() {
  mkdir -p "$reg_dir"
  printf '%s|%s|%s|%s\n' "$(tree_of)" "$(branch_of)" "$(date +%s)" "${SSH_TTY:-${TTY:-tty?}}" \
    > "$reg_dir/$me_pid"
}

# Prints "pid|tree|branch|started|tty" for every OTHER live session, one per line.
others() {
  [ -d "$reg_dir" ] || return 0
  local f pid
  for f in "$reg_dir"/*; do
    [ -e "$f" ] || continue
    pid="$(basename "$f")"
    [ "$pid" = "$me_pid" ] && continue
    printf '%s|%s\n' "$pid" "$(cat "$f")"
  done
}

# Others that share THIS working tree — the ones that actually collide.
same_tree_others() {
  local my_tree; my_tree="$(tree_of)"
  others | while IFS='|' read -r pid tree branch started tty; do
    [ "$tree" = "$my_tree" ] && printf '%s|%s|%s|%s\n' "$pid" "$branch" "$started" "$tty"
  done
}

human_age() {
  local secs=$(( $(date +%s) - ${1:-0} ))
  [ "$secs" -lt 0 ] && secs=0
  if   [ "$secs" -lt 60 ];   then echo "${secs}s"
  elif [ "$secs" -lt 3600 ]; then echo "$((secs/60))m"
  else echo "$((secs/3600))h$(((secs%3600)/60))m"; fi
}

warn_block() {
  local hits="$1"
  echo "=============================================================================="
  echo "  ANOTHER JARVIS SESSION IS LIVE IN THIS SAME WORKING TREE"
  echo "$hits" | while IFS='|' read -r pid branch started tty; do
    [ -n "$pid" ] || continue
    echo "    - pid $pid  branch '$branch'  up $(human_age "$started")  ($tty)"
  done
  cat <<'EOF'
    One tree + one .git for two sessions => they collide on checkout / stash /
    rebase / branch refs (this cost real time on 2026-09-04).
    Before ANY branch switch, rebase, merge or history rewrite in this tree:
      1. isolate this session ->  scripts/session/worktree.sh <name>
         then relaunch `claude` from the printed worktree path, OR
      2. agree out loud which session owns the tree and the other holds off.
    Same-branch commits from two sessions are also unsafe — see CLAUDE.md.
==============================================================================
EOF
}

cmd="${1:-register}"
case "$cmd" in
  register)
    prune_dead
    write_self
    hits="$(same_tree_others || true)"
    if [ -n "$hits" ]; then
      warn_block "$hits" >&2
    else
      echo "session guard: sole session in $(tree_of) (pid $me_pid, branch $(branch_of))"
    fi
    ;;
  list)
    prune_dead
    echo "live Jarvis sessions:"
    { printf '%s|%s|%s|%s|%s\n' "$me_pid(this)" "$(tree_of)" "$(branch_of)" "$(date +%s)" "self"
      others; } | while IFS='|' read -r pid tree branch started tty; do
      printf '  pid %-18s tree %-28s branch %-16s up %s\n' \
        "$pid" "$tree" "$branch" "$(human_age "$started")"
    done
    ;;
  check)
    prune_dead
    hits="$(same_tree_others || true)"
    if [ -n "$hits" ]; then warn_block "$hits" >&2; exit 1; fi
    echo "session guard: clear — no other session in this tree"
    ;;
  release)
    rm -f "$reg_dir/$me_pid" && echo "session guard: released pid $me_pid"
    ;;
  *)
    echo "usage: guard.sh {register|list|check|release}" >&2
    exit 2
    ;;
esac
