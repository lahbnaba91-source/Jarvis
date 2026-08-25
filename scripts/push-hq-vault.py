#!/usr/bin/env python3
"""Push /workspaces/Jarvis/HQ to the hq-vault GitHub repo without breaking
the GitHub Gitless Sync Obsidian plugin's own state on other devices.

Background (see HQ/05 - Resources/HQ Vault Sync.md for the full story):
the plugin (silvanocerza/github-gitless-sync) tracks every file's git blob
SHA in .obsidian/github-sync-metadata.json and decides what to sync purely
by comparing that file against each device's own local copy of it. A plain
`git push` from here never touches that file, so every other device's copy
goes stale and its sync silently becomes a no-op ("successful" but nothing
changes) until someone manually resets to a fresh empty vault. This script
regenerates that metadata file correctly as part of every push, computing
each file's real git blob SHA (identical algorithm to `git hash-object`:
sha1("blob " + len(bytes) + "\0" + bytes)), so any device's plugin sees a
push from here exactly like a sync it performed itself.

Usage:
    export HQVAULT_TOKEN="<fine-grained PAT, Contents: Read and write, hq-vault>"
    python3 push-hq-vault.py            # dry run: shows the plan, pushes nothing
    python3 push-hq-vault.py --apply    # actually commits and pushes

Never pass the token as a CLI argument or embed it in a command string --
always via the HQVAULT_TOKEN environment variable, so it never appears in
`ps aux` or a logged shell command.
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time

LOCAL_VAULT = "/workspaces/Jarvis/HQ"
REPO_OWNER = os.environ.get("HQVAULT_OWNER", "lalp070125")
REPO_NAME = os.environ.get("HQVAULT_REPO", "hq-vault")
BRANCH = os.environ.get("HQVAULT_BRANCH", "main")
MANIFEST_REL = ".obsidian/github-sync-metadata.json"

CRED_HELPER_SCRIPT = """#!/bin/sh
echo "username=x-access-token"
echo "password=$HQVAULT_TOKEN"
"""


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def git_blob_sha(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def is_hidden(rel_path: str) -> bool:
    return any(part.startswith(".") for part in rel_path.split(os.sep))


def walk_vault_files(root: str) -> dict:
    """Returns {relative_path: absolute_path} for every real content file,
    excluding .git, .obsidian, and any hidden file/folder -- matching the
    plugin's own rule of skipping hidden files. Exception: .gitignore is
    real tracked vault content (it's what keeps _local/ credential notes
    out of GitHub in the first place), so it must never be treated as
    hidden junk -- doing so would make every run of this script look like
    .gitignore was deleted and propagate that deletion to every device."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", ".obsidian") and not d.startswith(".")]
        for fn in filenames:
            if fn.startswith(".") and fn != ".gitignore":
                continue
            abs_path = os.path.join(dirpath, fn)
            rel_path = os.path.relpath(abs_path, root)
            out[rel_path] = abs_path
    return out


