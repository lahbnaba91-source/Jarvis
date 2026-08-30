#!/usr/bin/env python3
"""Cheaply sync new changes from the hq-vault GitHub repo into the local
/workspaces/Jarvis/HQ working copy, without an AI ever having to diff or
merge the whole vault by hand.

How: a small hidden clone of hq-vault is kept at SENSOR_DIR purely as a
"what did I last see" baseline -- it is NOT the folder Luis/Obsidian/an AI
session actually reads or writes (that's still the plain-copy HQ/, on
purpose -- see HQ Vault Sync.md for why HQ/ must never become a live git
checkout: a raw `git push` from inside it has already desynced Obsidian's
Gitless Sync plugin and crashed it, more than once). On each run:

  1. Fetch hq-vault's current main into the sensor clone.
  2. Diff the sensor's OLD head against the NEW head -- that's exactly
     what changed remotely since the last time this ran.
  3. For each changed file, compare against HQ/'s current copy:
     - If HQ/'s copy still matches the OLD (pre-fetch) version, nothing
       local has touched it since last sync -- just overwrite it with the
       new remote version. No merge, no tokens, just a file copy.
     - If HQ/'s copy has ALSO changed since last sync, attempt a real
       three-way line merge (git merge-file, the same algorithm `git
       merge` itself uses) with the old version as the common base. Most
       of the time two edits touch different lines/sections and this
       merges cleanly with zero human or AI attention.
     - Only a genuine same-line collision gets left alone: HQ/'s file is
       NOT touched, and the incoming remote version is saved alongside as
       "<name> (incoming from hq-vault).md" for a human or AI to actually
       look at and reconcile.
  4. Advance the sensor to the new head so next run's baseline is current.

Files that only changed locally (not touched upstream) are left alone
entirely -- this only ever pulls in what's genuinely new on the remote.

Usage:
    export HQVAULT_TOKEN="<fine-grained PAT, Contents: Read and write, hq-vault>"
    python3 pull-hq-vault.py
"""
import os
import stat
import subprocess
import sys
import tempfile

LOCAL_VAULT = "/workspaces/Jarvis/HQ"
SENSOR_DIR = "/workspaces/Jarvis/.hq-vault-pull-sensor"
REPO_OWNER = os.environ.get("HQVAULT_OWNER", "lalp070125")
REPO_NAME = os.environ.get("HQVAULT_REPO", "hq-vault")
BRANCH = os.environ.get("HQVAULT_BRANCH", "main")
SKIP_PREFIXES = (".obsidian/", "README.md")


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list, cwd: str = None, check: bool = True, env: dict = None) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        die(f"command failed: {' '.join(cmd)}")
    return result


CRED_HELPER_SCRIPT = """#!/bin/sh
echo "username=x-access-token"
echo "password=$HQVAULT_TOKEN"
"""


def git_with_token(cmd: list, cwd: str, token: str) -> subprocess.CompletedProcess:
    """Runs a git command with the token supplied via a helper script that
    reads it from the environment -- never embedded in argv/the command
    line itself (which would land in `ps aux`), same pattern as
    push-hq-vault.py. Clears the codespace's own system-level credential
    helper override first (see HQ Vault Sync.md) so ours actually wins."""
    with tempfile.TemporaryDirectory() as d:
        helper_path = os.path.join(d, "cred-helper.sh")
        with open(helper_path, "w") as f:
            f.write(CRED_HELPER_SCRIPT)
        os.chmod(helper_path, stat.S_IRWXU)
        full = ["git", "-c", "credential.helper=", "-c", f"credential.helper={helper_path}", *cmd]
        return run(full, cwd=cwd)


def show_file_at(rev: str, rel_path: str, cwd: str) -> bytes:
    result = subprocess.run(
        ["git", "show", f"{rev}:{rel_path}"], cwd=cwd, capture_output=True
    )
    return result.stdout if result.returncode == 0 else None  # None = didn't exist at that rev


def three_way_merge(base: bytes, local: bytes, remote: bytes) -> tuple:
    """Returns (merged_bytes, had_conflict: bool) via git's own merge-file."""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        lp, bp, rp = f"{d}/local", f"{d}/base", f"{d}/remote"
        open(lp, "wb").write(local)
        open(bp, "wb").write(base)
        open(rp, "wb").write(remote)
        result = subprocess.run(
            ["git", "merge-file", "-p", lp, bp, rp], capture_output=True
        )
        return result.stdout, result.returncode != 0


def should_skip(rel_path: str) -> bool:
    return any(rel_path == p or rel_path.startswith(p) for p in SKIP_PREFIXES)


