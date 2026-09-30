"""farm.agent_runner.parse_agent_reply(): the ONE shared run_agent + extract_json
+ retry/repair/salvage/handoff helper (HZ-124 metric 14). pm_agent.py and
step_agent.py both delegate to this — see test_pm_agent.py / test_step_agent.py
for the caller-side integration; this file drives the helper directly.
"""

import pytest

from farm.agent_runner import AgentError, AgentExhaustedError, parse_agent_reply, read_and_clear_handoff_note


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
