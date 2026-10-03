"""HZ-274: the WhatsApp Autopilot kill switch, handled before any model call.

`autopilot off <project>` is forwarded to the server, which is the only
authority on who the owner is (the first WA_APPROVER_JIDS entry, checked
there against the sender's jid behind WA_APPROVAL_SECRET — the same pattern
as wizard._approve_gate). This module only parses the message and words the
reply.

`autopilot on <project>` and `autopilot shadow <project>` are refused here,
with no server call at all: turning Autopilot on stays Admin + PIN only, and
a reply that never asked the server can say nothing about the project.

Senders outside FARM_WA_ALLOWED_JIDS never get here — poll_once drops them
silently first, so a stranger learns nothing.
"""

import re
from datetime import datetime

import httpx

from . import config
from .whatsapp.transport import Inbound, Transport, TransportError

COMMAND = re.compile(r"^\s*autopilot\s+(off|on|shadow)\s+(.+?)\s*$", re.IGNORECASE | re.DOTALL)
ROUTE = "/api/projects/autopilot-off-via-whatsapp"

ADMIN_ONLY = "Autopilot can only be turned on or to shadow in Admin, with the PIN. Nothing was changed."
REFUSED = "Refused. Only the owner can turn Autopilot off from WhatsApp. Nothing was changed."
NOT_FOUND = "No project matches that name. Nothing was changed."
UNREACHABLE = "Couldn't reach Horizon. Nothing was changed."


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] autopilot: {msg}", flush=True)


def parse(text: str) -> tuple[str, str] | None:
    """'Autopilot OFF  Horizon ' -> ('off', 'Horizon'); anything else -> None."""
    match = COMMAND.match(text or "")
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def _turn_off(base_url: str, project: str, sender_jid: str) -> str:
    if not config.WA_APPROVAL_SECRET:
        return UNREACHABLE
    try:
        res = httpx.post(
            f"{base_url}{ROUTE}",
            json={"project": project, "senderJid": sender_jid},
            headers={"x-wa-approval-secret": config.WA_APPROVAL_SECRET},
            timeout=15,
        )
    except httpx.HTTPError:
        return UNREACHABLE
    if res.status_code == 200:
        try:
            body = res.json()
        except ValueError:
            body = {}
        name = str(body.get("project") or project)
        if body.get("unchanged"):
            return f"Autopilot was already off for {name}."
        return f"Autopilot is now off for {name}."
    if res.status_code == 403:
        return REFUSED
    if res.status_code == 404:
        return NOT_FOUND
    return UNREACHABLE


def try_handle(msg: Inbound, transport: Transport, state, base_url: str) -> bool:
    """True when the message was an Autopilot command (handled, claimed and
    answered here); False leaves it to the next handler."""
    command = parse(msg.text)
    if command is None:
        return False
    mode, project = command
    # Claim before the side effect, like wizard.py: a crash can never repeat it.
    state.claim(msg)
    text = _turn_off(base_url, project, msg.sender_jid) if mode == "off" else ADMIN_ONLY
    _log(f"message {msg.msg_id}: autopilot {mode} — {text[:60]!r}")
    try:
        transport.send(msg.chat_jid, text)
    except TransportError as exc:
        _log(f"message {msg.msg_id}: reply send failed: {exc}")
    return True
