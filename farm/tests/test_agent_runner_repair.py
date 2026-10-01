"""HZ-157: the repair ladder inside the shared reply parser.

Two malformed shapes that cost a whole step run today are repaired — a trailing
comma (`{"a":1,}`) and single-quote delimiters (`{'a':1}`) — and every repair
that changes a byte reports a note. The review of HZ-124 attempt 9 rejected a
version where repairs happened silently; the bulk of this file is the proof that
cannot recur.

Three properties are load-bearing and each has its own section below:

* extract_json() is still byte-lossless. Repairs live only in the helper.
* no repair chooses between two readings of the same bytes until the lossless
  retry has actually run.
* nothing unrepairable is made to parse into plausible content. Raising is the
  correct outcome, and a near-miss that a rung ALMOST accepts must still raise.
"""

import json
from pathlib import Path

import pytest

from farm import agent_runner
from farm.agent_runner import (
    REPAIRS,
    SINGLE_QUOTE_NOTE,
    TRAILING_COMMA_NOTE,
    AgentError,
    AgentExhaustedError,
    Repair,
    extract_json,
    parse_agent_reply,
    record_repair,
    repair_counts,
)

TRAILING_COMMA = '{"a":1,}'
SINGLE_QUOTES = "{'a':1}"

# Bytes with more than one reading, or too little to read at all. Every one of
# these must raise: these are the near-misses a rung nearly accepts, which is
# where a fabrication would actually come from — not from obvious garbage.
NEAR_MISSES = [
    pytest.param('{\'a\':"b"}', id="mixed-quotes"),
    pytest.param("{'a':'it's fine'}", id="apostrophe-in-content"),
    pytest.param("{'a':'it\\'s fine'}", id="escaped-apostrophe"),
    pytest.param('{"s":"he said "hi" to me"}', id="unescaped-inner-quote"),
    pytest.param('{"a":1', id="truncated-no-closer"),
    pytest.param('{"a":1,,}', id="double-comma"),
    pytest.param('{"a":,}', id="comma-for-a-value"),
    # Both defects at once. Rungs are tried one at a time and never composed, so
    # each one alone leaves bytes that still fail and the reply raises — see the
    # ladder comment in agent_runner.py for why that limit is deliberate.
    pytest.param("{'a':1,}", id="both-defects-at-once"),
]


# The counter is repointed into tmp_path for every test in the suite by the
# autouse `repair_counter` fixture in farm/tests/conftest.py. It lives there
# rather than here because parse_agent_reply() ticks a real file from ANY test
# that happens to repair a reply, not only from the ones that assert on counts —
# so the tests that need the isolation are not the tests that cause the problem.


def recorder():
    """A retry callable that records that it ran and then fails to parse.

    Failing is the point for the ambiguous rungs: they are unlocked by the
    retry having RUN, and a retry that succeeds means no repair is needed.
    """
    calls: list[str] = []

    def retry(prompt: str) -> str:
        calls.append(prompt)
        return "still just prose"

    return retry, calls


# ---- the guardrail: extract_json() itself must not change bytes ----


@pytest.mark.parametrize("reply", [TRAILING_COMMA, SINGLE_QUOTES])
def test_the_raw_extractor_still_refuses_both_repairable_shapes(reply):
    """The repairs are in the HELPER, not in the extractor. A direct caller of
    extract_json() gets today's failure, which is what makes bypassing the
    helper useless as well as banned (farm/tests/test_one_reply_parser.py)."""
    with pytest.raises((AgentError, json.JSONDecodeError)):
        extract_json(reply)


def test_a_reply_that_parses_today_is_untouched_by_the_extractor():
    """The other half of losslessness: no repair leaked into the lossless path,
    so a well-formed reply still returns exactly its own value."""
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('prose {"a": "x, }"} prose') == {"a": "x, }"}


# ---- shape 1: the trailing comma, repaired before the retry is spent ----


def test_a_trailing_comma_parses_through_the_helper_with_a_note():
    retry, calls = recorder()
    parsed, notes = parse_agent_reply(TRAILING_COMMA, retry)
    assert parsed == {"a": 1}
    assert notes == [TRAILING_COMMA_NOTE]
    assert calls == [], "a trailing comma has one reading — it must not cost an agent run"


