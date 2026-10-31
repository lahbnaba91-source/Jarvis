"""Regression tests for evidence-backed status verification (jarvis_core/).

The incident these guard against: Jarvis looked at a local vault copy and its
sync metadata, didn't find a note, and said it had never been created or
pushed, though it was on GitHub. Local absence was treated as remote proof.

Each test checks two things: an unsupported claim ends up explicitly
unverified/unknown (or corrected), AND the valid scoped observations survive
as partial findings instead of being thrown away.
"""
import json
import socket
import subprocess
import time

import pytest

from jarvis_core.claims import ClaimGuard, Ledger
from jarvis_core.evidence import (
    ActionStatus,
    Observation,
    Outcome,
    Presence,
    Scope,
    Verification,
    assess_action,
    assess_presence,
)
from jarvis_core.github_verify import GitHubVerifier, remote_tracking_observation
from jarvis_core.vault_status import note_status, sync_metadata_observation

REPO = "lalp070125/hq-vault"
NOTE = "01 - Projects/Sesame.md"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

class FakeGitHub:
    """Stands in for api.github.com. routes: path-prefix -> (status, json) or Exception."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout):
        assert url.startswith("https://api.github.com/"), url
        assert "Authorization" in headers  # token is sent as a header, never in the URL
        path = url[len("https://api.github.com"):]
        self.calls.append(path)
        for prefix, result in self.routes.items():
            if path.startswith(prefix):
                if isinstance(result, Exception):
                    raise result
                status, body = result
                return status, {}, json.dumps(body).encode()
        return 404, {}, b'{"message": "Not Found"}'


def remote_has_note(head="abc1234def"):
    return FakeGitHub({
        f"/repos/{REPO}/branches/main": (200, {"commit": {"sha": head}}),
        f"/repos/{REPO}/contents/": (200, {"sha": "blob99", "size": 120}),
        f"/repos/{REPO}/commits": (200, [{"sha": head, "commit": {
            "committer": {"date": "2026-10-31T08:00:00Z"}, "message": "Add Sesame note"}}]),
    })


def remote_lacks_note(head="abc1234def"):
    return FakeGitHub({f"/repos/{REPO}/branches/main": (200, {"commit": {"sha": head}})})


def verifier(fetch, token="tok", **kw):
    return GitHubVerifier(token=token, allowed_repos=[REPO], fetch=fetch, **kw)


def make_vault(tmp_path, notes=(), manifest_files=None, write_manifest=True):
    vault = tmp_path / "HQ"
    vault.mkdir()
    for rel in notes:
        p = vault / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("# note\n")
    if write_manifest:
        (vault / ".obsidian").mkdir()
        (vault / ".obsidian" / "github-sync-metadata.json").write_text(json.dumps(
            {"lastSync": int((time.time() - 86400) * 1000), "files": manifest_files or {}}))
    return str(vault)


def snapshot_manifest(vault):
    with open(f"{vault}/.obsidian/github-sync-metadata.json", "rb") as f:
        return f.read()


INCIDENT_REPLY = "I checked the vault. That note was never created or pushed to GitHub."


# --------------------------------------------------------------------------
# 1. stale local checkout missing a file that exists remotely
# --------------------------------------------------------------------------

def test_stale_local_checkout_missing_file_that_exists_on_github(tmp_path):
    vault = make_vault(tmp_path)  # note NOT in the local copy
    before = snapshot_manifest(vault)
    ledger = Ledger()
    res = note_status(vault, NOTE, verifier(remote_has_note()), REPO, record=ledger.record)

    assert res["github"]["conclusion"] == Presence.PRESENT.value
    assert res["github"]["verified"] is True
    assert res["github"]["supported_by"][0]["source"] == "github_api"
    assert any("local copy is stale" in lim for lim in res["github"]["limitations"])
    # the local finding is kept, labelled local, not discarded
    assert res["local_copy"]["conclusion"] == Presence.ABSENT.value
    assert res["phone"]["conclusion"] == Presence.UNKNOWN.value

    guarded = ClaimGuard(ledger).check(INCIDENT_REPLY)
    assert guarded.flags[0]["status"] == "contradicted"
    assert "GitHub itself says the file is there" in guarded.text
    assert guarded.text.startswith("I checked the vault.")  # original reply preserved
    assert snapshot_manifest(vault) == before  # read-only: metadata untouched


# --------------------------------------------------------------------------
# 2. absent sync metadata despite remote existence
# --------------------------------------------------------------------------

@pytest.mark.parametrize("write_manifest", [True, False])
def test_absent_sync_metadata_does_not_decide_remote(tmp_path, write_manifest):
    vault = make_vault(tmp_path, notes=[NOTE], write_manifest=write_manifest)
    res = note_status(vault, NOTE, verifier(remote_has_note()), REPO)

    assert res["github"]["conclusion"] == Presence.PRESENT.value
    meta = [o for o in res["github"]["partial_findings"] if o["source"] == "sync_metadata"][0]
    assert meta["scope"] == Scope.CLIENT_METADATA.value
    assert meta["outcome"] in ("absent", "insufficient")
    if write_manifest:
        assert any("sync_metadata" in lim and "does not override" in lim
                   for lim in res["github"]["limitations"])


def test_sync_metadata_never_counts_as_remote_even_when_alone(tmp_path):
    vault = make_vault(tmp_path, manifest_files={})
    meta = sync_metadata_observation(vault, NOTE)
    a = assess_presence(NOTE, Scope.REMOTE_AUTHORITATIVE, [meta])
    assert a.conclusion == Presence.UNKNOWN.value
    assert a.partial == [meta]


# --------------------------------------------------------------------------
# 3. unavailable or denied verification
# --------------------------------------------------------------------------

@pytest.mark.parametrize("make,outcome", [
    (lambda: verifier(remote_has_note(), token=""), "unavailable"),          # no token
    (lambda: verifier(FakeGitHub({f"/repos/{REPO}/branches": (403, {})})), "denied"),
    (lambda: verifier(FakeGitHub({f"/repos/{REPO}/branches": (401, {})})), "denied"),
    (lambda: GitHubVerifier(token="t", allowed_repos=["someone/else"],
                            fetch=remote_has_note()), "denied"),                # not allowlisted
    (lambda: None, "unavailable"),                                            # no check configured
])
def test_unavailable_or_denied_verification_is_unknown_not_absent(tmp_path, make, outcome):
    vault = make_vault(tmp_path)  # local copy lacks the note
    ledger = Ledger()
    res = note_status(vault, NOTE, make(), REPO, record=ledger.record)

    gh = res["github"]
    assert gh["conclusion"] == Presence.UNKNOWN.value
    assert gh["verified"] is False
    assert any(o["outcome"] == outcome for o in gh["partial_findings"])
    assert any("could not check" in lim for lim in gh["limitations"])
    # the local absence is still reported, as a local finding
    assert res["local_copy"]["conclusion"] == Presence.ABSENT.value

    guarded = ClaimGuard(ledger).check(INCIDENT_REPLY)
    assert guarded.flags[0] == {"claim": "remote_absent", "status": "unverified"}
    assert "whether it's on GitHub is unverified" in guarded.text
    assert "the local copy" in guarded.text  # says what WAS checked...
    assert "the GitHub check" in guarded.text and "didn't give an answer" in guarded.text  # ...and what wasn't


def test_private_repo_404_is_insufficient_not_absent():
    v = verifier(FakeGitHub({}))  # branch lookup 404: repo hidden or missing
    obs = v.file_status(REPO, "main", NOTE)
    assert obs.outcome == Outcome.INSUFFICIENT
    assert assess_presence(NOTE, Scope.REMOTE_AUTHORITATIVE, [obs]).conclusion == "unknown"


# --------------------------------------------------------------------------
# 4. timeout / error
# --------------------------------------------------------------------------

@pytest.mark.parametrize("fetch,outcome", [
    (FakeGitHub({"/repos": socket.timeout()}), Outcome.TIMEOUT),
    (FakeGitHub({"/repos": TimeoutError()}), Outcome.TIMEOUT),
    (FakeGitHub({"/repos": ConnectionRefusedError()}), Outcome.UNAVAILABLE),
    (FakeGitHub({f"/repos/{REPO}/branches": (500, {})}), Outcome.ERROR),
    (FakeGitHub({f"/repos/{REPO}/branches": (429, {})}), Outcome.UNAVAILABLE),
    (FakeGitHub({f"/repos/{REPO}/branches/main": (200, {"commit": {"sha": "h"}}),
                 f"/repos/{REPO}/contents": socket.timeout()}), Outcome.TIMEOUT),
])
def test_timeout_and_errors_become_unknown(tmp_path, fetch, outcome):
    vault = make_vault(tmp_path, notes=[NOTE])
    obs = verifier(fetch).file_status(REPO, "main", NOTE)
    assert obs.outcome == outcome
    res = note_status(vault, NOTE, verifier(fetch), REPO)
    assert res["github"]["conclusion"] == Presence.UNKNOWN.value
    assert res["local_copy"]["conclusion"] == Presence.PRESENT.value  # partial finding kept


# --------------------------------------------------------------------------
# 5. conflicting local and remote evidence
# --------------------------------------------------------------------------

def test_local_present_remote_absent_goes_by_remote_and_flags_conflict(tmp_path):
    vault = make_vault(tmp_path, notes=[NOTE], manifest_files={NOTE: {"sha": "x", "deleted": False}})
    res = note_status(vault, NOTE, verifier(remote_lacks_note()), REPO)
    gh = res["github"]
    assert gh["conclusion"] == Presence.ABSENT.value and gh["verified"]
    assert any("local_vault" in lim and "does not override" in lim for lim in gh["limitations"])
    assert res["local_copy"]["conclusion"] == Presence.PRESENT.value


def test_two_fresh_authoritative_observations_that_disagree_are_a_conflict():
    now = time.time()
    a = Observation("github_api", Scope.REMOTE_AUTHORITATIVE, "read_file", NOTE, Outcome.FOUND, now - 5)
    b = Observation("github_api", Scope.REMOTE_AUTHORITATIVE, "read_file", NOTE, Outcome.ABSENT, now - 1)
    res = assess_presence(NOTE, Scope.REMOTE_AUTHORITATIVE, [a, b], now)
    assert res.conclusion == Presence.CONFLICT.value
    assert not res.verified and a in res.partial and b in res.partial


# --------------------------------------------------------------------------
# 6. stale cached results
# --------------------------------------------------------------------------

def test_cached_result_keeps_its_original_time_and_goes_stale():
    t = [1_000_000.0]
    fetch = remote_has_note()
    v = verifier(fetch, clock=lambda: t[0], cache_ttl_s=60)
    first = v.file_status(REPO, "main", NOTE)
    calls = len(fetch.calls)
    t[0] += 30
    second = v.file_status(REPO, "main", NOTE)
    assert len(fetch.calls) == calls  # served from cache...
    assert second.cached and second.observed_at == first.observed_at  # ...and labelled as such

    # used much later, the same observation no longer decides anything
    later = first.observed_at + 3600
    res = assess_presence(NOTE, Scope.REMOTE_AUTHORITATIVE, [second], now=later)
    assert res.conclusion == Presence.UNKNOWN.value
    assert any("stale (cached)" in lim for lim in res.limitations)

    # and after the cache window a fresh lookup really happens
    t[0] += 120
    third = v.file_status(REPO, "main", NOTE)
    assert not third.cached and len(fetch.calls) > calls


def test_stale_observation_is_not_used_by_the_claim_guard():
    old = Observation("github_api", Scope.REMOTE_AUTHORITATIVE, "read_file", NOTE, Outcome.ABSENT,
                      time.time() - 7200, Verification.VERIFIED)
    ledger = Ledger()
    ledger.record(old)
    res = ClaimGuard(ledger).check("It isn't on GitHub.")
    assert res.flags and res.flags[0]["status"] == "unverified"


def test_unfetched_remote_tracking_branch_is_local_cache_not_a_remote_lookup(tmp_path):
    def git(*a):
        subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True,
                       env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                            "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(tmp_path), "PATH": "/usr/bin:/bin"})
    git("init", "-q")
    git("commit", "-q", "--allow-empty", "-m", "x")
    git("update-ref", "refs/remotes/origin/main", "HEAD")  # a tracking ref, never fetched
    obs = remote_tracking_observation(str(tmp_path), "origin/main")
    assert obs.scope == Scope.LOCAL_CACHE and obs.outcome == Outcome.FOUND
    assert obs.observed_at is None and "never fetched" in obs.detail
    res = assess_presence("origin/main", Scope.REMOTE_AUTHORITATIVE, [obs])
    assert res.conclusion == Presence.UNKNOWN.value and res.partial == [obs]


# --------------------------------------------------------------------------
# 7. requested / queued / approval-pending mistaken for completed
# --------------------------------------------------------------------------

def _act(outcome, op="set_light:on"):
    return Observation("hubspace_cloud", Scope.DEVICE_CLOUD, op, "lamp", outcome, time.time())


@pytest.mark.parametrize("obs,expected", [
    ([], ActionStatus.REQUESTED),
    ([_act(Outcome.ACKNOWLEDGED)], ActionStatus.QUEUED),
    ([_act(Outcome.PENDING_APPROVAL)], ActionStatus.PENDING_APPROVAL),
    ([_act(Outcome.SUCCEEDED)], ActionStatus.COMPLETED),                      # no read-back
    ([_act(Outcome.SUCCEEDED), _act(Outcome.MISMATCH, "readback_get")], ActionStatus.COMPLETED),
    ([_act(Outcome.SUCCEEDED), _act(Outcome.MATCH, "readback_get")], ActionStatus.VERIFIED),
    ([_act(Outcome.TIMEOUT), _act(Outcome.MATCH, "readback_get")], ActionStatus.VERIFIED),
    ([_act(Outcome.TIMEOUT)], ActionStatus.ATTEMPTED),                        # unknown, not failed
    ([_act(Outcome.FAILED)], ActionStatus.FAILED),
])
def test_action_ladder(obs, expected):
    a = assess_action("lamp on", obs)
    assert a.conclusion == expected.value
    assert a.verified == (expected == ActionStatus.VERIFIED)


@pytest.mark.parametrize("outcome", [Outcome.ACKNOWLEDGED, Outcome.PENDING_APPROVAL, Outcome.SUCCEEDED])
def test_done_claim_without_verification_gets_a_caveat(outcome):
    ledger = Ledger()
    ledger.record_action(assess_action("lamp on", [_act(outcome)]))
    res = ClaimGuard(ledger).check("Done, I've turned the lamp on.")
    assert res.flags[0]["claim"] == "action_done"
    assert res.flags[0]["status"] in ("queued", "pending_approval", "completed")
    assert "To be clear, that's" in res.text


def test_verified_action_claim_is_left_alone():
    ledger = Ledger()
    ledger.record_action(assess_action("lamp on", [_act(Outcome.SUCCEEDED),
                                                   _act(Outcome.MATCH, "readback_get")]))
    res = ClaimGuard(ledger).check("Done, I've turned the lamp on.")
    assert res.flags == [] and res.text == "Done, I've turned the lamp on."


# --------------------------------------------------------------------------
# 8. unsupported success / failure claims
# --------------------------------------------------------------------------

@pytest.mark.parametrize("reply,claim,status", [
    ("Yep, it's on GitHub.", "remote_present", "unverified"),
    ("The note was pushed this morning.", "remote_present", "unverified"),
    ("The push failed.", "action_failed", "unknown"),
    ("It's synced to your phone now.", "phone_synced", "unknown"),
    ("That file doesn't exist on GitHub.", "remote_absent", "unverified"),
])
def test_unsupported_claims_are_flagged(reply, claim, status):
    res = ClaimGuard(Ledger()).check(reply)
    assert {"claim": claim, "status": status} in res.flags
    assert res.text.startswith(reply.rstrip("."))


def test_phone_sync_stays_unknown_even_when_github_has_it(tmp_path):
    ledger = Ledger()
    note_status(make_vault(tmp_path, notes=[NOTE]), NOTE, verifier(remote_has_note()), REPO,
                record=ledger.record)
    res = ClaimGuard(ledger).check("It's on GitHub and synced to your phone.")
    assert {"claim": "phone_synced", "status": "unknown"} in res.flags
    assert not any(f["claim"] == "remote_present" for f in res.flags)  # that part IS supported


def test_plain_answers_are_not_touched():
    for reply in ["You've got three meetings tomorrow.", "I couldn't check GitHub from here.",
                  "Your Sesame note talks about the MCP setup."]:
        assert ClaimGuard(Ledger()).check(reply).flags == []


# --------------------------------------------------------------------------
# beyond GitHub: the lamp adapter, the Sesame ask path, the vault push
# --------------------------------------------------------------------------

class FakeLamp:
    """Replaces server.hubspace(). script: list of (expected_args_prefix, result|Exception)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        want, result = self.script.pop(0)
        assert args[0] == want, (args, want)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def lamp(mcp_server_mod, monkeypatch):
    monkeypatch.setattr(mcp_server_mod, "LIGHT_MIN_INTERVAL_S", 0)

    def install(script):
        fake = FakeLamp(script)
        monkeypatch.setattr(mcp_server_mod, "hubspace", fake)
        return fake
    return install


