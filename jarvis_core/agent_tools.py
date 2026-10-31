"""Expose the read-only verification checks to a Claude Agent SDK session.

`build_verify_server` returns an in-process MCP server (no subprocess, no
network listener) with two read-only tools. Every result is recorded in the
shared Ledger so the reply guard can check claims against it.

    vault_note_status(path)                 -> per-scope answer for an HQ note
    github_file_status(repo, branch, path)  -> one authoritative GitHub lookup

Neither tool can write anything: the verifier only issues GET requests to
allowlisted repos, and the vault reader only opens files for reading.
"""
from __future__ import annotations

import json

from .claims import Ledger
from .github_verify import GitHubVerifier
from .vault_status import note_status

SERVER_NAME = "verify"
TOOL_NAMES = [f"mcp__{SERVER_NAME}__vault_note_status", f"mcp__{SERVER_NAME}__github_file_status"]

EVIDENCE_RULES = (
    "STATUS CLAIMS NEED MATCHING EVIDENCE. A local file or the vault's sync "
    "metadata only tells you about this local copy; it never proves what is "
    "or isn't on GitHub, and GitHub never proves what your phone has synced. "
    "Before saying a note or commit is or isn't on GitHub, call "
    "vault_note_status or github_file_status and go by its github result. If "
    "that check is unavailable, denied, times out or errors, say the GitHub "
    "state is unknown and why; don't turn 'I couldn't check' into 'it isn't "
    "there'. Say which source each conclusion comes from, and keep useful "
    "local findings labelled as local. A request being sent or acknowledged "
    "is not the same as it being done; only say something is done when a "
    "tool confirmed it, and say 'verified' only after an independent check."
)


def build_verify_server(vault_root: str, ledger: Ledger, verifier: GitHubVerifier | None = None,
                        repo: str = "lalp070125/hq-vault", branch: str = "main"):
    from claude_agent_sdk import create_sdk_mcp_server
    return create_sdk_mcp_server(SERVER_NAME, tools=make_verify_tools(
        vault_root, ledger, verifier, repo, branch))


def make_verify_tools(vault_root: str, ledger: Ledger, verifier: GitHubVerifier | None = None,
                      repo: str = "lalp070125/hq-vault", branch: str = "main") -> list:
    from claude_agent_sdk import tool

    verifier = verifier or GitHubVerifier()

    def _reply(payload: dict) -> dict:
        return {"content": [{"type": "text", "text": json.dumps(payload, indent=1, default=str)}]}

    @tool("vault_note_status",
          "Where does an HQ vault note exist? Returns separate, evidence-labelled answers for "
          "GitHub (authoritative, checked live, read-only), this local copy, and the phone "
          "(not observable). Use this before claiming a note is or isn't pushed/created.",
          {"path": str})
    async def vault_note_status(args):
        rel = str(args.get("path", ""))
        return _reply(note_status(vault_root, rel, verifier, repo, branch, record=ledger.record))

    @tool("github_file_status",
          "Read-only check of whether a file exists on a branch of an allowlisted GitHub repo, "
          "right now. Returns found/absent with commit evidence, or why it couldn't check.",
          {"repo": str, "branch": str, "path": str})
    async def github_file_status(args):
        obs = ledger.record(verifier.file_status(str(args.get("repo", repo)),
                                                 str(args.get("branch", branch)),
                                                 str(args.get("path", ""))))
        return _reply(obs.to_dict())

    return [vault_note_status, github_file_status]
