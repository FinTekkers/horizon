"""Real-bridge end-to-end check — the HZ-7 success metric, as one command.

CI runs the FakeTransport round trip (test_concierge.py); this file drives
the REAL whatsapp-mcp bridge and is skipped unless explicitly requested,
because it needs a paired WhatsApp session, the Node server, and a human
sending one message from their phone.

Run it like this (from the repo root):

    FARM_WA_E2E=1 \
    FARM_WA_ALLOWED_JIDS=<your number, e.g. 15550001111> \
    WA_DB_PATH=~/Dev/whatsapp-mcp/whatsapp-bridge/store/messages.db \
    FARM_CLAUDE_BIN=$(which claude) \
    farm/.venv/bin/python -m pytest farm/tests/test_e2e_whatsapp.py -s

then, when prompted, text "horizon e2e ping" (plus anything else, e.g. an
item id) to the farm's WhatsApp account from an allowlisted phone. The test
processes it through the real concierge pipeline and asserts the reply came
back out through the bridge.

HZ-15 (the item wizard and gate-choice approval) is a single-phone check
here — its cross-sender guardrail (two allowlisted phones mid-conversation
in one group chat never read or advance each other's wizard/approval state)
is covered automatically instead, in test_wizard.py.
"""

import os
import sqlite3
import time

import httpx
import pytest

from farm import config

pytestmark = pytest.mark.skipif(
    os.environ.get("FARM_WA_E2E") != "1",
    reason="real-bridge e2e — set FARM_WA_E2E=1 with a paired whatsapp-mcp bridge (see module docstring)",
)

PING = "horizon e2e ping"


def test_whatsapp_round_trip_through_the_real_bridge():
    from farm import concierge_agent as ca
    from farm.whatsapp.mcp_bridge import BridgeTransport

    if not config.WA_DB_PATH or not os.path.exists(os.path.expanduser(config.WA_DB_PATH)):
        pytest.skip(f"WA_DB_PATH not set or missing ({config.WA_DB_PATH!r}) — pair the bridge first")
    if not config.FARM_WA_ALLOWED_JIDS:
        pytest.skip("FARM_WA_ALLOWED_JIDS not set — the concierge would deny your message")
    try:
        httpx.get(config.WA_BRIDGE_URL, timeout=5)
    except httpx.HTTPError:
        pytest.skip(f"bridge not reachable at {config.WA_BRIDGE_URL} — is whatsapp-bridge running?")
    try:
        httpx.get(f"{config.HORIZON_URL}/api/items", timeout=5).raise_for_status()
    except httpx.HTTPError:
        pytest.skip(f"Horizon server not reachable at {config.HORIZON_URL} — start server/ first")

    db_path = os.path.expanduser(config.WA_DB_PATH)
    transport = BridgeTransport(db_path, config.WA_BRIDGE_URL)
    baseline = transport.latest_cursor()

    timeout_s = int(os.environ.get("FARM_WA_E2E_TIMEOUT_S", "180"))
    print(f'\n>>> Text "{PING}" (e.g. "{PING} — what items are open?") to the farm\'s')
    print(f">>> WhatsApp from an allowlisted phone. Waiting up to {timeout_s}s…")

    msg = None
    deadline = time.time() + timeout_s
    while msg is None and time.time() < deadline:
        for m in transport.fetch_new(baseline):
            if PING in m.text.lower() and ca.sender_allowed(m.sender_jid):
                msg = m
                break
        else:
            time.sleep(3)
    if msg is None:
        pytest.fail(f'no allowlisted message containing "{PING}" arrived within {timeout_s}s')
    print(f">>> got it ({msg.msg_id}); running the concierge pipeline…")

    state = ca.ConciergeState("e2e-run", transport)
    ca.process_message(msg, transport, state)

    # The bridge echoes messages sent through its REST API back into its own
    # store as is_from_me = 1 — that row is the proof the reply went out.
    deadline = time.time() + 30
    replied = 0
    while replied == 0 and time.time() < deadline:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        replied = con.execute(
            "SELECT COUNT(*) FROM messages WHERE chat_jid = ? AND is_from_me = 1 AND rowid > ?",
            (msg.chat_jid, msg.cursor),
        ).fetchone()[0]
        con.close()
        if replied == 0:
            time.sleep(2)
    assert replied >= 1, "the concierge reply never appeared in the bridge store — check the concierge log"
    print(">>> reply confirmed in the bridge store — full round trip OK")
