"""agent_runner: subprocess fallback, cost guardrail, JSON lifting.

Deliberately SDK-free: this module must collect and pass even when
claude-agent-sdk is not installed in the venv running the checks (that
exact gap failed the HZ-5 guardrail gate twice). The SDK streaming path
lives in test_agent_runner_sdk.py behind importorskip.

FARM_PROVIDER defaults to "claude" (conftest never sets it), so
assert_provider_auth()/run_agent() below exercise the claude provider,
same as the pre-HZ-83 claude_runner module did.
"""

import sys

import pytest

from farm.agent_runner import AgentError, assert_provider_auth, extract_json, run_agent


def test_extract_json_plain():
    assert extract_json('{"summary": "done"}') == {"summary": "done"}


def test_extract_json_fenced():
    assert extract_json('```json\n{"summary": "done"}\n```') == {"summary": "done"}


def test_extract_json_wrapped_in_prose():
    text = 'Here you go:\n{"summary": "done", "n": 2}\nHope that helps!'
    assert extract_json(text) == {"summary": "done", "n": 2}


def test_extract_json_missing_raises():
    with pytest.raises(AgentError):
        extract_json("no json here at all")


# ---- rollback lever: FARM_RUNNER=subprocess keeps the old silent path ----


def test_run_agent_with_fake_binary(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    reply = run_agent('Step to perform now: "Do the thing" (attempt 1)', max_turns=4, timeout_s=30)
    assert reply["session_id"] == "fake-session-001"
    inner = extract_json(reply["result"])
    assert inner["summary"].startswith("[fake-claude] completed")


def test_subprocess_path_never_touches_the_sdk(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    # None in sys.modules makes any `import claude_agent_sdk` raise — so if
    # the subprocess path touched the SDK at all, this test would blow up.
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    reply = run_agent("anything", max_turns=4, timeout_s=30, allowed_tools="Read,Grep")
    assert reply["session_id"] == "fake-session-001"


def test_sdk_path_without_sdk_names_the_rollback_lever(monkeypatch):
    """A venv missing claude-agent-sdk must fail with an actionable AgentError,
    not a bare ImportError mid-step."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    with pytest.raises(AgentError, match="FARM_RUNNER=subprocess"):
        run_agent("prompt", timeout_s=10)


# ---- cost guardrail (HZ-5 success metric: no API billing) ----


def test_assert_provider_auth_raises_with_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        assert_provider_auth()


def test_assert_provider_auth_passes_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert_provider_auth()  # must not raise


def test_sdk_path_refuses_to_run_with_api_key(monkeypatch):
    """The check must hold in the agent process itself, not just in farmd —
    and it fires before the SDK import, so it needs no SDK installed."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        run_agent("prompt")


def test_assert_provider_auth_allows_metered_billing_when_explicitly_capped(monkeypatch):
    """HZ-5 guarantee, extended by HZ-83: metered billing is refused unless
    explicitly opted in with an enforced cap — this is the "unless" branch,
    proven against the real claude provider stack (agent_runner ->
    providers.claude -> providers.base's spend gate), not just the gate in
    isolation."""
    from farm.providers import base

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "5.00")
    monkeypatch.setattr(base, "_METERED_SPEND_TRACKER", base._SpendTracker())

    assert_provider_auth()  # must not raise


def test_extract_json_tolerates_raw_control_characters_in_strings():
    # Real failure (HZ-21, 2026-07-31): an agent reply carried a literal
    # newline inside a JSON string; strict parsing failed the whole step.
    reply = '{"summary": "line one\nline two\ttabbed", "artifact_md": "# Plan\nbody"}'
    parsed = extract_json(reply)
    assert parsed["summary"] == "line one\nline two\ttabbed"
