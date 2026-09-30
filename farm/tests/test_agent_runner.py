"""agent_runner: subprocess fallback, cost guardrail, JSON lifting.

Deliberately SDK-free: this module must collect and pass even when
claude-agent-sdk is not installed in the venv running the checks (that
exact gap failed the HZ-5 guardrail gate twice). The SDK streaming path
lives in test_agent_runner_sdk.py behind importorskip.

FARM_PROVIDER defaults to "claude" (conftest never sets it), so
assert_provider_auth()/run_agent() below exercise the claude provider,
same as the pre-HZ-83 claude_runner module did.
"""

import json
import subprocess
import sys

import pytest

from farm import agent_runner
from farm.agent_runner import (
    AgentError,
    AgentExhaustedError,
    assert_provider_auth,
    extract_json,
    parse_agent_reply,
    run_agent,
    stamp_notes,
    stamp_notes_artifact,
)


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


# ---- config-driven provider selection, end to end (HZ-83 success metric) ----


def test_run_agent_selects_muse_provider_via_config_end_to_end(monkeypatch):
    """The success metric's central claim — 'a step runs on Muse Code
    selected by configuration' — needs a test that actually crosses the
    seam. Sets FARM_PROVIDER=muse and drives a real call through
    agent_runner.run_agent() into the real farm.providers.muse module, down
    to muse.subprocess.run — the same boundary test_providers_muse.py mocks
    in isolation — rather than a fake in-process provider standing in for
    it (as test_agent_runner_dispatch.py does for the dispatcher contract)."""
    from farm.providers import muse

    captured = {}

    def fake_subprocess_run(cmd, **kwargs):
        captured["cmd"] = cmd
        payload = json.dumps(
            {
                "payload_type": "run.terminal.completed",
                "payload": {"terminal": "completed", "text": "muse says hi", "command_id": "cmd-1"},
            }
        )
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=payload, stderr="")

    monkeypatch.setattr(muse.subprocess, "run", fake_subprocess_run)
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    reply = run_agent("say hi", session_id="fixed-session", max_turns=5, timeout_s=30)

    assert reply == {
        "result": "muse says hi",
        "session_id": "fixed-session",
        "provider": "muse",
        "command_id": "cmd-1",
    }
    # Proves the real muse.run() actually built the command (headless-safety
    # flags and all) rather than the dispatcher short-circuiting somewhere.
    assert captured["cmd"][0] == muse.FARM_MUSE_BIN
    assert "--approval-mode" in captured["cmd"]
    assert "--session-id" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--session-id") + 1] == "fixed-session"


def test_extract_json_tolerates_raw_control_characters_in_strings():
    # Real failure (HZ-21, 2026-07-31): an agent reply carried a literal
    # newline inside a JSON string; strict parsing failed the whole step.
    reply = '{"summary": "line one\nline two\ttabbed", "artifact_md": "# Plan\nbody"}'
    parsed = extract_json(reply)
    assert parsed["summary"] == "line one\nline two\ttabbed"


# ---- HZ-156: first-balanced-object extraction, as a LAST resort ----
# The two attempts that existed before (whole text, then widest {…} span) run
# first and unchanged, so every reply that parsed before parses the same way.
# The scanner below only ever sees input on which both of those failed.


def test_extract_json_returns_the_first_balanced_object():
    """The success metric's literal case. Two objects separated by prose: the
    whole text fails, the widest span (first `{` to LAST `}`) fails, and the
    scanner returns the FIRST object — not the second, not a merged span."""
    assert extract_json('{"s":"first"} prose {"s":"second"}') == {"s": "first"}