@pytest.mark.parametrize(
    "reply,expected",
    [
        ('{"a":1,}', {"a": 1}),
        ('{"a":[1,2,],}', {"a": [1, 2]}),
        ('{"a":1 ,\n}', {"a": 1}),
        ('{"a":{"b":1,},}', {"a": {"b": 1}}),
        ('```json\n{"reply":"ok","actions":[],}\n```', {"reply": "ok", "actions": []}),
    ],
)
def test_the_comma_rung_handles_every_position_it_claims(reply, expected):
    parsed, notes = parse_agent_reply(reply)
    assert parsed == expected
    assert notes == [TRAILING_COMMA_NOTE]


def test_the_comma_rung_never_edits_string_content():
    """The fabrication test for this rung. `", }"` is CONTENT — a rung that
    scanned bytes without the string state machine would silently delete a
    comma out of the middle of a value the model meant to send."""
    parsed, notes = parse_agent_reply('{"a":"x, }","b":[1,],}')
    assert parsed["a"] == "x, }", "a comma inside a string literal was edited"
    assert parsed["b"] == [1]
    assert notes == [TRAILING_COMMA_NOTE]


def test_an_escaped_quote_does_not_confuse_the_string_scanner():
    r"""`\"` keeps the scanner inside the literal; `\\` before a quote does
    not. Both are the shared _scan() contract, exercised through a repair."""
    parsed, _notes = parse_agent_reply(r'{"a":"say \", ] now","b":[1,]}')
    assert parsed == {"a": r'say ", ] now', "b": [1]}


# ---- shape 2: single quotes, and only after the lossless retry ----


def test_single_quotes_parse_through_the_helper_with_a_note():
    retry, calls = recorder()
    parsed, notes = parse_agent_reply(SINGLE_QUOTES, retry)
    assert parsed == {"a": 1}
    assert notes == [SINGLE_QUOTE_NOTE]
    assert len(calls) == 1, "an ambiguous repair must not skip the lossless retry"


def test_the_lossless_retry_runs_before_any_ambiguous_repair(monkeypatch):
    """The ordering guardrail, recorded rather than inferred.

    A shared list captures the retry call and the counter tick in the order
    they really happened, so this fails if a later change ever moves the
    ambiguous tier ahead of the retry.
    """
    order: list[str] = []
    real_record = agent_runner.record_repair

    def retry(prompt: str) -> str:
        order.append("retry")
        return "still just prose"

    def spy(name, path=None):
        order.append(f"repair:{name}")
        return real_record(name, path)

    monkeypatch.setattr(agent_runner, "record_repair", spy)
    parsed, notes = parse_agent_reply(SINGLE_QUOTES, retry)

    assert parsed == {"a": 1}
    assert order == ["retry", "repair:single_quotes"]
    assert notes == [SINGLE_QUOTE_NOTE]


def test_an_unescaped_inner_quote_raises_on_the_first_attempt():
    """The success metric's own input. It matches no rung, so the first attempt
    raises and the retry is what runs next — never a guess at which of those
    three quotes was meant to be a delimiter."""
    order: list[str] = []

    def retry(prompt: str) -> str:
        order.append("retry")
        return "still just prose"

    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply('{"s":"he said "hi" to me"}', retry)
    assert order == ["retry"], "something ran before or instead of the lossless retry"
    assert repair_counts() == {}


def test_the_single_quote_rung_refuses_a_span_containing_a_double_quote():
    """The precondition, at the rung. Re-quoting bytes that already use `"`
    would have to choose which quotes are delimiters."""
    assert agent_runner._repair_single_quotes('{\'a\':"b"}') == '{\'a\':"b"}'
    assert agent_runner._repair_single_quotes("{'a':1}") == '{"a":1}'


def test_a_rung_runs_on_the_extracted_span_not_the_whole_reply():
    """Scoping, on realistic bytes. A real reply carries prose and a fence
    around its JSON; a rung that inspected the whole reply would see the `"` in
    that prose and refuse, while still passing against a bare fixture."""
    reply = 'Done. He said "ok" to me.\n```json\n{\'a\':1}\n```\nHope that "helps".'
    retry, calls = recorder()
    parsed, notes = parse_agent_reply(reply, retry)
    assert parsed == {"a": 1}
    assert notes == [SINGLE_QUOTE_NOTE]
    assert len(calls) == 1


# ---- nothing unrepairable is made to parse ----


@pytest.mark.parametrize("reply", NEAR_MISSES)
def test_a_near_miss_raises_rather_than_parsing_into_plausible_content(reply):
    retry, calls = recorder()
    with pytest.raises((AgentError, json.JSONDecodeError)) as caught:
        parse_agent_reply(reply, retry)
    # No partial value smuggled out on the exception, and nothing counted.
    assert not hasattr(caught.value, "parsed")
    assert repair_counts() == {}
    assert len(calls) == 1, "the lossless retry is still owed on an unrepairable reply"


