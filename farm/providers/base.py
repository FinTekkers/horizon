"""Shared contract for agent providers (HZ-83).

Both farm/agent_runner.py (the dispatcher) and each farm/providers/*.py
module (the implementations) import from here — never from each other.
That's what keeps providers/claude.py's recursive stale-session retry from
becoming a circular import: it recurses into its own run(), not back
through agent_runner.
"""

import json
import os
import re
import threading
from datetime import datetime, timezone
from typing import Protocol


class AgentError(RuntimeError):
    pass


class AgentExhaustedError(AgentError):
    """A provider ran out of its turn/time budget (Claude's error_max_turns,
    a subprocess/asyncio timeout, Muse's --max-model-steps analogue). The one
    typed signal every provider raises for exhaustion, so callers like
    step_agent's checkpoint salvage (HZ-31) can tell it apart from any other
    failure without knowing which provider ran.

    Why the distinction earns a type: the orchestrator auto-retries THIS
    cause, up to its own hard cap, and no other (HZ-76). Callers must be able
    to ask "ran out of budget?" without parsing a message string.

    HZ-158: it also carries what the exhausted run left behind, so step_agent
    can salvage a reply cut off mid-string and ask the session for a handoff
    note instead of discarding a long run's work:

    * partial_text — the last reply text seen before the budget ran out, or
      None when the provider saw none (e.g. a timeout before any output).
    * session_id — the session that ran out, or None when it never reported
      one. Set by the provider.
    * provider — the provider name that ran. Set by agent_runner.run_agent(),
      the dispatcher, never by a provider module.

    Can a session that ended error_max_turns be resumed?

    * Claude: yes. The Agent SDK sessions docs
      (https://code.claude.com/docs/en/agent-sdk/sessions, "Resume by ID")
      list "Recover from a limit. The first run ended with error_max_turns
      ... resume with a higher limit" as a supported use of
      `resume=<session_id>`; the transcript is written to disk as the run
      goes, and the session id is on every result, error or not. The CLI's
      `--resume <id>` is the same mechanism. There is no docs/providers/ page
      for Claude to cite, so this docstring is the record.
    * Muse: no (unverified, treated as no). docs/providers/muse-code.md
      verifies `exec --session-id` continuity between COMPLETED runs only, and
      lists how exhaustion is reported as still unverified — no exhausting run
      was observed. Each provider module states its answer as
      RESUMES_AFTER_EXHAUSTION; on False the handoff falls back to a note
      built mechanically from partial_text, with no model call."""

    def __init__(self, msg: str, *, partial_text: str | None = None, session_id: str | None = None) -> None:
        super().__init__(msg)
        self.partial_text = partial_text
        self.session_id = session_id
        self.provider: str | None = None


class AgentMessageTooLargeError(AgentError):
    """HZ-424: one SDK message was bigger than the SDK reader's buffer (see
    providers/claude.py's sdk_max_buffer_bytes). Its message is one line that
    names the limit, never the message itself; step_agent tags it with the
    retryable SDK_MESSAGE_TOO_LARGE reason. Not an AgentExhaustedError: no
    budget ran out, so there is nothing to salvage or hand off. Only the
    Claude SDK path raises it."""


class AgentUsageLimitedError(AgentError):
    """HZ-422: the provider refused the run because a usage limit is spent — a
    subscription window, a quota or a rate limit. step_agent tags it with the
    retryable USAGE_LIMITED reason, and the server re-runs the step on the next
    model in domain/providers.json's fallbackChain without using an attempt.

    * reset_at — when the limit lifts, as an ISO-8601 UTC string, or None when
      the provider gave no time this module could parse. Set by the provider.
    * provider, model — what ran into the limit. Set by agent_runner.run_agent(),
      the dispatcher, never by a provider module."""

    def __init__(self, msg: str, *, reset_at: str | None = None) -> None:
        super().__init__(msg)
        self.reset_at = reset_at
        self.provider: str | None = None
        self.model: str | None = None