@pytest.mark.parametrize(
    "reply",
    [
        'Here: {"a": {"b": 1}, "c": 2}',
        '{"a": "}"} ',
        'prose {"a": 1} prose',
    ],
)
def test_the_widest_span_attempt_still_runs_and_still_wins(reply):
    """Attempt 2 is kept ahead of attempt 3 for two reasons, both tested here
    and in test_a_reply_that_fails_today_raises_the_same_exception_type.

    First, exception identity: when nothing parses, the error a caller sees is
    attempt 2's, unchanged in type and message.

    Second — and this is the property that makes the addition safe — whenever
    the widest span DOES parse, the first balanced object is necessarily the
    same span: a parse that succeeds consumes exactly one balanced object
    ending at the last `}`, so there is no room for a shorter one in front of
    it. Attempt 3 can therefore only ever widen what parses, never change it.
    """
    assert extract_json(reply) == json.loads(
        reply.strip()[reply.strip().find("{") : reply.strip().rfind("}") + 1], strict=False
    )
    assert extract_json(reply) == json.loads(
        agent_runner._first_balanced_object(reply.strip()), strict=False
    )


def test_a_leading_object_shadows_a_later_payload_and_the_retry_is_the_answer():
    """The one accepted behaviour change, pinned so it is recorded rather than
    discovered.

    `Example: {} \\n {"summary": "done"}` used to raise, which sent the caller
    into its lossless retry. It now returns the leading `{}`, because that is
    structurally the SAME input as the success metric's
    `{"s":"first"} prose {"s":"second"}` — an object, prose, another object.
    No attempt order can return the first object in one and raise on the
    other, so the metric decides it.

    What keeps this lossless is the caller: pm_agent and concierge_agent hand
    their validator to parse_agent_reply(), so `{}` fails validation INSIDE
    the retry envelope and the retry still runs (see the two
    `..._still_takes_the_lossless_retry` tests below). step_agent's generic
    path validates after the call, by deliberate design (its summary check
    predates this item and stays where it is), so on this input shape it now
    fails on the first pass instead of retrying — a bounded regression on
    input that failed either way, never on input that succeeded.
    """
    assert extract_json('Example: {} \n {"summary": "done"}') == {}


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ("no json here at all", AgentError),
        ("", AgentError),
        ('{"a": 1', AgentError),  # no closing brace at all
        ('prose {"a" 1} prose', json.JSONDecodeError),  # malformed, both attempts fail
        ('{"a": 1,}', json.JSONDecodeError),  # trailing comma: repair is a LATER item
        ("{'a': 1}", json.JSONDecodeError),  # single quotes: also a later item
    ],
)
def test_a_reply_that_fails_today_raises_the_same_exception_type(reply, expected):
    """The guardrail's hard proof: the scanner is a last resort, so it must not
    convert a failure into a different failure — same type, same route. The
    trailing-comma and single-quote cases also pin that NO byte-altering
    repair landed in this item."""
    with pytest.raises(expected):
        extract_json(reply)


@pytest.mark.parametrize(
    "reply",
    [
        '{"a" 1} tail {"b" 2}',
        '{"a": "x} tail {"b": 2}',
        '{"a": [1,} t {"b":2}',
        '{"a": {"b" 2}} t {"c":3}',
        '{nope} t {"b" 2}',
    ],
)
def test_a_still_failing_reply_carries_the_pre_scanner_error_message(reply):
    """Same type is not enough: this message is interpolated into RETRY_PROMPT,
    so a reply that fails must produce the SAME retry prompt it produced before
    the scanner existed. Compared against the widest-span parse done by hand —
    i.e. exactly what extract_json did on its last attempt before HZ-156."""
    span = reply[reply.find("{") : reply.rfind("}") + 1]
    with pytest.raises(json.JSONDecodeError) as before:
        json.loads(span, strict=False)
    with pytest.raises(json.JSONDecodeError) as after:
        extract_json(reply)
    assert str(after.value) == str(before.value)
    # One failure in the traceback, not a "during handling of the above
    # exception" pair — the scanner's own failure is an implementation detail.
    # Either it was never reached (bare re-raise, no context) or it was reached
    # and suppressed; both spellings must reach the log as a single failure.
    exc = after.value
    assert exc.__context__ is None or exc.__suppress_context__


def test_strict_false_still_applies_on_the_first_object_path():
    """The likeliest silent regression: a literal newline inside a string is
    meaningful content (HZ-21), and the scanner path must be no stricter than
    the two attempts above it."""
    parsed = extract_json('{"s": "line one\nline two"} prose {"s":"second"}')
    assert parsed == {"s": "line one\nline two"}


