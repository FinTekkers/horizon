"""HZ-141 success metric 7: outgoing gate notifications carry the bot marker and
the concierge does not react to them.

The notification is sent by the NODE server (server/src/waSend.js), not by this
process — the cursor it watches is Node state. So the guarantee spans two
languages, and no single test can carry it. The chain, stated here and in
server/test/bot-marker-parity.test.mjs:

  1. server/test/bot-marker-parity.test.mjs — the JS and Python BOT_MARKER
     constants are byte-equal, imported through a real python3.
  2. server/test/gate-notifier-retry.test.mjs — the Node wire payload is
     BOT_MARKER + body, exactly once.
  3. THIS FILE — a body of that exact shape is not ingested, in every chat kind
     the bridge would otherwise accept a self-sent message from.

That third point is why this is parametrized rather than a single case, and it is
the part a naive version gets wrong. In mcp_bridge.py's fetch_new, an is_from_me
row is dropped by the CHAT FILTER unless the chat is the self-chat or a
configured command chat; the BOT_MARKER check on the next line is only reached
after that. Seed a notification into an unrelated third-party chat and it is
ignored for a reason that has nothing to do with the marker — the test passes and
proves nothing. So all three kinds are covered, each asserting for its own
reason:

  self-chat      — reaches the marker check. THIS is the marker leg.
  configured group — reaches the marker check (command_chats). Also the marker leg.
  unrelated chat — dropped earlier, by the chat filter. Asserted so the
                   distinction is recorded rather than accidentally relied on.
"""

import sqlite3

import pytest

from farm.whatsapp.mcp_bridge import BOT_MARKER, BridgeTransport

BRIDGE_SCHEMA = """
CREATE TABLE messages (
    id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP,
    is_from_me BOOLEAN, media_type TEXT, filename TEXT, url TEXT,
    PRIMARY KEY (id, chat_jid)
);
"""

OWN_PHONE = "16464276473"
OWN_LID = "275096967086230"
SELF_CHAT = f"{OWN_PHONE}@s.whatsapp.net"
COMMAND_GROUP = "120363000000000001@g.us"
UNRELATED_CHAT = "15559998888@s.whatsapp.net"

# A real rendered notification, matching server/src/gateNotifier.js's template:
# id and title, gate label, the ask line, the PM recommendation, and the link.
# Hand-written here because Node renders it and Python cannot import that — what
# keeps the two honest is step 2 of the chain above, not this string.
NOTICE_BODY = (
    "HZ-141 — Notify on WhatsApp when a work item reaches a human gate\n"
    "Gate: Review before execution\n"
    "Asking: Approve the implementation plan before any code is written, or send it back.\n"
    "PM recommendation: **APPROVE** — the plan addresses every reviewer finding.\n"
    "http://localhost:5173/hz-141"
)


def make_store(tmp_path):
    con = sqlite3.connect(tmp_path / "messages.db")
    con.executescript(BRIDGE_SCHEMA)
    con.commit()
    con.close()
    # The sibling whatsmeow store the bridge reads its own jids from — without it
    # the self-chat is not recognised and the self-chat leg would be vacuous.
    con = sqlite3.connect(tmp_path / "whatsapp.db")
    con.execute("CREATE TABLE whatsmeow_device (jid TEXT, lid TEXT)")
    con.execute(
        "INSERT INTO whatsmeow_device (jid, lid) VALUES (?, ?)",
        (f"{OWN_PHONE}:32@s.whatsapp.net", f"{OWN_LID}:32@lid"),
    )
    con.commit()
    con.close()
    return tmp_path / "messages.db"


def seed(db_path, chat, text, *, msg_id, is_from_me=1):
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)",
        (msg_id, chat, OWN_LID, text, "2026-09-30 10:00:00", is_from_me),
    )
    con.commit()
    con.close()


@pytest.fixture
def transport(tmp_path):
    db_path = make_store(tmp_path)
    # command_chats mirrors farm/concierge_agent.py:405, which builds the real
    # transport with command_chats=set(config.FARM_WA_GROUP_JIDS).
    return BridgeTransport(db_path, "http://127.0.0.1:1", command_chats={COMMAND_GROUP}), db_path


@pytest.mark.parametrize("chat", [SELF_CHAT, COMMAND_GROUP, UNRELATED_CHAT])
def test_a_gate_notification_is_never_ingested_as_a_command(transport, chat):
    bridge, db_path = transport
    seed(db_path, chat, BOT_MARKER + NOTICE_BODY, msg_id="NOTICE-1")
    assert bridge.fetch_new(0) == [], f"the concierge would have reacted to its own notification in {chat}"


@pytest.mark.parametrize("chat", [SELF_CHAT, COMMAND_GROUP])
def test_the_marker_is_what_suppresses_it_in_the_chats_the_bridge_accepts(transport, chat):
    """The load-bearing leg. Without the marker the SAME row IS ingested from
    these two chats, which is what proves the marker — not the chat filter — is
    doing the work. Deliberately excludes UNRELATED_CHAT, where the chat filter
    drops it either way (see the next test)."""
    bridge, db_path = transport
    seed(db_path, chat, NOTICE_BODY, msg_id="UNMARKED-1")
    ingested = bridge.fetch_new(0)
    assert [m.text for m in ingested] == [NOTICE_BODY]

    seed(db_path, chat, BOT_MARKER + NOTICE_BODY, msg_id="MARKED-1")
    after = bridge.fetch_new(ingested[-1].cursor)
    assert after == [], "the marker did not suppress the notification"


def test_an_unrelated_chat_is_dropped_by_the_chat_filter_not_the_marker(transport):
    """Recorded so the parametrized case above is not mistaken for a marker
    assertion in this chat: an unmarked message here is dropped too, because
    mcp_bridge.py only accepts is_from_me rows from the self-chat and configured
    command chats. Both legs assert 'ignored', for two different reasons."""
    bridge, db_path = transport
    seed(db_path, UNRELATED_CHAT, NOTICE_BODY, msg_id="UNMARKED-2")
    assert bridge.fetch_new(0) == []


def test_an_inbound_message_from_a_human_still_gets_through(transport):
    """The whole-file positive control. Every assertion above is 'nothing was
    ingested', which a broken fixture satisfies for free."""
    bridge, db_path = transport
    seed(db_path, UNRELATED_CHAT, "HZ-141 approve", msg_id="HUMAN-1", is_from_me=0)
    assert [m.text for m in bridge.fetch_new(0)] == ["HZ-141 approve"]


def test_the_notification_body_carries_the_fields_metric_3_requires():
    """Not a concierge assertion — a pin on the FIXTURE, so this file cannot
    drift into testing suppression of a body that no longer resembles a real
    notification. The renderer itself is asserted on the Node side."""
    assert "HZ-141" in NOTICE_BODY
    assert "Gate: " in NOTICE_BODY
    assert "PM recommendation: " in NOTICE_BODY
    assert "http://" in NOTICE_BODY
    assert not NOTICE_BODY.startswith(BOT_MARKER), "the marker is added at send time, never baked into the body"