def test_lamp_color_verified_by_readback(mcp_server_mod, lamp):
    lamp([("set", {"name": "Lamp", "on": True, "color": [0, 0, 255], "brightness": 30}),
          ("get", {"name": "Lamp", "on": True, "r": 0, "g": 0, "b": 255, "brightness": 30})])
    text, err, meta = mcp_server_mod.run_light("color", "blue", 30)
    assert meta["conclusion"] == "verified" and not err
    assert "Confirmed with a fresh read" in text


def test_lamp_success_reply_but_readback_disagrees_is_not_verified(mcp_server_mod, lamp):
    lamp([("set", {"name": "Lamp", "on": True}),
          ("get", {"name": "Lamp", "on": True, "r": 255, "g": 0, "b": 0, "brightness": 100})])
    text, err, meta = mcp_server_mod.run_light("color", "blue", 30)
    assert meta["conclusion"] == "completed"
    assert "isn't confirmed" in text and "does not match" in text


def test_lamp_timeout_then_matching_readback_is_verified(mcp_server_mod, lamp):
    lamp([("white", subprocess.TimeoutExpired("hubspace", 15)),
          ("get", {"name": "Lamp", "on": True, "color_mode": "white", "brightness": 100})])
    text, err, meta = mcp_server_mod.run_light("on", None, 100)
    assert meta["conclusion"] == "verified"