def test_a_nested_object_is_returned_whole():
    assert extract_json('{"a": {"b": 1}} then {"c": 2}') == {"a": {"b": 1}}


def test_a_brace_inside_a_string_does_not_end_the_object():
    assert extract_json('{"a": "}"} tail {"b": 2}') == {"a": "}"}


def test_a_double_backslash_before_the_closing_quote_is_not_an_escape():
    # JSON text: {"a": "c:\\"} {"b": 2}  — the string value is `c:\`.
    assert extract_json('{"a": "c:\\\\"} {"b": 2}') == {"a": "c:\\"}


def test_a_unicode_escaped_brace_is_not_a_brace():
    assert extract_json('{"a":"\\u007d"} {"b":2}') == {"a": "}"}


def test_a_top_level_array_reply_is_unchanged():
    """The scanner must not intercept a reply the first attempt already
    handles — a bare array still comes back as a list."""
    assert extract_json('[{"a":1}]') == [{"a": 1}]


@pytest.mark.parametrize("reply", ["{" * 10_000, "{" * 10_000 + "}"])
def test_ten_thousand_unclosed_braces_terminate_and_raise(reply):
    """One forward pass, no backtracking: unbalanced input must fail fast
    rather than explore spans. A hang here is the failure mode."""
    with pytest.raises((AgentError, json.JSONDecodeError)):
        extract_json(reply)


def test_a_fence_followed_by_a_second_object_now_yields_the_fenced_one():
    """The crude ``cleaned.strip("`")`` fence handling is untouched, so this
    input still fails both existing attempts — and the scanner then recovers
    the fenced object, where before it raised. Same accepted widening as
    test_a_leading_object_shadows_a_later_payload..., on a fenced reply."""
    assert extract_json('```json\n{"a":1}\n```\n{"b":2}') == {"a": 1}


# ---- parse_agent_reply: the one path every agent uses ----


def test_parse_agent_reply_returns_the_parsed_object_and_empty_notes():
    parsed, notes = parse_agent_reply('{"summary": "done"}')
    assert parsed == {"summary": "done"}
    assert notes == []


def test_parse_agent_reply_without_a_retry_raises_immediately():
    """step_agent's implement step omits retry= and must not gain one."""
    with pytest.raises(AgentError):
        parse_agent_reply("no json at all")


def test_parse_agent_reply_retries_once_then_succeeds():
    calls = []

    def retry(prompt):
        calls.append(prompt)
        return '{"summary": "done"}'

    parsed, notes = parse_agent_reply("plain prose", retry)
    assert parsed == {"summary": "done"}
    assert notes == []
    assert len(calls) == 1
    assert "Your previous reply was invalid" in calls[0]
    assert "no JSON object in agent reply" in calls[0]  # the retry names what was wrong


def test_the_retry_prompt_is_byte_identical_to_the_one_the_callers_used():
    """Converting three callers to this helper must not have changed a single
    byte of what the model is asked."""
    assert agent_runner.RETRY_PROMPT.format(exc="BOOM") == (
        "Your previous reply was invalid: BOOM. Respond again with ONLY the JSON object, no other text."
    )


def test_a_second_failure_names_the_second_reply_and_is_not_retried_again():
    calls = []

    def retry(prompt):
        calls.append(prompt)
        return "still not json"

    with pytest.raises(AgentError, match="still not json"):
        parse_agent_reply("plain prose", retry)
    assert len(calls) == 1  # bounded at one retry, as before


def test_an_exhaustion_inside_the_retry_propagates_untouched():
    """AgentExhaustedError subclasses AgentError, so a broad handler around the
    retry call would swallow it and strip the turn-cap tag the orchestrator
    needs to auto-retry the run."""

    def retry(prompt):
        raise AgentExhaustedError("ran out of turns")

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply("plain prose", retry)