def iso_utc(moment: datetime) -> str:
    """A reset time as the ISO-8601 UTC string AgentUsageLimitedError carries.
    A naive time is taken as UTC already."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# "resets at 2026-10-12T14:00:00Z", "resets 2026-10-12 14:00 +02:00", ...
_RESET_ISO_RE = re.compile(
    r"resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?)",
    re.IGNORECASE,
)


def reset_from_text(text: str) -> str | None:
    """The ISO-8601 reset time a limit message names after "resets (at)", as
    UTC, or None when it names none this can parse — a clock time with no
    date ("resets 3pm") included, since its day is a guess."""
    match = _RESET_ISO_RE.search(text or "")
    if not match:
        return None
    raw = match.group(1).replace(" Z", "Z")
    raw = re.sub(r"\s([+-]\d)", r"\1", raw)
    try:
        return iso_utc(datetime.fromisoformat(raw))
    except ValueError:
        return None


def decode_partial(output: bytes | str | None) -> str | None:
    """The text a subprocess.TimeoutExpired captured, or None. Its .stdout is
    bytes even under text=True, per the subprocess docs."""
    if output is None:
        return None
    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else output
    return text or None


def brief(tool_input) -> str:
    """A tool call's input as one log-line fragment: JSON, cut to 160 chars.
    Claude's and Muse's farm log lines both use it (HZ-489)."""
    try:
        text = json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(tool_input)
    return text if len(text) <= 160 else text[:157] + "…"


class AgentProvider(Protocol):
    """Typing-only shape check — no abc, matches this package's plain-module
    style. A provider is a module, not a class instance."""

    SUPPORTS_RESUME: bool
    # HZ-158: whether a session that ran out of budget can be resumed — the
    # docs answer in AgentExhaustedError's docstring, one flag per provider.
    RESUMES_AFTER_EXHAUSTION: bool

    def run(
        self,
        prompt: str,
        *,
        session_id: str | None,
        append_system: str | None,
        cwd: str | None,
        model: str | None,
        max_turns: int,
        timeout_s: int,
        allowed_tools: str | None,
        retry_fresh: bool = True,
    ) -> dict: ...

    def assert_subscription_auth(self) -> None: ...


# ---- metered billing gate (HZ-5 guarantee, extended by HZ-83) ----
# Every provider must assert subscription-style auth and refuse metered
# billing unless explicitly opted in AND an enforced spend cap backs it up.
# The opt-in var alone must never be enough — that's the concrete guardrail
# this module exists to satisfy in code, not a comment.


class _SpendTracker:
    """In-process, conservative spend counter for a metered-billing opt-in
    run. None of the providers expose a real per-call USD cost (Claude's SDK
    result and Muse's JSONL events carry no cost field), so this charges a
    flat, deliberately pessimistic estimate per call rather than ever
    under-counting spend. Resets with the process — same lifetime as one
    agent_runner invocation. step_agent runs items concurrently in threads,
    so charge() takes a lock around the check-then-add — otherwise two
    concurrent metered calls could both read spent_usd before either
    updates it, letting total spend exceed the cap."""

    def __init__(self) -> None:
        self.spent_usd = 0.0
        self._lock = threading.Lock()

    def charge(self, estimate_usd: float, cap_usd: float) -> None:
        with self._lock:
            if self.spent_usd + estimate_usd > cap_usd:
                raise AgentError(
                    f"metered billing spend cap would be exceeded: "
                    f"{self.spent_usd:.2f} + {estimate_usd:.2f} > cap {cap_usd:.2f} USD "
                    "(FARM_METERED_SPEND_CAP_USD) — refusing this call"
                )
            self.spent_usd += estimate_usd


_METERED_SPEND_TRACKER = _SpendTracker()

# Conservative flat per-call estimate backing the tracker below — override
# only for testing; there is no real per-call cost signal to read instead.
_METERED_CALL_ESTIMATE_USD = float(os.environ.get("FARM_METERED_CALL_ESTIMATE_USD", "1.00"))


def metered_billing_opted_in() -> bool:
    return os.environ.get("FARM_ALLOW_METERED_BILLING", "0").strip().lower() in ("1", "true", "yes")


def assert_metered_billing_authorized(provider_name: str) -> None:
    """Call this from a provider's assert_subscription_auth() the moment it
    detects a metered credential is in play. Raises AgentError unless BOTH
    FARM_ALLOW_METERED_BILLING is set AND FARM_METERED_SPEND_CAP_USD is a
    positive number — and even then, the call is charged against a real
    in-process tracker that refuses once the cap would be exceeded, so the
    opt-in env var by itself can never bypass spend enforcement."""
    if not metered_billing_opted_in():
        raise AgentError(
            f"{provider_name}: metered billing credential detected but FARM_ALLOW_METERED_BILLING "
            "is not set — the farm runs on subscription auth only unless explicitly opted in (HZ-5)"
        )
    cap_raw = os.environ.get("FARM_METERED_SPEND_CAP_USD", "").strip()
    try:
        cap_usd = float(cap_raw)
    except ValueError:
        cap_usd = 0.0
    if cap_usd <= 0:
        raise AgentError(
            f"{provider_name}: FARM_ALLOW_METERED_BILLING is set but FARM_METERED_SPEND_CAP_USD is not "
            "a positive number — metered billing requires an enforced cap, not just the opt-in var"
        )
    _METERED_SPEND_TRACKER.charge(_METERED_CALL_ESTIMATE_USD, cap_usd)
