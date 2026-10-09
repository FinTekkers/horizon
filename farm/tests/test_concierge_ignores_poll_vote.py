"""HZ-142 success metric 9 and guardrail 1: no model call on the vote path.

The Node half of this metric (server/test/wa-poll-no-model.test.mjs) walks
waPollVotes.js's import graph and drives a whole vote request. It cannot cover
the failure mode this file exists for, which is upstream of Node entirely:

    if the forked bridge ever wrote a poll — the question, or a vote — into its
    `messages` table, mcp_bridge.py's fetch_new() would hand it to the
    concierge as an inbound command, and run_agent would interpret it.

That is not a hypothetical: it is precisely the "processing that approval now"
bug HZ-142 exists to remove, reintroduced through the back door. Two things
stop it, and both are asserted here.

  1. The fork keeps votes in its own `poll_votes` table, which fetch_new never
     reads. Verified in Go by infra/whatsapp-bridge/hzpoll/sendpoll_test.go and
     by probe 3 in infra/whatsapp-bridge/PROBE.md, which calls the pinned
     bridge's own extractTextContent/extractMediaInfo with a real
     PollCreationMessage and a real PollUpdateMessage and gets nothing back.

  2. The poll question carries BOT_MARKER anyway, so even if point 1 stopped
     being true after an upstream re-pin, the row would be filtered. That is
     the leg this file actually runs — parametrized over every chat kind the
     bridge accepts a self-sent message from, exactly as
     test_concierge_ignores_gate_notice.py is, and for the same reason: seed it
     into an unrelated chat and it is dropped by the CHAT filter instead, so
     the test would pass proving nothing.

The last test is the one that would have caught the real bug: an UNMARKED poll
question in a command chat IS ingested and DOES reach run_agent. It is recorded
here so the marker is understood to be load-bearing rather than decorative.
"""

import sqlite3

import pytest

from farm import concierge_agent
from farm.config import ensure_dirs
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

# What server/src/gateNotifier.js's renderPollQuestion produces, and what the
# two options are byte-for-byte. Hand-written because Node renders them and
# Python cannot import that; what keeps the copies honest is the hex pin in
# server/test/gate-notifier-poll.test.mjs and in
# infra/whatsapp-bridge/hzpoll/poll_test.go.
POLL_QUESTION = "HZ-142 — Review before execution"
POLL_APPROVE = "✅ Approve"
POLL_SEND_BACK = "↩️ Send back"


def make_store(tmp_path):
    con = sqlite3.connect(tmp_path / "messages.db")
    con.executescript(BRIDGE_SCHEMA)
    con.commit()
    con.close()
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
    return BridgeTransport(db_path, "http://127.0.0.1:1", command_chats={COMMAND_GROUP}), db_path


@pytest.mark.parametrize("chat", [SELF_CHAT, COMMAND_GROUP, UNRELATED_CHAT])
def test_a_poll_question_is_never_ingested_as_a_command(transport, chat):
    bridge, db_path = transport
    seed(db_path, chat, BOT_MARKER + POLL_QUESTION, msg_id="POLL-1")
    assert bridge.fetch_new(0) == [], f"the concierge would have reacted to its own poll in {chat}"


@pytest.mark.parametrize("chat", [SELF_CHAT, COMMAND_GROUP])
def test_the_marker_is_what_suppresses_the_poll_question(transport, chat):
    """The load-bearing leg. Without the marker the same row IS ingested from
    these two chats — so the marker, not the chat filter, is doing the work.
    UNRELATED_CHAT is excluded because the chat filter drops it either way."""
    bridge, db_path = transport
    seed(db_path, chat, POLL_QUESTION, msg_id="UNMARKED-POLL")
    ingested = bridge.fetch_new(0)
    assert [m.text for m in ingested] == [POLL_QUESTION]

    seed(db_path, chat, BOT_MARKER + POLL_QUESTION, msg_id="MARKED-POLL")
    assert bridge.fetch_new(ingested[-1].cursor) == [], "the marker did not suppress the poll question"


