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


# Concierge replies carry this marker so self-chat ingestion can never
# echo-loop on the bot's own messages (they are is_from_me=1 in the same chat
# as the human's commands).
BOT_MARKER = "\U0001F916 "  # robot face + space


def _normalize(jid: str) -> str:
    return (jid or "").split("@")[0].split(":")[0].strip().lower()


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

    def _own_identities(self) -> tuple[set, str]:
        """(normalized own ids {phone, lid}, canonical phone jid) from the
        bridge's whatsmeow store. Missing/unpaired store -> empty: self-chat
        commands are then simply not recognized (incoming-only behavior)."""
        device_db = Path(self.db_path).parent / "whatsapp.db"
        if not device_db.exists():
            return set(), ""
        try:
            con = sqlite3.connect(f"file:{device_db}?mode=ro", uri=True)
            try:
                row = con.execute("SELECT jid, COALESCE(lid, '') FROM whatsmeow_device LIMIT 1").fetchone()
            finally:
                con.close()
        except sqlite3.Error:
            return set(), ""
        if not row or not row[0]:
            return set(), ""
        phone = _normalize(row[0])
        ids = {phone}
        if row[1]:
            ids.add(_normalize(row[1]))
        return ids, f"{phone}@s.whatsapp.net"

    def fetch_new(self, cursor: int) -> list[Inbound]:
        con = self._connect()
        try:
            rows = con.execute(
                "SELECT rowid, id, chat_jid, sender, content, timestamp, is_from_me FROM messages "
                "WHERE rowid > ? ORDER BY rowid",
                (cursor,),
            ).fetchall()
        finally:
            con.close()
        own_ids, own_phone_jid = self._own_identities()
        out = []
        for r in rows:
            text = r[4] or ""
            if r[6]:  # is_from_me: only the owner's SELF-chat counts as inbound
                if _normalize(r[2]) not in own_ids:
                    continue  # owner's message in someone else's chat — never a command
                if text.startswith(BOT_MARKER):
                    continue  # our own reply echoing back
                # WhatsApp records self-chat senders as the LID; present the
                # canonical phone jid so the allowlist matches naturally.
                out.append(Inbound(msg_id=r[1], chat_jid=r[2], sender_jid=own_phone_jid or (r[3] or ""), text=text, ts=str(r[5]), cursor=r[0]))
            else:
                out.append(Inbound(msg_id=r[1], chat_jid=r[2], sender_jid=r[3] or "", text=text, ts=str(r[5]), cursor=r[0]))
        return out

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
                json={"recipient": chat_jid, "message": BOT_MARKER + text},
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
