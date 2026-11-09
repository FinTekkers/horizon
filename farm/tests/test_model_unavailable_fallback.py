"""Model-unavailable fallback in run_agent: a model that does not exist on
this box must fall back to the next candidate instead of pausing the item.

Fake modules are registered under the REAL provider names, so _model_for
and the real catalogue drive the candidate order — the test proves the
dispatcher, not a fabricated catalogue.
"""

import types

import pytest

from farm import agent_runner
from farm.providers.base import AgentError, AgentModelUnavailableError


def _fake_provider(run):
    def assert_subscription_auth():
        pass

    return types.SimpleNamespace(
        SUPPORTS_RESUME=True,
        assert_subscription_auth=assert_subscription_auth,
        run=run,
    )


def test_model_unavailable_falls_back_to_next_provider(monkeypatch):
    calls = []

    def fail_muse(prompt, **kwargs):
        calls.append(("muse", kwargs.get("model")))
        raise AgentModelUnavailableError("model 'muse-spark-1.3-contributor' does not exist or you lack access")

    def succeed_claude(prompt, **kwargs):
        calls.append(("claude", kwargs.get("model")))
        return {"result": "ok", "session_id": "new-session"}

    monkeypatch.setitem(agent_runner._PROVIDERS, "muse", _fake_provider(fail_muse))
    monkeypatch.setitem(agent_runner._PROVIDERS, "claude", _fake_provider(succeed_claude))
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    reply = agent_runner.run_agent("prompt", agent="eng", provider="muse")

    # Muse's other declared models fail the same way in the fake, so the
    # retry walks them before reaching Claude; the reply must come from
    # Claude, with Claude's model, after at least one Muse attempt.
    assert reply["result"] == "ok"
    assert reply["provider"] == "claude"
    assert reply["model"] == "claude-opus-5-5"
    assert calls[0][0] == "muse"
    assert calls[-1] == ("claude", "claude-opus-5-5")


def test_model_unavailable_locked_step_stays_on_same_provider(monkeypatch):
    calls = []

    def run_claude(prompt, **kwargs):
        calls.append(kwargs.get("model"))
        if kwargs.get("model") == "claude-opus-5-5":
            raise AgentModelUnavailableError("model 'claude-opus-5-5' not found")
        return {"result": "ok", "session_id": "new-session"}

    monkeypatch.setitem(agent_runner._PROVIDERS, "claude", _fake_provider(run_claude))
    monkeypatch.setenv("FARM_PROVIDER", "claude")

    reply = agent_runner.run_agent("prompt", agent="eng", provider="claude", provider_locked=True)

    assert reply["result"] == "ok"
    assert reply["provider"] == "claude"
    # The second Claude model in the catalogue, never a different provider.
    assert reply["model"] == "claude-sonnet-5-5"
    assert calls == ["claude-opus-5-5", "claude-sonnet-5-5"]


def test_generic_error_does_not_fall_back(monkeypatch):
    calls = []

    def fail(prompt, **kwargs):
        calls.append(1)
        raise AgentError("boom")

    monkeypatch.setitem(agent_runner._PROVIDERS, "muse", _fake_provider(fail))
    monkeypatch.setitem(agent_runner._PROVIDERS, "claude", _fake_provider(lambda p, **k: {"result": "ok"}))
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    with pytest.raises(AgentError, match="boom"):
        agent_runner.run_agent("prompt", agent="eng", provider="muse")

    assert len(calls) == 1


def test_all_candidates_unavailable_raises_the_last_error(monkeypatch):
    def fail(prompt, **kwargs):
        raise AgentModelUnavailableError("model does not exist")

    monkeypatch.setitem(agent_runner._PROVIDERS, "muse", _fake_provider(fail))
    monkeypatch.setitem(agent_runner._PROVIDERS, "claude", _fake_provider(fail))
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    with pytest.raises(AgentModelUnavailableError, match="does not exist"):
        agent_runner.run_agent("prompt", agent="eng", provider="muse")
