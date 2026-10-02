"""HZ-209: one WhatsApp concierge across every enabled project — the farm half.

The snapshot is fixtures/snapshot_multi_project.json, which
server/test/concierge-multi-project.test.mjs pins to the server's real
`GET /api/farm/snapshot?scope=enabled` reply: Horizon (HZ) and FinTekkers (US)
enabled, Ledger (LS) disabled, each with item 12 at a gate. Variants with
fewer projects are derived from it the way the server would answer.

The model is a recorder; actions go to StubHorizon, so "no POST" is checked
against real HTTP. One session is shared by every project, so what these
tests prove is prompt scoping plus action filtering — not data isolation:
the model's history still holds earlier turns about other projects.
"""

import copy
import json
from pathlib import Path

import pytest

from farm import concierge_agent as ca
from farm import concierge_routing as routing
from farm import config, wizard
from farm.config import STATE_DIR, ensure_dirs
from wa_fakes import FakeTransport, StubHorizon

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "snapshot_multi_project.json").read_text())
DAVID = "15550001111@s.whatsapp.net"
KEY = f"{DAVID}:{DAVID}"
TITLES = {it["id"]: it["title"] for it in FIXTURE["items"]}
PROJECT_IDS = {p["name"]: p["id"] for p in FIXTURE["projects"]}
# Ledger's LS-12 exists server-side but is not in a scope=enabled snapshot —
# the server test gives it this title and pins that it is excluded.
LS_12_TITLE = "Ledger reconciliation job"


def only_enabled(*names):
    """The fixture as the server answers with just `names` enabled: every
    project is still listed, but a disabled one's items are not in it."""
    snap = copy.deepcopy(FIXTURE)
    for p in snap["projects"]:
        p["enabled"] = p["name"] in names
    on = {p["id"] for p in snap["projects"] if p["enabled"]}
    snap["items"] = [it for it in snap["items"] if it["project_id"] in on]
    return snap


def only_project(name):
    """A farm with a single project, which is enabled."""
    snap = only_enabled(name)
    snap["projects"] = [p for p in snap["projects"] if p["name"] == name]
    return snap