@pytest.mark.parametrize("reply", NEAR_MISSES)
def test_a_near_miss_with_no_retry_raises_too(reply):
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply(reply)
    assert repair_counts() == {}


def test_a_truncated_reply_is_not_salvaged_here():
    """Explicitly out of scope (part 3). A rung that closed the braces would be
    inventing the rest of the object."""
    for reply in ('{"a":1', '{"a":[1,2', '{"summary":"half a sen'):
        with pytest.raises((AgentError, json.JSONDecodeError)):
            parse_agent_reply(reply)


def test_the_failure_a_caller_sees_is_unchanged_in_type_and_message():
    """The repair layer added try/except nesting. An unrepairable reply must
    still fail with byte-identical text, because the retry prompt embeds it."""
    reply = '{"s":"he said "hi" to me"}'
    with pytest.raises(json.JSONDecodeError) as via_helper:
        parse_agent_reply(reply)
    with pytest.raises(json.JSONDecodeError) as via_extractor:
        extract_json(reply)
    assert str(via_helper.value) == str(via_extractor.value)


# ---- a validator rejection means the rung FAILED ----


def test_a_repaired_value_is_handed_to_the_callers_validator():
    """validate()'s return value is what the caller consumes — concierge_agent
    unpacks a 4-tuple out of it. An unvalidated repair would hand it a raw
    dict and crash the unpack."""
    parsed, notes = parse_agent_reply(
        '{"summary":"done",}', validate=lambda p: (p["summary"], "extra")
    )
    assert parsed == ("done", "extra")
    assert notes == [TRAILING_COMMA_NOTE]


def test_a_rung_whose_value_the_validator_rejects_has_failed_not_succeeded():
    """No note, no tick, and the retry is still spent: a repaired value the
    caller would refuse is no better than no value at all.

    The comma rung DOES fire on these bytes and produces `{"a":1}` — the
    validator then refuses it, so the run continues to the retry and ends on
    the retry's own failure, exactly as an unrepairable reply would.
    """
    retry, calls = recorder()
    with pytest.raises((AgentError, json.JSONDecodeError)) as caught:
        parse_agent_reply(TRAILING_COMMA, retry, validate=_needs_summary)
    assert "still just prose" in str(caught.value), "the retry's failure should be what stands"
    assert repair_counts() == {}, "a repair the caller refused must not be counted"
    assert len(calls) == 1


def test_a_validator_rejection_of_a_clean_reply_never_triggers_a_repair():
    """The reply PARSES; it is just missing a field. Editing its bytes could
    only invent a different object, so no rung may run on it — not before the
    retry and not after it."""
    retry, calls = recorder()
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply('{"patch":{}}', retry, validate=_needs_summary)
    assert repair_counts() == {}
    assert len(calls) == 1


def test_a_validator_rejection_of_a_clean_RETRY_never_triggers_a_repair(monkeypatch):
    """The same rule, applied to the retried text — the symmetric case, which is
    easy to miss because the pre-retry branch reads as if it covered it.

    A rung that could edit a reply the lossless ladder already parsed is the
    fabrication risk restated: `{'x':1}` here parses to a real object the
    validator refuses, and re-quoting it would only produce a DIFFERENT object
    to offer the validator instead.
    """
    seen: list[str] = []

    def spy(text, *, ambiguous, validate):
        seen.append(text)
        return None

    monkeypatch.setattr(agent_runner, "_repair_ladder", spy)
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply("no json here", lambda prompt: '{"patch":{}}', validate=_needs_summary)
    assert "{\"patch\":{}}" not in seen, "a losslessly-parsed retry was handed to a rung"


def _needs_summary(parsed):
    if not parsed.get("summary"):
        raise AgentError("agent reply missing 'summary'")
    return parsed


# ---- ordering and tier declarations ----


def test_exactly_one_rung_may_run_before_the_retry():
    """The classification is a field, not prose, so it can be asserted. A rung
    added to the unambiguous tier has to change this line, in this test, with a
    reason — which is the review the guardrail actually wants."""
    assert [r.name for r in REPAIRS if not r.ambiguous] == ["trailing_comma"]
    assert [r.name for r in REPAIRS if r.ambiguous] == ["single_quotes"]


