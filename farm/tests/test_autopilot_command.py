"""HZ-274: the WhatsApp Autopilot kill switch, through poll_messages_once.

The server half (the owner check, the 'off'-only write, the audit row) is
server/test/autopilot-off-via-whatsapp.test.mjs, which posts the same literal
body asserted here — so a key-name mismatch fails one suite or the other.
Every request goes to StubHorizon over real HTTP; numbers are fake and
FakeTransport records replies instead of sending them.
"""

import pytest

from farm import autopilot_command
from farm import concierge_agent as ca
from farm import config, wizard
from farm.config import ensure_dirs
from wa_fakes import FakeTransport, StubHorizon

OWNER = "15550001111@s.whatsapp.net"
OTHER = "15550002222@s.whatsapp.net"
STRANGER = "19998887777@s.whatsapp.net"
ROUTE = "/api/projects/autopilot-off-via-whatsapp"
FAKE_SECRET = "wa-secret-for-tests"


@pytest.fixture(autouse=True)
def allowlist(monkeypatch):
    monkeypatch.setattr(config, "FARM_WA_ALLOWED_JIDS", ["15550001111", "15550002222"])
    monkeypatch.setattr(config, "WA_APPROVAL_SECRET", FAKE_SECRET)


@pytest.fixture(autouse=True)
def no_model(monkeypatch):
    """Any message reaching the model, or the item wizard, fails the test."""

    def boom(*args, **kwargs):
        raise AssertionError("an autopilot command reached the model or the wizard")

    monkeypatch.setattr(ca, "run_agent", boom)
    monkeypatch.setattr(ca, "fetch_snapshot", boom)
    monkeypatch.setattr(wizard, "try_handle_item_wizard", boom)
    monkeypatch.setattr(wizard, "try_handle_gate_choice", boom)


def poll(stub, text, sender, slug):
    ensure_dirs()
    t = FakeTransport()
    state = ca.ConciergeState(slug, t)  # baselines before the message is seeded
    t.seed(text, sender=sender, chat=sender)
    ca.poll_messages_once(t, state, base_url=stub.url, farmd_url=stub.url)
    return t, state


def test_owner_off_posts_the_exact_contract_and_the_reply_names_the_project():
    stub = StubHorizon()
    try:
        t, _ = poll(stub, "autopilot off Horizon", OWNER, "ap-owner")
        assert stub.posts() == [(ROUTE, {"project": "Horizon", "senderJid": OWNER})]
        assert stub.credential_headers_for(ROUTE) == [["x-wa-approval-secret"]]
        assert t.sent == [(OWNER, "Autopilot is now off for Horizon.")]
    finally:
        stub.close()


def test_already_off_says_so():
    stub = StubHorizon(autopilot_off_result=(200, {"ok": True, "project": "Horizon", "old": "off", "new": "off", "unchanged": True}))
    try:
        t, _ = poll(stub, "Autopilot OFF horizon ", OWNER, "ap-already")
        assert stub.autopilot_offs == [{"project": "horizon", "senderJid": OWNER}]
        assert t.sent == [(OWNER, "Autopilot was already off for Horizon.")]
    finally:
        stub.close()


def test_a_refused_non_owner_gets_a_reply_naming_no_project_or_setting():
    stub = StubHorizon(autopilot_off_result=(403, {"error": "refused"}))
    try:
        t, state = poll(stub, "autopilot off Horizon", OTHER, "ap-refused")
        assert stub.autopilot_offs == [{"project": "Horizon", "senderJid": OTHER}]
        [(chat, reply)] = t.sent
        assert chat == OTHER
        assert reply == autopilot_command.REFUSED
        for leak in ("Horizon", " on", "shadow"):
            assert leak not in reply
        assert state.cursor == 1
    finally:
        stub.close()


def test_a_stranger_causes_no_post_and_no_reply():
    stub = StubHorizon()
    try:
        t, state = poll(stub, "autopilot off Horizon", STRANGER, "ap-stranger")
        assert stub.posts() == []
        assert t.sent == []
        assert state.cursor == 1  # claimed silently
    finally:
        stub.close()


@pytest.mark.parametrize("mode", ["on", "shadow", "ON", "Shadow"])
@pytest.mark.parametrize("sender", [OWNER, OTHER])
def test_on_and_shadow_make_no_http_call_and_say_admin_and_pin_are_required(mode, sender):
    stub = StubHorizon()
    try:
        t, _ = poll(stub, f"autopilot {mode} Horizon", sender, f"ap-{mode}-{sender[:11]}")
        assert stub.requests == []
        [(_, reply)] = t.sent
        assert "Admin" in reply and "PIN" in reply
        assert reply == autopilot_command.ADMIN_ONLY
    finally:
        stub.close()


def test_server_unreachable_or_unconfigured_changes_nothing(monkeypatch):
    stub = StubHorizon(autopilot_off_result=(503, {"error": "wa_approval_not_configured"}))
    try:
        t, _ = poll(stub, "autopilot off Horizon", OWNER, "ap-503")
        assert t.sent[-1][1] == autopilot_command.UNREACHABLE
        monkeypatch.setattr(config, "WA_APPROVAL_SECRET", "")
        stub.requests.clear()
        t, _ = poll(stub, "autopilot off Horizon", OWNER, "ap-nosecret")
        assert stub.requests == []
        assert t.sent[-1][1] == autopilot_command.UNREACHABLE
    finally:
        stub.close()


@pytest.mark.parametrize(
    "text, expected",
    [
        ("autopilot off Horizon", ("off", "Horizon")),
        ("  AUTOPILOT   shadow   Fin Tekkers  ", ("shadow", "Fin Tekkers")),
        ("autopilot on x", ("on", "x")),
        ("autopilot off", None),
        ("autopilot pause Horizon", None),
        ("please turn autopilot off Horizon", None),
    ],
)
def test_parse(text, expected):
    assert autopilot_command.parse(text) == expected
