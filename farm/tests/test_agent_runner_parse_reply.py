"""farm.agent_runner.parse_agent_reply(): the ONE shared run_agent + extract_json
+ retry/repair/salvage/handoff helper (HZ-124 metric 14). pm_agent.py and
step_agent.py both delegate to this — see test_pm_agent.py / test_step_agent.py
for the caller-side integration; this file drives the helper directly.
"""

import pytest

from farm.agent_runner import AgentError, AgentExhaustedError, parse_agent_reply, read_and_clear_handoff_note


# ---- real-provider e2e: the pipeline over an actual dispatch, not a mock ----
# Every other test in this file passes run_agent_fn=<a hand-rolled closure>,
# which proves parse_agent_reply()'s own control flow but never exercises the
# real seam (agent_runner.run_agent -> providers.claude -> the subprocess
# boundary). This one leaves run_agent_fn at its default and drives
# fake_claude — the same subprocess stand-in test_agent_runner.py's
# test_run_agent_with_fake_binary and test_hz44_real_subprocess_... rely on
# — through the real repair ladder.


def test_parse_agent_reply_drives_a_real_subprocess_dispatch_through_the_repair_ladder(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")

    parsed, reply_meta, notes = parse_agent_reply("HZ124_REPAIR_LADDER do the thing", max_turns=4, timeout_s=30)

    assert parsed == {"summary": "trailing comma bug"}
    assert notes == ["stripped a trailing comma"]
    assert reply_meta["session_id"] == "fake-session-hz124"


def sequenced_run_agent(replies, calls):
    def _fake(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        reply = replies[len(calls) - 1]
        if isinstance(reply, Exception):
            raise reply
        return reply

    return _fake


# ---- metric 5 / guardrail 1: lossless retry before any ambiguous repair ----


def test_parse_agent_reply_retries_once_before_giving_up():
    calls = []
    bad = '{"s":"he said "hi" to me"}'  # unescaped inner quote — genuinely ambiguous
    good = '{"s":"he said hi to me"}'
    fake = sequenced_run_agent(
        [{"result": bad, "session_id": "sess-1"}, {"result": good, "session_id": "sess-1"}], calls
    )

    parsed, reply_meta, notes = parse_agent_reply("do it", run_agent_fn=fake)

    assert len(calls) == 2  # exactly one retry, no repair attempted on the ambiguous text
    assert parsed == {"s": "he said hi to me"}
    assert notes == []
    assert reply_meta["session_id"] == "sess-1"
    assert calls[1]["session_id"] == "sess-1"  # retry resumes the same session
    assert calls[1]["prompt"].startswith("Your previous reply was invalid:")


def test_parse_agent_reply_a_second_failure_still_raises_without_fabricating():
    """Metric 6: unrepairable input still raises — no fabricated content."""
    calls = []
    bad = '{"s":"oops"'  # truncated, unparseable both times
    fake = sequenced_run_agent([{"result": bad}, {"result": bad}], calls)

    with pytest.raises(AgentError):
        parse_agent_reply("do it", run_agent_fn=fake)
    assert len(calls) == 2  # exactly one retry — no retry loop


def test_parse_agent_reply_returns_ladder_notes_without_needing_a_retry():
    calls = []
    fake = sequenced_run_agent([{"result": '{"a":1,}'}], calls)

    parsed, _meta, notes = parse_agent_reply("do it", run_agent_fn=fake)

    assert len(calls) == 1  # the deterministic repair succeeded — no retry call spent
    assert parsed == {"a": 1}
    assert notes == ["stripped a trailing comma"]


def test_parse_agent_reply_produces_no_notes_on_a_clean_reply():
    calls = []
    fake = sequenced_run_agent([{"result": '{"summary": "done"}'}], calls)
    _parsed, _meta, notes = parse_agent_reply("do it", run_agent_fn=fake)
    assert notes == []


def test_parse_agent_reply_retry_on_failure_false_returns_none_instead_of_raising():
    """The implement step's own tolerance for a malformed final reply (HZ-29):
    the code in the workspace is the deliverable, not the message."""
    calls = []
    fake = sequenced_run_agent([{"result": "not json at all"}], calls)

    parsed, _meta, notes = parse_agent_reply("do it", run_agent_fn=fake, retry_on_failure=False)

    assert len(calls) == 1  # no retry spent
    assert parsed is None
    assert notes == []


# ---- metric 9: exhaustion salvage of a truncated-but-valid reply ----


def test_parse_agent_reply_salvages_a_reply_truncated_mid_string():
    calls = []
    truncated = '{"summary": "partially done, cut off mid'
    exc = AgentExhaustedError("claude timed out", partial_text=truncated, session_id="sess-exhausted")
    fake = sequenced_run_agent([exc], calls)

    parsed, reply_meta, notes = parse_agent_reply("do it", run_agent_fn=fake)

    assert len(calls) == 1  # salvage succeeded — no handoff call needed
    assert parsed == {"summary": "partially done, cut off mid"}
    assert reply_meta["session_id"] == "sess-exhausted"
    assert notes and "salvaged" in notes[0]


def test_salvage_closes_and_then_strips_the_trailing_comma_it_just_exposed():
    """Closing a reply cut off right after a structural comma yields
    `{"a":1,}` — the single most common truncation shape, and one that does
    not parse until the trailing comma goes too."""
    calls = []
    exc = AgentExhaustedError("out of turns", partial_text='{"summary": "did a thing", ', session_id="s")
    parsed, _meta, notes = parse_agent_reply("do it", run_agent_fn=sequenced_run_agent([exc], calls))

    assert parsed == {"summary": "did a thing"}
    assert notes == [
        "salvaged a reply truncated mid-string/object at the point of turn-budget exhaustion",
        "stripped a trailing comma",
    ]


@pytest.mark.parametrize(
    "partial",
    [
        '{"summary": "did a thing", "verdic',  # cut mid-key
        '{"summary": "did a thing", "verdict":',  # cut after the colon
        '{"summary": "did a thing", "verdict": tru',  # cut mid-literal
    ],
)
def test_salvage_drops_an_incomplete_trailing_field_no_closing_punctuation_can_rescue(partial):
    """Rung 3 of the ladder. What survives is a strict subset of the bytes the
    model actually wrote — the half-written field is dropped, never guessed at."""
    calls = []
    exc = AgentExhaustedError("out of turns", partial_text=partial, session_id="s")
    parsed, _meta, notes = parse_agent_reply("do it", run_agent_fn=sequenced_run_agent([exc], calls))

    assert parsed == {"summary": "did a thing"}
    assert "dropped an incomplete trailing field" in notes[-1]


def test_salvage_still_refuses_input_that_is_not_a_truncation(monkeypatch, tmp_path):
    """Guardrail: unrepairable input must not be made to parse into plausible
    content. No rung of the ladder may invent a field."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    calls = []
    exc = AgentExhaustedError("out of turns", partial_text="I was about to write some JSON", session_id="s")

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply("do it", run_agent_fn=sequenced_run_agent([exc], calls))


# ---- gate safety: a salvage missing a gated field is refused ----
# A reply cut off one byte after `"verdict": "pass"` salvages cleanly, and
# step_agent's _code_review_section then reads the absent "findings" as [] —
# a findings-free PASS through the review gate, where before HZ-124 the run
# failed as turn_cap and auto-retried. salvage_required_keys is what stops a
# salvage from ever loosening a gate.


def test_a_salvage_missing_a_required_key_is_refused_and_the_run_stays_retryable(monkeypatch, tmp_path, capsys):
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    calls = []
    truncated = '{"summary": "reviewed the diff", "verdict": "pass"'
    exc = AgentExhaustedError("out of turns", partial_text=truncated, session_id="s")

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply(
            "review it",
            run_agent_fn=sequenced_run_agent([exc, {"result": "note"}], calls),
            salvage_required_keys=("verdict", "findings"),
        )

    assert "salvage: refused" in capsys.readouterr().out
    assert '"path": "salvage_refused_incomplete"' in (tmp_path / "repair-stats.ndjson").read_text()


def test_the_same_bytes_salvage_fine_for_a_step_whose_output_gates_nothing():
    """The other half of the pair above: the refusal is scoped to callers that
    NAME a gated key, so a planning step still keeps its 26 minutes of work."""
    calls = []
    truncated = '{"summary": "reviewed the diff", "verdict": "pass"'
    exc = AgentExhaustedError("out of turns", partial_text=truncated, session_id="s")

    parsed, _meta, _notes = parse_agent_reply("plan it", run_agent_fn=sequenced_run_agent([exc], calls))

    assert parsed == {"summary": "reviewed the diff", "verdict": "pass"}


def test_a_salvage_carrying_every_required_key_is_accepted():
    calls = []
    truncated = '{"verdict": "fail", "findings": [], "summary": "cut off mid'
    exc = AgentExhaustedError("out of turns", partial_text=truncated, session_id="s")

    parsed, _meta, notes = parse_agent_reply(
        "review it",
        run_agent_fn=sequenced_run_agent([exc], calls),
        salvage_required_keys=("verdict", "findings"),
    )

    assert parsed == {"verdict": "fail", "findings": [], "summary": "cut off mid"}
    assert notes


# ---- HZ-102 provenance survives an exhaustion salvage ----


def test_a_salvaged_reply_keeps_the_provider_and_command_id_off_the_exception():
    """A salvaged muse_smoke_test run must still record WHICH provider ran —
    writing NULL provenance would quietly delete HZ-102's guarantee on exactly
    the runs that needed salvaging."""
    calls = []
    exc = AgentExhaustedError(
        "muse reported exhaustion",
        partial_text='{"summary": "cut off mid',
        session_id="sess-muse",
        provider="muse",
        command_id="cmd-42",
    )

    _parsed, reply_meta, _notes = parse_agent_reply("do it", run_agent_fn=sequenced_run_agent([exc], calls))

    assert reply_meta == {"provider": "muse", "command_id": "cmd-42", "session_id": "sess-muse"}


def test_run_agent_stamps_the_dispatched_provider_onto_an_exhaustion(monkeypatch):
    """The provenance above is stamped at the one dispatch chokepoint, so no
    provider has to remember to do it."""
    from farm import agent_runner
    from farm.providers import claude

    def _boom(*args, **kwargs):
        raise AgentExhaustedError("error_max_turns", partial_text="{", session_id="s")

    monkeypatch.setattr(claude, "run", _boom)
    monkeypatch.setattr(claude, "assert_subscription_auth", lambda: None)

    with pytest.raises(AgentExhaustedError) as exc_info:
        agent_runner.run_agent("do it", provider="claude")

    assert exc_info.value.provider == "claude"


# ---- metric 10: handoff fires at most once per run, only on exhaustion ----


def test_parse_agent_reply_fires_a_handoff_when_salvage_fails(monkeypatch, tmp_path):
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    unsalvageable = "not JSON and not truncated-JSON either"
    exc = AgentExhaustedError("claude timed out", partial_text=unsalvageable, session_id="sess-exhausted")
    handoff_reply = {"result": "Finished the schema migration; still need to wire up the API route."}
    fake = sequenced_run_agent([exc, handoff_reply], calls)

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply(
            "do it",
            run_agent_fn=fake,
            max_turns=8,
            handoff_item_id="HZ-1",
            handoff_step_index=11,
        )

    assert len(calls) == 2  # the main exhausting call, plus exactly one handoff call
    handoff_call = calls[1]
    assert handoff_call["session_id"] == "sess-exhausted"  # resumes the exhausted session
    assert handoff_call["max_turns"] < 8  # strictly below the step's own budget

    note = read_and_clear_handoff_note("HZ-1", 11)
    assert note == "Finished the schema migration; still need to wire up the API route."
    # Read-once: a second read (e.g. a re-queued attempt) must not see it again.
    assert read_and_clear_handoff_note("HZ-1", 11) is None


@pytest.mark.parametrize("step_max_turns", [1, 2, 3, 8, 40])
def test_the_handoff_budget_is_always_strictly_below_the_steps_own(monkeypatch, tmp_path, step_max_turns):
    """Strictly below, with no max(1, ...) floor: on a 1-turn step, clamping up
    to 1 would make the handoff call as expensive as the step it reports on, so
    the correct outcome is to skip it — worst case is no note, which is exactly
    pre-HZ-124 behaviour."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    exc = AgentExhaustedError("timed out", partial_text="garbage, not json", session_id="sess-1")
    fake = sequenced_run_agent([exc, {"result": "got about halfway"}], calls)

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply(
            "do it",
            run_agent_fn=fake,
            max_turns=step_max_turns,
            handoff_item_id="HZ-3",
            handoff_step_index=4,
        )

    if step_max_turns == 1:
        assert len(calls) == 1  # no room underneath a 1-turn budget — skipped, not clamped
        assert '"path": "handoff_skipped_no_budget"' in (tmp_path / "repair-stats.ndjson").read_text()
    else:
        assert calls[1]["max_turns"] < step_max_turns
        assert calls[1]["max_turns"] >= 1


def test_handoff_never_fires_twice_across_two_consecutive_exhaustions(monkeypatch, tmp_path):
    """The main call exhausts (salvage fails, handoff fires and ALSO
    exhausts). Guardrail: no retry of the handoff call itself, and the
    ORIGINAL exception still propagates — never the handoff's."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    main_exc = AgentExhaustedError("main run timed out", partial_text="garbage, not json", session_id="sess-1")
    handoff_exc = AgentExhaustedError("handoff call also timed out", partial_text="", session_id="sess-1")
    fake = sequenced_run_agent([main_exc, handoff_exc], calls)

    with pytest.raises(AgentExhaustedError, match="main run timed out"):
        parse_agent_reply(
            "do it",
            run_agent_fn=fake,
            handoff_item_id="HZ-2",
            handoff_step_index=4,
        )

    assert len(calls) == 2  # main call + one handoff attempt — no third call
    assert read_and_clear_handoff_note("HZ-2", 4) is None  # the failed handoff wrote nothing


@pytest.mark.parametrize(
    "handoff_failure",
    [
        TypeError("provider shim called with an unexpected kwarg"),
        OSError("connection reset by peer"),
        RuntimeError("something nobody anticipated"),
    ],
    ids=["TypeError", "OSError", "RuntimeError"],
)
def test_a_non_agent_error_handoff_failure_never_costs_the_turn_cap_classification(
    monkeypatch, tmp_path, handoff_failure
):
    """QA finding: _fire_handoff() catching only AgentError let anything else
    the best-effort handoff call raised escape _handle_exhaustion() BEFORE its
    `raise exc` — so pm_agent/step_agent never saw an AgentExhaustedError,
    never tagged reason="turn_cap", and the item paused for a human instead of
    auto-retrying. The ORIGINAL exhaustion must always be what propagates."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    main_exc = AgentExhaustedError("main run timed out", partial_text="garbage, not json", session_id="sess-1")
    fake = sequenced_run_agent([main_exc, handoff_failure], calls)

    with pytest.raises(AgentExhaustedError, match="main run timed out") as exc_info:
        parse_agent_reply("do it", run_agent_fn=fake, handoff_item_id="HZ-5", handoff_step_index=7)

    assert exc_info.value is main_exc  # not the handoff's failure, not a new exception
    assert len(calls) == 2  # one handoff attempt, never retried
    assert read_and_clear_handoff_note("HZ-5", 7) is None


def test_a_failed_handoff_is_contained_but_not_silent(monkeypatch, tmp_path, capsys):
    """Contained is not the same as silent (guardrail: failures stay
    observable) — the giving-up reason prints, and the counter records it so
    farm/scripts/repair_stats.py shows handoff failures alongside firings."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    main_exc = AgentExhaustedError("main run timed out", partial_text="not json", session_id="sess-1")
    fake = sequenced_run_agent([main_exc, TypeError("boom")], calls)

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply("do it", run_agent_fn=fake, handoff_item_id="HZ-6", handoff_step_index=7)

    out = capsys.readouterr().out
    assert "handoff note: giving up" in out
    assert "TypeError" in out
    assert '"path": "handoff_failed"' in (tmp_path / "repair-stats.ndjson").read_text()


def test_a_non_str_partial_text_cannot_cost_the_turn_cap_classification(monkeypatch, tmp_path):
    """Defence in depth on the salvage half of the same failure mode: a
    provider that hands back bytes (subprocess.TimeoutExpired.stdout is raw
    bytes even in text mode — see providers/base.decode_partial_output) must
    not turn an auto-retryable exhaustion into an unclassified TypeError."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    exc = AgentExhaustedError("timed out", partial_text=b'{"summary": "cut off mid', session_id=None)
    fake = sequenced_run_agent([exc], calls)

    with pytest.raises(AgentExhaustedError, match="timed out"):
        parse_agent_reply("do it", run_agent_fn=fake)


def test_on_exhaustion_reraise_skips_salvage_and_handoff_entirely(monkeypatch, tmp_path):
    """The implement step's on_exhaustion="reraise": HZ-31's own checkpoint
    salvage is the only recovery for this step — guardrail 10."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)

    calls = []
    truncated = '{"summary": "cut off mid'  # would otherwise salvage cleanly
    exc = AgentExhaustedError("timed out", partial_text=truncated, session_id="sess-1")
    fake = sequenced_run_agent([exc], calls)

    with pytest.raises(AgentExhaustedError):
        parse_agent_reply(
            "do it",
            run_agent_fn=fake,
            on_exhaustion="reraise",
            handoff_item_id="HZ-3",
            handoff_step_index=11,
        )

    assert len(calls) == 1  # no handoff call attempted
    assert read_and_clear_handoff_note("HZ-3", 11) is None


# ---- handoff note file: read-once, unverified wording (metric 11) ----


def test_read_and_clear_handoff_note_is_read_once(monkeypatch, tmp_path):
    from farm.agent_runner import _write_handoff_note

    monkeypatch.setattr("farm.agent_runner.STATE_DIR", tmp_path)
    _write_handoff_note("HZ-9", 6, "made good progress")
    assert read_and_clear_handoff_note("HZ-9", 6) == "made good progress"
    assert read_and_clear_handoff_note("HZ-9", 6) is None


def test_read_and_clear_handoff_note_returns_none_when_absent(tmp_path, monkeypatch):
    monkeypatch.setattr("farm.agent_runner.STATE_DIR", tmp_path)
    assert read_and_clear_handoff_note("HZ-404", 1) is None


def test_an_oversized_handoff_note_is_cut_at_a_boundary_and_says_so(monkeypatch, tmp_path):
    """The note is labelled "unverified" downstream, but a silent mid-sentence
    cut would still present as a COMPLETE account of the attempt — the exact
    failure this item exists to prevent. Marked, word-boundary cut instead."""
    from farm.agent_runner import MAX_HANDOFF_NOTE_CHARS, _write_handoff_note

    monkeypatch.setattr("farm.agent_runner.STATE_DIR", tmp_path)
    oversized = "progress " * (MAX_HANDOFF_NOTE_CHARS // 4)
    _write_handoff_note("HZ-9", 6, oversized)

    note = read_and_clear_handoff_note("HZ-9", 6)
    assert "chars omitted" in note
    assert "not a complete account" in note
    # cut landed on a word boundary — never mid-token
    content = note[: note.index(" […")]
    assert all(tok == "progress" for tok in content.split() if tok)


def test_a_handoff_note_within_the_ceiling_is_written_verbatim_and_unmarked(monkeypatch, tmp_path):
    from farm.agent_runner import _write_handoff_note

    monkeypatch.setattr("farm.agent_runner.STATE_DIR", tmp_path)
    _write_handoff_note("HZ-9", 7, "finished the parser, tests still to write")
    note = read_and_clear_handoff_note("HZ-9", 7)
    assert note == "finished the parser, tests still to write"
    assert "omitted" not in note