def run(cmd: list, cwd: str = None, env: dict = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        die(f"command failed: {' '.join(cmd)}")
    return result


def git_env_with_helper(helper_path: str) -> list:
    """Returns the -c args needed to clear this codespace's system-level
    credential helper override and use ours instead. See HQ Vault Sync.md
    for why this is required -- without it, every push silently uses the
    codespace's own Jarvis-scoped token instead of HQVAULT_TOKEN."""
    return ["-c", "credential.helper=", "-c", f"credential.helper={helper_path}"]


def main():
    apply = "--apply" in sys.argv

    if not os.environ.get("HQVAULT_TOKEN"):
        die("HQVAULT_TOKEN is not set in the environment")
    if not os.path.isdir(LOCAL_VAULT):
        die(f"local vault not found at {LOCAL_VAULT}")

    scratch = tempfile.mkdtemp(prefix="push-hq-vault-")
    clone_dir = os.path.join(scratch, "hq-vault-sync")
    helper_path = os.path.join(scratch, "cred-helper.sh")

    try:
        with open(helper_path, "w") as f:
            f.write(CRED_HELPER_SCRIPT)
        os.chmod(helper_path, stat.S_IRWXU)

        repo_url = f"https://github.com/{REPO_OWNER}/{REPO_NAME}.git"
        print(f"Cloning {repo_url} ...")
        run(["git", *git_env_with_helper(helper_path), "clone", repo_url, clone_dir])

        manifest_abs = os.path.join(clone_dir, MANIFEST_REL)
        old_manifest = {"lastSync": 0, "files": {}}
        if os.path.isfile(manifest_abs):
            with open(manifest_abs) as f:
                old_manifest = json.load(f)
        old_files = old_manifest.get("files", {})

        # Mirror local HQ into the clone, excluding .git and .obsidian entirely --
        # the metadata file is handled separately below, and we never want to
        # touch any other .obsidian content (plugin configs, themes, etc.).
        print("Mirroring local vault content ...")
        rsync_cmd = [
            "rsync", "-a", "--delete",
            "--exclude=.git", "--exclude=.obsidian", "--exclude=README.md",
            f"{LOCAL_VAULT}/", f"{clone_dir}/",
        ]
        run(rsync_cmd)

        new_files_on_disk = walk_vault_files(clone_dir)
        now_ms = int(time.time() * 1000)

        new_manifest_files = {}
        changed, added, removed, unchanged = [], [], [], []

        for rel_path, abs_path in new_files_on_disk.items():
            new_sha = git_blob_sha(abs_path)
            old_entry = old_files.get(rel_path)
            if old_entry is None:
                added.append(rel_path)
            elif old_entry.get("sha") != new_sha or old_entry.get("deleted"):
                changed.append(rel_path)
            else:
                unchanged.append(rel_path)
            new_manifest_files[rel_path] = {
                "path": rel_path,
                "sha": new_sha,
                "dirty": False,
                "justDownloaded": False,
                "lastModified": now_ms,
            }

        for rel_path, old_entry in old_files.items():
            if rel_path in new_files_on_disk:
                continue
            if rel_path == MANIFEST_REL:
                # The plugin tracks itself as an entry but never acts on this
                # path (determineSyncActions explicitly skips it) -- it's not
                # part of the content walk since we regenerate it separately
                # below, so it must never be treated as "removed".
                new_manifest_files[rel_path] = old_entry
                continue
            if old_entry.get("deleted"):
                # Already marked deleted previously; carry it forward so
                # devices that haven't caught up yet still see it -- but
                # force sha null (see the tombstone-shape comment below):
                # an old tombstone written before that fix can still carry
                # a real sha, which is the exact state that broke sync.
                new_manifest_files[rel_path] = {**old_entry, "sha": None}
                continue
            removed.append(rel_path)
            # sha must be null, NOT the old entry's real content sha -- the
            # plugin's own delete_remote handler writes null (sync-manager.ts:
            # `newTreeFiles[action.filePath].sha = null`), and its own
            # determineSyncActions short-circuits on `remoteFile.sha ===
            # localSHA` BEFORE ever checking the deleted flag. A tombstone
            # that keeps the real sha (this bug, live 2026-08-25 -- confirmed
            # by reading sync-manager.ts after a device got stuck unable to
            # ever delete two files) matches an unchanged device's local sha
            # and short-circuits every sync into "nothing to do", so the
            # device never runs delete_local and the deletion never lands.
            # Worse: with mismatched deleted flags across devices this can
            # also route into delete_remote for a path already absent from
            # the real git tree, which crashes the plugin outright (it
            # doesn't guard that case) -- "TypeError: undefined is not an
            # object (evaluating 'u[f.filePath].sha=null')" is that crash.
            new_manifest_files[rel_path] = {
                "path": rel_path,
                "sha": None,
                "dirty": False,
                "justDownloaded": False,
                "deleted": True,
                "deletedAt": now_ms,
            }

        # Hard guarantee, not just a comment: refuse to write a manifest
        # where any deleted entry still carries a real sha. This exact
        # shape is what broke sync live on 2026-08-25 (see HQ Vault Sync.md)
        # -- a stale sha makes the plugin's own short-circuit skip the
        # deletion forever, and can crash it outright. Checked for EVERY
        # deleted entry, not just ones this run just marked, so a bad
        # tombstone from before this check existed still gets caught.
        bad_tombstones = [
            p for p, e in new_manifest_files.items()
            if e.get("deleted") and e.get("sha") is not None
        ]
        if bad_tombstones:
            die("refusing to push: deleted entries with a non-null sha "
                f"(would break sync): {bad_tombstones}")

        print()
        print(f"Plan: {len(added)} added, {len(changed)} changed, {len(removed)} removed, {len(unchanged)} unchanged")
        for rel_path in added:
            print(f"  + {rel_path}")
        for rel_path in changed:
            print(f"  ~ {rel_path}")
        for rel_path in removed:
            print(f"  - {rel_path}")
        print()

        if not (added or changed or removed):
            print("Nothing to push.")
            return

        if not apply:
            print("Dry run only -- rerun with --apply to actually commit and push.")
            return

        new_manifest = {"lastSync": now_ms, "files": new_manifest_files}
        os.makedirs(os.path.dirname(manifest_abs), exist_ok=True)
        with open(manifest_abs, "w") as f:
            json.dump(new_manifest, f)

        run(["git", "add", "-A"], cwd=clone_dir)
        status = run(["git", "status", "--short"], cwd=clone_dir)
        print(status.stdout)

        commit_msg = f"Sync from codespace: {len(added)} added, {len(changed)} changed, {len(removed)} removed"
        run(["git", "commit", "-m", commit_msg, "-q"], cwd=clone_dir)

        print("Pushing ...")
        push_result = run(
            ["git", *git_env_with_helper(helper_path), "push", "origin", f"HEAD:{BRANCH}"],
            cwd=clone_dir,
        )
        print(push_result.stdout)
        print(push_result.stderr)
        print("Push complete.")

    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
