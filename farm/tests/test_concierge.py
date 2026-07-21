"""Concierge pipeline tests (HZ-7): FakeTransport + fake_claude + a stub
Horizon server — the CI gate for "user can communicate via WhatsApp".

The real-bridge leg lives in test_e2e_whatsapp.py (FARM_WA_E2E=1, manual).
"""

import json

import pytest

from farm import concierge_agent as ca
from farm import config
from farm.config import ensure_dirs
from wa_fakes import FakeTransport, StubHorizon

STRANGER = "19998887777@s.whatsapp.net"


@pytest.fixture(autouse=True)
def allowlist(monkeypatch):
    # wa_fakes.FakeTransport seeds from 15550001111 by default
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", ["15550001111"])


@pytest.fixture
def stub():
    s = StubHorizon(
        items=[
            {
                "id": "HZ-7",
                "title": "WhatsApp for the farm",
                "priority": "Medium",
                "desc": "talk to the farm from your phone",
                "metric": "round trip works",
                "paused": False,
                "activeRun": None,
                "stepOutputs": {"6": {"artifact": "# Impl plan\ntransport seam", "attempt": 1}},
            }
        ]
    )
    yield s
    s.close()


def make_state(transport, slug):
    ensure_dirs()
    return ca.ConciergeState(slug, transport)


# ---- the round trip ----


def test_round_trip_message_to_action_to_reply_to_cursor(stub):
    t = FakeTransport()
    state = make_state(t, "rt")
    msg = t.seed("set HZ-7 priority to Critical")

    assert ca.poll_once(t, state, stub.url) == 1

    # action hit the server with the validated enum value
    assert stub.posts("/priority") == [("/api/items/HZ-7/priority", {"priority": "Critical"})]
    # reply went back to the same chat and reports the outcome
    assert len(t.sent) == 1
    chat, text = t.sent[0]
    assert chat == msg.chat_jid
    assert "HZ-7 priority set to Critical" in text
    # cursor + dedupe record persisted
    assert state.cursor == msg.cursor
    assert state.cursor_path.read_text() == str(msg.cursor)
    assert state.is_processed(msg.msg_id)


def test_question_produces_reply_but_no_actions(stub):
    t = FakeTransport()
    state = make_state(t, "question")
    t.seed("what's the status of HZ-7?")
    ca.poll_once(t, state, stub.url)
    assert stub.posts() == []
    assert len(t.sent) == 1


def test_first_run_baselines_instead_of_replaying_history(stub):
    t = FakeTransport()
    t.seed("set HZ-7 priority to Low")  # already in the store before we start
    state = make_state(t, "baseline")
    assert ca.poll_once(t, state, stub.url) == 0
    assert stub.posts() == []
    assert t.sent == []


# ---- security: allowlist and action whitelist ----


def test_non_allowlisted_sender_is_dropped_silently(stub):
    t = FakeTransport()
    state = make_state(t, "stranger")
    msg = t.seed("set HZ-7 priority to Critical", sender=STRANGER, chat=STRANGER)
    assert ca.poll_once(t, state, stub.url) == 0
    assert stub.requests == []  # not even a snapshot fetch
    assert t.sent == []  # no reply that would confirm the bot exists
    assert state.cursor == msg.cursor  # but the message is consumed


