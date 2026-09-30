"""agent_runner: subprocess fallback, cost guardrail, JSON lifting.

Deliberately SDK-free: this module must collect and pass even when
claude-agent-sdk is not installed in the venv running the checks (that
exact gap failed the HZ-5 guardrail gate twice). The SDK streaming path
lives in test_agent_runner_sdk.py behind importorskip.

FARM_PROVIDER defaults to "claude" (conftest never sets it), so
assert_provider_auth()/run_agent() below exercise the claude provider,
same as the pre-HZ-83 claude_runner module did.
"""

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

from farm.agent_runner import (
    AgentError,
    _extract_json_with_notes,
    _record_repair,
    _salvage_truncated_json,
    assert_provider_auth,
    extract_json,
    repair_stats_path,
    run_agent,
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


# ---- HZ-124: extended repair ladder (success metrics 1-6) ----


def test_extract_json_strips_a_trailing_comma():
    assert extract_json('{"a":1,}') == {"a": 1}


def test_extract_json_converts_single_quotes():
    assert extract_json("{'a':1}") == {"a": 1}


def test_extract_json_returns_the_first_of_two_objects():
    text = '{"s":"first"} prose {"s":"second"}'
    assert extract_json(text) == {"s": "first"}


def test_taking_the_first_of_two_objects_is_disclosed_not_silent():
    """Guardrail 2 applied to the rung that discards the MOST of the model's
    output: metric 3 requires returning the first object, and doing that
    throws away a whole second object the model wrote. Returning it silently
    is precisely the 'repair silently' failure this item is named after, so
    the drop rides out as a note like every byte-altering fix."""
    parsed, notes = _extract_json_with_notes('{"s":"first"} prose {"s":"second"}')
    assert parsed == {"s": "first"}
    assert len(notes) == 1
    assert "discarded 1 further object" in notes[0]


def test_the_discard_note_counts_every_object_it_dropped():
    _parsed, notes = _extract_json_with_notes('{"a":1} {"b":2} {"c":3}')
    assert "discarded 2 further objects" in notes[0]


def test_prose_containing_balanced_braces_is_not_reported_as_a_discarded_object():
    """False-alarm guard: prose can carry balanced braces that are not JSON.
    Reporting `{braces}` as a discarded reply would put a scary, wrong note in
    the artifact on exactly the prose-tolerant input the ladder must accept."""
    parsed, notes = _extract_json_with_notes('{"s":"done"} then: use {braces} carefully')
    assert parsed == {"s": "done"}
    assert notes == []


def test_a_single_prose_wrapped_object_still_reports_no_repair_at_all():
    """The pre-HZ-124 regression (metric 4, prose half) must stay silent —
    prose tolerance is not a repair and must not start producing notes."""
    parsed, notes = _extract_json_with_notes('Here you go:\n{"summary": "done"}\nHope that helps!')
    assert parsed == {"summary": "done"}
    assert notes == []


def test_a_discard_is_only_counted_when_the_parse_it_belongs_to_succeeds(monkeypatch, tmp_path):
    """The counter must not log a drop that never took effect: if the first
    object is unparseable, this is a raise, not a repair, and a
    `discarded ...` line here would inflate the totals the script prints with
    repairs that never happened."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    with pytest.raises(AgentError):
        _extract_json_with_notes('{"s":"he said "hi" to me"} {"b":2}')

    assert not (tmp_path / "repair-stats.ndjson").exists()


def test_a_discard_that_did_take_effect_is_counted(monkeypatch, tmp_path):
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    _extract_json_with_notes('{"a":1} {"b":2}')

    assert "discarded 1 further object" in (tmp_path / "repair-stats.ndjson").read_text()


def test_the_discard_note_rides_along_with_a_byte_altering_repair():
    """Both disclosures must survive together — the drop is reported even
    when a later rung is what finally made the first object parse."""
    _parsed, notes = _extract_json_with_notes('{"a":1,} prose {"b":2}')
    assert "discarded 1 further object" in notes[0]
    assert "stripped a trailing comma" in notes[1]


def test_extract_json_unescaped_inner_quote_raises_on_first_attempt():
    """Metric 5, first half: this shape is genuinely ambiguous (there is no
    deterministic byte-level fix), so extract_json() alone must raise — the
    lossless retry in parse_agent_reply() is the ONLY recovery path, never a
    heuristic guess here."""
    with pytest.raises(AgentError):
        extract_json('{"s":"he said "hi" to me"}')


def test_extract_json_unrepairable_input_raises_without_fabricating_content():
    """Metric 6: truncation mid-literal (not mid-string) is not something
    _salvage_truncated_json or the repair ladder can fix without guessing —
    it must raise, never return plausible-looking but invented content."""
    with pytest.raises(AgentError):
        extract_json('{"ok": tru')


def test_extract_json_produces_no_notes_on_already_valid_input():
    """Negative case for guardrail 2 ('a note only when bytes are altered'):
    clean input must repair-report as silent — an empty notes list — not
    just happen to parse."""
    parsed, notes = _extract_json_with_notes('{"summary": "done"}')
    assert parsed == {"summary": "done"}
    assert notes == []


def test_extract_json_notes_name_the_repair_actually_applied():
    _parsed, comma_notes = _extract_json_with_notes('{"a":1,}')
    assert comma_notes == ["stripped a trailing comma"]

    _parsed, quote_notes = _extract_json_with_notes("{'a':1}")
    assert quote_notes == ["converted single quotes to double quotes"]


def test_extract_json_combines_trailing_comma_and_single_quote_repairs():
    """Neither fix alone parses `{'a':1,}` — trailing-comma-only still has
    single quotes, quote-only still has the trailing comma — only the
    combined `both_fixed` branch in the ladder recovers it."""
    parsed, notes = _extract_json_with_notes("{'a':1,}")
    assert parsed == {"a": 1}
    assert notes == ["stripped a trailing comma", "converted single quotes to double quotes"]


def _dotted_name(node) -> str:
    """"json.loads" / "run_agent" / "" for anything else callable."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _is_file_read(node) -> bool:
    """`<something>.read_text()` — a task file off disk, not a model reply."""
    return isinstance(node, ast.Call) and _dotted_name(node.func).endswith("read_text")


def reply_parsing_offenders(source: str) -> list[str]:
    """Every call in `source` that could turn a model reply into JSON outside
    agent_runner.parse_agent_reply().

    An AST walk, not a substring scan: it can tell a genuine `run_agent(...)`
    call from the bare `run_agent` reference these modules legitimately pass as
    `run_agent_fn=`, and it can tell `json.loads(path.read_text())` (a task
    file) from `json.loads(reply["result"])` (a hand-rolled reply parse) —
    neither of which a grep can do without false positives or blind spots.
    """
    offenders = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            offenders += [f"from-import of {a.name}" for a in node.names if a.name == "extract_json"]
            continue
        if not isinstance(node, ast.Call):
            continue
        name = _dotted_name(node.func)
        if name in ("extract_json", "run_agent"):
            # run_agent() directly returns UNPARSED reply text — whatever the
            # caller does with it next is by definition outside the shared
            # retry/repair/salvage/handoff ladder.
            offenders.append(f"{name}() call on line {node.lineno}")
        elif name.endswith("json.loads") or name == "loads":
            if not _is_file_read(node.args[0] if node.args else None):
                offenders.append(f"{name}() on line {node.lineno} parses something that isn't a file read")
    return offenders


def test_pm_agent_and_step_agent_never_parse_a_reply_without_the_shared_helper():
    """Metric 14: farm/agent_runner.py's parse_agent_reply() must be the ONE
    place a reply is turned into JSON. Three ways to bypass it, all caught
    here: calling extract_json() directly, importing it, or calling run_agent()
    and hand-parsing the raw text with json.loads()."""
    repo_root = Path(__file__).resolve().parent.parent.parent
    for relative in ("farm/pm_agent.py", "farm/step_agent.py"):
        source = (repo_root / relative).read_text()
        offenders = reply_parsing_offenders(source)
        assert offenders == [], f"{relative} must parse replies via parse_agent_reply() only — found: {offenders}"
        assert "parse_agent_reply(" in source, f"{relative} must call the shared parse_agent_reply() helper"


def test_the_metric_14_guard_actually_catches_each_bypass():
    """The guard above only proves something if it can fail. Each of these
    three shapes is a real bypass a caller could write, and the scan must name
    every one of them."""
    assert reply_parsing_offenders("from .agent_runner import extract_json\n")
    assert reply_parsing_offenders('parsed = extract_json(reply["result"])\n')
    assert reply_parsing_offenders('reply = run_agent("do it")\n')
    assert reply_parsing_offenders('parsed = json.loads(reply["result"])\n')
    # ...and must NOT fire on what these modules legitimately do.
    assert reply_parsing_offenders("parse_agent_reply(prompt, run_agent_fn=run_agent)\n") == []
    assert reply_parsing_offenders("task = json.loads(task_path.read_text())\n") == []


def test_requirements_txt_gains_no_third_party_json_repair_dependency():
    """Guardrail 4: no json-repair-style dependency may be added — the
    repair ladder must be implemented in plain Python in agent_runner.py."""
    requirements = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text().lower()
    for banned in ("json-repair", "json_repair", "demjson", "dirtyjson"):
        assert banned not in requirements


# ---- a repair must never alter the model's own words ----


def test_trailing_comma_repair_leaves_string_contents_untouched():
    """QA finding: a `,(\\s*[}\\]])` regex also matches INSIDE a string value.
    This reply's only real defect is the trailing comma before `}` — the
    `, ]` sequence in the summary is the model's prose and must survive
    byte-for-byte. Before the string-aware rewrite this parsed as
    "fixed the list ] typo" (a comma silently deleted from the content) while
    the note claimed only a trailing comma had been stripped."""
    reply = '{"summary": "fixed the list, ] typo", "ok": true,}'
    parsed, notes = _extract_json_with_notes(reply)
    assert parsed == {"summary": "fixed the list, ] typo", "ok": True}
    assert notes == ["stripped a trailing comma"]


def test_trailing_comma_repair_preserves_a_comma_before_a_brace_inside_a_string():
    """Same defect class, object-closing variant, plus an escaped quote right
    before it — the string scanner must not end the literal on `\\"`."""
    reply = '{"summary": "see \\"note, }\\" below", "n": 1,}'
    parsed, notes = _extract_json_with_notes(reply)
    assert parsed == {"summary": 'see "note, }" below', "n": 1}
    assert notes == ["stripped a trailing comma"]


def test_trailing_comma_repair_handles_nested_arrays_and_whitespace():
    reply = '{\n  "items": [1, 2, 3,\n  ],\n  "ok": true,\n}'
    parsed, notes = _extract_json_with_notes(reply)
    assert parsed == {"items": [1, 2, 3], "ok": True}
    assert notes == ["stripped a trailing comma"]


# ---- _salvage_truncated_json: the two "never fabricate" give-up branches ----


def test_salvage_truncated_json_gives_up_on_a_mid_literal_cut():
    """`'{"b": tru'` has an open brace (recoverable-looking) but the patched
    text still doesn't parse, because the cut is mid-literal, not mid-string
    or mid-object — salvage must return None here rather than guess a value
    for `b`."""
    assert _salvage_truncated_json('{"b": tru') is None


def test_salvage_truncated_json_gives_up_when_nothing_is_open_at_eof():
    """Braces/strings are already balanced at EOF, so whatever is wrong with
    this text isn't exhaustion truncation — salvage must not touch it."""
    assert _salvage_truncated_json('{"a": 1} trailing garbage after') is None


@pytest.mark.parametrize("partial", ["{", "  {  ", '```json\n{', "{\n"])
def test_salvage_refuses_an_object_with_no_members_at_all(partial):
    """`{` is the likeliest capture when a budget runs out mid-JSON (it is
    exactly what test_run_agent_stamps_the_dispatched_provider_onto_an_exhaustion
    uses). Closing it yields `{}`, which PARSES — and accepting that turns a
    retryable AgentExhaustedError into the caller's own plain AgentError
    ("reply missing 'summary'"), which carries no reason="turn_cap", so the item
    pauses for a human where before HZ-124 it auto-retried. A memberless object
    carries nothing any caller can use, so salvage must refuse it."""
    assert _salvage_truncated_json(partial) is None


# ---- which field the truncation landed in (HZ-124) ----
# A salvaged value that the PATCH terminated rather than the model is a
# fragment: it parses, but it is not what the model meant to write. Salvage
# reports it so a gate-bearing caller can refuse it (see
# test_agent_runner_parse_reply.py) and so the note never claims more than it
# should.


def test_salvage_names_the_field_the_truncation_landed_in():
    parsed, notes, damaged = _salvage_truncated_json('{"url": "https://x/", "expected_text": "Horizon')
    assert parsed == {"url": "https://x/", "expected_text": "Horizon"}
    assert damaged == frozenset({"expected_text"})
    assert "cut off part-way through the 'expected_text' field" in notes[-1]


def test_salvage_reports_an_unclosed_nested_container_as_a_cut_field():
    parsed, _notes, damaged = _salvage_truncated_json('{"verdict": "fail", "findings": [{"detail": "one"}')
    assert parsed == {"verdict": "fail", "findings": [{"detail": "one"}]}
    assert damaged == frozenset({"findings"})


@pytest.mark.parametrize(
    "partial,expected",
    [
        ('{"a": 1, "b": "done"', {"a": 1, "b": "done"}),  # the model closed the string itself
        ('{"a": 1, "b": {"c": 2}', {"a": 1, "b": {"c": 2}}),  # ...and the nested object
        ('{"a": 1, "b": true', {"a": 1, "b": True}),  # a bare literal can only be read one way
    ],
)
def test_salvage_reports_no_cut_field_when_the_model_finished_the_value(partial, expected):
    parsed, _notes, damaged = _salvage_truncated_json(partial)
    assert parsed == expected
    assert damaged == frozenset()


def test_salvage_treats_a_trailing_bare_number_as_cut_because_12_may_have_been_123():
    """The one shape that cannot be verified: `12` is indistinguishable from a
    `123` the budget halved, so it counts as cut rather than intact."""
    _parsed, _notes, damaged = _salvage_truncated_json('{"a": "x", "count": 12')
    assert damaged == frozenset({"count"})


def test_a_field_dropped_by_rung_three_leaves_no_cut_field_behind():
    """Rung 3 keeps only whole members — everything it retains sits before the
    last top-level comma, so nothing it returns is a fragment."""
    parsed, _notes, damaged = _salvage_truncated_json('{"summary": "did a thing", "verdict":')
    assert parsed == {"summary": "did a thing"}
    assert damaged == frozenset()


# ---- metric 15 / QA: repair counter must honor a patched STATE_DIR ----


def test_record_repair_writes_to_the_current_state_dir_not_a_frozen_import_time_one(monkeypatch, tmp_path):
    """repair_stats_path() (and therefore _record_repair()) must read
    STATE_DIR at call time — a module-level constant bound at import would
    silently ignore monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    and every repair-triggering test would instead pollute the real,
    process-wide STATE_DIR."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    assert repair_stats_path() == tmp_path / "repair-stats.ndjson"

    _record_repair("stripped a trailing comma")

    stats_file = tmp_path / "repair-stats.ndjson"
    assert stats_file.exists()
    assert json.loads(stats_file.read_text().strip()) == {"path": "stripped a trailing comma"}


# ---- HZ-124 metric 8, subprocess-rollback half: partial_text/session_id on
# the FARM_RUNNER=subprocess timeout path (claude.py's _run_subprocess) ----


def test_subprocess_runner_timeout_carries_partial_text_and_no_session_id(monkeypatch):
    from farm.providers import base, claude

    monkeypatch.setenv("FARM_RUNNER", "subprocess")

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"), output="partial output before kill")

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    with pytest.raises(base.AgentExhaustedError) as exc_info:
        run_agent("prompt", timeout_s=5)
    assert exc_info.value.partial_text == "partial output before kill"
    assert exc_info.value.session_id is None


def test_subprocess_runner_timeout_decodes_the_raw_bytes_posix_hands_back(monkeypatch):
    """What a REAL timeout looks like: subprocess.TimeoutExpired.stdout is raw
    BYTES even under text=True, because on POSIX the timeout is raised from
    inside Popen._communicate's read loop, before the decode step. partial_text
    must still reach callers as str — the repair ladder and
    _salvage_truncated_json are str-only, so bytes there turned an
    auto-retryable exhaustion into an unclassified TypeError."""
    from farm.providers import base, claude

    monkeypatch.setenv("FARM_RUNNER", "subprocess")

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"), output=b'{"summary": "cut off mid')

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    with pytest.raises(base.AgentExhaustedError) as exc_info:
        run_agent("prompt", timeout_s=5)
    assert exc_info.value.partial_text == '{"summary": "cut off mid'
    # ...and that str is what makes the salvage possible at all.
    assert _salvage_truncated_json(exc_info.value.partial_text)[0] == {"summary": "cut off mid"}


def test_decode_partial_output_handles_the_three_shapes_a_provider_can_hand_it():
    from farm.providers.base import decode_partial_output

    assert decode_partial_output(b"bytes") == "bytes"
    assert decode_partial_output("str") == "str"
    assert decode_partial_output(None) == ""
    # Undecodable bytes must degrade, never raise mid-exhaustion-handling.
    assert decode_partial_output(b"ok \xff\xfe") == "ok ��"


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
