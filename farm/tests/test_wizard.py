"""Unit tests for the WhatsApp item-creation wizard and gate-choice
resolver (HZ-15) — the deterministic, non-LLM state machines wired into
concierge_agent.poll_once ahead of any Claude call.

Poll-level wiring (wizard turns never reaching Claude, a full
create-then-approve loop through poll_once) lives in test_concierge.py.
"""

import pytest

from farm import concierge_agent as ca
from farm import config, wizard
from farm.config import ensure_dirs
from wa_fakes import FakeTransport, StubHorizon

DAVID = "15550001111@s.whatsapp.net"
EVAN = "15550002222@s.whatsapp.net"


@pytest.fixture(autouse=True)
def allowlist(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", ["15550001111", "15550002222"])


def make_state(transport, slug):
    ensure_dirs()
    return ca.ConciergeState(slug, transport)


def step(t, state, stub, text, sender=DAVID, chat=DAVID):
    msg = t.seed(text, sender=sender, chat=chat)
    handled = wizard.try_handle_item_wizard(msg, t, state.wizard_store, state, stub.url)
    return msg, handled


# ---- item-creation wizard: happy path ----


def test_item_wizard_happy_path_creates_the_item(monkeypatch):
    monkeypatch.setattr(config, "FARM_UI_URL", "http://ui.local")
    t = FakeTransport()
    state = make_state(t, "wiz-happy")
    stub = StubHorizon(
        create_item_result=(200, {"ok": True, "id": "HZ-42", "issue": 9, "url": "https://github.com/x/y/issues/9"})
    )
    try:
        step(t, state, stub, "[New Item] Faster onboarding")
        assert "outcome" in t.sent[-1][1].lower()  # inline title skips straight past the title prompt

        step(t, state, stub, "New users finish setup in under 2 minutes")
        assert "measure success" in t.sent[-1][1].lower()

        step(t, state, stub, "90% completion rate in the first session")
        assert "guardrails" in t.sent[-1][1].lower()

        step(t, state, stub, "skip")
        assert "priority" in t.sent[-1][1].lower()

        step(t, state, stub, "2")  # High
        summary = t.sent[-1][1]
        assert "High" in summary and "Reply 1 to create" in summary

        msg, handled = step(t, state, stub, "1")
        assert handled
        assert stub.created_items == [
            {
                "title": "Faster onboarding",
                "outcome": "New users finish setup in under 2 minutes",
                "metric": "90% completion rate in the first session",
                "guardrails": "",
                "priority": "High",
            }
        ]
        reply = t.sent[-1][1]
        assert "Created HZ-42!" in reply
        assert "http://ui.local/hz-42" in reply
        assert "GitHub issue #9" in reply
        assert state.is_processed(msg.msg_id)
        assert state.wizard_store.get(f"{msg.chat_jid}:{msg.sender_jid}") is None
    finally:
        stub.close()


def test_item_wizard_title_prompted_separately_when_omitted_from_the_trigger():
    t = FakeTransport()
    state = make_state(t, "wiz-notitle")
    stub = StubHorizon()
    try:
        _, handled = step(t, state, stub, "[New Item]")
        assert handled
        assert "title" in t.sent[-1][1].lower()
        key = f"{DAVID}:{DAVID}"
        assert state.wizard_store.get(key)["step"] == "title"

        step(t, state, stub, "Faster onboarding")
        assert "outcome" in t.sent[-1][1].lower()
        assert state.wizard_store.get(key)["title"] == "Faster onboarding"
    finally:
        stub.close()


def test_item_wizard_guardrails_text_is_kept_when_not_skipped():
    t = FakeTransport()
    state = make_state(t, "wiz-guardrails")
    stub = StubHorizon(create_item_result=(200, {"ok": True, "id": "HZ-50"}))
    try:
        step(t, state, stub, "[New Item] X")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "no destructive migrations")
        step(t, state, stub, "3")  # Medium
        step(t, state, stub, "1")
        assert stub.created_items[0]["guardrails"] == "no destructive migrations"
    finally:
        stub.close()


def test_item_wizard_accepts_a_priority_word_as_well_as_a_number():
    t = FakeTransport()
    state = make_state(t, "wiz-priword")
    stub = StubHorizon(create_item_result=(200, {"ok": True, "id": "HZ-51"}))
    try:
        step(t, state, stub, "[New Item] X")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "skip")
        step(t, state, stub, "critical")
        assert "Critical" in t.sent[-1][1]
        step(t, state, stub, "1")
        assert stub.created_items[0]["priority"] == "Critical"
    finally:
        stub.close()


