"""Item-creation wizard and gate-choice resolver for the WhatsApp concierge
(HZ-15). Both are deterministic, non-LLM state machines — Claude never runs
for these turns — so a crash mid-conversation or a model hiccup can never
confuse one sender's turn for another's or make the bot reply to itself.

State is keyed by the exact (chat_jid, sender_jid) pair, never chat_jid
alone: two people mid-conversation in the same group chat can never read or
advance each other's wizard/choice state (the David/Evan guardrail).

Idempotency mirrors concierge_agent.ConciergeState's existing contract:
`state.claim(msg)` is called before any side effect a turn produces (a state
write, or the POST to Horizon on the wizard's final "confirm" step / a gate
choice), so a crash never replays a step — the plain-feedback flow's
claim-before-execute discipline (see concierge_agent.py's module docstring)
applies here too. The trade-off is the same one that flow already accepts:
a crash between claim() and the side effect loses that turn's answer rather
than ever duplicating a created item or a gate approval.
"""

import json
import re
import time
from datetime import datetime
from typing import TYPE_CHECKING

import httpx

from . import config
from .config import STATE_DIR
from .whatsapp.transport import Inbound, Transport, TransportError

if TYPE_CHECKING:
    from .concierge_agent import ConciergeState

PRIORITIES = ("Critical", "High", "Medium", "Low")
NEW_ITEM_RE = re.compile(r"^\[new item\]\s*(.*)$", re.IGNORECASE | re.DOTALL)
NUMERIC_RE = re.compile(r"^[1-9]$")

STEP_PROMPTS = {
    "title": "What's the title?",
    "outcome": "What's the outcome — what should be true when this is done?",
    "metric": "How will we measure success?",
    "guardrails": "Any guardrails or constraints? (reply 'skip' for none)",
    "priority": "Priority — reply 1) Critical 2) High 3) Medium 4) Low",
}
_PRIORITY_NUMS = {"1": "Critical", "2": "High", "3": "Medium", "4": "Low"}


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] wizard: {msg}", flush=True)


def sender_label(sender_jid: str) -> str:
    """Display name for a sender — every wizard/gate-choice reply is
    prefixed with this, so it's always explicit whose turn is being
    answered even when two people share one group chat."""
    from .concierge_agent import normalize_jid

    jid = normalize_jid(sender_jid)
    return config.FARM_WA_SENDER_NAMES.get(jid) or f"...{jid[-4:]}"


def _key(msg: Inbound) -> str:
    return f"{msg.chat_jid}:{msg.sender_jid}"


def _touch(session: dict) -> dict:
    session["updated_at"] = time.time()
    return session


def _expired(session: dict, ttl_s: int) -> bool:
    return (time.time() - session.get("updated_at", 0)) > ttl_s


def _reply(transport: Transport, msg: Inbound, text: str) -> None:
    try:
        transport.send(msg.chat_jid, f"{sender_label(msg.sender_jid)}, {text}")
    except TransportError as exc:
        _log(f"send to {msg.chat_jid} failed: {exc}")


class _JsonStore:
    """Tiny per-slug JSON dict store, same survives-restarts pattern as
    ConciergeState's cursor/processed files."""

    def __init__(self, path):
        self.path = path
        try:
            self._data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            self._data = {}

    def get(self, key: str):
        return self._data.get(key)

    def set(self, key: str, value: dict) -> None:
        self._data[key] = value
        self.path.write_text(json.dumps(self._data))

    def clear(self, key: str) -> None:
        if key in self._data:
            del self._data[key]
            self.path.write_text(json.dumps(self._data))


class WizardStore(_JsonStore):
    def __init__(self, slug: str):
        super().__init__(STATE_DIR / f"concierge-wizard-{slug}.json")


class PendingChoiceStore(_JsonStore):
    def __init__(self, slug: str):
        super().__init__(STATE_DIR / f"concierge-choice-{slug}.json")


# ---- item-creation wizard ----


def _new_session(title: str) -> dict:
    return _touch(
        {
            "step": "outcome" if title else "title",
            "title": title,
            "outcome": "",
            "metric": "",
            "guardrails": "",
            "priority": "Medium",
        }
    )


def _parse_priority(text: str) -> str | None:
    t = text.strip()
    if t in _PRIORITY_NUMS:
        return _PRIORITY_NUMS[t]
    for p in PRIORITIES:
        if t.lower() == p.lower():
            return p
    return None


def _summary(session: dict) -> str:
    lines = [
        "Here's what I've got:",
        f"Title: {session['title']}",
        f"Outcome: {session['outcome']}",
        f"Success metric: {session['metric']}",
        f"Guardrails: {session['guardrails'] or '(none)'}",
        f"Priority: {session['priority']}",
        "Reply 1 to create it, 2 to edit, or 3 to cancel.",
    ]
    return "\n".join(lines)


def _create_item(base_url: str, session: dict) -> tuple[bool, str]:
    try:
        res = httpx.post(
            f"{base_url}/api/items",
            json={
                "title": session["title"],
                "outcome": session["outcome"],
                "metric": session["metric"],
                "guardrails": session["guardrails"],
                "priority": session["priority"],
            },
            timeout=15,
        )
    except httpx.HTTPError as exc:
        return False, f"Couldn't create the item — Horizon is unreachable ({exc})."
    if res.status_code != 200:
        try:
            err = res.json().get("error", res.status_code)
        except ValueError:
            err = res.status_code
        return False, f"Couldn't create the item: {err}"
    body = res.json()
    item_id = body["id"]
    lines = [f"Created {item_id}! {config.FARM_UI_URL}/{item_id.lower()}"]
    if body.get("issue") and body.get("url"):
        lines.append(f"GitHub issue #{body['issue']}: {body['url']}")
    return True, "\n".join(lines)


