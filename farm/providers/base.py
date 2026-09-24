"""Shared contract for agent providers (HZ-83).

Both farm/agent_runner.py (the dispatcher) and each farm/providers/*.py
module (the implementations) import from here — never from each other.
That's what keeps providers/claude.py's recursive stale-session retry from
becoming a circular import: it recurses into its own run(), not back
through agent_runner.
"""

import os
import threading
from typing import Protocol


class AgentError(RuntimeError):
    pass


class AgentExhaustedError(AgentError):
    """A provider ran out of its turn/time budget (Claude's error_max_turns,
    a subprocess/asyncio timeout, Muse's --max-model-steps analogue). The one
    typed signal every provider raises for exhaustion, so callers like
    step_agent's checkpoint salvage (HZ-31) can tell it apart from any other
    failure without knowing which provider ran."""


class AgentProvider(Protocol):
    """Typing-only shape check — no abc, matches this package's plain-module
    style. A provider is a module, not a class instance."""

    SUPPORTS_RESUME: bool

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
