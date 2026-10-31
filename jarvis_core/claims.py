"""Turn ledger + reply guard: flag status claims the turn's evidence doesn't support.

The ledger collects every Observation and Assessment produced by Jarvis's
own adapters during a turn. After the model writes its reply, ClaimGuard
scans it for status claims (remote presence/absence, phone sync, an action
being done or having failed) and checks each against the ledger:

  supported     -> left alone
  unsupported   -> the reply is kept, and a plain-spoken caveat is appended
                   saying that state is unverified and why
  contradicted  -> a caveat states what the evidence actually shows

LIMITS (read before trusting it): detection is pattern-based English, so a
claim phrased in an unexpected way can slip through, and an innocent
sentence can occasionally get a caveat. It only sees evidence from
Jarvis's adapters, not from generic file reads. It reduces, not eliminates,
unsupported claims; the agent instructions carry the rest.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from .evidence import INABILITY, ActionStatus, Assessment, Observation, Outcome, Scope, Verification


class Ledger:
    def __init__(self):
        self.observations: list[Observation] = []
        self.actions: list[Assessment] = []

    def record(self, obs: Observation) -> Observation:
        self.observations.append(obs)
        return obs

    def record_action(self, a: Assessment) -> Assessment:
        self.actions.append(a)
        return a

    def reset(self):
        self.observations.clear()
        self.actions.clear()

    def to_dict(self, now: float | None = None) -> dict:
        return {"observations": [o.to_dict(now) for o in self.observations],
                "actions": [a.to_dict(now) for a in self.actions]}


_REMOTE = r"(github|the remote|remote repo|the repo(?:sitory)?|origin|hq-vault)"
_PATTERNS = {
    # "never created or pushed", "not on GitHub", "doesn't exist in the repo", "was never committed"
    "remote_absent": re.compile(
        r"\b(never (been )?(created|pushed|committed|uploaded|synced)"
        r"|(was|were|has|have)(n'?t| not| never)( been)? (pushed|committed|uploaded)"
        r"|(is|are)(n'?t| not) (on|in) " + _REMOTE +
        r"|(does|do)(n'?t| not) exist (on|in) " + _REMOTE +
        r"|missing from " + _REMOTE + r")", re.I),
    # "it's on GitHub", "was pushed", "committed to the repo", "exists on GitHub"
    "remote_present": re.compile(
        r"\b((it'?s|it is|is|are|they'?re) (now )?(on|in) " + _REMOTE +
        r"|(was|were|has been|have been|got) (successfully )?(pushed|committed|uploaded)"
        r"|exists? (on|in) " + _REMOTE + r")", re.I),
    "phone_synced": re.compile(
        r"\b(synced|syncing|showing|show up|available|is) (to|on|in) (your |the )?(phone|obsidian|mobile)"
        r"|(phone|obsidian) (has|have) (it|synced)", re.I),
    "action_done": re.compile(
        r"\b(i'?ve|i have|i just|done[,.]? i) (turned|switched|set|changed|pushed|sent|created|saved|updated|made)"
        r"|\b(it'?s|that'?s|all) done\b"
        r"|\b(the )?(lamp|light)('s| is) now (on|off|red|orange|yellow|green|cyan|blue|purple|pink)", re.I),
    "action_failed": re.compile(
        r"\b(the )?(push|commit|lamp|light|request|change) (failed|didn'?t (go through|work|change))\b", re.I),
}

_CAVEATS = {
    "remote_absent": "One caveat: I haven't confirmed that against GitHub itself, so whether it's on GitHub is unverified. What I checked was {scopes}.",
    "remote_present": "One caveat: I haven't confirmed that against GitHub itself, so it's unverified.",
    "remote_contradicted": "Correction: GitHub itself says {actual}, so go by that.",
    "phone_synced": "I can't see your phone from here, so whether it's synced there is unknown, even if GitHub has it.",
    "action_unverified": "To be clear, that's {status}: {why}.",
    "action_failed": "I don't actually have evidence it failed; the result is unknown.",
}


@dataclass
class GuardResult:
    text: str
    flags: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"unverified_claims": self.flags}


class ClaimGuard:
    def __init__(self, ledger: Ledger, now: float | None = None):
        self.ledger = ledger
        self.now = now

    def _remote(self) -> list[Observation]:
        now = self.now or time.time()
        return [o for o in self.ledger.observations
                if o.scope == Scope.REMOTE_AUTHORITATIVE and o.outcome in (Outcome.FOUND, Outcome.ABSENT)
                and o.verification == Verification.VERIFIED and o.is_fresh(now)]

    _SPOKEN = {Scope.LOCAL_WORKING_COPY: "the local copy", Scope.CLIENT_METADATA: "the sync metadata",
               Scope.LOCAL_CACHE: "a cached copy", Scope.REMOTE_AUTHORITATIVE: "GitHub",
               Scope.DEVICE_CLOUD: "the device's cloud", Scope.OTHER_CLIENT: "another device"}

    def _scopes_checked(self) -> str:
        """Spoken summary of what was actually observed, and which checks failed."""
        seen, failed = [], []
        for o in self.ledger.observations:
            name = self._SPOKEN.get(o.scope, o.scope.value)
            if o.outcome in INABILITY:
                entry = f"the {name} check ({o.outcome.value})" if o.scope == Scope.REMOTE_AUTHORITATIVE \
                    else f"{name} ({o.outcome.value})"
                if entry not in failed:
                    failed.append(entry)
            elif name not in seen:
                seen.append(name)
        out = " and ".join(seen) if seen else "nothing outside this conversation"
        if failed:
            out += "; " + ", ".join(failed) + " didn't give an answer"
        return out

    def check(self, reply: str) -> GuardResult:
        found = {k for k, p in _PATTERNS.items() if p.search(reply or "")}
        flags: list[dict] = []
        caveats: list[str] = []
        remote = self._remote()
        remote_outcomes = {o.outcome for o in remote}

        def flag(kind, caveat, **extra):
            flags.append({"claim": kind, **extra})
            if caveat not in caveats:
                caveats.append(caveat)

        if "remote_absent" in found:
            if Outcome.FOUND in remote_outcomes:
                flag("remote_absent", _CAVEATS["remote_contradicted"].format(
                    actual="the file is there"), status="contradicted")
            elif Outcome.ABSENT not in remote_outcomes:
                flag("remote_absent", _CAVEATS["remote_absent"].format(scopes=self._scopes_checked()),
                     status="unverified")
        if "remote_present" in found and "remote_absent" not in found:
            if Outcome.ABSENT in remote_outcomes and Outcome.FOUND not in remote_outcomes:
                flag("remote_present", _CAVEATS["remote_contradicted"].format(
                    actual="the file isn't there"), status="contradicted")
            elif Outcome.FOUND not in remote_outcomes:
                flag("remote_present", _CAVEATS["remote_present"], status="unverified")
        if "phone_synced" in found:
            flag("phone_synced", _CAVEATS["phone_synced"], status="unknown")

        if "action_done" in found:
            verified = [a for a in self.ledger.actions if a.conclusion == ActionStatus.VERIFIED.value]
            if not verified:
                best = self.ledger.actions[-1] if self.ledger.actions else None
                status = best.conclusion.replace("_", " ") if best else "not confirmed"
                why = (best.limitations[0] if best and best.limitations
                       else "there's no record of the action completing this turn")
                flag("action_done", _CAVEATS["action_unverified"].format(status=status, why=why),
                     status=best.conclusion if best else "unknown")
        if "action_failed" in found:
            failed = [a for a in self.ledger.actions if a.conclusion == ActionStatus.FAILED.value]
            if not failed:
                flag("action_failed", _CAVEATS["action_failed"], status="unknown")

        text = reply or ""
        if caveats:
            text = text.rstrip() + ("" if text.rstrip().endswith((".", "!", "?")) or not text else ".") \
                + " " + " ".join(caveats)
        return GuardResult(text.strip(), flags)
