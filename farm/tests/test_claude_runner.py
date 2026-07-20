"""claude_runner: subprocess fallback, cost guardrail, JSON lifting.

Deliberately SDK-free: this module must collect and pass even when
claude-agent-sdk is not installed in the venv running the checks (that
exact gap failed the HZ-5 guardrail gate twice). The SDK streaming path
lives in test_claude_runner_sdk.py behind importorskip.
"""

import sys

import pytest

from farm.claude_runner import ClaudeError, assert_subscription_auth, extract_json, run_claude


def test_extract_json_plain():
    assert extract_json('{"summary": "done"}') == {"summary": "done"}


def test_extract_json_fenced():
    assert extract_json('```json\n{"summary": "done"}\n```') == {"summary": "done"}


def test_extract_json_wrapped_in_prose():
    text = 'Here you go:\n{"summary": "done", "n": 2}\nHope that helps!'
    assert extract_json(text) == {"summary": "done", "n": 2}


def test_extract_json_missing_raises():
    with pytest.raises(ClaudeError):
        extract_json("no json here at all")


# ---- rollback lever: FARM_RUNNER=subprocess keeps the old silent path ----


def test_run_claude_with_fake_binary(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    reply = run_claude('Step to perform now: "Do the thing" (attempt 1)', max_turns=4, timeout_s=30)
    assert reply["session_id"] == "fake-session-001"
    inner = extract_json(reply["result"])
    assert inner["summary"].startswith("[fake-claude] completed")


def test_subprocess_path_never_touches_the_sdk(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    # None in sys.modules makes any `import claude_agent_sdk` raise — so if
    # the subprocess path touched the SDK at all, this test would blow up.
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    reply = run_claude("anything", max_turns=4, timeout_s=30, allowed_tools="Read,Grep")
    assert reply["session_id"] == "fake-session-001"


def test_sdk_path_without_sdk_names_the_rollback_lever(monkeypatch):
    """A venv missing claude-agent-sdk must fail with an actionable ClaudeError,
    not a bare ImportError mid-step."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    with pytest.raises(ClaudeError, match="FARM_RUNNER=subprocess"):
        run_claude("prompt", timeout_s=10)


# ---- cost guardrail (HZ-5 success metric: no API billing) ----


def test_assert_subscription_auth_raises_with_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(ClaudeError, match="ANTHROPIC_API_KEY"):
        assert_subscription_auth()


def test_assert_subscription_auth_passes_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert_subscription_auth()  # must not raise


def test_sdk_path_refuses_to_run_with_api_key(monkeypatch):
    """The check must hold in the agent process itself, not just in farmd —
    and it fires before the SDK import, so it needs no SDK installed."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(ClaudeError, match="ANTHROPIC_API_KEY"):
        run_claude("prompt")
