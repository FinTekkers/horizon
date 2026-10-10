"""agent_runner's provider seam (HZ-83): dispatch-time capability refusal,
the metered-billing code gate, and the provider registry itself.

Uses a fake in-process provider (a types.SimpleNamespace, same shape real
provider modules export) registered into agent_runner._PROVIDERS under a
throwaway name — this tests the *dispatcher's* contract, independent of
whether claude or muse happen to implement it correctly.
"""

import types

import pytest

from domain.py import providers as domain_providers
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
        agent_runner.run_agent("prompt", agent="eng")


def test_resume_incapable_provider_refuses_before_calling_run(register_fake_provider):
    """The dispatch function proving-point (success metric: 'refuses at
    dispatch, with a test proving the dispatch function was never
    called')."""
    provider, run_calls, _ = _fake_provider(supports_resume=False)
    register_fake_provider(provider)

    with pytest.raises(AgentError, match="does not support resuming"):
        agent_runner.run_agent("prompt", agent="eng", session_id="some-session")

    assert run_calls == [], "provider.run must never be invoked when the resume check refuses"


def test_resume_incapable_provider_runs_normally_without_a_session_id(register_fake_provider):
    """Negative case: SUPPORTS_RESUME=False must not over-trigger and block
    ordinary (non-resuming) calls — only a real resume attempt is refused."""
    provider, run_calls, _ = _fake_provider(supports_resume=False)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", agent="eng")

    # "fake" is in no domain/providers.json list, so it has no model to run.
    assert reply == {"result": "ok", "session_id": "new-session", "provider": "fake", "model": None, "command_id": None}
    assert len(run_calls) == 1


def test_resume_capable_provider_forwards_session_id(register_fake_provider):
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", agent="eng", session_id="existing-session")

    assert reply["session_id"] == "existing-session"
    assert run_calls[0][1]["session_id"] == "existing-session"


def test_run_agent_calls_provider_auth_before_run(register_fake_provider):
    provider, run_calls, auth_calls = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    agent_runner.run_agent("prompt", agent="eng")

    assert auth_calls == [1]
    assert len(run_calls) == 1


def test_run_agent_stamps_provider_and_defaults_missing_command_id(register_fake_provider):
    """HZ-102: every reply carries provenance — which provider ran, and a
    command_id key even for a provider (like the fake here, or Claude) that
    never reports one."""
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", agent="eng")

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

    reply = agent_runner.run_agent("prompt", agent="eng", provider="fake-override")

    assert reply["provider"] == "fake-override"
    assert len(override_calls) == 1
    assert default_calls == [], "the env-selected default must never run when an explicit provider is given"


def test_omitting_provider_keeps_dispatching_to_the_env_selected_default(register_fake_provider):
    """Regression guard: every caller that never passes provider= (i.e.
    every real persona today) keeps today's FARM_PROVIDER-selected
    behaviour unchanged."""
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", agent="eng")

    assert reply["provider"] == "fake"
    assert len(run_calls) == 1


def test_explicit_provider_unknown_name_raises_agent_error():
    with pytest.raises(AgentError, match="bogus-provider"):
        agent_runner.run_agent("prompt", agent="eng", provider="bogus-provider")


# ---- provider lock (HZ-117): closes the bare-FARM_PROVIDER hole ----
# Before this, a step's provider guardrail only ever ran on the
# persona-forced override path (step_agent.py's old
# PROVIDER_OVERRIDE_ELIGIBLE_STEPS check) — a bare `FARM_PROVIDER=muse` env
# var reached implement/deploy completely unguarded. provider_locked is
# enforced at run_agent()'s one dispatch chokepoint, so it catches that path
# too, with no persona involved at all.