def test_no_ambiguous_rung_fires_when_the_caller_declined_the_retry():
    """step_agent's implement step passes no retry, so the lossless retry can
    never run — and the guardrail is that no ambiguous repair precedes it."""
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply(SINGLE_QUOTES)
    assert repair_counts() == {}


def test_an_unambiguous_rung_still_fires_without_a_retry():
    """The other side: the implement step is exactly the caller this item's
    stated pain is about, and it has no retry to spend."""
    parsed, notes = parse_agent_reply('{"summary":"built it",}')
    assert parsed == {"summary": "built it"}
    assert notes == [TRAILING_COMMA_NOTE]


def test_a_losslessly_parsed_fallback_beats_a_repairable_retry():
    """One of the two branches the plan left undefined, decided here: lossless
    beats repaired. The original reply's leading object parsed from UNALTERED
    bytes, so it wins over a repair of the retried text, and the retry's
    repairable comma is never counted."""
    shadowed = '{"a":1} prose {"b":2}'
    parsed, notes = parse_agent_reply(shadowed, lambda prompt: '{"c":3,}')
    assert parsed == {"a": 1}
    assert notes == [agent_runner.FIRST_OBJECT_NOTE]
    assert repair_counts() == {}


def test_a_reply_the_scanner_could_parse_is_never_repaired():
    """The other undefined branch. _extract_json() succeeded — by attempt 3,
    with a pre-scan failure recorded — so no rung runs on those bytes at all,
    and the retry still wins exactly as it did before this item."""
    parsed, notes = parse_agent_reply('{"a":1} prose {"b":2}', lambda prompt: '{"real":1}')
    assert parsed == {"real": 1}
    assert notes == []
    assert repair_counts() == {}, "a reply the lossless ladder could parse was repaired"


def test_a_shadowed_reply_that_also_needs_a_comma_removed_reports_both_facts():
    """The comma denies attempt 3 the scan it would otherwise have made, so the
    rung IS reached here — and both things true of these bytes are reported: a
    comma was removed, and only the first of two objects was usable."""
    parsed, notes = parse_agent_reply('{"a":1,} prose {"b":2}')
    assert parsed == {"a": 1}
    assert notes == [TRAILING_COMMA_NOTE, agent_runner.FIRST_OBJECT_NOTE]


def test_a_repair_of_the_retried_reply_is_reported_against_the_retried_text():
    """When the original is unparseable and unrepairable, the model's second
    attempt is what gets repaired — and the note travels with it rather than
    describing the bytes the original reply never had."""
    parsed, notes = parse_agent_reply("no json at all", lambda prompt: '{"summary":"second try",}')
    assert parsed == {"summary": "second try"}
    assert notes == [TRAILING_COMMA_NOTE]
    assert repair_counts() == {"trailing_comma": 1}


def test_the_retried_reply_is_repaired_when_the_original_cannot_be():
    parsed, notes = parse_agent_reply(
        '{"s":"he said "hi" to me"}', lambda prompt: "prose {'a':1} prose"
    )
    assert parsed == {"a": 1}
    assert notes == [SINGLE_QUOTE_NOTE]
    assert repair_counts() == {"single_quotes": 1}


# ---- no byte change without a note, no note without a byte change ----


def test_a_rung_that_changes_nothing_is_skipped_before_any_parse_attempt():
    """Asserted at the rung, not just through its absent note: a declining rung
    must be indistinguishable from a rung that does not exist."""
    assert agent_runner._repair_trailing_commas('{"a":1}') == '{"a":1}'
    assert agent_runner._repair_single_quotes('{"a":1}') == '{"a":1}'
    assert agent_runner._repair_ladder('{"a":1}', ambiguous=False, validate=None) is None


@pytest.mark.parametrize(
    "reply", ['{"a": 1}', '```json\n{"a": 1}\n```', 'prose {"a":1} prose', "[1, 2]", "{}"]
)
def test_a_clean_reply_produces_no_note_and_no_tick(reply):
    """The 'behaviour otherwise unchanged' proof for this item: every reply that
    parsed before the ladder existed still parses with an empty notes list."""
    retry, calls = recorder()
    _parsed, notes = parse_agent_reply(reply, retry)
    assert notes == []
    assert calls == []
    assert repair_counts() == {}


def test_every_repair_that_changed_bytes_carries_its_own_note():
    """The HZ-124 attempt-9 failure mode, stated as an invariant over the whole
    ladder: pair each rung with an input it repairs and assert the note."""
    for reply, rung in ((TRAILING_COMMA, REPAIRS[0]), (SINGLE_QUOTES, REPAIRS[1])):
        retry, _calls = recorder()
        _parsed, notes = parse_agent_reply(reply, retry)
        assert rung.note in notes, f"{rung.name} changed bytes without a note"