def test_item_wizard_cancel_mid_flow_creates_nothing():
    t = FakeTransport()
    state = make_state(t, "wiz-cancel")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] Something")
        step(t, state, stub, "some outcome")
        msg, handled = step(t, state, stub, "cancel")
        assert handled
        assert "Cancelled" in t.sent[-1][1]
        assert stub.created_items == []
        assert state.wizard_store.get(f"{msg.chat_jid}:{msg.sender_jid}") is None
    finally:
        stub.close()


def test_item_wizard_cancel_at_confirm_step_creates_nothing():
    t = FakeTransport()
    state = make_state(t, "wiz-cancel-confirm")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] X")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "skip")
        step(t, state, stub, "1")  # Critical -> confirm
        step(t, state, stub, "3")  # cancel
        assert "Cancelled" in t.sent[-1][1]
        assert stub.created_items == []
    finally:
        stub.close()


def test_item_wizard_bad_priority_input_reprompts_without_advancing():
    t = FakeTransport()
    state = make_state(t, "wiz-badpri")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] X")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "skip")
        msg, handled = step(t, state, stub, "banana")
        assert handled
        assert "didn't catch that" in t.sent[-1][1]
        assert state.wizard_store.get(f"{msg.chat_jid}:{msg.sender_jid}")["step"] == "priority"
        assert stub.created_items == []
    finally:
        stub.close()


def test_item_wizard_edit_choice_restarts_at_the_title_step():
    t = FakeTransport()
    state = make_state(t, "wiz-edit")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] Original title")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "skip")
        step(t, state, stub, "1")  # -> confirm
        step(t, state, stub, "2")  # edit
        assert "title?" in t.sent[-1][1].lower()
        key = f"{DAVID}:{DAVID}"
        assert state.wizard_store.get(key)["step"] == "title"
        assert stub.created_items == []
    finally:
        stub.close()


def test_item_wizard_expires_after_ttl_and_the_message_falls_through(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_WIZARD_TTL_S", 1)
    t = FakeTransport()
    state = make_state(t, "wiz-ttl")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] X")
        key = f"{DAVID}:{DAVID}"
        session = state.wizard_store.get(key)
        session["updated_at"] -= 2  # backdate instead of sleeping
        state.wizard_store.set(key, session)

        msg, handled = step(t, state, stub, "totally unrelated text")
        assert not handled  # falls through to Claude — never mistaken for an outcome answer
        assert state.wizard_store.get(key) is None
        assert not state.is_processed(msg.msg_id)
    finally:
        stub.close()


def test_item_wizard_fresh_trigger_restarts_and_discards_the_old_draft():
    t = FakeTransport()
    state = make_state(t, "wiz-restart")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] First draft")
        step(t, state, stub, "[New Item] Second draft")
        key = f"{DAVID}:{DAVID}"
        session = state.wizard_store.get(key)
        assert session["title"] == "Second draft"
        assert stub.created_items == []
    finally:
        stub.close()