# A vote is not text at all — it is a PollUpdateMessage carrying encrypted
# option hashes. Probe 3 established that the pinned bridge writes no row for
# one. If a fork regression ever did write the resolved option string as a
# message, this is the shape it would take, and it must not be a command.
@pytest.mark.parametrize("option", [POLL_APPROVE, POLL_SEND_BACK])
@pytest.mark.parametrize("chat", [SELF_CHAT, COMMAND_GROUP])
def test_a_vote_shaped_row_from_ourselves_is_not_a_command(transport, chat, option):
    bridge, db_path = transport
    seed(db_path, chat, BOT_MARKER + option, msg_id=f"VOTE-{chat}-{option}")
    assert bridge.fetch_new(0) == []


def test_run_agent_is_never_invoked_for_a_poll_the_concierge_sees(transport, monkeypatch, tmp_path):
    """The literal metric-9 assertion, through the real poll_messages_once().

    run_agent is replaced with something that raises, so a single model call
    anywhere on this pass fails the test outright rather than being inferred
    from a mock's call count.
    """

    def explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("run_agent was called on the poll path")

    monkeypatch.setattr(concierge_agent, "run_agent", explode)
    monkeypatch.setattr(concierge_agent.config, "FARM_WA_ALLOWED_JIDS", [OWN_PHONE])
    monkeypatch.setattr(concierge_agent.config, "FARM_WA_GROUP_JIDS", [COMMAND_GROUP])

    bridge, db_path = transport
    for i, text in enumerate([BOT_MARKER + POLL_QUESTION, BOT_MARKER + POLL_APPROVE, BOT_MARKER + POLL_SEND_BACK]):
        seed(db_path, SELF_CHAT, text, msg_id=f"PASS-{i}")

    ensure_dirs()
    state = concierge_agent.ConciergeState("poll-nomodel", bridge)
    state.cursor = 0
    assert concierge_agent.poll_messages_once(bridge, state, base_url="http://127.0.0.1:1") == 0


def test_an_ordinary_inbound_message_still_reaches_the_model(transport, monkeypatch, tmp_path):
    """The whole-file positive control. Every assertion above is "nothing was
    ingested", which a broken fixture satisfies for free — and metric 10 says
    the concierge's free-text path must still work during the rollout.
    """
    called = []

    def record(*args, **kwargs):
        called.append(args)
        raise RuntimeError("stop here — reaching the model is the whole assertion")

    monkeypatch.setattr(concierge_agent, "run_agent", record)
    monkeypatch.setattr(concierge_agent.config, "FARM_WA_ALLOWED_JIDS", [OWN_PHONE])
    monkeypatch.setattr(concierge_agent.config, "FARM_WA_GROUP_JIDS", [COMMAND_GROUP])

    bridge, db_path = transport
    seed(db_path, SELF_CHAT, "approve HZ-142 please", msg_id="HUMAN-1", is_from_me=1)

    ensure_dirs()
    state = concierge_agent.ConciergeState("poll-control", bridge)
    state.cursor = 0
    concierge_agent.poll_messages_once(bridge, state, base_url="http://127.0.0.1:1")
    assert called, "a plain human message no longer reaches the concierge's model"


def test_the_fixture_strings_match_what_node_and_go_send():
    """Pins the FIXTURE, so this file cannot drift into suppressing a shape no
    longer resembling a real poll. The renderers themselves are asserted on the
    Node and Go sides."""
    assert POLL_APPROVE.encode("utf-8").hex() == "e29c8520417070726f7665"
    assert POLL_SEND_BACK.encode("utf-8").hex() == "e286a9efb88f2053656e64206261636b"
    assert " — " in POLL_QUESTION
    assert not POLL_QUESTION.startswith(BOT_MARKER), "the marker is added at send time, never baked into the question"