def test_an_injected_seam_note_still_reaches_a_repaired_reply(monkeypatch):
    """The HZ-156 seam keeps working underneath the repair ladder."""
    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["seam note"])
    _parsed, notes = parse_agent_reply(TRAILING_COMMA)
    assert notes == [TRAILING_COMMA_NOTE, "seam note"]


# ---- the counter ----


def test_each_repair_path_is_counted_separately(repair_counter):
    retry, _calls = recorder()
    parse_agent_reply(TRAILING_COMMA)
    parse_agent_reply(TRAILING_COMMA)
    parse_agent_reply(SINGLE_QUOTES, retry)
    assert repair_counts() == {"trailing_comma": 2, "single_quotes": 1}
    assert repair_counter.exists()


def test_the_counter_ticks_with_the_state_directory_absent(repair_counter):
    """Without an explicit mkdir every tick is dropped into a missing directory
    and the script prints zeros forever — a metric that passes its own test
    while measuring nothing. STATE_DIR is created by config.ensure_dirs() at
    farmd startup, and an agent process may never have run it."""
    assert not repair_counter.parent.exists()
    parse_agent_reply(TRAILING_COMMA)
    assert repair_counts() == {"trailing_comma": 1}


def test_a_corrupt_counter_file_never_fails_a_parse(repair_counter):
    repair_counter.parent.mkdir(parents=True)
    repair_counter.write_text("{not json at all")
    parsed, notes = parse_agent_reply(TRAILING_COMMA)
    assert parsed == {"a": 1} and notes == [TRAILING_COMMA_NOTE]
    assert repair_counts() == {"trailing_comma": 1}  # rewritten from scratch


