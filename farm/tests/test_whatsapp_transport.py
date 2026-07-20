"""Transport contract suite (HZ-7).

One parametrized set of assertions runs against BOTH FakeTransport (the CI
double the concierge tests use) and BridgeTransport (Option A, on a temp
SQLite file with the real whatsapp-mcp schema and a stub send endpoint).
This is what keeps the fake honest — and it is the bar a future
CloudApiTransport must pass before FARM_WA_TRANSPORT=cloud_api flips
(the Option B cutover).
"""

import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler

import pytest

from farm.whatsapp.mcp_bridge import BridgeTransport
from farm.whatsapp.transport import SchemaMismatch, TransportError
from wa_fakes import FakeTransport, QuietHTTPServer

BRIDGE_SCHEMA = """
CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TIMESTAMP);
CREATE TABLE messages (
    id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP,
    is_from_me BOOLEAN, media_type TEXT, filename TEXT, url TEXT,
    media_key BLOB, file_sha256 BLOB, file_enc_sha256 BLOB, file_length INTEGER,
    PRIMARY KEY (id, chat_jid)
);
"""


class StubBridgeSend:
    """Stands in for the whatsapp-mcp bridge REST endpoint (POST /api/send)."""

    def __init__(self):
        self.sends: list[dict] = []
        self.fail = False
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                if stub.fail:
                    body = b'{"success": false, "message": "not paired"}'
                    self.send_response(500)
                else:
                    stub.sends.append(payload)
                    body = b'{"success": true, "message": "sent"}'
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = QuietHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self._server.server_port}"

    def close(self):
        self._server.shutdown()
        self._server.server_close()


class BridgeHarness:
    def __init__(self, tmp_path):
        self.db = tmp_path / "messages.db"
        con = sqlite3.connect(self.db)
        con.executescript(BRIDGE_SCHEMA)
        con.commit()
        con.close()
        self.stub = StubBridgeSend()
        self.transport = BridgeTransport(self.db, self.stub.url)
        self._n = 0

    def seed(self, text, *, sender="15550001111", chat="15550001111@s.whatsapp.net",
             msg_id=None, ts="2026-07-20 10:00:00", is_from_me=0):
        self._n += 1
        con = sqlite3.connect(self.db)
        con.execute(
            "INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)",
            (msg_id or f"MSG-{self._n}", chat, sender, text, ts, is_from_me),
        )
        con.commit()
        con.close()

    def sent(self):
        return [(s["recipient"], s["message"]) for s in self.stub.sends]

    def make_send_fail(self):
        self.stub.fail = True

    def close(self):
        self.stub.close()


class FakeHarness:
    def __init__(self):
        self.transport = FakeTransport()

    def seed(self, text, **kw):
        kw.pop("is_from_me", None)  # the fake only ever holds inbound messages
        self.transport.seed(text, **kw)

    def sent(self):
        return list(self.transport.sent)

    def make_send_fail(self):
        self.transport.fail_send = True

    def close(self):
        pass


@pytest.fixture(params=["fake", "bridge"])
def harness(request, tmp_path):
    h = FakeHarness() if request.param == "fake" else BridgeHarness(tmp_path)
    yield h
    h.close()


# ---- the contract ----


def test_fetch_new_returns_messages_after_cursor_in_order(harness):
    harness.seed("one")
    harness.seed("two")
    harness.seed("three")
    msgs = harness.transport.fetch_new(0)
    assert [m.text for m in msgs] == ["one", "two", "three"]
    cursors = [m.cursor for m in msgs]
    assert cursors == sorted(cursors) and len(set(cursors)) == 3
    # advancing to the last cursor yields nothing
    assert harness.transport.fetch_new(cursors[-1]) == []
    # a partial cursor yields exactly the tail
    assert [m.text for m in harness.transport.fetch_new(cursors[0])] == ["two", "three"]


def test_equal_timestamps_are_neither_skipped_nor_doubled(harness):
    ts = "2026-07-20 12:00:00"
    harness.seed("same-a", ts=ts)
    harness.seed("same-b", ts=ts)
    first = harness.transport.fetch_new(0)
    assert [m.text for m in first] == ["same-a", "same-b"]
    # a poll from the first message's cursor sees only the second, once
    assert [m.text for m in harness.transport.fetch_new(first[0].cursor)] == ["same-b"]
    assert harness.transport.fetch_new(first[1].cursor) == []


def test_latest_cursor_baselines_to_the_newest_message(harness):
    assert harness.transport.latest_cursor() == 0
    harness.seed("old history")
    harness.seed("newer")
    latest = harness.transport.latest_cursor()
    assert harness.transport.fetch_new(latest) == []
    harness.seed("after baseline")
    assert [m.text for m in harness.transport.fetch_new(latest)] == ["after baseline"]


def test_send_delivers_recipient_and_text(harness):
    harness.transport.send("15550001111@s.whatsapp.net", "hello from the farm")
    assert harness.sent() == [("15550001111@s.whatsapp.net", "hello from the farm")]


def test_send_failure_raises_transport_error(harness):
    harness.make_send_fail()
    with pytest.raises(TransportError):
        harness.transport.send("15550001111@s.whatsapp.net", "hello")


# ---- bridge-specific behavior ----


def test_bridge_excludes_our_own_messages(tmp_path):
    h = BridgeHarness(tmp_path)
    try:
        h.seed("from them", is_from_me=0)
        h.seed("from us", is_from_me=1)
        assert [m.text for m in h.transport.fetch_new(0)] == ["from them"]
    finally:
        h.close()


def test_bridge_schema_mismatch_fails_loudly(tmp_path):
    db = tmp_path / "messages.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE messages (id TEXT, chat_jid TEXT, timestamp TIMESTAMP)")  # no content/sender/is_from_me
    con.commit()
    con.close()
    transport = BridgeTransport(db, "http://127.0.0.1:9")
    with pytest.raises(SchemaMismatch):
        transport.fetch_new(0)
    with pytest.raises(SchemaMismatch):
        transport.latest_cursor()


def test_bridge_missing_db_fails_loudly(tmp_path):
    transport = BridgeTransport(tmp_path / "nope.db", "http://127.0.0.1:9")
    with pytest.raises(TransportError):
        transport.fetch_new(0)