def test_item_wizard_isolates_state_between_two_senders_in_one_group_chat(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_SENDER_NAMES", {"15550001111": "David", "15550002222": "Evan"})
    group = "12036300000@g.us"
    t = FakeTransport()
    state = make_state(t, "wiz-crosstalk")
    stub = StubHorizon()
    try:
        step(t, state, stub, "[New Item] David's item", sender=DAVID, chat=group)
        david_key = f"{group}:{DAVID}"
        evan_key = f"{group}:{EVAN}"
        david_before = dict(state.wizard_store.get(david_key))

        # Evan has no session of his own; his plain-text message must never
        # be read as an answer to David's in-progress wizard.
        _, handled = step(t, state, stub, "Evan's unrelated message", sender=EVAN, chat=group)
        assert not handled
        assert state.wizard_store.get(david_key) == david_before
        assert state.wizard_store.get(evan_key) is None

        # Evan starts his own item — fully independent of David's draft.
        step(t, state, stub, "[New Item] Evan's item", sender=EVAN, chat=group)
        assert state.wizard_store.get(david_key) == david_before
        assert state.wizard_store.get(evan_key)["title"] == "Evan's item"

        # Every reply names whose turn it is.
        assert any(text.startswith("David,") for _, text in t.sent)
        assert any(text.startswith("Evan,") for _, text in t.sent)
    finally:
        stub.close()


def test_item_wizard_crash_replay_of_the_confirm_message_never_duplicates_the_item():
    """Mirrors test_concierge.test_duplicate_delivery_executes_actions_exactly_once:
    the confirm step's state.claim(msg) happens before POST /api/items, so if the
    cursor is lost (crash) the processed-msg_id record survives and poll_once's
    dedupe check skips the message before it can reach the wizard again."""
    t = FakeTransport()
    state = make_state(t, "wiz-crash")
    stub = StubHorizon(create_item_result=(200, {"ok": True, "id": "HZ-77"}))
    try:
        step(t, state, stub, "[New Item] X")
        step(t, state, stub, "outcome")
        step(t, state, stub, "metric")
        step(t, state, stub, "skip")
        step(t, state, stub, "3")  # Medium -> confirm
        confirm_msg, handled = step(t, state, stub, "1")
        assert handled
        assert len(stub.created_items) == 1

        state.cursor_path.write_text("0")  # simulate the crash-replay window
        replay_state = ca.ConciergeState("wiz-crash", t)
        assert replay_state.cursor == 0
        assert replay_state.is_processed(confirm_msg.msg_id)
        assert ca.poll_once(t, replay_state, stub.url) == 0
        assert len(stub.created_items) == 1  # still exactly one item
    finally:
        stub.close()


# ---- gate-choice resolver ----


def offer(state, item_ids_and_steps, sender=DAVID, chat=DAVID):
    options = [{"item_id": i, "step_index": s, "label": lbl} for (i, s, lbl) in item_ids_and_steps]
    wizard.offer_gate_choices(chat, sender, options, state.choice_store)
    return options


def test_gate_choice_resolves_a_numbered_reply_and_approves(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_SENDER_NAMES", {"15550001111": "David"})
    t = FakeTransport()
    state = make_state(t, "choice-happy")
    stub = StubHorizon(items=[{"id": "HZ-7"}, {"id": "HZ-9"}])
    try:
        offer(state, [("HZ-7", 12, "Accept the code"), ("HZ-9", 3, "Approve & prioritize this work")])
        msg = t.seed("2", sender=DAVID, chat=DAVID)
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert handled
        assert stub.approvals == [("HZ-9", 3, {"sender": "David"})]
        assert "Approved HZ-9" in t.sent[-1][1]
        assert state.is_processed(msg.msg_id)
        assert state.choice_store.get(f"{DAVID}:{DAVID}") is None
    finally:
        stub.close()


def test_gate_choice_out_of_range_number_is_rejected_without_approving():
    t = FakeTransport()
    state = make_state(t, "choice-oor")
    stub = StubHorizon(items=[{"id": "HZ-7"}])
    try:
        offer(state, [("HZ-7", 12, "Accept the code")])
        msg = t.seed("5", sender=DAVID, chat=DAVID)
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert handled
        assert stub.approvals == []
        assert "isn't one of the approvals" in t.sent[-1][1]
        assert state.choice_store.get(f"{DAVID}:{DAVID}") is None  # stale offer cleared either way
    finally:
        stub.close()


def test_gate_choice_bare_number_without_a_pending_offer_falls_through():
    t = FakeTransport()
    state = make_state(t, "choice-none")
    stub = StubHorizon()
    try:
        msg = t.seed("2", sender=DAVID, chat=DAVID)
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert not handled
        assert t.sent == []
        assert not state.is_processed(msg.msg_id)
    finally:
        stub.close()


def test_expired_choice_falls_through_to_claude(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_CHOICE_TTL_S", 1)
    t = FakeTransport()
    state = make_state(t, "choice-ttl")
    stub = StubHorizon(items=[{"id": "HZ-7"}])
    try:
        offer(state, [("HZ-7", 12, "Accept the code")])
        key = f"{DAVID}:{DAVID}"
        pending = state.choice_store.get(key)
        pending["updated_at"] -= 2
        state.choice_store.set(key, pending)

        msg = t.seed("1", sender=DAVID, chat=DAVID)
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert not handled  # poll_once would hand this to Claude next, not treat it as an approval
        assert stub.approvals == []
        assert state.choice_store.get(key) is None
        assert not state.is_processed(msg.msg_id)
    finally:
        stub.close()


def test_gate_choice_isolates_offers_between_two_senders_in_one_group_chat():
    group = "g@g.us"
    t = FakeTransport()
    state = make_state(t, "choice-crosstalk")
    stub = StubHorizon(items=[{"id": "HZ-7"}, {"id": "HZ-9"}])
    try:
        offer(state, [("HZ-7", 12, "Accept the code")], sender=DAVID, chat=group)
        msg = t.seed("1", sender=EVAN, chat=group)  # Evan was never offered anything in this chat
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert not handled
        assert stub.approvals == []
        assert state.choice_store.get(f"{group}:{DAVID}") is not None  # David's offer is untouched
    finally:
        stub.close()


def test_offering_an_empty_list_clears_a_previous_offer_so_a_stale_number_cannot_resurface():
    t = FakeTransport()
    state = make_state(t, "choice-clear")
    stub = StubHorizon(items=[{"id": "HZ-7"}])
    try:
        offer(state, [("HZ-7", 12, "Accept the code")])
        wizard.offer_gate_choices(DAVID, DAVID, [], state.choice_store)
        msg = t.seed("1", sender=DAVID, chat=DAVID)
        handled = wizard.try_handle_gate_choice(msg, t, state.choice_store, state, stub.url)
        assert not handled
        assert stub.approvals == []
    finally:
        stub.close()
