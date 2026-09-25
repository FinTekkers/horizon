"""agent_runner: the SDK streaming path (HZ-5), driven through the claude
provider (the default when FARM_PROVIDER is unset, unchanged by HZ-83).

These tests need the real claude-agent-sdk for its message types, so the
whole module skips when it is absent (e.g. a farm-host venv that predates
HZ-5). The cost guardrail and the subprocess fallback stay enforced
regardless — they live SDK-free in test_agent_runner.py.
"""

import subprocess
import sys
import time

import pytest

sdk = pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed — SDK-path tests need its message types")

from farm.agent_runner import AgentError, run_agent
from farm.providers.base import AgentExhaustedError

# conftest defaults tests to the subprocess runner (fake_claude can't speak
# the SDK stream protocol); these opt in and mock claude_agent_sdk.query.


@pytest.fixture
def sdk_runner(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "sdk")


def _result_message(session_id="sdk-session-1", result='{"summary": "done"}', is_error=False, subtype="success"):
    return sdk.ResultMessage(
        subtype=subtype,
        duration_ms=1500,
        duration_api_ms=1200,
        is_error=is_error,
        num_turns=2,
        session_id=session_id,
        result=result,
    )


def test_sdk_path_streams_events_and_returns_result(sdk_runner, monkeypatch, capsys):
    seen_options = {}

    def fake_query(*, prompt, options=None, **kwargs):
        seen_options["options"] = options

        async def gen():
            yield sdk.AssistantMessage(
                content=[
                    sdk.TextBlock(text="Reading the runner first."),
                    sdk.ToolUseBlock(id="t1", name="Read", input={"file_path": "farm/agent_runner.py"}),
                ],
                model="m",
            )
            yield _result_message()

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    reply = run_agent(
        "do it",
        append_system="be terse",
        max_turns=5,
        timeout_s=10,
        allowed_tools="Read, Glob,Grep",
    )

    assert reply == {
        "result": '{"summary": "done"}',
        "session_id": "sdk-session-1",
        "provider": "claude",
        "command_id": None,
    }
    # The comma-joined public param must reach the SDK as a list.
    assert seen_options["options"].allowed_tools == ["Read", "Glob", "Grep"]
    assert seen_options["options"].system_prompt["append"] == "be terse"
    # One flushed line per event lands on stdout (= the tmux pane).
    out = capsys.readouterr().out
    assert "Reading the runner first." in out
    assert '⏺ Read({"file_path": "farm/agent_runner.py"})' in out
    assert "── result: 2 turn(s)" in out


def test_sdk_stale_resume_retries_exactly_once_fresh(sdk_runner, monkeypatch):
    calls = []

    def fake_query(*, prompt, options=None, **kwargs):
        calls.append(options.resume)

        async def gen():
            if options.resume is not None:
                raise sdk.ProcessError("stale session", exit_code=1)
            yield _result_message(session_id="fresh-1")

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    reply = run_agent("hello", session_id="dead-session", timeout_s=10)
    assert reply["session_id"] == "fresh-1"
    assert calls == ["dead-session", None]


def test_sdk_failure_without_resume_raises(sdk_runner, monkeypatch):
    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            raise sdk.ProcessError("cli exploded", exit_code=1)
            yield  # pragma: no cover — makes this an async generator

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentError, match="cli exploded"):
        run_agent("hello", timeout_s=10)


def test_sdk_timeout_closes_the_stream_and_kills_the_child(sdk_runner, monkeypatch):
    """asyncio.wait_for cancels the iterator; the runner must close the
    generator so the SDK's cleanup kills the spawned process (no orphans
    silently eating MAX_EPHEMERAL slots)."""
    import asyncio

    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            try:
                await asyncio.sleep(3600)
                yield  # pragma: no cover
            finally:
                # Mirrors the SDK transport teardown triggered by aclose().
                child.terminate()
                child.wait(timeout=10)

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    try:
        with pytest.raises(AgentExhaustedError, match="timed out after 1s"):
            run_agent("hang forever", timeout_s=1)
        deadline = time.time() + 10
        while child.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        assert child.poll() is not None, "the spawned child survived the timeout"
    finally:
        if child.poll() is None:
            child.kill()


def test_sdk_error_result_raises_plain_agent_error(sdk_runner, monkeypatch):
    """A generic SDK error result (not a max-turns exhaustion) is a plain
    AgentError — the negative case proving exhaustion typing doesn't
    over-fire on every error subtype (architecture review finding)."""

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _result_message(result="max turns exceeded", is_error=True, subtype="success")

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentError, match="error result") as exc_info:
        run_agent("hello", timeout_s=10)
    assert not isinstance(exc_info.value, AgentExhaustedError)


def test_sdk_error_max_turns_raises_agent_exhausted_error(sdk_runner, monkeypatch):
    """The positive exhaustion case: subtype=error_max_turns is Claude's
    real max-turns signal and must raise the typed AgentExhaustedError so
    step_agent's checkpoint salvage (HZ-31) can tell it apart uniformly."""

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _result_message(result="", is_error=True, subtype="error_max_turns")

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentExhaustedError, match="error_max_turns"):
        run_agent("hello", timeout_s=10)