def main():
    token = os.environ.get("HQVAULT_TOKEN")
    if not token:
        die("HQVAULT_TOKEN is not set in the environment")
    if not os.path.isdir(LOCAL_VAULT):
        die(f"local vault not found at {LOCAL_VAULT}")

    repo_url = f"https://github.com/{REPO_OWNER}/{REPO_NAME}.git"
    first_run = not os.path.isdir(os.path.join(SENSOR_DIR, ".git"))

    if first_run:
        print(f"First run -- cloning {repo_url} to set the baseline (nothing applied yet) ...")
        os.makedirs(os.path.dirname(SENSOR_DIR), exist_ok=True)
        git_with_token(["clone", "-q", repo_url, SENSOR_DIR], cwd="/", token=token)
        print("Baseline set. Re-run this after the next real remote change to see it sync.")
        return

    old_head = run(["git", "rev-parse", "HEAD"], cwd=SENSOR_DIR).stdout.strip()
    print("Fetching hq-vault ...")
    git_with_token(["fetch", "-q", "origin", BRANCH], cwd=SENSOR_DIR, token=token)
    new_head = run(["git", "rev-parse", f"origin/{BRANCH}"], cwd=SENSOR_DIR).stdout.strip()

    if old_head == new_head:
        print("Nothing new on hq-vault since last pull.")
        return

    diff = run(["git", "diff", "--name-status", old_head, new_head], cwd=SENSOR_DIR).stdout
    changed_paths = []
    for line in diff.splitlines():
        parts = line.split("\t")
        status, rel_path = parts[0], parts[-1]
        if should_skip(rel_path):
            continue
        changed_paths.append((status, rel_path))

    applied, merged, deleted, flagged = [], [], [], []

    for status, rel_path in changed_paths:
        local_abs = os.path.join(LOCAL_VAULT, rel_path)
        remote_new = show_file_at(new_head, rel_path, SENSOR_DIR)  # None if deleted upstream
        remote_old = show_file_at(old_head, rel_path, SENSOR_DIR)  # None if it's newly added
        local_current = open(local_abs, "rb").read() if os.path.isfile(local_abs) else None

        local_matches_old_baseline = (local_current == remote_old)

        if remote_new is None:
            # Deleted upstream.
            if local_matches_old_baseline and local_current is not None:
                os.remove(local_abs)
                deleted.append(rel_path)
            elif local_current is None:
                pass  # already gone locally too, nothing to do
            else:
                flagged.append((rel_path, "deleted upstream, but edited locally since last sync"))
            continue

        if local_matches_old_baseline:
            os.makedirs(os.path.dirname(local_abs), exist_ok=True)
            with open(local_abs, "wb") as f:
                f.write(remote_new)
            applied.append(rel_path)
            continue

        if local_current is None:
            # Exists upstream now, doesn't exist locally, and wasn't just
            # "deleted since baseline" (remote_old is None too) -- brand
            # new file, safe to add.
            if remote_old is None:
                os.makedirs(os.path.dirname(local_abs), exist_ok=True)
                with open(local_abs, "wb") as f:
                    f.write(remote_new)
                applied.append(rel_path)
            else:
                flagged.append((rel_path, "deleted locally, but changed upstream since last sync"))
            continue

        # Both sides touched it since the last sync -- try a real 3-way merge.
        base = remote_old if remote_old is not None else b""
        merged_bytes, had_conflict = three_way_merge(base, local_current, remote_new)
        if not had_conflict:
            with open(local_abs, "wb") as f:
                f.write(merged_bytes)
            merged.append(rel_path)
        else:
            side_path = local_abs.rsplit(".", 1)
            incoming_path = (
                f"{side_path[0]} (incoming from hq-vault).{side_path[1]}"
                if len(side_path) == 2 else f"{local_abs} (incoming from hq-vault)"
            )
            with open(incoming_path, "wb") as f:
                f.write(remote_new)
            flagged.append((rel_path, f"same lines edited both places -- incoming version saved next to it as \"{os.path.basename(incoming_path)}\""))

    run(["git", "reset", "-q", "--hard", new_head], cwd=SENSOR_DIR)

    print()
    print(f"Auto-applied (remote-only changes): {len(applied)}")
    for p in applied:
        print(f"  + {p}")
    print(f"Auto-merged (both sides, no overlap): {len(merged)}")
    for p in merged:
        print(f"  ~ {p}")
    print(f"Deleted locally (removed upstream): {len(deleted)}")
    for p in deleted:
        print(f"  - {p}")
    if flagged:
        print(f"NEEDS ATTENTION: {len(flagged)}")
        for p, reason in flagged:
            print(f"  ! {p} -- {reason}")
    if not (applied or merged or deleted or flagged):
        print("Nothing applicable (all remote changes were to skipped paths).")


if __name__ == "__main__":
    main()
