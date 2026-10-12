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
from pathlib import Path

import pytest

sdk = pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed — SDK-path tests need its message types")

from farm.agent_runner import AgentError, AgentMessageTooLargeError, run_agent
from domain.py import providers as domain_providers
from domain.py import reasons
from domain.py.personas import resolve_model
from farm.providers import claude as claude_provider
from farm.providers.base import AgentExhaustedError

# conftest defaults tests to the subprocess runner (fake_claude can't speak
# the SDK stream protocol); these opt in and mock claude_agent_sdk.query.

# HZ-398: ids read from domain/providers.json — Muse's pinned default, and a
# declared Claude id to stand in for the operator's emergency override.
MUSE_DEFAULT = domain_providers.default_model("muse")
EMERGENCY_MODEL = domain_providers.PROVIDERS["claude"]["models"][1]["id"]


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
        agent="eng",
        append_system="be terse",
        max_turns=5,
        timeout_s=10,
        allowed_tools="Read, Glob,Grep",
    )

    assert reply == {
        "result": '{"summary": "done"}',
        "session_id": "sdk-session-1",
        "provider": "claude",
        # HZ-398: the model that ran — eng's domain/personas.json default.
        "model": resolve_model("eng"),
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
    reply = run_agent("hello", agent="eng", session_id="dead-session", timeout_s=10)
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
        run_agent("hello", agent="eng", timeout_s=10)


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
            run_agent("hang forever", agent="eng", timeout_s=1)
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
        run_agent("hello", agent="eng", timeout_s=10)
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
        run_agent("hello", agent="eng", timeout_s=10)


def _init_message(session_id="sdk-session-1"):
    return sdk.SystemMessage(subtype="init", data={"type": "system", "subtype": "init", "session_id": session_id})


def test_error_max_turns_carries_the_reply_in_progress_and_the_session_id(sdk_runner, monkeypatch):
    """HZ-158: the result text is empty on error_max_turns, so partial_text
    is the last assistant text — the reply the run was writing."""

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _init_message("sess-7")
            yield sdk.AssistantMessage(content=[sdk.TextBlock(text='{"summary": "half')], model="m")
            yield _result_message(session_id="sess-7", result="", is_error=True, subtype="error_max_turns")

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentExhaustedError) as exc_info:
        run_agent("hello", agent="eng", timeout_s=10)
    assert exc_info.value.partial_text == '{"summary": "half'
    assert exc_info.value.session_id == "sess-7"
    assert exc_info.value.provider == "claude"


def test_sdk_timeout_carries_the_session_id_from_init_and_the_last_text(sdk_runner, monkeypatch):
    import asyncio

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _init_message("sess-8")
            yield sdk.AssistantMessage(content=[sdk.TextBlock(text="working on it")], model="m")
            await asyncio.sleep(3600)

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentExhaustedError, match="timed out") as exc_info:
        run_agent("hang", agent="eng", timeout_s=1)
    assert exc_info.value.session_id == "sess-8"
    assert exc_info.value.partial_text == "working on it"


def test_sdk_retry_fresh_false_never_starts_a_fresh_session(sdk_runner, monkeypatch):
    calls = []

    def fake_query(*, prompt, options=None, **kwargs):
        calls.append(options.resume)

        async def gen():
            raise sdk.ProcessError("stale session", exit_code=1)
            yield  # pragma: no cover

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with pytest.raises(AgentError, match="stale session"):
        run_agent("hello", agent="eng", session_id="dead-session", timeout_s=10, retry_fresh=False)
    assert calls == ["dead-session"]


