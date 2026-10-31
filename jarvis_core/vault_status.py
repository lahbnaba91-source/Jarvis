"""Scoped observations of the HQ vault and a combined, evidence-backed answer.

Three different questions, three different scopes:
  * "Is it in this local copy?"      -> LOCAL_WORKING_COPY (the HQ/ folder)
  * "Is it on GitHub?"               -> REMOTE_AUTHORITATIVE (GitHub API only)
  * "Has my phone synced it?"        -> OTHER_CLIENT (not observable from here)
The sync metadata file (.obsidian/github-sync-metadata.json) is CLIENT_METADATA:
it records what the last sync from *this copy* believed, not the remote, and
not the phone. This module only reads; it never writes the vault or metadata.

The local copy's age comes from a snapshot marker written OUTSIDE the vault
(<root>/.hq-snapshot.json, by load-vault.sh) so it can't be pushed into the
vault by accident. Without it, the local copy's age is "unknown".
"""
from __future__ import annotations

import json
import os
import time

from .evidence import (
    Assessment,
    Observation,
    Outcome,
    Presence,
    Scope,
    Verification,
    assess_presence,
)

MANIFEST_REL = os.path.join(".obsidian", "github-sync-metadata.json")
SNAPSHOT_NAME = ".hq-snapshot.json"


def _safe_rel(rel: str) -> str | None:
    rel = os.path.normpath(rel.strip().lstrip("/"))
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    return rel


def snapshot_info(vault_root: str) -> dict:
    path = os.path.join(os.path.dirname(os.path.abspath(vault_root)), SNAPSHOT_NAME)
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def local_file_observation(vault_root: str, rel: str) -> Observation:
    safe = _safe_rel(rel)
    subject = f"local HQ:{rel}"
    if safe is None:
        return Observation("local_vault", Scope.LOCAL_WORKING_COPY, "read_file", subject,
                           Outcome.DENIED, time.time(), detail="path outside the vault")
    if not os.path.isdir(vault_root):
        return Observation("local_vault", Scope.LOCAL_WORKING_COPY, "read_file", subject,
                           Outcome.UNAVAILABLE, None, detail="no local vault copy here")
    snap = snapshot_info(vault_root)
    # The local copy reflects remote state as of its snapshot, but as a
    # LOCAL observation it is fresh now (we just looked at the folder).
    exists = os.path.isfile(os.path.join(vault_root, safe))
    return Observation(
        "local_vault", Scope.LOCAL_WORKING_COPY, "read_file", subject,
        Outcome.FOUND if exists else Outcome.ABSENT, time.time(),
        detail=("copy taken " + snap["taken_at_iso"]) if snap.get("taken_at_iso")
        else "age of this local copy is unknown",
        data={"snapshot_commit": snap.get("commit"), "snapshot_taken_at": snap.get("taken_at")})


def sync_metadata_observation(vault_root: str, rel: str) -> Observation:
    safe = _safe_rel(rel) or rel
    subject = f"sync metadata:{rel}"
    path = os.path.join(vault_root, MANIFEST_REL)
    try:
        with open(path) as f:
            manifest = json.load(f)
    except FileNotFoundError:
        return Observation("sync_metadata", Scope.CLIENT_METADATA, "read_metadata", subject,
                           Outcome.INSUFFICIENT, None, detail="no sync metadata file in this copy")
    except (OSError, ValueError) as e:
        return Observation("sync_metadata", Scope.CLIENT_METADATA, "read_metadata", subject,
                           Outcome.ERROR, None, detail=f"unreadable: {type(e).__name__}")
    last_sync_ms = manifest.get("lastSync")
    observed = last_sync_ms / 1000 if isinstance(last_sync_ms, (int, float)) else None
    entry = (manifest.get("files") or {}).get(safe.replace(os.sep, "/"))
    if entry is None:
        outcome, detail = Outcome.ABSENT, "not listed in this copy's sync metadata"
    elif entry.get("deleted"):
        outcome, detail = Outcome.ABSENT, "listed as deleted in this copy's sync metadata"
    else:
        outcome, detail = Outcome.FOUND, "listed in this copy's sync metadata"
    return Observation("sync_metadata", Scope.CLIENT_METADATA, "read_metadata", subject,
                       outcome, observed, detail=detail, data={"entry": entry or {}})


def note_status(vault_root: str, rel: str, verifier=None, repo: str = "lalp070125/hq-vault",
                branch: str = "main", now: float | None = None, record=None) -> dict:
    """Answer 'where does this note exist?' per scope, without letting one
    scope stand in for another. Returns a JSON-able dict. `record`, if
    given, is called with each raw Observation (e.g. Ledger.record)."""
    now = now or time.time()
    local = local_file_observation(vault_root, rel)
    meta = sync_metadata_observation(vault_root, rel)
    if verifier is not None:
        remote = verifier.file_status(repo, branch, rel)
    else:
        remote = Observation("github_api", Scope.REMOTE_AUTHORITATIVE, "read_file",
                             f"{repo}@{branch}:{rel}", Outcome.UNAVAILABLE, None,
                             detail="no read-only GitHub check is configured in this session")
    obs = [local, meta, remote]
    if record is not None:
        for o in obs:
            record(o)
    remote_a = assess_presence(f"{repo}@{branch}:{rel}", Scope.REMOTE_AUTHORITATIVE, obs, now)
    local_a = assess_presence(f"local HQ:{rel}", Scope.LOCAL_WORKING_COPY, obs, now)
    phone_a = Assessment(f"phone/Obsidian:{rel}", Scope.OTHER_CLIENT, Presence.UNKNOWN.value,
                         partial=[o for o in obs if o.outcome in (Outcome.FOUND, Outcome.ABSENT)],
                         limitations=["the phone's vault can't be observed from here; GitHub "
                                      "having the file does not mean the phone has synced it"])
    if (local.outcome == Outcome.ABSENT and remote.outcome == Outcome.FOUND
            and remote.verification == Verification.VERIFIED):
        remote_a.limitations.append("this local copy is missing a file GitHub has: the local copy is stale")
    return {
        "note": rel,
        "github": remote_a.to_dict(now),
        "local_copy": local_a.to_dict(now),
        "phone": phone_a.to_dict(now),
        "summary": "\n".join(a.summary(now) for a in (remote_a, local_a, phone_a)),
    }
