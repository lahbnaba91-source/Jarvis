"""Read-only, allowlisted GitHub verification that returns Observations.

Least privilege by construction:
  * only GET requests, only to api.github.com
  * only repositories in the allowlist (env JARVIS_VERIFY_REPOS, comma
    separated owner/repo; defaults to the HQ vault repo)
  * token comes from the environment (HQVAULT_TOKEN by default); a
    fine-grained token with Contents: Read-only is enough
  * no git, no shell, nothing that writes

A cached answer is returned with cached=True and its ORIGINAL observed_at,
so callers can't mistake it for a fresh lookup. `remote_tracking_observation`
reads a local refs/remotes/* ref and labels it LOCAL_CACHE: an unfetched
remote-tracking branch is a memory of the remote, not a lookup of it.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

from .evidence import Observation, Outcome, Scope, Verification

API = "https://api.github.com"
DEFAULT_REPOS = "lalp070125/hq-vault"

# (status, headers, body_bytes) <- fetch(url, headers, timeout)
Fetch = Callable[[str, dict, float], tuple[int, dict, bytes]]


def _urllib_fetch(url: str, headers: dict, timeout: float) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read() if e.fp else b""


class GitHubVerifier:
    def __init__(self, token: str | None = None, allowed_repos: list[str] | None = None,
                 timeout: float = 8.0, fetch: Fetch | None = None,
                 cache_ttl_s: float = 60.0, clock: Callable[[], float] = time.time):
        self.token = token if token is not None else os.environ.get("HQVAULT_TOKEN", "")
        repos = allowed_repos if allowed_repos is not None else \
            os.environ.get("JARVIS_VERIFY_REPOS", DEFAULT_REPOS).split(",")
        self.allowed = {r.strip().lower() for r in repos if r.strip()}
        self.timeout = timeout
        self.fetch = fetch or _urllib_fetch
        self.cache_ttl_s = cache_ttl_s
        self.clock = clock
        self._cache: dict[str, Observation] = {}

    # ---- plumbing
    def _get(self, path: str) -> tuple[int, dict | list | None, str]:
        """Returns (status, json, error_kind). status 0 = transport failure."""
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "jarvis-verify",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            status, _h, body = self.fetch(API + path, headers, self.timeout)
        except (TimeoutError, socket.timeout):
            return 0, None, "timeout"
        except urllib.error.URLError as e:
            kind = "timeout" if isinstance(getattr(e, "reason", None), (TimeoutError, socket.timeout)) \
                else "unavailable"
            return 0, None, kind
        except OSError:
            return 0, None, "unavailable"
        try:
            data = json.loads(body or b"null")
        except ValueError:
            data = None
        return status, data, ""

    def _obs(self, subject, operation, outcome, detail="", data=None,
             verification=Verification.NOT_CHECKED, observed_at=None) -> Observation:
        return Observation(
            source="github_api", scope=Scope.REMOTE_AUTHORITATIVE, operation=operation,
            subject=subject, outcome=outcome,
            observed_at=self.clock() if observed_at is None else observed_at,
            verification=verification, detail=detail, data=data or {})

    def _fail(self, subject, operation, status, kind) -> Observation:
        if kind == "timeout":
            return self._obs(subject, operation, Outcome.TIMEOUT, f"no answer within {self.timeout:g}s")
        if kind:
            return self._obs(subject, operation, Outcome.UNAVAILABLE, "GitHub API unreachable")
        if status in (401, 403):
            return self._obs(subject, operation, Outcome.DENIED,
                             f"HTTP {status}: token missing, expired or lacks read access")
        if status == 429:
            return self._obs(subject, operation, Outcome.UNAVAILABLE, "rate limited (HTTP 429)")
        return self._obs(subject, operation, Outcome.ERROR, f"HTTP {status}")

    # ---- public
    def file_status(self, repo: str, branch: str, path: str, use_cache: bool = True) -> Observation:
        """Is `path` present on `branch` of `repo` right now, per GitHub?"""
        path = path.strip().lstrip("/")
        subject = f"{repo}@{branch}:{path}"
        op = "read_file"
        if repo.strip().lower() not in self.allowed:
            return self._obs(subject, op, Outcome.DENIED,
                             f"{repo} is not in the read-only verification allowlist")
        if not self.token:
            return self._obs(subject, op, Outcome.UNAVAILABLE,
                             "no GitHub read token configured (HQVAULT_TOKEN)")
        if use_cache and subject in self._cache:
            hit = self._cache[subject]
            if self.clock() - (hit.observed_at or 0) <= self.cache_ttl_s:
                return Observation(**{**hit.__dict__, "cached": True})

        q = urllib.parse.quote
        status, branch_json, kind = self._get(f"/repos/{repo}/branches/{q(branch, safe='')}")
        if status != 200:
            if status == 404 and not kind:
                # repo or branch missing, or no access (GitHub hides private repos as 404)
                return self._obs(subject, op, Outcome.INSUFFICIENT,
                                 "repository or branch not found, or the token can't see it")
            return self._fail(subject, op, status, kind)
        head = ((branch_json or {}).get("commit") or {}).get("sha", "")

        status, content, kind = self._get(
            f"/repos/{repo}/contents/{q(path)}?ref={q(head or branch, safe='')}")
        if status == 200 and isinstance(content, dict):
            last = self._last_commit(repo, head or branch, path)
            obs = self._obs(subject, op, Outcome.FOUND, verification=Verification.VERIFIED,
                            data={"branch_head": head, "blob_sha": content.get("sha"),
                                  "size": content.get("size"), **last})
        elif status == 200:
            obs = self._obs(subject, op, Outcome.INSUFFICIENT, "path is a directory",
                            data={"branch_head": head})
        elif status == 404 and not kind:
            obs = self._obs(subject, op, Outcome.ABSENT, verification=Verification.VERIFIED,
                            detail=f"not present at branch head {head[:7]}",
                            data={"branch_head": head})
        else:
            return self._fail(subject, op, status, kind)
        self._cache[subject] = obs
        return obs

    def _last_commit(self, repo: str, ref: str, path: str) -> dict:
        q = urllib.parse.quote
        status, data, _ = self._get(
            f"/repos/{repo}/commits?sha={q(ref, safe='')}&path={q(path)}&per_page=1")
        if status == 200 and isinstance(data, list) and data:
            c = data[0]
            return {"last_commit": c.get("sha"),
                    "last_commit_date": ((c.get("commit") or {}).get("committer") or {}).get("date"),
                    "last_commit_message": ((c.get("commit") or {}).get("message") or "")[:120]}
        return {}

    def branch_head(self, repo: str, branch: str) -> Observation:
        subject = f"{repo}@{branch}"
        if repo.strip().lower() not in self.allowed:
            return self._obs(subject, "read_branch", Outcome.DENIED, "not in allowlist")
        if not self.token:
            return self._obs(subject, "read_branch", Outcome.UNAVAILABLE, "no read token")
        status, data, kind = self._get(f"/repos/{repo}/branches/{urllib.parse.quote(branch, safe='')}")
        if status == 200:
            return self._obs(subject, "read_branch", Outcome.FOUND, verification=Verification.VERIFIED,
                             data={"sha": ((data or {}).get("commit") or {}).get("sha")})
        if status == 404 and not kind:
            return self._obs(subject, "read_branch", Outcome.INSUFFICIENT, "branch not found or not visible")
        return self._fail(subject, "read_branch", status, kind)


def remote_tracking_observation(repo_dir: str, ref: str = "origin/main") -> Observation:
    """What a local remote-tracking ref says. Always LOCAL_CACHE scope, timed
    by the last fetch -- never a substitute for a live remote lookup."""
    subject = f"{repo_dir}:{ref}"
    try:
        out = subprocess.run(["git", "rev-parse", "--verify", "-q", f"refs/remotes/{ref}"],
                             cwd=repo_dir, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as e:
        return Observation("git_remote_tracking", Scope.LOCAL_CACHE, "read_ref", subject,
                           Outcome.ERROR, None, detail=type(e).__name__)
    fetch_head = os.path.join(repo_dir, ".git", "FETCH_HEAD")
    fetched_at = os.path.getmtime(fetch_head) if os.path.exists(fetch_head) else None
    if out.returncode != 0:
        return Observation("git_remote_tracking", Scope.LOCAL_CACHE, "read_ref", subject,
                           Outcome.ABSENT, fetched_at, detail="ref not present locally")
    return Observation("git_remote_tracking", Scope.LOCAL_CACHE, "read_ref", subject,
                       Outcome.FOUND, fetched_at,
                       detail="as of last fetch" if fetched_at else "never fetched (time unknown)",
                       data={"sha": out.stdout.strip()})