def test_lamp_timeout_and_no_readback_is_unknown_not_failed(mcp_server_mod, lamp):
    lamp([("white", subprocess.TimeoutExpired("hubspace", 15)),
          ("get", subprocess.TimeoutExpired("hubspace", 15))])
    text, err, meta = mcp_server_mod.run_light("on", None, 100)
    assert meta["conclusion"] == "attempted" and err
    assert "result is unknown" in text and "failed" not in text


def test_lamp_off_does_not_act_when_state_cannot_be_read(mcp_server_mod, lamp):
    fake = lamp([("status", {"error": "no cached session"})])
    text, err, meta = mcp_server_mod.run_light("off", None, 100)
    assert err and "didn't change it" in text and "unknown" in text
    assert fake.calls == [("status",)]  # no toggle was sent blind


def test_lamp_tool_result_carries_evidence(mcp_server_mod, lamp, monkeypatch):
    monkeypatch.setattr(mcp_server_mod, "lights_available", lambda: True)
    lamp([("status", {"name": "Lamp", "on": True}), ("toggle", {"name": "Lamp", "on": False}),
          ("get", {"name": "Lamp", "on": False})])
    out = mcp_server_mod.call_tool(1, {"name": "control_light", "arguments": {"action": "off"}})
    res = out["result"]
    assert res["content"][0]["text"].startswith("Lamp is now off")  # clients reading text still work
    sc = res["structuredContent"]
    assert sc["conclusion"] == "verified"
    assert sc["supported_by"][0]["source"] == "hubspace_cloud"
    assert sc["supported_by"][0]["scope"] == "device_cloud"