def test_an_unwritable_counter_never_fails_a_parse(repair_counter, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(Path, "mkdir", boom)
    parsed, notes = parse_agent_reply(TRAILING_COMMA)
    assert parsed == {"a": 1} and notes == [TRAILING_COMMA_NOTE]


def test_unknown_keys_survive_a_tick(repair_counter):
    """A rung added by part 3 must not erase part 2's totals, and vice versa."""
    repair_counter.parent.mkdir(parents=True)
    repair_counter.write_text(json.dumps({"truncation": 7}))
    parse_agent_reply(TRAILING_COMMA)
    assert repair_counts() == {"truncation": 7, "trailing_comma": 1}


def test_a_missing_counter_file_reads_as_empty_rather_than_raising(tmp_path):
    assert repair_counts(tmp_path / "nope.json") == {}


def test_non_integer_counter_values_are_dropped_not_coerced(tmp_path):
    path = tmp_path / "counts.json"
    path.write_text(json.dumps({"good": 3, "bad": "many", "worse": None, "nope": True}))
    assert repair_counts(path) == {"good": 3}


def test_a_counter_file_that_is_not_an_object_reads_as_empty(tmp_path):
    path = tmp_path / "counts.json"
    path.write_text("[1, 2, 3]")
    assert repair_counts(path) == {}


def test_record_repair_accepts_an_explicit_path(tmp_path):
    path = tmp_path / "deep" / "counts.json"
    record_repair("trailing_comma", path)
    record_repair("trailing_comma", path)
    assert repair_counts(path) == {"trailing_comma": 2}


def test_no_temporary_file_is_left_behind(repair_counter):
    parse_agent_reply(TRAILING_COMMA)
    assert list(repair_counter.parent.iterdir()) == [repair_counter]


def test_a_failed_rename_leaves_no_temporary_file_behind(repair_counter, monkeypatch):
    """The split failure the happy-path test above cannot see: write_text()
    SUCCEEDS and os.replace() is what raises. Without an unlink in the handler
    a half-written `.tmp` sits in STATE_DIR forever, and nothing cleans it up —
    one orphan per failed tick."""

    def boom(src, dst):
        raise OSError("rename failed")

    repair_counter.parent.mkdir(parents=True)
    monkeypatch.setattr(agent_runner.os, "replace", boom)

    parsed, notes = parse_agent_reply(TRAILING_COMMA)

    assert parsed == {"a": 1} and notes == [TRAILING_COMMA_NOTE]
    assert list(repair_counter.parent.iterdir()) == [], "a .tmp sibling was left behind"


def test_a_cleanup_that_also_fails_still_never_fails_a_parse(repair_counter, monkeypatch):
    """The handler's own handler. Nothing about a counter — not the write, not
    the rename, not tidying up after them — may be the reason a step failed."""

    def boom(*args, **kwargs):
        raise OSError("filesystem gone")

    repair_counter.parent.mkdir(parents=True)
    monkeypatch.setattr(agent_runner.os, "replace", boom)
    monkeypatch.setattr(Path, "unlink", boom)

    parsed, notes = parse_agent_reply(TRAILING_COMMA)

    assert parsed == {"a": 1} and notes == [TRAILING_COMMA_NOTE]


# ---- exhaustion is never mistaken for a parse failure ----


def test_an_exhaustion_from_the_retry_propagates_untouched():
    """The HZ-156 guarantee. New try/except layers are exactly what breaks it:
    the orchestrator auto-retries a run only while it carries this type."""

    def retry(prompt: str) -> str:
        raise AgentExhaustedError("ran out of turns")

    with pytest.raises(AgentExhaustedError, match="ran out of turns"):
        parse_agent_reply(SINGLE_QUOTES, retry)


def test_an_exhaustion_from_inside_a_rung_propagates_untouched(monkeypatch):
    """A rung is pure text editing, so apply() is called outside the ladder's
    try block — swallowing an exception from one would hide a real bug."""

    def boom(span):
        raise AgentExhaustedError("exhausted mid-repair")

    monkeypatch.setattr(
        agent_runner, "REPAIRS", (Repair("boom", False, "boom note", boom),)
    )
    with pytest.raises(AgentExhaustedError, match="exhausted mid-repair"):
        parse_agent_reply(TRAILING_COMMA)


def test_an_exhaustion_from_a_validator_on_a_repaired_value_propagates(monkeypatch):
    def validate(parsed):
        raise AgentExhaustedError("exhausted in validate")

    with pytest.raises(AgentExhaustedError, match="exhausted in validate"):
        parse_agent_reply(TRAILING_COMMA, validate=validate)


# ---- the kill switch reads at call time ----


def test_repairs_can_be_switched_off_at_call_time(monkeypatch):
    """An import-bound flag is a rollback lever that does not move: it cannot be
    flipped by a restart's env or by this test. Read per call, like
    _selected_provider_name() above it."""
    monkeypatch.setenv("FARM_REPLY_REPAIR", "0")
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply(TRAILING_COMMA)
    assert repair_counts() == {}


def test_repairs_are_on_by_default():
    """The switch defaults to enabled, so no host needs configuring for this
    item to do anything."""
    assert agent_runner._repairs_enabled() is True


@pytest.mark.parametrize("value", ["0", "false", "no", "FALSE", " 0 "])
def test_the_switch_recognises_every_off_spelling(monkeypatch, value):
    monkeypatch.setenv("FARM_REPLY_REPAIR", value)
    assert agent_runner._repairs_enabled() is False


# ---- pathological input stays linear ----


def test_ten_thousand_commas_complete_in_one_pass():
    """One forward scan, no backtracking. A quadratic rung would hang the farm
    on a reply a model can produce by accident."""
    reply = "{" + "," * 10_000 + "}"
    with pytest.raises((AgentError, json.JSONDecodeError)):
        parse_agent_reply(reply)


def test_a_huge_well_formed_reply_with_one_trailing_comma_repairs():
    body = ",".join(f'"k{i}":{i}' for i in range(2_000))
    parsed, notes = parse_agent_reply("{" + body + ",}")
    assert parsed["k1999"] == 1999
    assert notes == [TRAILING_COMMA_NOTE]


# ---- the no-new-dependency guardrail, as a test ----


def test_the_farm_requirements_are_unchanged_and_carry_no_json_repair_library():
    """Verified here rather than by hand: a guardrail a reviewer has to
    remember to check is a guardrail that eventually is not checked. The repair
    ladder is ~80 lines of this repo's own code precisely so this list can stay
    exactly as it was."""
    path = Path(agent_runner.__file__).resolve().parent / "requirements.txt"
    declared = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    assert declared == [
        "fastapi>=0.115",
        "uvicorn>=0.32",
        "httpx>=0.27",
        "httpx2>=0",
        "claude-agent-sdk>=0.2",
    ]
    lowered = path.read_text().lower()
    for banned in ("json-repair", "jsonrepair", "json5", "demjson", "dirtyjson", "hjson", "pyjson5"):
        assert banned not in lowered, f"{banned} is a JSON-repair dependency this item must not add"