@pytest.fixture(autouse=True)
def allowlist(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", ["15550001111"])


@pytest.fixture(autouse=True)
def fresh_shared_state():
    """Every test starts from no shared concierge state, and leaves none."""
    ensure_dirs()

    def wipe():
        for pattern in ca.LEGACY_STATE_FILES:
            for slug in (ca.CONCIERGE_KEY, "legacy-proj"):
                (STATE_DIR / pattern.format(slug)).unlink(missing_ok=True)

    wipe()
    yield
    wipe()


@pytest.fixture
def stub():
    s = StubHorizon(items=[{"id": i} for i in [*TITLES, "LS-12"]])
    yield s
    s.close()


class Model:
    """Stands in for run_agent: records each call, answers `reply`."""

    def __init__(self, monkeypatch, reply=None):
        self.calls = []
        self.reply = reply or {"reply": "ok"}
        monkeypatch.setattr(ca, "run_agent", self)

    def __call__(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return {"result": json.dumps(self.reply), "session_id": "sess-shared"}


@pytest.fixture
def serve(monkeypatch):
    """Points the concierge's snapshot read at `snap`."""
    reads = []

    def install(snap):
        def fetch(farmd_url=ca.FARMD):
            reads.append(farmd_url)
            return copy.deepcopy(snap)

        monkeypatch.setattr(ca, "fetch_snapshot", fetch)
        return reads

    return install


def run(t, state, stub, text):
    msg = t.seed(text)
    ca.poll_once(t, state, stub.url, farmd_url=stub.url)
    return msg


# ---- metric 1: one session, each answer from its own project ----


def test_us_12_and_hz_12_are_each_answered_from_their_own_project_in_one_session(monkeypatch, stub, serve):
    serve(FIXTURE)
    model = Model(monkeypatch)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)
    state.save_session("sess-shared")

    run(t, state, stub, "what's the status of US-12?")
    run(t, state, stub, "and HZ-12?")

    assert len(model.calls) == 2
    assert [c["session_id"] for c in model.calls] == ["sess-shared", "sess-shared"]
    assert state.session_path.name == "concierge-session-_shared.txt"
    us, hz = (c["prompt"] for c in model.calls)
    assert "US-12" in us and TITLES["US-12"] in us
    assert "HZ-12" not in us and TITLES["HZ-12"] not in us
    assert "HZ-12" in hz and TITLES["HZ-12"] in hz
    assert "US-12" not in hz and TITLES["US-12"] not in hz
    for prompt in (us, hz):
        assert "LS-12" not in prompt and LS_12_TITLE not in prompt


# ---- metric 3: no project named -> ask, never guess ----


def test_a_message_naming_no_project_gets_the_enabled_projects_back_and_nothing_runs(monkeypatch, stub, serve):
    serve(FIXTURE)
    model = Model(monkeypatch)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    msg = run(t, state, stub, "what's pending my approval?")

    assert model.calls == []
    assert stub.posts() == []
    reply = t.sent[-1][1]
    assert reply.startswith("Which project do you mean?")
    assert "FinTekkers" in reply and "Horizon" in reply
    assert "Ledger" not in reply
    assert state.choice_store.get(KEY) is None
    assert state.wizard_store.get(KEY) is None
    assert state.is_processed(msg.msg_id)


# ---- metric 4: a disabled project is never read or acted on ----


@pytest.mark.parametrize(
    "snap,text,name",
    [
        (FIXTURE, "status of LS-12? set LS-12 priority to Critical", "Ledger"),
        (only_enabled("Horizon"), "status of LS-12? set LS-12 priority to Critical", "Ledger"),
        (only_enabled("Horizon"), "feedback on US-12: ship it", "FinTekkers"),
    ],
    ids=["two-enabled", "one-enabled", "one-enabled-other-disabled"],
)
def test_a_disabled_projects_key_gets_the_disabled_reply_and_no_data_or_action(monkeypatch, stub, serve, snap, text, name):
    serve(snap)
    model = Model(monkeypatch)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    run(t, state, stub, text)

    assert model.calls == []
    assert stub.posts() == []
    reply = t.sent[-1][1]
    assert reply == routing.render_disabled([name])
    assert not any(title in reply for title in [*TITLES.values(), LS_12_TITLE])


def test_with_one_enabled_project_a_disabled_key_alongside_an_enabled_one_is_dropped(monkeypatch, stub, serve):
    serve(only_enabled("Horizon"))
    model = Model(
        monkeypatch,
        {
            "reply": "done",
            "actions": [
                {"type": "set_priority", "item_id": "HZ-12", "priority": "High"},
                {"type": "set_priority", "item_id": "LS-12", "priority": "High"},
            ],
        },
    )
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    run(t, state, stub, "set HZ-12 and LS-12 to High")

    assert len(model.calls) == 1
    assert LS_12_TITLE not in model.calls[0]["prompt"]
    assert [p for p, _ in stub.posts()] == ["/api/items/HZ-12/priority"]
    assert "Ledger is disabled" in t.sent[-1][1]


# ---- guardrail 6: the model never picks the project ----


def test_actions_and_gate_options_outside_the_resolved_project_are_dropped(monkeypatch, stub, serve):
    serve(FIXTURE)
    Model(
        monkeypatch,
        {
            "reply": "Here you go",
            "actions": [
                {"type": "set_priority", "item_id": "US-5", "priority": "High"},
                {"type": "set_priority", "item_id": "HZ-12", "priority": "High"},
            ],
            "gate_options": [
                {"item_id": "US-5", "step_index": 3, "label": "Approve plan"},
                {"item_id": "HZ-12", "step_index": 3, "label": "Approve plan"},
            ],
        },
    )
    offered = []
    real_offer = wizard.offer_gate_choices
    monkeypatch.setattr(
        wizard, "offer_gate_choices", lambda chat, sender, options, store: offered.append(options) or real_offer(chat, sender, options, store)
    )
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    run(t, state, stub, "set HZ-12 to High and show what's pending on Horizon")

    assert [p for p, _ in stub.posts()] == ["/api/items/HZ-12/priority"]
    assert [[o["item_id"] for o in opts] for opts in offered] == [["HZ-12"]]
    assert [o["item_id"] for o in state.choice_store.get(KEY)["options"]] == ["HZ-12"]
    reply = t.sent[-1][1]
    assert "(dropped set_priority for US-5" in reply
    assert "(dropped approval option for US-5" in reply


# ---- guardrail 7: a choice offered before the project was disabled ----


def test_a_numbered_choice_on_a_project_disabled_since_the_offer_is_refused(monkeypatch, serve):
    serve(FIXTURE)
    Model(monkeypatch, {"reply": "1) HZ-12", "gate_options": [{"item_id": "HZ-12", "step_index": 3, "label": "Approve plan"}]})
    # Horizon is disabled after the offer: the server's approve route answers
    # with the store's refusal (pinned in concierge-multi-project.test.mjs).
    stub = StubHorizon(items=[{"id": "HZ-12"}], approve_result=(409, {"error": "project_not_active"}))
    try:
        t = FakeTransport()
        state = ca.ConciergeState(ca.CONCIERGE_KEY, t)
        run(t, state, stub, "what's pending on HZ-12?")
        assert state.choice_store.get(KEY) is not None

        run(t, state, stub, "1")

        assert [(item, step) for item, step, _ in stub.approvals] == [("HZ-12", 3)]
        assert t.sent[-1][1].endswith("Couldn't approve HZ-12: project_not_active")
        assert state.choice_store.get(KEY) is None
    finally:
        stub.close()


# ---- guardrail 8: one enabled project behaves exactly as before ----


def test_with_one_enabled_project_a_message_with_no_key_runs_todays_prompt(monkeypatch, stub, serve):
    snap = only_project("Horizon")
    serve(snap)
    model = Model(monkeypatch)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    msg = run(t, state, stub, "what's pending my approval?")

    assert [c["prompt"] for c in model.calls] == [ca.build_prompt(msg, snap)]
    assert routing.plan(msg.text, snap) == routing.Plan(snapshot=snap)


# ---- guardrail 8: the session rename keeps today's state ----


def test_migration_copies_the_legacy_state_byte_for_byte_once(tmp_path):
    contents = {
        "concierge-cursor-{}.txt": b"42",
        "concierge-processed-{}.json": b'["MSG-1", "MSG-2"]',
        "concierge-session-{}.txt": b"sess-legacy",
        "concierge-wizard-{}.json": json.dumps({KEY: {"step": "metric", "title": "t"}}).encode(),
        "concierge-choice-{}.json": json.dumps({KEY: {"options": [{"item_id": "HZ-1"}]}}).encode(),
    }
    for pattern, data in contents.items():
        (STATE_DIR / pattern.format("legacy-proj")).write_bytes(data)

    copied = ca.migrate_legacy_state("legacy-proj")

    assert sorted(p.name for p in copied) == sorted(p.format("_shared") for p in contents)
    for pattern, data in contents.items():
        assert (STATE_DIR / pattern.format("_shared")).read_bytes() == data
    state = ca.ConciergeState(ca.CONCIERGE_KEY, FakeTransport())
    assert state.cursor == 42 and state.is_processed("MSG-2") and state.session_id() == "sess-legacy"
    assert state.wizard_store.get(KEY)["step"] == "metric"

    # The shared cursor exists now: a later boot never overwrites it.
    (STATE_DIR / "concierge-cursor-legacy-proj.txt").write_text("7")
    assert ca.migrate_legacy_state("legacy-proj") == []
    assert (STATE_DIR / "concierge-cursor-_shared.txt").read_text() == "42"


def test_migration_of_a_missing_legacy_slug_is_a_no_op():
    assert ca.migrate_legacy_state("no-such-project") == []
    assert ca.migrate_legacy_state("") == []
    assert not (STATE_DIR / "concierge-cursor-_shared.txt").exists()


# ---- guardrail 4: the wizard asks which project, and never defaults ----


def wizard_step(t, state, stub, text, farmd_url):
    msg = t.seed(text)
    assert wizard.try_handle_item_wizard(msg, t, state.wizard_store, state, stub.url, farmd_url)
    return t.sent[-1][1]


def test_the_wizard_asks_which_project_rejects_a_bad_pick_and_sends_the_chosen_projectid(stub, serve):
    reads = serve(FIXTURE)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    assert "Which project is this for? Reply 1) FinTekkers 2) Horizon" in wizard_step(t, state, stub, "[New Item] Faster onboarding", "http://farmd")
    assert reads == ["http://farmd"]
    for bad in ("3", "0", "Horizon", "²"):
        assert "didn't catch that" in wizard_step(t, state, stub, bad, "http://farmd")
        assert state.wizard_store.get(KEY)["step"] == "project"
    assert stub.created_items == []

    assert "outcome" in wizard_step(t, state, stub, "2", "http://farmd").lower()
    for text in ("New users finish setup fast", "90% complete", "skip", "2"):
        wizard_step(t, state, stub, text, "http://farmd")
    assert "Project: Horizon" in t.sent[-1][1]
    wizard_step(t, state, stub, "1", "http://farmd")

    assert len(stub.created_items) == 1
    assert stub.created_items[0]["projectId"] == PROJECT_IDS["Horizon"]


def test_with_one_enabled_project_the_wizard_has_no_project_step_and_sends_no_projectid(stub, serve):
    serve(only_enabled("Horizon"))
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    assert "outcome" in wizard_step(t, state, stub, "[New Item] Faster onboarding", "http://farmd").lower()
    for text in ("New users finish setup fast", "90% complete", "skip", "2", "1"):
        wizard_step(t, state, stub, text, "http://farmd")

    assert len(stub.created_items) == 1
    assert "projectId" not in stub.created_items[0]


def test_the_wizard_does_not_start_when_the_projects_cannot_be_read(monkeypatch, stub):
    import httpx

    def unreachable(farmd_url=ca.FARMD):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(ca, "fetch_snapshot", unreachable)
    t = FakeTransport()
    state = ca.ConciergeState(ca.CONCIERGE_KEY, t)

    assert "nothing was started" in wizard_step(t, state, stub, "[New Item] X", "http://farmd")
    assert state.wizard_store.get(KEY) is None


# ---- resolve(): what counts as naming a project ----


@pytest.mark.parametrize(
    "text,targets,disabled",
    [
        ("hz-12 please", {"Horizon"}, []),
        ("see https://shoreward.ai/horizon/us-12", {"Horizon", "FinTekkers"}, []),
        ("US-12 and HZ-12", {"Horizon", "FinTekkers"}, []),
        ("COVID-19 and HZ12 and Horizontal", set(), []),
        ("anything new on FinTekkers?", {"FinTekkers"}, []),
        ("LS-12 and US-12", {"FinTekkers"}, ["Ledger"]),
    ],
)
def test_resolve(text, targets, disabled):
    res = routing.resolve(text, FIXTURE)
    assert res.targets == {PROJECT_IDS[n] for n in targets}
    assert res.disabled == disabled