def test_provider_locked_step_refuses_non_default_provider_even_from_bare_env(monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    with pytest.raises(AgentError, match="provider-locked"):
        agent_runner.run_agent("prompt", agent="eng", provider_locked=True)


def test_provider_locked_step_refuses_an_explicit_override_too(register_fake_provider):
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    with pytest.raises(AgentError, match="provider-locked"):
        agent_runner.run_agent("prompt", agent="eng", provider="fake", provider_locked=True)
    assert run_calls == [], "a provider-locked step must never dispatch to the refused provider"


def test_provider_locked_step_still_runs_on_the_default_provider(monkeypatch):
    monkeypatch.delenv("FARM_PROVIDER", raising=False)
    monkeypatch.setattr(agent_runner, "FARM_PROVIDER", agent_runner.DEFAULT_PROVIDER)

    reply = agent_runner.run_agent("prompt", agent="eng", provider_locked=True)

    assert reply["provider"] == agent_runner.DEFAULT_PROVIDER


def test_omitting_provider_locked_keeps_every_existing_caller_unaffected(register_fake_provider):
    provider, run_calls, _ = _fake_provider(supports_resume=True)
    register_fake_provider(provider)

    reply = agent_runner.run_agent("prompt", agent="eng")

    assert reply["provider"] == "fake"
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


# ---- HZ-192: the model is resolved here, never passed in ----


def _models(**overrides):
    return {
        "agents": {"eng": "claude-test-eng", "concierge": "claude-test-concierge"},
        "steps": overrides.get("steps", {}),
        "personas": overrides.get("personas", {}),
    }


@pytest.fixture
def recorded(monkeypatch):
    """Fake "claude" and "muse" providers recording what run() was handed,
    plus a fabricated `models` block for the resolver."""
    import functools

    from domain.py import personas as domain_personas

    calls = []

    def install(**overrides):
        for name in ("claude", "muse"):
            provider, _, _ = _fake_provider(supports_resume=True)
            provider.run = lambda prompt, _name=name, **kw: calls.append((_name, kw)) or {"result": "ok", "session_id": "s"}
            monkeypatch.setitem(agent_runner._PROVIDERS, name, provider)
        monkeypatch.setattr(
            agent_runner, "resolve_model", functools.partial(domain_personas.resolve_model, models=_models(**overrides))
        )
        monkeypatch.delenv("FARM_PROVIDER", raising=False)
        monkeypatch.delenv("FARM_MODEL_OVERRIDE", raising=False)
        return calls

    return install


def test_run_agent_has_no_model_parameter():
    import inspect

    params = inspect.signature(agent_runner.run_agent).parameters
    assert "model" not in params
    assert params["agent"].kind is inspect.Parameter.KEYWORD_ONLY and params["agent"].default is inspect.Parameter.empty


def test_passing_a_model_is_a_type_error():
    with pytest.raises(TypeError, match="model"):
        agent_runner.run_agent("p", agent="eng", model="claude-x")


def test_omitting_the_agent_is_a_type_error():
    with pytest.raises(TypeError, match="agent"):
        agent_runner.run_agent("p")


def test_claude_gets_the_resolved_model_persona_then_step_then_agent(recorded):
    calls = recorded(steps={"Build": "claude-test-step"}, personas={"eng.python": "claude-test-persona"})

    agent_runner.run_agent("p", agent="eng")
    agent_runner.run_agent("p", agent="eng", step="Build")
    agent_runner.run_agent("p", agent="eng", step="Build", persona="eng.python")

    assert [kw["model"] for _, kw in calls] == ["claude-test-eng", "claude-test-step", "claude-test-persona"]


def test_an_unknown_agent_fails_before_any_provider_runs_on_every_provider(recorded):
    calls = recorded()
    with pytest.raises(ValueError, match="unknown model agent"):
        agent_runner.run_agent("p", agent="nobody")
    with pytest.raises(ValueError, match="unknown model agent"):
        agent_runner.run_agent("p", agent="nobody", provider="muse")
    assert calls == []


def test_a_valid_override_beats_even_a_persona_override_on_claude(recorded, monkeypatch):
    calls = recorded(personas={"eng.python": "claude-test-persona"})
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", SONNET)

    agent_runner.run_agent("p", agent="eng", step="Build", persona="eng.python")

    assert [kw["model"] for _, kw in calls] == [SONNET]


def test_an_empty_override_counts_as_unset(recorded, monkeypatch):
    calls = recorded()
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", "")

    agent_runner.run_agent("p", agent="eng")

    assert [kw["model"] for _, kw in calls] == ["claude-test-eng"]


# HZ-398: "claude-opus-9-9" has the old ^claude- shape but is declared nowhere —
# the catalogue, not a pattern, decides.
@pytest.mark.parametrize("bad", ["opus", "gpt-4o", " claude-opus-5-5", "claude-opus-5-5\n", "Claude-Opus-5-5", "claude-opus-9-9"])
def test_a_malformed_override_raises_before_the_provider_runs(recorded, monkeypatch, bad):
    calls = recorded()
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", bad)

    with pytest.raises(ValueError, match="FARM_MODEL_OVERRIDE"):
        agent_runner.run_agent("p", agent="eng")

    assert calls == []


@pytest.mark.parametrize("override", [None, "$sonnet"])
@pytest.mark.parametrize("route", ["explicit", "env", "both"])
def test_muse_never_receives_a_claude_model(recorded, monkeypatch, muse_smoke_test_persona, override, route):
    """The runtime guard is the real protection: the load-time rule only sees
    domain/personas.json, and a runtime-registered Muse persona whose model
    override was injected past it must still reach Muse with its own pinned
    default (HZ-398), never the Claude one."""
    persona = f"eng.{muse_smoke_test_persona}"
    calls = recorded(personas={persona: "claude-test-persona"}, steps={"Build": "claude-test-step"})
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", SONNET)
    if route in ("env", "both"):
        monkeypatch.setenv("FARM_PROVIDER", "muse")

    agent_runner.run_agent(
        "p", agent="eng", step="Build", persona=persona, provider="muse" if route in ("explicit", "both") else None
    )

    assert len(calls) == 1
    name, kw = calls[0]
    assert name == "muse" and kw["model"] == MUSE_DEFAULT
    assert not [v for v in kw.values() if isinstance(v, str) and v.startswith("claude-")]


# ---- HZ-398: the owner's model choice, and the order _model_for() applies ----
# Every id below is read from domain/providers.json.

CLAUDE_IDS = [m["id"] for m in domain_providers.PROVIDERS["claude"]["models"] if m["selectable"]]
MUSE_IDS = [m["id"] for m in domain_providers.PROVIDERS["muse"]["models"] if m["selectable"]]
SONNET = next(i for i in CLAUDE_IDS if "sonnet" in i)
HAIKU = next(i for i in CLAUDE_IDS if "haiku" in i)
MUSE_DEFAULT = domain_providers.default_model("muse")
MUSE_CHOSEN = next(i for i in MUSE_IDS if i != MUSE_DEFAULT)


def test_level_1_the_override_beats_a_chosen_model(recorded, monkeypatch):
    calls = recorded()
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", SONNET)

    agent_runner.run_agent("p", agent="eng", model_choice=HAIKU)

    assert [kw["model"] for _, kw in calls] == [SONNET]


def test_level_2_a_chosen_model_beats_the_models_block(recorded):
    """The chosen id is the item's choice or, with none, the project default —
    the server merges the two before dispatch (server/test covers that half)."""
    calls = recorded(personas={"eng.python": "claude-test-persona"}, steps={"Build": "claude-test-step"})

    reply = agent_runner.run_agent("p", agent="eng", step="Build", persona="eng.python", model_choice=HAIKU)

    assert [kw["model"] for _, kw in calls] == [HAIKU]
    assert reply["model"] == HAIKU


def test_level_3_with_no_choice_the_models_block_runs(recorded):
    calls = recorded()

    reply = agent_runner.run_agent("p", agent="eng")

    assert [kw["model"] for _, kw in calls] == ["claude-test-eng"]
    assert reply["provider"] == "claude" and reply["model"] == "claude-test-eng"


def test_a_chosen_muse_model_and_muses_default_both_reach_muse(recorded):
    calls = recorded()

    chosen = agent_runner.run_agent("p", agent="eng", provider="muse", model_choice=MUSE_CHOSEN)
    default = agent_runner.run_agent("p", agent="eng", provider="muse")

    assert [kw["model"] for _, kw in calls] == [MUSE_CHOSEN, MUSE_DEFAULT]
    assert (chosen["model"], default["model"]) == (MUSE_CHOSEN, MUSE_DEFAULT)


def test_an_undeclared_chosen_model_is_dropped_for_the_default(recorded):
    """claude-opus-9-9 has the old ^claude- shape; only the catalogue counts."""
    calls = recorded()

    agent_runner.run_agent("p", agent="eng", model_choice="claude-opus-9-9")
    agent_runner.run_agent("p", agent="eng", provider="muse", model_choice="muse-spark-9.9")

    assert [kw["model"] for _, kw in calls] == ["claude-test-eng", MUSE_DEFAULT]


def test_no_model_crosses_providers_either_way(recorded, monkeypatch):
    calls = recorded()

    agent_runner.run_agent("p", agent="eng", model_choice=MUSE_CHOSEN)
    agent_runner.run_agent("p", agent="eng", provider="muse", model_choice=SONNET)
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", MUSE_CHOSEN)
    agent_runner.run_agent("p", agent="eng")
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", SONNET)
    agent_runner.run_agent("p", agent="eng", provider="muse")

    assert [(name, kw["model"]) for name, kw in calls] == [
        ("claude", "claude-test-eng"),
        ("muse", MUSE_DEFAULT),
        ("claude", "claude-test-eng"),
        ("muse", MUSE_DEFAULT),
    ]


def test_an_override_for_the_running_provider_still_beats_its_choice_on_muse(recorded, monkeypatch):
    calls = recorded()
    monkeypatch.setenv("FARM_MODEL_OVERRIDE", MUSE_CHOSEN)

    agent_runner.run_agent("p", agent="eng", provider="muse", model_choice=MUSE_DEFAULT)

    assert [kw["model"] for _, kw in calls] == [MUSE_CHOSEN]


def test_an_exhausted_run_carries_the_model_it_ran_on(recorded):
    from farm.providers.base import AgentExhaustedError

    recorded()

    def exhausted(prompt, **kw):
        raise AgentExhaustedError("out of turns", partial_text=None, session_id=None)

    agent_runner._PROVIDERS["claude"].run = exhausted
    with pytest.raises(AgentExhaustedError) as err:
        agent_runner.run_agent("p", agent="eng", model_choice=HAIKU)
    assert (err.value.provider, err.value.model) == ("claude", HAIKU)
