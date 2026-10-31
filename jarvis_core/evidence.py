"""Evidence provenance and claim-support rules.

Every tool integration reports what it saw as an Observation: who looked
(source), when (observed_at), where the answer is authoritative (scope),
what was attempted (operation), what actually happened (outcome) and how
far that has been checked (verification). Conclusions are then derived by
`assess_presence` / `assess_action`, which only promote an observation to a
fact when its scope and freshness actually support it.

The rules this module enforces:
  * A local observation never establishes remote state. A remote
    observation never establishes another client's (e.g. a phone's) state.
  * Inability to check (denied, unavailable, timeout, error, insufficient)
    yields UNKNOWN, never success, failure or absence.
  * Cached / stale observations keep their original timestamp and are
    never silently treated as fresh.
  * An acknowledgment or a tool reporting success is not verification;
    VERIFIED needs an independent read-back.
  * Conflicting fresh authoritative observations yield CONFLICT.
Partial findings are always kept, labelled with their scope.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from enum import Enum


class Scope(str, Enum):
    """Where an observation is authoritative."""
    LOCAL_WORKING_COPY = "local_working_copy"   # files on this machine
    LOCAL_CACHE = "local_cache"                 # cached/remote-tracking copies of remote state
    CLIENT_METADATA = "client_metadata"         # a sync client's own bookkeeping file
    REMOTE_AUTHORITATIVE = "remote_authoritative"  # the source of truth, queried directly
    DEVICE_CLOUD = "device_cloud"               # a device's state as reported by its vendor cloud
    OTHER_CLIENT = "other_client"               # another device (phone) -- rarely observable


class Outcome(str, Enum):
    FOUND = "found"
    ABSENT = "absent"
    MATCH = "match"            # read-back equals what was requested
    MISMATCH = "mismatch"      # read-back differs from what was requested
    SUCCEEDED = "succeeded"    # the tool says the operation succeeded
    ACKNOWLEDGED = "acknowledged"  # request accepted / queued, outcome not known
    PENDING_APPROVAL = "pending_approval"
    FAILED = "failed"          # the operation itself was performed and failed
    DENIED = "denied"          # not allowed to check / act
    UNAVAILABLE = "unavailable"  # check path not configured or unreachable
    TIMEOUT = "timeout"
    ERROR = "error"
    INSUFFICIENT = "insufficient"  # ran, but the result can't answer the question


INABILITY = {Outcome.DENIED, Outcome.UNAVAILABLE, Outcome.TIMEOUT,
             Outcome.ERROR, Outcome.INSUFFICIENT}


class Verification(str, Enum):
    VERIFIED = "verified"        # independently confirmed by an authoritative read
    UNVERIFIED = "unverified"    # reported, not independently confirmed
    NOT_CHECKED = "not_checked"


class ActionStatus(str, Enum):
    REQUESTED = "requested"
    QUEUED = "queued"
    PENDING_APPROVAL = "pending_approval"
    ATTEMPTED = "attempted"
    COMPLETED = "completed"      # the tool reported success (unverified)
    VERIFIED = "verified"        # independent read-back confirms it
    FAILED = "failed"
    UNKNOWN = "unknown"


class Presence(str, Enum):
    PRESENT = "present"
    ABSENT = "absent"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"


# Default freshness per scope, in seconds. Integrations can override per
# observation via ttl_s. None = never fresh enough to stand in for a live read.
DEFAULT_TTL_S = {
    Scope.REMOTE_AUTHORITATIVE: 120,
    Scope.DEVICE_CLOUD: 30,
    Scope.LOCAL_WORKING_COPY: 300,
    Scope.LOCAL_CACHE: None,
    Scope.CLIENT_METADATA: None,
    Scope.OTHER_CLIENT: None,
}


@dataclass
class Observation:
    source: str                 # e.g. "github_api", "local_vault", "hubspace_cloud"
    scope: Scope
    operation: str              # e.g. "read_file", "set_light", "push"
    subject: str                # what was looked at, e.g. "lalp070125/hq-vault@main:Notes/a.md"
    outcome: Outcome
    observed_at: float | None   # epoch seconds the underlying state was read; None = unknown
    verification: Verification = Verification.NOT_CHECKED
    detail: str = ""
    data: dict = field(default_factory=dict)
    ttl_s: float | None = -1    # -1 = use DEFAULT_TTL_S for the scope
    cached: bool = False        # served from a cache rather than read just now

    def ttl(self) -> float | None:
        return DEFAULT_TTL_S.get(self.scope) if self.ttl_s == -1 else self.ttl_s

    def age_s(self, now: float | None = None) -> float | None:
        if self.observed_at is None:
            return None
        return max(0.0, (now or time.time()) - self.observed_at)

    def is_fresh(self, now: float | None = None) -> bool:
        ttl, age = self.ttl(), self.age_s(now)
        return ttl is not None and age is not None and age <= ttl

    def to_dict(self, now: float | None = None) -> dict:
        d = asdict(self)
        for k in ("scope", "outcome", "verification"):
            d[k] = d[k].value
        d["age_s"] = None if self.age_s(now) is None else round(self.age_s(now), 1)
        d["fresh"] = self.is_fresh(now)
        d.pop("ttl_s")
        return d

    def label(self, now: float | None = None) -> str:
        age = self.age_s(now)
        when = "time unknown" if age is None else f"{_human_age(age)} ago"
        tag = "cached, " if self.cached else ""
        return f"{self.source} [{self.scope.value}, {tag}{when}]: {self.outcome.value}"


def _human_age(seconds: float) -> str:
    if seconds < 90:
        return f"{int(seconds)}s"
    if seconds < 5400:
        return f"{int(seconds // 60)}m"
    if seconds < 172800:
        return f"{int(seconds // 3600)}h"
    return f"{int(seconds // 86400)}d"


@dataclass
class Assessment:
    subject: str
    question_scope: Scope
    conclusion: str               # Presence or ActionStatus value
    supported_by: list[Observation] = field(default_factory=list)
    partial: list[Observation] = field(default_factory=list)  # valid, but other scope / stale
    limitations: list[str] = field(default_factory=list)

    @property
    def verified(self) -> bool:
        return self.conclusion in (Presence.PRESENT.value, Presence.ABSENT.value,
                                   ActionStatus.VERIFIED.value) and bool(self.supported_by)

    def to_dict(self, now: float | None = None) -> dict:
        return {
            "subject": self.subject,
            "question_scope": self.question_scope.value,
            "conclusion": self.conclusion,
            "verified": self.verified,
            "supported_by": [o.to_dict(now) for o in self.supported_by],
            "partial_findings": [o.to_dict(now) for o in self.partial],
            "limitations": self.limitations,
        }

    def summary(self, now: float | None = None) -> str:
        lines = [f"{self.subject} @ {self.question_scope.value}: {self.conclusion.upper()}"
                 + ("" if self.verified else " (unverified)")]
        for o in self.supported_by:
            lines.append(f"  supported by {o.label(now)}")
        for o in self.partial:
            lines.append(f"  partial (does not decide this): {o.label(now)}")
        for lim in self.limitations:
            lines.append(f"  limitation: {lim}")
        return "\n".join(lines)


def assess_presence(subject: str, question_scope: Scope,
                    observations: list[Observation], now: float | None = None) -> Assessment:
    """Does `subject` exist at `question_scope`? Only fresh observations made
    AT that scope can decide it; everything else is kept as partial evidence."""
    now = now or time.time()
    a = Assessment(subject, question_scope, Presence.UNKNOWN.value)
    deciding: list[Observation] = []
    for o in observations:
        if o.scope != question_scope:
            a.partial.append(o)
            continue
        if o.outcome in INABILITY:
            a.partial.append(o)
            a.limitations.append(f"{o.source} could not check ({o.outcome.value}"
                                 + (f": {o.detail}" if o.detail else "") + ")")
            continue
        if o.outcome not in (Outcome.FOUND, Outcome.ABSENT):
            a.partial.append(o)
            continue
        if not o.is_fresh(now):
            a.partial.append(o)
            age = o.age_s(now)
            a.limitations.append(
                f"{o.source} result is stale"
                + (" (cached)" if o.cached else "")
                + (f", observed {_human_age(age)} ago" if age is not None else ", observation time unknown"))
            continue
        deciding.append(o)

    outcomes = {o.outcome for o in deciding}
    if len(outcomes) > 1:
        a.conclusion = Presence.CONFLICT.value
        a.partial.extend(deciding)
        a.limitations.append("fresh authoritative observations disagree: "
                             + "; ".join(o.label(now) for o in deciding))
    elif outcomes:
        a.conclusion = (Presence.PRESENT if Outcome.FOUND in outcomes else Presence.ABSENT).value
        a.supported_by = deciding
        # flag scoped observations that disagree with the authoritative answer
        want = Outcome.FOUND if a.conclusion == Presence.PRESENT.value else Outcome.ABSENT
        for o in a.partial:
            if o.outcome in (Outcome.FOUND, Outcome.ABSENT) and o.outcome != want:
                a.limitations.append(
                    f"{o.source} ({o.scope.value}) says {o.outcome.value}; that is a different "
                    f"scope and does not override {question_scope.value}")
    else:
        if not any("could not check" in lim or "stale" in lim for lim in a.limitations):
            a.limitations.append(f"no direct {question_scope.value} observation was made; "
                                 "other-scope findings cannot decide it")
    return a


def assess_action(subject: str, observations: list[Observation],
                  now: float | None = None, requested: bool = True) -> Assessment:
    """Status of an action. Ladder: requested < queued/pending < attempted <
    completed (tool says so) < verified (independent fresh read-back matches)."""
    now = now or time.time()
    a = Assessment(subject, Scope.REMOTE_AUTHORITATIVE,
                   ActionStatus.REQUESTED.value if requested else ActionStatus.UNKNOWN.value)
    status = ActionStatus.REQUESTED if requested else ActionStatus.UNKNOWN
    order = [ActionStatus.UNKNOWN, ActionStatus.REQUESTED, ActionStatus.QUEUED,
             ActionStatus.PENDING_APPROVAL, ActionStatus.ATTEMPTED, ActionStatus.COMPLETED,
             ActionStatus.VERIFIED]

    def bump(s: ActionStatus):
        nonlocal status
        if status == ActionStatus.FAILED:
            return
        if order.index(s) > order.index(status):
            status = s

    readbacks = [o for o in observations if o.operation.startswith("readback")]
    for o in observations:
        if o in readbacks:
            continue
        if o.outcome == Outcome.ACKNOWLEDGED:
            bump(ActionStatus.QUEUED)
            a.partial.append(o)
            a.limitations.append(f"{o.source} only acknowledged the request; that is not completion")
        elif o.outcome == Outcome.PENDING_APPROVAL:
            bump(ActionStatus.PENDING_APPROVAL)
            a.partial.append(o)
            a.limitations.append("waiting for approval; nothing has been done yet")
        elif o.outcome == Outcome.SUCCEEDED:
            bump(ActionStatus.COMPLETED)
            a.partial.append(o)
        elif o.outcome == Outcome.FAILED:
            status = ActionStatus.FAILED
            a.supported_by.append(o)
        elif o.outcome in INABILITY:
            bump(ActionStatus.ATTEMPTED)
            a.partial.append(o)
            a.limitations.append(f"{o.source}: {o.outcome.value}"
                                 + (f" ({o.detail})" if o.detail else "")
                                 + " -- outcome unknown, not treated as success or failure")
        else:
            a.partial.append(o)

    if status in (ActionStatus.COMPLETED, ActionStatus.ATTEMPTED):
        good = [o for o in readbacks if o.outcome == Outcome.MATCH and o.is_fresh(now)
                and o.scope in (Scope.REMOTE_AUTHORITATIVE, Scope.DEVICE_CLOUD)]
        bad = [o for o in readbacks if o.outcome == Outcome.MISMATCH and o.is_fresh(now)]
        if good and not bad:
            status = ActionStatus.VERIFIED
            a.supported_by.extend(good)
        else:
            for o in readbacks:
                a.partial.append(o)
                if o.outcome == Outcome.MISMATCH:
                    a.limitations.append(f"read-back from {o.source} does not match the request")
                elif o.outcome in INABILITY:
                    a.limitations.append(f"read-back unavailable ({o.outcome.value})")
                elif not o.is_fresh(now):
                    a.limitations.append(f"read-back from {o.source} is stale")
            if not readbacks:
                a.limitations.append("no independent read-back was done")
    a.conclusion = status.value
    if status == ActionStatus.UNKNOWN and not a.limitations:
        a.limitations.append("no observation of this action")
    return a