@pytest.mark.parametrize(("override", "expected"), [(None, "claude-opus-5-5"), (EMERGENCY_MODEL, EMERGENCY_MODEL)])
def test_a_dispatched_step_hands_the_resolved_model_to_claude_agent_options(sdk_runner, monkeypatch, override, expected):
    """HZ-192: the model run_agent() resolves from domain/personas.json — or
    the operator's FARM_MODEL_OVERRIDE — reaches ClaudeAgentOptions."""
    from farm import step_agent

    monkeypatch.delenv("FARM_PROVIDER", raising=False)
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", override)
    seen = []
    real_options = sdk.ClaudeAgentOptions

    def recording_options(**kwargs):
        seen.append(kwargs)
        return real_options(**kwargs)

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _result_message()

        return gen()

    monkeypatch.setattr(sdk, "ClaudeAgentOptions", recording_options)
    monkeypatch.setattr(sdk, "query", fake_query)

    step_agent._run_and_parse(
        "do it",
        agent="eng",
        step="Draft implementation plan",
        persona=None,
        append_system=None,
        cwd=None,
        max_turns=1,
        timeout_s=10,
        allowed_tools=None,
        required_keys=("summary", "artifact_md"),
        item_id="T-1",
        guard=step_agent.HandoffGuard(),
    )

    assert seen and seen[0].get("model") == expected


# ---- HZ-424: the SDK reader's per-message buffer ----
# The SDK caps each CLI message at 1 MB by default; one Read of a full-page
# screenshot overflowed it and the reader died. These pin the raised cap, its
# bounded env override, and the one-line retryable error an overflow becomes.

SIXTEEN_MB = 16777216
# The start of a base64 PNG: stands in for image data the SDK error carries.
PNG_MARKER = "iVBORw0KGgo"
OVERFLOW_TEXT = f"JSON message exceeded maximum buffer size of {SIXTEEN_MB} bytes"


def _raising_query(exc, calls=None):
    def fake_query(*, prompt, options=None, **kwargs):
        if calls is not None:
            calls.append(options.resume)

        async def gen():
            raise exc
            yield  # pragma: no cover

        return gen()

    return fake_query


def _sdk_overflow_error():
    """The overflow as claude-agent-sdk's transport raises it."""
    return sdk.CLIJSONDecodeError(OVERFLOW_TEXT + " " + PNG_MARKER, ValueError(f"Buffer size 20000000 exceeds limit {SIXTEEN_MB}"))


def test_sdk_max_buffer_defaults_to_16_mb(monkeypatch):
    monkeypatch.delenv(claude_provider.SDK_MAX_BUFFER_ENV, raising=False)
    assert claude_provider.SDK_MAX_BUFFER_DEFAULT_BYTES == SIXTEEN_MB
    assert claude_provider.sdk_max_buffer_bytes() == SIXTEEN_MB


def test_the_env_var_overrides_the_buffer_and_reaches_claude_agent_options(sdk_runner, monkeypatch):
    monkeypatch.setenv("FARM_SDK_MAX_BUFFER_BYTES", "33554432")
    assert claude_provider.sdk_max_buffer_bytes() == 33554432
    seen = []
    real_options = sdk.ClaudeAgentOptions

    def recording_options(**kwargs):
        seen.append(kwargs)
        return real_options(**kwargs)

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield _result_message()

        return gen()

    monkeypatch.setattr(sdk, "ClaudeAgentOptions", recording_options)
    monkeypatch.setattr(sdk, "query", fake_query)
    run_agent("hello", agent="eng", timeout_s=10)
    assert seen[0]["max_buffer_size"] == 33554432


def test_the_real_sdk_options_accept_the_buffer_size(monkeypatch):
    monkeypatch.delenv(claude_provider.SDK_MAX_BUFFER_ENV, raising=False)
    options = sdk.ClaudeAgentOptions(max_buffer_size=claude_provider.sdk_max_buffer_bytes())
    assert options.max_buffer_size == SIXTEEN_MB