def test_sesame_ask_path_applies_the_guard(mcp_server_mod):
    # echo mode repeats the message, so the "reply" contains an unsupported claim
    out = mcp_server_mod.call_tool(1, {"name": "ask_jarvis", "arguments": {
        "message": "the Sesame note was never pushed to GitHub"}})
    res = out["result"]
    assert "unverified" in res["content"][0]["text"]
    assert res["structuredContent"]["unverified_claims"][0]["claim"] == "remote_absent"


def test_agent_tool_records_evidence_for_the_guard(tmp_path):
    sdk = pytest.importorskip("claude_agent_sdk")
    import asyncio

    from jarvis_core.agent_tools import make_verify_tools
    ledger = Ledger()
    tools = make_verify_tools(make_vault(tmp_path), ledger, verifier(remote_has_note()))
    assert all(isinstance(t, sdk.SdkMcpTool) for t in tools)
    out = asyncio.run(tools[0].handler({"path": NOTE}))
    assert json.loads(out["content"][0]["text"])["github"]["conclusion"] == "present"
    assert {o.scope for o in ledger.observations} == {
        Scope.LOCAL_WORKING_COPY, Scope.CLIENT_METADATA, Scope.REMOTE_AUTHORITATIVE}


def test_push_report_distinguishes_completed_from_verified(push_mod):
    head = "f" * 40
    ok = verifier(FakeGitHub({f"/repos/{REPO}/branches/main": (200, {"commit": {"sha": head}})}))
    assert push_mod.report_push(head, ok).startswith("Push VERIFIED")
    moved = verifier(FakeGitHub({f"/repos/{REPO}/branches/main": (200, {"commit": {"sha": "e" * 40}})}))
    assert "NOT verified" in push_mod.report_push(head, moved)
    down = verifier(FakeGitHub({"/repos": socket.timeout()}))
    msg = push_mod.report_push(head, down)
    assert "unverified" in msg and "timeout" in msg
    assert all("phone" in m for m in (msg, push_mod.report_push(head, ok)))
