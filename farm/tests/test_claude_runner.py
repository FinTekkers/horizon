"""claude_runner: SDK streaming path (HZ-5), subprocess fallback, JSON lifting."""

import subprocess
import sys
import time

import claude_agent_sdk as sdk
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

    def boom(**kwargs):
        raise AssertionError("sdk query() must not be called on the subprocess path")

    monkeypatch.setattr(sdk, "query", boom)
    reply = run_claude("anything", max_turns=4, timeout_s=30, allowed_tools="Read,Grep")
    assert reply["session_id"] == "fake-session-001"


# ---- cost guardrail (HZ-5 success metric: no API billing) ----


def test_assert_subscription_auth_raises_with_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(ClaudeError, match="ANTHROPIC_API_KEY"):
        assert_subscription_auth()


def test_assert_subscription_auth_passes_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert_subscription_auth()  # must not raise


def test_sdk_path_refuses_to_run_with_api_key(monkeypatch):
    """The check must hold in the agent process itself, not just in farmd."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(ClaudeError, match="ANTHROPIC_API_KEY"):
        run_claude("prompt")


# ---- SDK streaming path ----
# conftest defaults tests to the subprocess runner (fake_claude can't speak
# the SDK stream protocol); these opt in and mock claude_agent_sdk.query.


@pytest.fixture
def sdk_runner(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "sdk")


def _result_message(session_id="sdk-session-1", result='{"summary": "done"}', is_error=False):
    return sdk.ResultMessage(
        subtype="success",
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
                    sdk.ToolUseBlock(id="t1", name="Read", input={"file_path": "farm/claude_runner.py"}),
                ],
                model="m",
            )
            yield _result_message()

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    reply = run_claude(
        "do it",
        append_system="be terse",
        max_turns=5,
        timeout_s=10,
        allowed_tools="Read, Glob,Grep",
    )

    assert reply == {"result": '{"summary": "done"}', "session_id": "sdk-session-1"}
    # The comma-joined public param must reach the SDK as a list.
    assert seen_options["options"].allowed_tools == ["Read", "Glob", "Grep"]
    assert seen_options["options"].system_prompt["append"] == "be terse"
    # One flushed line per event lands on stdout (= the tmux pane).
    out = capsys.readouterr().out
    assert "Reading the runner first." in out
    assert '⏺ Read({"file_path": "farm/claude_runner.py"})' in out
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
    reply = run_claude("hello", session_id="dead-session", timeout_s=10)
    assert reply["session_id"] == "fresh-1"
    assert calls == ["dead-session", None]


def test_sdk_failure_without_resume_raises(sdk_runner, monkeypatch):
    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            raise sdk.ProcessError("cli exploded", exit_code=1)
            yield  # pragma: no cover — makes this an async generator

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(ClaudeError, match="cli exploded"):
        run_claude("hello", timeout_s=10)


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
        with pytest.raises(ClaudeError, match="timed out after 1s"):
            run_claude("hang forever", timeout_s=1)
        deadline = time.time() + 10
        while child.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        assert child.poll() is not None, "the spawned child survived the timeout"
    finally:
        if child.poll() is None:
            child.kill()


def test_sdk_error_result_raises(sdk_runner, monkeypatch):
    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _result_message(result="max turns exceeded", is_error=True)

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(ClaudeError, match="error result"):
        run_claude("hello", timeout_s=10)
