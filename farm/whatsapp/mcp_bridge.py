"""Option A transport: the local whatsapp-mcp WhatsApp Web bridge.

Reads inbound messages straight from the bridge's SQLite store (WA_DB_PATH,
read-only) and sends replies through its REST endpoint (WA_BRIDGE_URL,
`POST /api/send`). The store schema is third-party and unversioned — pin the
bridge version you paired with (see farm/README.md) — so every poll verifies
the columns we rely on and raises SchemaMismatch instead of silently
returning nothing.

The cursor is the messages table's rowid: assigned in insert order, strictly
increasing, and immune to the equal-timestamp skip/double-read problem a
timestamp cursor would have.
"""

import sqlite3
from pathlib import Path

import httpx

from .transport import Inbound, SchemaMismatch, TransportError

EXPECTED_COLUMNS = {"id", "chat_jid", "sender", "content", "timestamp", "is_from_me"}


class BridgeTransport:
    def __init__(self, db_path: str | Path, bridge_url: str):
        self.db_path = Path(db_path)
        self.bridge_url = bridge_url.rstrip("/")

    def _connect(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise TransportError(
                f"bridge store not found at {self.db_path} — is the whatsapp-mcp bridge running and paired?"
            )
        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        cols = {row[1] for row in con.execute("PRAGMA table_info(messages)")}
        missing = EXPECTED_COLUMNS - cols
        if missing:
            con.close()
            raise SchemaMismatch(
                f"bridge store {self.db_path} is missing expected messages columns {sorted(missing)} — "
                "the whatsapp-mcp bridge schema changed; re-pin the bridge version"
            )
        return con

    def fetch_new(self, cursor: int) -> list[Inbound]:
        con = self._connect()
        try:
            rows = con.execute(
                "SELECT rowid, id, chat_jid, sender, content, timestamp FROM messages "
                "WHERE rowid > ? AND is_from_me = 0 ORDER BY rowid",
                (cursor,),
            ).fetchall()
        finally:
            con.close()
        return [
            Inbound(msg_id=r[1], chat_jid=r[2], sender_jid=r[3] or "", text=r[4] or "", ts=str(r[5]), cursor=r[0])
            for r in rows
        ]

    def latest_cursor(self) -> int:
        con = self._connect()
        try:
            return con.execute("SELECT COALESCE(MAX(rowid), 0) FROM messages").fetchone()[0]
        finally:
            con.close()

    def send(self, chat_jid: str, text: str) -> None:
        try:
            res = httpx.post(
                f"{self.bridge_url}/api/send",
                json={"recipient": chat_jid, "message": text},
                timeout=30,
            )
        except httpx.HTTPError as exc:
            raise TransportError(f"bridge send failed: {exc}") from exc
        if res.status_code != 200:
            raise TransportError(f"bridge send returned {res.status_code}: {res.text[:200]}")
        try:
            body = res.json()
        except ValueError:
            body = {}
        if body.get("success") is False:
            raise TransportError(f"bridge refused the send: {body.get('message', 'unknown reason')}")