@pytest.mark.parametrize("raw", ["abc", "0", "-1", "67108865", "x" * 200])
def test_a_bad_buffer_override_falls_back_to_16_mb_with_one_warning(monkeypatch, capsys, raw):
    monkeypatch.setenv("FARM_SDK_MAX_BUFFER_BYTES", raw)
    assert claude_provider.sdk_max_buffer_bytes() == SIXTEEN_MB
    err = capsys.readouterr().err
    warnings = [line for line in err.splitlines() if "FARM_SDK_MAX_BUFFER_BYTES" in line]
    assert len(warnings) == 1
    assert str(SIXTEEN_MB) in warnings[0]
    assert "x" * 33 not in err, "a long bad value must not be echoed in full"


def test_the_installed_sdk_still_words_the_overflow_as_detection_expects():
    """Detection matches the SDK's text; an SDK upgrade that rewords it must
    fail here, not silently stop tagging overflows."""
    package = Path(sdk.__file__).parent
    source = "\n".join(path.read_text(encoding="utf-8") for path in package.rglob("*.py"))
    assert claude_provider._BUFFER_OVERFLOW_PHRASE in source


@pytest.mark.parametrize(
    "make_exc",
    [_sdk_overflow_error, lambda: Exception(f"Fatal error in message reader: Failed to decode JSON: {OVERFLOW_TEXT} {PNG_MARKER}")],
    ids=["cli-json-decode-error", "plain-exception"],
)
def test_an_overflow_raises_one_line_too_large_error_without_a_fresh_retry(sdk_runner, monkeypatch, make_exc):
    monkeypatch.delenv(claude_provider.SDK_MAX_BUFFER_ENV, raising=False)
    calls = []
    monkeypatch.setattr(sdk, "query", _raising_query(make_exc(), calls))
    with pytest.raises(AgentMessageTooLargeError) as exc_info:
        run_agent("hello", agent="eng", session_id="resumed-1", timeout_s=10)
    message = str(exc_info.value)
    assert reasons.REASON["SDK_MESSAGE_TOO_LARGE"] in message
    assert str(SIXTEEN_MB) in message
    assert "\n" not in message
    assert PNG_MARKER not in message
    assert exc_info.value.__cause__ is None
    assert exc_info.value.__suppress_context__ is True
    # The stale-resume fallback must not swallow it into a fresh run.
    assert calls == ["resumed-1"]


def test_the_message_size_is_named_when_the_sdk_reports_it(sdk_runner, monkeypatch):
    monkeypatch.setattr(sdk, "query", _raising_query(_sdk_overflow_error()))
    with pytest.raises(AgentMessageTooLargeError, match=r"\(20000000 bytes\)"):
        run_agent("hello", agent="eng", timeout_s=10)


@pytest.mark.parametrize("case", ["resumed-sdk-error", "malformed-line", "plain-exception"])
def test_other_errors_keep_their_classification(sdk_runner, monkeypatch, case):
    calls = []
    if case == "resumed-sdk-error":
        def fake_query(*, prompt, options=None, **kwargs):
            calls.append(options.resume)

            async def gen():
                if options.resume is not None:
                    raise sdk.ProcessError("stale session", exit_code=1)
                yield _result_message(session_id="fresh-1")

            return gen()

        monkeypatch.setattr(sdk, "query", fake_query)
        assert run_agent("hello", agent="eng", session_id="dead", timeout_s=10)["session_id"] == "fresh-1"
        assert calls == ["dead", None]
    elif case == "malformed-line":
        monkeypatch.setattr(sdk, "query", _raising_query(sdk.CLIJSONDecodeError("{not json", ValueError("bad"))))
        with pytest.raises(AgentError, match=r"^claude \(sdk\) failed: ") as exc_info:
            run_agent("hello", agent="eng", timeout_s=10)
        assert not isinstance(exc_info.value, AgentMessageTooLargeError)
    else:
        boom = Exception("boom")
        monkeypatch.setattr(sdk, "query", _raising_query(boom))
        with pytest.raises(Exception) as exc_info:
            run_agent("hello", agent="eng", timeout_s=10)
        assert exc_info.value is boom
