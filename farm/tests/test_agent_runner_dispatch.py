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

    assert reply == {"result": "ok", "session_id": "new-session", "provider": "fake", "command_id": None}
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


def test_run_agent_stamps_provider_and_defaults_missing_command_id(register_fake_provider):
    """HZ-102: every reply carries provenance — which provider ran, and a
    command_id key even for a provider (like the fake here, or Claude) that
    never reports one."""
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt")

    assert reply["provider"] == "fake"
    assert reply["command_id"] is None


# ---- explicit provider override (HZ-102: persona-forced dispatch) ----
# A persona mapped to a non-default provider (farm/personas.py's
# provider_for()) must reach it as a plain argument to run_agent(), never
# through FARM_PROVIDER — an env var would leak into every other call in the
# same process, which is exactly the global-state bleed the ticket's options
# review flagged against a simpler approach.


def test_explicit_provider_overrides_the_env_selected_default(monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "fake-default")
    default_provider, default_calls, _ = _fake_provider(supports_resume=True)
    override_provider, override_calls, _ = _fake_provider(supports_resume=True)
    monkeypatch.setitem(agent_runner._PROVIDERS, "fake-default", default_provider)
    monkeypatch.setitem(agent_runner._PROVIDERS, "fake-override", override_provider)

    reply = agent_runner.run_agent("prompt", provider="fake-override")

    assert reply["provider"] == "fake-override"
    assert len(override_calls) == 1
    assert default_calls == [], "the env-selected default must never run when an explicit provider is given"


def test_omitting_provider_keeps_dispatching_to_the_env_selected_default(register_fake_provider):
    """Regression guard: every caller that never passes provider= (i.e.
    every real persona today) keeps today's FARM_PROVIDER-selected
    behaviour unchanged."""
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt")

    assert reply["provider"] == "fake"
    assert len(run_calls) == 1


def test_explicit_provider_unknown_name_raises_agent_error():
    with pytest.raises(AgentError, match="bogus-provider"):
        agent_runner.run_agent("prompt", provider="bogus-provider")


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


def test_spend_tracker_charge_is_thread_safe_under_concurrent_calls():
    """step_agent runs work items concurrently (see test_workspaces.py), so
    two threads racing to charge the same tracker must not both read
    spent_usd before either writes it — that would let total spend exceed
    the cap. 50 threads each charge 1.00 against a 20.00 cap: exactly 20
    must succeed and the rest must be refused, never more than 20."""
    import threading

    from farm.providers.base import AgentError, _SpendTracker

    tracker = _SpendTracker()
    cap_usd = 20.00
    successes = []
    lock = threading.Lock()

    def worker():
        try:
            tracker.charge(1.00, cap_usd)
        except AgentError:
            return
        with lock:
            successes.append(1)

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert len(successes) == 20
    assert tracker.spent_usd == 20.00