def try_handle_item_wizard(
    msg: Inbound,
    transport: Transport,
    wstore: WizardStore,
    state: "ConciergeState",
    base_url: str,
) -> bool:
    """Returns True if this message belongs to the item-creation wizard
    (start/advance/edit/cancel/confirm) and must not reach Claude."""
    key = _key(msg)
    text = msg.text.strip()
    session = wstore.get(key)
    m = NEW_ITEM_RE.match(text)

    if session is not None and _expired(session, config.FARM_WA_WIZARD_TTL_S):
        wstore.clear(key)
        session = None

    if session is None:
        if not m:
            return False
        state.claim(msg)
        session = _new_session(m.group(1).strip())
        wstore.set(key, session)
        _reply(transport, msg, STEP_PROMPTS[session["step"]])
        return True

    if m:  # a fresh trigger mid-conversation restarts it; the old draft is discarded, never created
        state.claim(msg)
        session = _new_session(m.group(1).strip())
        wstore.set(key, session)
        _reply(transport, msg, f"Starting a new item (the previous draft was discarded). {STEP_PROMPTS[session['step']]}")
        return True

    if text.lower() == "cancel":
        state.claim(msg)
        wstore.clear(key)
        _reply(transport, msg, "Cancelled — no item was created.")
        return True

    step = session["step"]
    if step in ("title", "outcome", "metric", "guardrails"):
        state.claim(msg)
        next_step = {"title": "outcome", "outcome": "metric", "metric": "guardrails", "guardrails": "priority"}[step]
        if step == "guardrails":
            session["guardrails"] = "" if text.lower() == "skip" else text
        else:
            session[step] = text
        session["step"] = next_step
        wstore.set(key, _touch(session))
        _reply(transport, msg, STEP_PROMPTS[next_step])
        return True

    if step == "priority":
        priority = _parse_priority(text)
        state.claim(msg)
        if priority is None:
            _reply(transport, msg, "Sorry, I didn't catch that — reply 1) Critical 2) High 3) Medium 4) Low.")
            return True
        session["priority"] = priority
        session["step"] = "confirm"
        wstore.set(key, _touch(session))
        _reply(transport, msg, _summary(session))
        return True

    # step == "confirm"
    choice = text.strip().lower()
    if choice in ("1", "create", "yes", "y"):
        state.claim(msg)  # claimed before the external POST — a crash from here on never duplicates the item
        wstore.clear(key)
        ok, text_out = _create_item(base_url, session)
        _reply(transport, msg, text_out)
        return True
    if choice in ("2", "edit"):
        state.claim(msg)
        session["step"] = "title"
        wstore.set(key, _touch(session))
        _reply(transport, msg, "Let's redo it — " + STEP_PROMPTS["title"])
        return True
    if choice in ("3", "cancel"):
        state.claim(msg)
        wstore.clear(key)
        _reply(transport, msg, "Cancelled — no item was created.")
        return True
    state.claim(msg)
    _reply(transport, msg, "Reply 1 to create it, 2 to edit, or 3 to cancel.")
    return True


# ---- gate-choice resolver (the WhatsApp proxy for a radio-button approval) ----


def offer_gate_choices(chat_jid: str, sender_jid: str, options: list[dict], cstore: PendingChoiceStore) -> None:
    """Called after a Claude reply that lists items AWAITING HUMAN APPROVAL
    with a gate_options list — remembers the numbered mapping so the next
    bare numeric reply from this exact sender resolves deterministically.
    The script (this function and try_handle_gate_choice), never the model,
    decides what a number means."""
    key = f"{chat_jid}:{sender_jid}"
    if not options:
        cstore.clear(key)
        return
    cstore.set(key, _touch({"options": options}))


def _approve_gate(base_url: str, option: dict, sender: str) -> tuple[bool, str]:
    try:
        res = httpx.post(
            f"{base_url}/api/items/{option['item_id']}/gates/{option['step_index']}/approve-via-whatsapp",
            json={"sender": sender},
            headers={"x-farm-secret": config.SHARED_SECRET},
            timeout=15,
        )
    except httpx.HTTPError as exc:
        return False, f"Horizon unreachable ({exc})"
    if res.status_code == 200:
        return True, ""
    try:
        return False, str(res.json().get("error", res.status_code))
    except ValueError:
        return False, str(res.status_code)


def try_handle_gate_choice(
    msg: Inbound,
    transport: Transport,
    cstore: PendingChoiceStore,
    state: "ConciergeState",
    base_url: str,
) -> bool:
    """A bare 1-9 reply resolves against this sender's most recently offered
    gate_options list (WhatsApp's proxy for a radio button — see
    concierge_agent module docstring). Claimed before the
    approve-via-whatsapp POST for the same at-most-once guarantee as the
    item wizard."""
    text = msg.text.strip()
    if not NUMERIC_RE.match(text):
        return False
    key = _key(msg)
    pending = cstore.get(key)
    if pending is None:
        return False
    if _expired(pending, config.FARM_WA_CHOICE_TTL_S):
        cstore.clear(key)
        return False

    options = pending["options"]
    idx = int(text) - 1
    state.claim(msg)
    if idx < 0 or idx >= len(options):
        cstore.clear(key)
        _reply(transport, msg, "That number isn't one of the approvals I listed — nothing changed.")
        return True
    option = options[idx]
    cstore.clear(key)
    ok, err = _approve_gate(base_url, option, sender_label(msg.sender_jid))
    if ok:
        _reply(transport, msg, f"Approved {option['item_id']} — {option['label']}.")
    else:
        _reply(transport, msg, f"Couldn't approve {option['item_id']}: {err}")
    return True