def test_an_exhaustion_from_the_first_attempt_is_never_retried():
    """Defence in depth on the other side of the envelope: if a validator ever
    raises an exhaustion, that is not a parse failure and must not spend a
    second run."""
    calls = []

    def retry(prompt):
        calls.append(prompt)
        return '{"summary": "done"}'

    def validate(parsed):
        raise AgentExhaustedError("ran out of turns")

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply('{"summary": "x"}', retry, validate=validate)
    assert calls == []


# ---- validate= keeps validation inside the retry envelope ----


def test_a_parsed_but_invalid_reply_still_takes_the_lossless_retry():
    """pm_agent and concierge_agent both validated inside their retry block, so
    a reply that PARSES but is missing a required field takes the retry. Moving
    the parse out without moving the validator in would have silently removed
    that."""
    calls = []

    def retry(prompt):
        calls.append(prompt)
        return '{"summary": "done"}'

    def validate(parsed):
        if not parsed.get("summary"):
            raise AgentError("agent reply missing 'summary'")
        return parsed["summary"]

    result, notes = parse_agent_reply('{"patch": {}}', retry, validate=validate)
    assert result == "done"
    assert notes == []
    assert len(calls) == 1
    assert "missing 'summary'" in calls[0]


def test_the_validators_return_value_is_what_comes_back():
    result, _notes = parse_agent_reply('{"a": 1}', validate=lambda parsed: ("tuple", parsed["a"]))
    assert result == ("tuple", 1)


def test_a_validation_failure_with_no_retry_propagates():
    def validate(parsed):
        raise AgentError("nope")

    with pytest.raises(AgentError, match="nope"):
        parse_agent_reply('{"a": 1}', validate=validate)


# ---- the notes channel ----


def test_notes_come_from_the_seam_the_later_repair_items_report_through(monkeypatch):
    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["fake note"])
    parsed, notes = parse_agent_reply('{"summary": "done"}')
    assert parsed == {"summary": "done"}
    assert notes == ["fake note"]


def test_notes_are_returned_when_the_retry_produced_the_parse(monkeypatch):
    monkeypatch.setattr(
        agent_runner, "_notes_for", lambda text, parsed: [f"note for {text[:5]}"]
    )
    parsed, notes = parse_agent_reply("prose", lambda prompt: '{"summary": "done"}')
    assert notes == ['note for {"sum']  # the reply that actually parsed, not the first


def test_no_note_is_produced_in_this_item():
    """HZ-156 lands the channel empty: no byte-altering repair exists yet, so
    every real reply reports no notes and every caller's output is unchanged."""
    for reply in ('{"a": 1}', '```json\n{"a": 1}\n```', 'prose {"a":1} prose', '{"s":"1"} p {"s":"2"}'):
        _parsed, notes = parse_agent_reply(reply)
        assert notes == []


# ---- stamping notes without truncating them away ----


def test_stamp_notes_is_a_no_op_without_notes():
    assert stamp_notes("summary", [], 300) == "summary"
    assert stamp_notes_artifact("body", [], 100) == "body"


def test_a_note_survives_a_max_length_summary():
    """Appending a suffix and re-slicing to the cap drops the note exactly when
    the summary is already at the cap — which is the common case, since callers
    slice to the cap first. Room is reserved instead."""
    for limit in (300, 600):
        stamped = stamp_notes("x" * limit, ["repaired a trailing comma"], limit)
        assert len(stamped) == limit
        assert "repaired a trailing comma" in stamped


def test_a_note_survives_an_artifact_already_at_the_ceiling():
    limit = 1000
    stamped = stamp_notes_artifact("y" * limit, ["repaired a trailing comma"], limit)
    assert len(stamped) == limit
    assert "## Parser notes" in stamped
    assert "- repaired a trailing comma" in stamped


def test_several_notes_are_joined():
    assert stamp_notes("s", ["one", "two"], 300) == "s [one; two]"


def test_a_note_longer_than_the_whole_budget_wins_over_the_summary():
    """Pathological, but it must not return a summary with a half-note glued
    on, and it must not exceed the cap."""
    stamped = stamp_notes("summary", ["z" * 500], 300)
    assert len(stamped) == 300
    assert "summary" not in stamped
