"""The transport seam: every byte of WhatsApp I/O crosses this interface.

The concierge agent, role prompt and action executor only ever see `Inbound`
and `Transport`. Option A (the local whatsapp-mcp bridge, mcp_bridge.py) and
the later Option B cutover (WhatsApp Business Cloud API, cloud_api.py) are
just two implementations — swapping FARM_WA_TRANSPORT is the whole switch.

Cursor semantics (contract-tested in tests/test_whatsapp_transport.py):
- `cursor` is a transport-specific monotonically increasing int; each Inbound
  carries its own position so the caller can advance per message.
- `fetch_new(cursor)` returns inbound (never our own) messages with a cursor
  strictly greater than the argument, in ascending cursor order.
- `latest_cursor()` is the position of the newest stored message (0 if none) —
  used to baseline a first run instead of replaying the whole chat history.
"""

from dataclasses import dataclass
from typing import Protocol


class TransportError(RuntimeError):
    """The transport could not fetch or send (bridge down, HTTP failure)."""


class SchemaMismatch(TransportError):
    """The third-party bridge store no longer looks like we expect — fail
    loudly rather than silently polling nothing."""


@dataclass(frozen=True)
class Inbound:
    msg_id: str
    chat_jid: str
    sender_jid: str
    text: str
    ts: str
    cursor: int


class Transport(Protocol):
    def fetch_new(self, cursor: int) -> list[Inbound]: ...

    def latest_cursor(self) -> int: ...

    def send(self, chat_jid: str, text: str) -> None: ...
