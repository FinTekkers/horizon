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

    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 1

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
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert stub.posts() == []
    assert len(t.sent) == 1


def test_first_run_baselines_instead_of_replaying_history(stub):
    t = FakeTransport()
    t.seed("set HZ-7 priority to Low")  # already in the store before we start
    state = make_state(t, "baseline")
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 0
    assert stub.posts() == []
    assert t.sent == []


# ---- security: allowlist and action whitelist ----


def test_non_allowlisted_sender_is_dropped_silently(stub):
    t = FakeTransport()
    state = make_state(t, "stranger")
    msg = t.seed("set HZ-7 priority to Critical", sender=STRANGER, chat=STRANGER)
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 0
    assert stub.requests == []  # not even a snapshot fetch
    assert t.sent == []  # no reply that would confirm the bot exists
    assert state.cursor == msg.cursor  # but the message is consumed


def test_empty_allowlist_means_deny_all(stub, monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", [])
    t = FakeTransport()
    state = make_state(t, "denyall")
    t.seed("set HZ-7 priority to Critical")  # even the usual allowed sender
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 0
    assert stub.requests == []
    assert t.sent == []


def test_gate_approval_attempt_is_dropped_before_any_http_call(stub):
    t = FakeTransport()
    state = make_state(t, "gate")
    t.seed("approve the gate on HZ-7")  # fake_claude emits {"type": "approve_gate"}
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert stub.posts() == []  # the action never reached the server
    assert len(t.sent) == 1
    assert "dropped unsupported action" in t.sent[0][1]


def test_media_only_messages_are_skipped_without_crashing(stub):
    t = FakeTransport()
    state = make_state(t, "media")
    msg = t.seed("")  # media row: no text content
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 0
    assert t.sent == []
    assert state.cursor == msg.cursor


# ---- HZ-15: item wizard + gate choice are wired ahead of the Claude call ----


def test_new_item_trigger_is_intercepted_by_the_wizard_and_never_reaches_claude(stub, monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("Claude must not be called for a [New Item] trigger")

    monkeypatch.setattr(ca, "run_agent", boom)
    t = FakeTransport()
    state = make_state(t, "wizard-no-claude")
    t.seed("[New Item] Something new")
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 1
    assert "outcome" in t.sent[-1][1].lower()


def test_bare_numeric_reply_with_a_pending_gate_choice_never_reaches_claude(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("Claude must not be called to resolve a numbered gate choice")

    monkeypatch.setattr(ca, "run_agent", boom)
    stub = StubHorizon(items=[{"id": "HZ-7"}])
    try:
        t = FakeTransport()
        state = make_state(t, "choice-no-claude")
        from farm import wizard

        wizard.offer_gate_choices(
            "15550001111@s.whatsapp.net",
            "15550001111@s.whatsapp.net",
            [{"item_id": "HZ-7", "step_index": 12, "label": "Accept the code"}],
            state.choice_store,
        )
        t.seed("1")
        assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 1
        assert "Approved HZ-7" in t.sent[-1][1]
        assert stub.approvals == [("HZ-7", 12, {"sender": "...1111", "senderJid": "15550001111@s.whatsapp.net"})]
    finally:
        stub.close()


def test_full_create_then_approve_loop_entirely_via_whatsapp(monkeypatch):
    """The literal success metric: create a work item and work it through
    (here, to gate approval) entirely over WhatsApp — no other interface."""
    created_id = "HZ-90"
    stub = StubHorizon(create_item_result=(200, {"ok": True, "id": created_id}))
    stub.known_ids.add(created_id)
    try:
        t = FakeTransport()
        state = make_state(t, "e2e")

        # 1) create the item via the wizard — deterministic, no Claude involved.
        t.seed("[New Item] Ship the thing")
        assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 1
        t.seed("users can do X")
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        t.seed("X happens 95% of the time")
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        t.seed("skip")
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        t.seed("2")  # High
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        t.seed("1")  # create
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        assert stub.created_items == [
            {"title": "Ship the thing", "outcome": "users can do X", "metric": "X happens 95% of the time",
             "guardrails": "", "priority": "High"}
        ]
        assert f"Created {created_id}!" in t.sent[-1][1]

        # 2) ask what's pending approval — Claude lists it and offers a numbered choice.
        def fake_run(prompt, **kw):
            inner = {
                "reply": f"{created_id} is awaiting approval at 'Accept the code'. Reply 1 to approve.",
                "actions": [],
                "gate_options": [{"item_id": created_id, "step_index": 12, "label": "Accept the code"}],
            }
            return {"result": json.dumps(inner), "session_id": "s1"}

        monkeypatch.setattr(ca, "run_agent", fake_run)
        t.seed("what's pending my approval?")
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        assert "awaiting approval" in t.sent[-1][1]

        # 3) approve it with a bare number — resolved deterministically, not by Claude.
        t.seed("1")
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        assert stub.approvals == [(created_id, 12, {"sender": "...1111", "senderJid": "15550001111@s.whatsapp.net"})]
        assert f"Approved {created_id}" in t.sent[-1][1]
    finally:
        stub.close()


# ---- gate_options validation (the WhatsApp radio-button proxy) ----


def test_validate_reply_accepts_well_formed_gate_options():
    _, _, notes, gate_options = ca.validate_reply(
        {"reply": "ok", "actions": [], "gate_options": [{"item_id": "HZ-7", "step_index": 12, "label": "Accept the code"}]}
    )
    assert gate_options == [{"item_id": "HZ-7", "step_index": 12, "label": "Accept the code"}]
    assert notes == []


def test_validate_reply_drops_malformed_gate_options():
    _, _, notes, gate_options = ca.validate_reply(
        {
            "reply": "ok",
            "actions": [],
            "gate_options": [
                {"item_id": "", "step_index": 1, "label": "x"},  # empty item_id
                {"item_id": "HZ-7", "step_index": "12", "label": "x"},  # step_index not an int
                {"item_id": "HZ-7", "step_index": -1, "label": "x"},  # negative
                {"item_id": "HZ-7", "step_index": 1, "label": ""},  # empty label
                "not even a dict",
            ],
        }
    )
    assert gate_options == []
    assert len(notes) == 5
    assert all("malformed gate_options" in n for n in notes)


def test_validate_reply_caps_gate_options_at_nine():
    many = [{"item_id": f"HZ-{i}", "step_index": 1, "label": "x"} for i in range(12)]
    _, _, _, gate_options = ca.validate_reply({"reply": "ok", "actions": [], "gate_options": many})
    assert len(gate_options) == 9


# ---- delivery semantics ----


def test_duplicate_delivery_executes_actions_exactly_once(stub):
    t = FakeTransport()
    state = make_state(t, "dup")
    t.seed("feedback for HZ-7: please add more tests")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert len(stub.posts("/feedback")) == 1

    # simulate the crash-replay window: cursor lost, processed store intact
    state.cursor_path.write_text("0")
    replay_state = ca.ConciergeState("dup", t)
    assert replay_state.cursor == 0
    assert ca.poll_once(t, replay_state, stub.url, farmd_url=stub.url) == 0
    assert len(stub.posts("/feedback")) == 1  # still exactly one comment
    assert replay_state.cursor > 0  # cursor healed past the old message


def test_send_failure_never_reexecutes_the_action(stub):
    t = FakeTransport()
    state = make_state(t, "sendfail")
    t.seed("feedback for HZ-7: tighten the seam tests")
    t.fail_send = True
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)  # action runs, send fails, no raise
    assert len(stub.posts("/feedback")) == 1
    assert t.sent == []

    t.fail_send = False
    assert ca.poll_once(t, state, stub.url, farmd_url=stub.url) == 0  # claimed — never replayed
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
        ca.poll_once(t, state, stub.url, farmd_url=stub.url)
        assert len(t.sent) == 1
        assert "re-runs with your note" in t.sent[0][1]
    finally:
        stub.close()


def test_unknown_item_becomes_a_friendly_note(stub):
    t = FakeTransport()
    state = make_state(t, "unknown")
    t.seed("set ZZ-99 priority to High")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
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

    monkeypatch.setattr(ca, "run_agent", fake_run)
    t = FakeTransport()
    state = make_state(t, "retry")
    t.seed("hello there")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert len(calls) == 2
    assert "invalid" in calls[1]  # the retry names what was wrong
    assert t.sent[0][1] == "ok after retry"


def test_persistently_invalid_reply_sends_an_error_and_claims(stub, monkeypatch):
    monkeypatch.setattr(ca, "run_agent", lambda prompt, **kw: {"result": "still not json", "session_id": "s1"})
    t = FakeTransport()
    state = make_state(t, "broken")
    msg = t.seed("hello?")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
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


# ---- group-chat policy ----


def test_unlisted_group_messages_are_claimed_silently(stub, monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_GROUP_JIDS", [])
    t = FakeTransport()
    state = make_state(t, "group-unlisted")
    t.seed("status of HZ-7?", chat="12036300000@g.us")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert t.sent == []  # never replies into a group it wasn't invited to


def test_listed_group_message_from_allowlisted_sender_is_served(stub, monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_GROUP_JIDS", ["12036300000@g.us"])
    t = FakeTransport()
    state = make_state(t, "group-listed")
    t.seed("status of HZ-7?", chat="12036300000@g.us")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert len(t.sent) == 1
    assert t.sent[0][0] == "12036300000@g.us"  # reply lands in the group


# ---- HZ-140: the concierge holds no server credential ----


def test_the_snapshot_is_read_from_farmd_with_no_credential(stub):
    """The concierge used to send FARM_SHARED_SECRET straight to the server.
    It doesn't hold that credential any more — farmd does — so the read goes
    over loopback to farmd's /internal/snapshot, bare."""
    t = FakeTransport()
    state = make_state(t, "snapshot-via-farmd")
    t.seed("what's the status of HZ-7?")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    gets = [(method, path) for (method, path, _body) in stub.requests if method == "GET"]
    assert gets == [("GET", "/internal/snapshot")]
    assert stub.credential_headers_for("/internal/snapshot") == [[]]


def test_fetch_snapshot_targets_farmd_not_the_horizon_server(stub):
    assert ca.fetch_snapshot(stub.url) == {"items": stub.items}
    assert [path for (_m, path, _b) in stub.requests] == ["/internal/snapshot"]
    assert stub.credential_headers_for("/internal/snapshot") == [[]]


def test_the_unauthenticated_action_posts_are_untouched(stub):
    """Guardrail 4: /priority and /feedback still go to the server directly,
    with no credential, exactly as before."""
    t = FakeTransport()
    state = make_state(t, "actions-untouched")
    t.seed("set HZ-7 priority to Critical")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert stub.posts("/priority") == [("/api/items/HZ-7/priority", {"priority": "Critical"})]
    assert stub.credential_headers_for("/priority") == [[]]


def test_no_farm_module_but_config_and_farmd_still_reads_the_shared_secret():
    """Static guard: the credential must not creep back into the concierge or
    the wizard in a later change. farmd is the only consumer."""
    import re
    from pathlib import Path

    farm_dir = Path(ca.__file__).resolve().parent
    offenders = []
    for path in sorted(farm_dir.glob("*.py")):
        if path.name in ("config.py", "farmd.py"):
            continue
        # Comments record history on purpose; only live code counts.
        code = "\n".join(line.split("#", 1)[0] for line in path.read_text().splitlines())
        if re.search(r"\bSHARED_SECRET\b", code):
            offenders.append(path.name)
    assert offenders == []


# ---- HZ-156: the shared reply parser ----
# The concierge is not a step: it has no run output line and no artifact, so
# its WhatsApp reply is where parser notes surface.


def test_a_parsed_but_invalid_reply_still_takes_the_lossless_retry(stub, monkeypatch):
    """test_invalid_json_reply_is_retried_once above covers a reply that does
    not parse. This one PARSES and fails validate_reply for a missing 'reply'
    field — which took the retry before the parse path moved into
    agent_runner, because validation was inside the retry block. Handing the
    validator to parse_agent_reply is what keeps that true."""
    calls = []

    def fake_run(prompt, **kw):
        calls.append(prompt)
        if len(calls) == 1:
            return {"result": json.dumps({"actions": []}), "session_id": "s1"}
        return {"result": json.dumps({"reply": "ok after retry", "actions": []}), "session_id": "s1"}

    monkeypatch.setattr(ca, "run_agent", fake_run)
    t = FakeTransport()
    state = make_state(t, "validretry")
    t.seed("hello there")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert len(calls) == 2
    assert "missing 'reply'" in calls[1]  # the retry names what was actually wrong
    assert t.sent[0][1] == "ok after retry"


def test_the_retry_still_saves_the_session_it_was_given(stub, monkeypatch):
    """Session continuity across the retry lives in the closure, not in the
    shared helper — it must not have been lost in the move."""
    calls = []

    def fake_run(prompt, **kw):
        calls.append(kw.get("session_id"))
        if len(calls) == 1:
            return {"result": "not json", "session_id": "s-first"}
        return {"result": json.dumps({"reply": "ok", "actions": []}), "session_id": "s-second"}

    monkeypatch.setattr(ca, "run_agent", fake_run)
    t = FakeTransport()
    state = make_state(t, "sess")
    t.seed("hello there")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert calls[1] == "s-first"  # the retry resumed the first call's session
    assert state.session_id() == "s-second"  # and the retry's own id was saved


def test_an_empty_parse_note_list_leaves_the_whatsapp_text_unchanged(stub, monkeypatch):
    """_notes_for returns [] in this item, so the reply is byte-identical."""
    monkeypatch.setattr(
        ca, "run_agent", lambda prompt, **kw: {"result": json.dumps({"reply": "hello", "actions": []}), "session_id": "s1"}
    )
    t = FakeTransport()
    state = make_state(t, "nonotes")
    t.seed("hi")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert t.sent[0][1] == "hello"


def test_a_parse_note_is_appended_after_the_action_notes(stub, monkeypatch):
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["fake parse note"])
    t = FakeTransport()
    state = make_state(t, "notes")
    t.seed("set HZ-7 priority to Critical")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    lines = t.sent[0][1].splitlines()
    assert "fake parse note" == lines[-1], "the parse note must come last, after the action results"
    assert any("priority set to Critical" in line for line in lines)


# ---- HZ-157: a repaired reply is logged AND texted, never sent silently ----
# The concierge is the caller the HZ-124 attempt-9 review actually rejected: it
# has no run output line and no artifact, so a silent repair here would leave
# no record anywhere. The outbound text is one surface, the session log is the
# other, and these tests assert both.


# `repair_counter` is the suite-wide autouse fixture in farm/tests/conftest.py,
# which repoints the counter into tmp_path — poll_once() runs the real parser,
# which ticks a real file. Named in the signatures below so the dependency of a
# count assertion is visible where it is made.


def _replying(text, monkeypatch):
    calls = []

    def fake_run(prompt, **kw):
        calls.append(prompt)
        return {"result": text, "session_id": "s1"}

    monkeypatch.setattr(ca, "run_agent", fake_run)
    return calls


def test_the_success_metrics_concierge_shape_is_repaired_and_reported(
    stub, monkeypatch, capsys, repair_counter
):
    """The exact reply the success metric names: `{"reply":"ok","actions":[],}`.

    It must parse, it must be LOGGED as repaired, and the note must ride out on
    the WhatsApp text. A run where the human sees a bare "ok" and nothing else
    is the version review sent back.
    """
    from farm import agent_runner

    calls = _replying('{"reply":"ok","actions":[],}', monkeypatch)
    t = FakeTransport()
    state = make_state(t, "repaircomma")
    t.seed("what's up")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert len(calls) == 1, "a trailing comma must not cost a second agent run"
    sent = t.sent[0][1]
    assert sent.startswith("ok")
    assert agent_runner.TRAILING_COMMA_NOTE in sent, "the repair was sent silently"
    logged = capsys.readouterr().out
    assert "repaired to parse" in logged, "the repair was never logged"
    assert agent_runner.TRAILING_COMMA_NOTE in logged
    assert agent_runner.repair_counts() == {"trailing_comma": 1}


def test_a_single_quoted_concierge_reply_is_repaired_after_the_retry(
    stub, monkeypatch, capsys, repair_counter
):
    from farm import agent_runner

    calls = []

    def fake_run(prompt, **kw):
        calls.append(prompt)
        # Both attempts come back single-quoted, so the ambiguous rung is what
        # finally recovers it — after the lossless retry has really run.
        return {"result": "{'reply':'ok','actions':[]}", "session_id": "s1"}

    monkeypatch.setattr(ca, "run_agent", fake_run)
    t = FakeTransport()
    state = make_state(t, "repairquotes")
    t.seed("what's up")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert len(calls) == 2, "the lossless retry must run before an ambiguous repair"
    sent = t.sent[0][1]
    assert agent_runner.SINGLE_QUOTE_NOTE in sent
    assert "repaired to parse" in capsys.readouterr().out
    assert agent_runner.repair_counts() == {"single_quotes": 1}


def test_a_repaired_reply_still_goes_through_validate_reply(stub, monkeypatch, repair_counter):
    """validate_reply builds the 4-tuple process_message unpacks. A repaired
    value that skipped it would crash the unpack instead of replying — this is
    the concrete failure the architecture review flagged."""
    _replying(
        '{"reply":"done","actions":[{"type":"set_priority","item_id":"HZ-7",'
        '"priority":"Critical"},],}',
        monkeypatch,
    )
    t = FakeTransport()
    state = make_state(t, "repairvalidate")
    t.seed("set HZ-7 priority to Critical")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    lines = t.sent[0][1].splitlines()
    # The action survived validation and really executed...
    assert any("priority set to Critical" in line for line in lines)
    # ...and the parse note is still last, after the action results.
    from farm import agent_runner

    assert lines[-1] == agent_runner.TRAILING_COMMA_NOTE


def test_an_unrepairable_concierge_reply_sends_the_error_and_fabricates_nothing(
    stub, monkeypatch, repair_counter
):
    from farm import agent_runner

    _replying('{"reply":"he said "hi" to me","actions":[]}', monkeypatch)
    t = FakeTransport()
    state = make_state(t, "unrepairable")
    t.seed("hello")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    sent = t.sent[0][1]
    assert "hit an error" in sent, "an unrepairable reply must not be answered with a guess"
    assert "he said" not in sent
    assert agent_runner.repair_counts() == {}


def test_a_note_that_changed_no_byte_is_not_logged_as_a_repair(
    stub, monkeypatch, capsys, repair_counter
):
    """FIRST_OBJECT_NOTE says WHICH lossless attempt parsed the reply — not one
    byte was edited. Logging it as "repaired to parse" would claim a byte
    change that never happened, which misreports the parser just as badly as
    hiding a real repair does. It must still be logged, under its own wording.
    """
    from farm import agent_runner

    # Attempts 1 and 2 both fail, attempt 3 lifts the leading object out, and
    # the lossless retry then returns nothing usable — so the scanned object is
    # what the human gets, with its note.
    replies = ['{"reply":"ok","actions":[]} prose {"b":2}', "still just prose"]

    def fake_run(prompt, **kw):
        return {"result": replies.pop(0), "session_id": "s1"}

    monkeypatch.setattr(ca, "run_agent", fake_run)
    t = FakeTransport()
    state = make_state(t, "firstobject")
    t.seed("what's up")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)

    assert replies == [], "both the first reply and the lossless retry should have run"
    assert agent_runner.FIRST_OBJECT_NOTE in t.sent[0][1]
    logged = capsys.readouterr().out
    assert agent_runner.FIRST_OBJECT_NOTE in logged, "the note must still reach the log"
    assert "repaired to parse" not in logged, "no byte changed — this is not a repair"
    assert "parser note" in logged
    assert agent_runner.repair_counts() == {}


def test_every_rung_note_is_labelled_a_repair_in_the_log(monkeypatch, capsys):
    """The labelling rule stated over the whole ladder rather than per rung, so
    a rung added by part 3 is covered the day it lands: REPAIR_NOTES is derived
    from REPAIRS, so a new rung's note joins it without a second edit."""
    from farm import agent_runner

    assert agent_runner.REPAIR_NOTES == {rung.note for rung in agent_runner.REPAIRS}
    assert agent_runner.FIRST_OBJECT_NOTE not in agent_runner.REPAIR_NOTES


# ---- the concierge's model (HZ-192) ----
# The REAL run_agent() over recording providers (conftest): the model both
# concierge call sites handed their provider.


def _drive_concierge(stub, monkeypatch, recording_providers, slug):
    from farm import agent_runner

    monkeypatch.setattr(ca, "run_agent", agent_runner.run_agent)
    # An invalid first reply forces the retry call site too.
    recorder = recording_providers("plain prose, no json", json.dumps({"reply": "ok after retry", "actions": []}))
    t = FakeTransport()
    state = make_state(t, slug)
    t.seed("hello there")
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    assert t.sent[0][1] == "ok after retry"
    return recorder


def test_both_concierge_call_sites_hand_the_concierge_model_to_claude(stub, monkeypatch, recording_providers):
    monkeypatch.delenv("FARM_PROVIDER", raising=False)

    recorder = _drive_concierge(stub, monkeypatch, recording_providers, "model-claude")

    assert recorder.models()[0] == "claude-sonnet-5", "concierge_agent.process_message: first run_agent call"
    assert recorder.models()[1] == "claude-sonnet-5", "concierge_agent.process_message: retry_once run_agent call"


@pytest.mark.parametrize("override", [None, "claude-test-emergency"])
def test_both_concierge_calls_on_muse_receive_no_model(stub, monkeypatch, recording_providers, override):
    """Unguarded before HZ-192: the env-selected concierge model went to whichever
    provider FARM_PROVIDER selected."""
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", override)

    recorder = _drive_concierge(stub, monkeypatch, recording_providers, f"model-muse-{bool(override)}")

    assert [(c["provider"], c["model"]) for c in recorder.calls] == [("muse", None), ("muse", None)]