def test_empty_allowlist_means_deny_all(stub, monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", [])
    t = FakeTransport()
    state = make_state(t, "denyall")
    t.seed("set HZ-7 priority to Critical")  # even the usual allowed sender
    assert ca.poll_once(t, state, stub.url) == 0
    assert stub.requests == []
    assert t.sent == []


def test_gate_approval_attempt_is_dropped_before_any_http_call(stub):
    t = FakeTransport()
    state = make_state(t, "gate")
    t.seed("approve the gate on HZ-7")  # fake_claude emits {"type": "approve_gate"}
    ca.poll_once(t, state, stub.url)
    assert stub.posts() == []  # the action never reached the server
    assert len(t.sent) == 1
    assert "dropped unsupported action" in t.sent[0][1]


def test_media_only_messages_are_skipped_without_crashing(stub):
    t = FakeTransport()
    state = make_state(t, "media")
    msg = t.seed("")  # media row: no text content
    assert ca.poll_once(t, state, stub.url) == 0
    assert t.sent == []
    assert state.cursor == msg.cursor


# ---- delivery semantics ----


def test_duplicate_delivery_executes_actions_exactly_once(stub):
    t = FakeTransport()
    state = make_state(t, "dup")
    t.seed("feedback for HZ-7: please add more tests")
    ca.poll_once(t, state, stub.url)
    assert len(stub.posts("/feedback")) == 1

    # simulate the crash-replay window: cursor lost, processed store intact
    state.cursor_path.write_text("0")
    replay_state = ca.ConciergeState("dup", t)
    assert replay_state.cursor == 0
    assert ca.poll_once(t, replay_state, stub.url) == 0
    assert len(stub.posts("/feedback")) == 1  # still exactly one comment
    assert replay_state.cursor > 0  # cursor healed past the old message


def test_send_failure_never_reexecutes_the_action(stub):
    t = FakeTransport()
    state = make_state(t, "sendfail")
    t.seed("feedback for HZ-7: tighten the seam tests")
    t.fail_send = True
    ca.poll_once(t, state, stub.url)  # action runs, send fails, no raise
    assert len(stub.posts("/feedback")) == 1
    assert t.sent == []

    t.fail_send = False
    assert ca.poll_once(t, state, stub.url) == 0  # claimed — never replayed
    assert len(stub.posts("/feedback")) == 1


def test_feedback_on_active_item_warns_about_the_rerun():
    stub = StubHorizon(
        items=[{"id": "HZ-7", "title": "x", "priority": "Medium", "desc": "", "metric": "",
                "paused": False, "activeRun": {"step_index": 11}, "stepOutputs": {}}],
        feedback_rerun=True,
    )
    try:
        t = FakeTransport()
        state = make_state(t, "rerun")
        t.seed("feedback for HZ-7: change the button copy")
        ca.poll_once(t, state, stub.url)
        assert len(t.sent) == 1
        assert "re-runs with your note" in t.sent[0][1]
    finally:
        stub.close()


def test_unknown_item_becomes_a_friendly_note(stub):
    t = FakeTransport()
    state = make_state(t, "unknown")
    t.seed("set ZZ-99 priority to High")
    ca.poll_once(t, state, stub.url)
    assert ("/api/items/ZZ-99/priority", {"priority": "High"}) in stub.posts("/priority")
    assert "couldn't find ZZ-99" in t.sent[0][1]


# ---- model-output robustness ----


def test_invalid_json_reply_is_retried_once(stub, monkeypatch):
    calls = []

    def fake_run(prompt, **kw):
        calls.append(prompt)
        if len(calls) == 1:
            return {"result": "sorry, plain prose with no json", "session_id": "s1"}
        return {"result": json.dumps({"reply": "ok after retry", "actions": []}), "session_id": "s1"}

    monkeypatch.setattr(ca, "run_claude", fake_run)
    t = FakeTransport()
    state = make_state(t, "retry")
    t.seed("hello there")
    ca.poll_once(t, state, stub.url)
    assert len(calls) == 2
    assert "invalid" in calls[1]  # the retry names what was wrong
    assert t.sent[0][1] == "ok after retry"


def test_persistently_invalid_reply_sends_an_error_and_claims(stub, monkeypatch):
    monkeypatch.setattr(ca, "run_claude", lambda prompt, **kw: {"result": "still not json", "session_id": "s1"})
    t = FakeTransport()
    state = make_state(t, "broken")
    msg = t.seed("hello?")
    ca.poll_once(t, state, stub.url)
    assert stub.posts() == []
    assert "hit an error" in t.sent[0][1]
    assert state.is_processed(msg.msg_id)  # never retried forever


# ---- snapshot status lines (what the model gets to answer "what's pending?") ----


def _line(**overrides):
    item = {"id": "HZ-5", "title": "Agent output in tmux", "priority": "High",
            "paused": False, "activeRun": None}
    item.update(overrides)
    return ca._item_line(item)


def test_item_line_flags_a_gate_as_awaiting_human_approval():
    line = _line(currentStep={"index": 12, "label": "Accept the code", "kind": "gate", "gate": True}, pr=12)
    assert 'AWAITING HUMAN APPROVAL at gate "Accept the code" (PR #12)' in line


def test_item_line_flags_merge_conflicts_on_the_accept_gate():
    line = _line(currentStep={"label": "Accept the code", "kind": "gate", "gate": True},
                 pr=12, pr_mergeable=False)
    assert "(PR #12, has merge conflicts)" in line


def test_item_line_names_the_running_step():
    line = _line(currentStep={"label": "Specialist agent implements", "kind": "agent", "gate": False},
                 activeRun={"id": 1, "step_index": 11})
    assert 'agent working on "Specialist agent implements"' in line


def test_item_line_reports_paused_and_closed_states():
    assert 'paused at "Deploy the changes"' in _line(
        paused=True, currentStep={"label": "Deploy the changes", "kind": "agent", "gate": False})
    assert _line(currentStep={"label": "Closed", "kind": "done", "gate": False}).endswith("— closed")


def test_item_line_survives_a_snapshot_without_current_step():
    # An older server (or a test stub) that doesn't send currentStep must not crash the concierge.
    assert _line().endswith("— waiting")
    assert _line(activeRun={"id": 1}).endswith("— step running now")


# ---- named-item detail (status / artifact questions) ----


def _msg(text):
    from farm.whatsapp.transport import Inbound
    return Inbound(msg_id="M-1", chat_jid="c@s.whatsapp.net", sender_jid="15550001111@s.whatsapp.net",
                   text=text, ts="2026-07-20 10:00:00", cursor=1)


def _snapshot_item(**overrides):
    item = {
        "id": "HZ-9", "title": "Project-scoped persona rules", "priority": "High",
        "paused": False, "activeRun": None, "desc": "rules per project", "metric": "parity tests pass",
        "pr": 5, "pr_url": "https://github.com/FinTekkers/horizon/pull/5",
        "release_tag": "deploy-hz-9", "release_url": "https://github.com/FinTekkers/horizon/releases/deploy-hz-9",
        "stepOutputs": {
            "8": {"label": "QA reviews the test plan", "attempt": 2,
                  "output": "verdict: pass-with-conditions", "artifact": "# QA review\nAdd a parity test."},
        },
    }
    item.update(overrides)
    return item


def test_build_prompt_details_a_named_item_with_labeled_steps_and_artifacts():
    prompt = ca.build_prompt(_msg("what did QA say about HZ-9?"), {"items": [_snapshot_item()]})
    assert "PR: #5 https://github.com/FinTekkers/horizon/pull/5" in prompt
    assert "release: deploy-hz-9" in prompt
    assert '8. "QA reviews the test plan" (attempt 2): verdict: pass-with-conditions' in prompt
    assert 'artifact from step 8 "QA reviews the test plan":' in prompt
    assert "Add a parity test." in prompt


def test_build_prompt_keeps_detail_out_of_unnamed_items():
    prompt = ca.build_prompt(_msg("what's in the backlog?"), {"items": [_snapshot_item()]})
    assert "HZ-9" in prompt  # the one-line summary is always there
    assert "artifact from step" not in prompt
    assert "completed steps:" not in prompt


def test_build_prompt_falls_back_to_step_numbers_without_labels():
    item = _snapshot_item(stepOutputs={"6": {"attempt": 1, "output": "plan drafted", "artifact": "# Plan"}})
    prompt = ca.build_prompt(_msg("status of HZ-9"), {"items": [item]})
    assert '6. "step 6" (attempt 1): plan drafted' in prompt
    assert 'artifact from step 6 "step 6":' in prompt
