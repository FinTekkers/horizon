"""agent_runner's provider seam (HZ-83): dispatch-time capability refusal,
the metered-billing code gate, and the provider registry itself.

Uses a fake in-process provider (a types.SimpleNamespace, same shape real
provider modules export) registered into agent_runner._PROVIDERS under a
throwaway name — this tests the *dispatcher's* contract, independent of
whether claude or muse happen to implement it correctly.
"""

import types

import pytest

from farm import agent_runner
from farm.providers.base import AgentError


def _fake_provider(*, supports_resume, auth_calls=None, run_calls=None):
    auth_calls = auth_calls if auth_calls is not None else []
    run_calls = run_calls if run_calls is not None else []

    def assert_subscription_auth():
        auth_calls.append(1)

    def run(prompt, **kwargs):
        run_calls.append((prompt, kwargs))
        return {"result": "ok", "session_id": kwargs.get("session_id") or "new-session"}

    return types.SimpleNamespace(
        SUPPORTS_RESUME=supports_resume,
        assert_subscription_auth=assert_subscription_auth,
        run=run,
    ), run_calls, auth_calls


@pytest.fixture
def register_fake_provider(monkeypatch):
    """Registers a fake provider under FARM_PROVIDER="fake" for one test."""

    def _register(provider):
        monkeypatch.setitem(agent_runner._PROVIDERS, "fake", provider)
        monkeypatch.setenv("FARM_PROVIDER", "fake")

    return _register


def test_unknown_provider_raises_agent_error(monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "nonexistent")
    with pytest.raises(AgentError, match="nonexistent"):
        agent_runner.run_agent("prompt")


def test_resume_incapable_provider_refuses_before_calling_run(register_fake_provider):
    """The dispatch function proving-point (success metric: 'refuses at
    dispatch, with a test proving the dispatch function was never
    called')."""
    provider, run_calls, _ = _fake_provider(supports_resume=False)
    register_fake_provider(provider)

    with pytest.raises(AgentError, match="does not support resuming"):
        agent_runner.run_agent("prompt", session_id="some-session")

    assert run_calls == [], "provider.run must never be invoked when the resume check refuses"


def test_resume_incapable_provider_runs_normally_without_a_session_id(register_fake_provider):
    """Negative case: SUPPORTS_RESUME=False must not over-trigger and block
    ordinary (non-resuming) calls — only a real resume attempt is refused."""
    provider, run_calls, _ = _fake_provider(supports_resume=False)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt")

    assert reply == {"result": "ok", "session_id": "new-session"}
    assert len(run_calls) == 1


def test_resume_capable_provider_forwards_session_id(register_fake_provider):
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", session_id="existing-session")

    assert reply["session_id"] == "existing-session"
    assert run_calls[0][1]["session_id"] == "existing-session"


def test_run_agent_calls_provider_auth_before_run(register_fake_provider):
    provider, run_calls, auth_calls = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    agent_runner.run_agent("prompt")

    assert auth_calls == [1]
    assert len(run_calls) == 1


# ---- metered billing gate (HZ-5 guarantee; HZ-83 code-enforced cap) ----


def test_metered_billing_refused_when_not_opted_in(monkeypatch):
    monkeypatch.delenv("FARM_ALLOW_METERED_BILLING", raising=False)
    from farm.providers.base import assert_metered_billing_authorized

    with pytest.raises(AgentError, match="FARM_ALLOW_METERED_BILLING"):
        assert_metered_billing_authorized("fake-provider")


def test_metered_billing_refused_when_opted_in_without_a_cap(monkeypatch):
    """The opt-in env var ALONE must not be enough — no positive cap means
    no working spend tracker backs the opt-in, so it still refuses."""
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.delenv("FARM_METERED_SPEND_CAP_USD", raising=False)
    from farm.providers.base import assert_metered_billing_authorized

    with pytest.raises(AgentError, match="FARM_METERED_SPEND_CAP_USD"):
        assert_metered_billing_authorized("fake-provider")


def test_metered_billing_authorized_when_opted_in_with_a_cap(monkeypatch):
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "5.00")
    from farm.providers import base

    monkeypatch.setattr(base, "_METERED_SPEND_TRACKER", base._SpendTracker())
    monkeypatch.setattr(base, "_METERED_CALL_ESTIMATE_USD", 1.00)
    base.assert_metered_billing_authorized("fake-provider")  # must not raise


def test_metered_billing_tracker_refuses_once_cap_would_be_exceeded(monkeypatch):
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "1.50")
    from farm.providers import base

    tracker = base._SpendTracker()
    monkeypatch.setattr(base, "_METERED_SPEND_TRACKER", tracker)
    monkeypatch.setattr(base, "_METERED_CALL_ESTIMATE_USD", 1.00)

    base.assert_metered_billing_authorized("fake-provider")  # 1.00 <= 1.50, ok
    with pytest.raises(AgentError, match="spend cap"):
        base.assert_metered_billing_authorized("fake-provider")  # 2.00 > 1.50, refused
