"""The WhatsApp concierge loop. Runs inside tmux session farm-concierge-<slug>.

A deliberate *script* around the model, same shape as pm_agent.py: it polls
the WhatsApp transport, maps each allowed inbound message to one resumed
Claude call, validates the reply against a two-action whitelist
(set_priority, feedback), executes the survivors against the Node server's
HTTP API, and texts the reply back. It can never approve gates, merge or
deploy — those routes demand the human gate key, which this process does not
have.

Delivery semantics: at-most-once side effects. A message is *claimed*
(msg_id persisted, cursor advanced) after the model call but before any
action executes, so a crash mid-execution or a failed send never replays
actions — duplicate GitHub comments were the architecture review's headline
risk. The cursor is the transport's rowid-style position, not a timestamp,
so equal-timestamp messages can't be skipped or double-read.
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

from . import config
from .claude_runner import ClaudeError, extract_json, run_claude
from .config import CONCIERGE_MODEL, HORIZON_URL, STATE_DIR, ensure_dirs, slugify
from .whatsapp.transport import Inbound, Transport, TransportError

ROLE_PROMPT = (Path(__file__).parent / "roles" / "concierge.md").read_text()
PRIORITIES = ("Critical", "High", "Medium", "Low")
ALLOWED_ACTIONS = ("set_priority", "feedback")
PROCESSED_KEEP = 500  # msg_id dedupe window persisted across restarts
MAX_ACTIONS = 3


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def normalize_jid(jid: str) -> str:
    """'15551234567:12@s.whatsapp.net' -> '15551234567' (device suffix and
    server part are routing detail, not identity)."""
    return jid.split("@")[0].split(":")[0].strip().lower()


def sender_allowed(sender_jid: str) -> bool:
    """Hard allowlist — an empty FARM_WA_ALLOWED_JIDS means deny-all."""
    allowed = {normalize_jid(j) for j in config.FARM_WA_ALLOWED_JIDS}
    return bool(allowed) and normalize_jid(sender_jid) in allowed


def chat_allowed(chat_jid: str) -> bool:
    """Group chats are opt-in: only groups in FARM_WA_GROUP_JIDS are served.
    Direct/self chats pass through (the sender allowlist governs those)."""
    if not (chat_jid or "").endswith("@g.us"):
        return True
    return normalize_jid(chat_jid) in {normalize_jid(g) for g in config.FARM_WA_GROUP_JIDS}


class ConciergeState:
    """Cursor + processed-msg_id persistence (survives restarts).

    A missing cursor file baselines to the transport's latest position so a
    first run never replays the whole chat history as fresh commands.
    """

    def __init__(self, slug: str, transport: Transport):
        self.cursor_path = STATE_DIR / f"concierge-cursor-{slug}.txt"
        self.processed_path = STATE_DIR / f"concierge-processed-{slug}.json"
        self.session_path = STATE_DIR / f"concierge-session-{slug}.txt"
        if self.cursor_path.exists():
            self.cursor = int(self.cursor_path.read_text().strip() or 0)
        else:
            self.cursor = transport.latest_cursor()
            self.cursor_path.write_text(str(self.cursor))
        try:
            self.processed = list(json.loads(self.processed_path.read_text()))
        except (OSError, json.JSONDecodeError):
            self.processed = []

    def is_processed(self, msg_id: str) -> bool:
        return msg_id in self.processed

    def claim(self, msg: Inbound) -> None:
        """Persist BEFORE side effects: after this, the message never
        re-executes, even across a crash."""
        if msg.msg_id not in self.processed:
            self.processed.append(msg.msg_id)
            del self.processed[:-PROCESSED_KEEP]
            self.processed_path.write_text(json.dumps(self.processed))
        self.cursor = max(self.cursor, msg.cursor)
        self.cursor_path.write_text(str(self.cursor))

    def session_id(self) -> str | None:
        return self.session_path.read_text().strip() if self.session_path.exists() else None

    def save_session(self, session_id: str | None) -> None:
        if session_id:
            self.session_path.write_text(session_id)


# ---- prompt ----


def fetch_snapshot(base_url: str) -> dict:
    res = httpx.get(f"{base_url}/api/items", timeout=15)
    res.raise_for_status()
    return res.json()


def _item_line(item: dict) -> str:
    step = item.get("currentStep") or {}
    label = step.get("label")
    if item.get("activeRun"):
        status = f'agent working on "{label}"' if label else "step running now"
    elif item.get("paused"):
        status = f'paused at "{label}"' if label else "paused"
    elif step.get("kind") == "done":
        status = "closed"
    elif step.get("gate"):
        status = f'AWAITING HUMAN APPROVAL at gate "{label}"'
        if item.get("pr"):
            conflicts = ", has merge conflicts" if item.get("pr_mergeable") is False else ""
            status += f" (PR #{item['pr']}{conflicts})"
    else:
        status = f'queued at "{label}"' if label else "waiting"
    return f"- {item['id']} [{item.get('priority')}] {item.get('title')} — {status}"


def build_prompt(msg: Inbound, snapshot: dict) -> str:
    items = snapshot.get("items") or []
    lines = [
        f'WhatsApp message from {msg.sender_jid}: "{msg.text}"',
        "",
        "Current work items:",
    ]
    lines += [_item_line(it) for it in items] or ["(none)"]
    # Detail (outcome, progress, artifacts) only for items the message
    # names — the full snapshot would drown the model.
    named = [it for it in items if it["id"].lower() in msg.text.lower()]
    for it in named[:3]:
        lines += [
            "",
            f"Details for {it['id']}:",
            f"  outcome: {it.get('desc') or '(empty)'}",
            f"  success metric: {it.get('metric') or '(empty)'}",
        ]
        if it.get("pr"):
            lines.append(f"  PR: #{it['pr']} {it.get('pr_url') or ''}".rstrip())
        if it.get("release_tag"):
            lines.append(f"  release: {it['release_tag']} {it.get('release_url') or ''}".rstrip())
        outputs = sorted((it.get("stepOutputs") or {}).items(), key=lambda kv: int(kv[0]))
        if outputs:
            lines.append("  completed steps:")
            for step_index, out in outputs:
                name = out.get("label") or f"step {step_index}"
                summary = (out.get("output") or "").replace("\n", " ")[:300]
                lines.append(f'    {step_index}. "{name}" (attempt {out.get("attempt")}): {summary}')
        for step_index, out in outputs:
            if out.get("artifact"):
                name = out.get("label") or f"step {step_index}"
                lines.append(f'  artifact from step {step_index} "{name}":')
                lines.append("    " + out["artifact"][:4000].replace("\n", "\n    "))
    lines += ["", "Respond with ONLY the JSON object described in your role instructions."]
    return "\n".join(lines)


# ---- reply validation & action execution ----


def validate_reply(parsed: dict) -> tuple[str, list[dict], list[str]]:
    """Returns (reply, executable actions, notes about dropped ones)."""
    reply = str(parsed.get("reply", "")).strip()
    if not reply:
        raise ClaudeError("concierge reply missing 'reply'")
    actions: list[dict] = []
    notes: list[str] = []
    raw = parsed.get("actions")
    for action in (raw if isinstance(raw, list) else [])[:MAX_ACTIONS]:
        if not isinstance(action, dict):
            continue
        a_type = str(action.get("type", ""))
        item_id = str(action.get("item_id", "")).strip()
        if a_type not in ALLOWED_ACTIONS:
            # The prompt-injection / gate-bypass line of defense: nothing
            # outside the whitelist ever reaches the farm.
            notes.append(f"(dropped unsupported action '{a_type or 'unknown'}' — gates and merges need the Horizon UI)")
            continue
        if not item_id:
            notes.append(f"(dropped a {a_type} action with no item id)")
            continue
        if a_type == "set_priority":
            priority = str(action.get("priority", ""))
            if priority not in PRIORITIES:
                notes.append(f"(dropped set_priority for {item_id}: '{priority}' is not one of {'/'.join(PRIORITIES)})")
                continue
            actions.append({"type": a_type, "item_id": item_id, "priority": priority})
        else:
            message = str(action.get("message", "")).strip()[:2000]
            if not message:
                notes.append(f"(dropped an empty feedback action for {item_id})")
                continue
            actions.append({"type": a_type, "item_id": item_id, "message": message})
    return reply[:1500], actions, notes


def execute_actions(actions: list[dict], base_url: str = HORIZON_URL) -> list[str]:
    """Runs validated actions against the Node server; returns human-readable
    notes for the WhatsApp reply. Never raises — every outcome becomes a note."""
    notes: list[str] = []
    for action in actions:
        item_id = action["item_id"]
        try:
            if action["type"] == "set_priority":
                res = httpx.post(
                    f"{base_url}/api/items/{item_id}/priority",
                    json={"priority": action["priority"]},
                    timeout=15,
                )
                if res.status_code == 200:
                    notes.append(f"✓ {item_id} priority set to {action['priority']}")
                elif res.status_code == 404:
                    notes.append(f"✗ couldn't find {item_id}")
                else:
                    notes.append(f"✗ priority change for {item_id} failed ({_error_of(res)})")
            else:
                res = httpx.post(
                    f"{base_url}/api/items/{item_id}/feedback",
                    json={"message": action["message"]},
                    timeout=15,
                )
                if res.status_code == 200:
                    body = res.json()
                    if body.get("rerun"):
                        # The hidden side effect the architecture review
                        # flagged: feedback superseded an in-flight step.
                        notes.append(f"✓ feedback sent to {item_id} — it superseded the step that was running, which now re-runs with your note")
                    else:
                        notes.append(f"✓ feedback queued for {item_id} (and mirrored to its GitHub issue)")
                elif res.status_code == 404:
                    notes.append(f"✗ couldn't find {item_id}")
                else:
                    notes.append(f"✗ feedback for {item_id} failed ({_error_of(res)})")
        except httpx.HTTPError as exc:
            log(f"action {action['type']} for {item_id} errored: {exc}")
            notes.append(f"✗ {action['type']} for {item_id} failed (Horizon unreachable)")
    return notes


def _error_of(res: httpx.Response) -> str:
    try:
        return str(res.json().get("error", res.status_code))
    except ValueError:
        return str(res.status_code)


# ---- per-message pipeline ----


def process_message(msg: Inbound, transport: Transport, state: ConciergeState, base_url: str = HORIZON_URL) -> None:
    try:
        snapshot = fetch_snapshot(base_url)
        prompt = build_prompt(msg, snapshot)
        reply_raw = run_claude(
            prompt, session_id=state.session_id(), append_system=ROLE_PROMPT, model=CONCIERGE_MODEL
        )
        state.save_session(reply_raw.get("session_id"))
        try:
            reply, actions, notes = validate_reply(extract_json(reply_raw["result"]))
        except (ClaudeError, json.JSONDecodeError) as exc:
            log(f"invalid concierge reply ({exc}); retrying once")
            retry = run_claude(
                f"Your previous reply was invalid: {exc}. Respond again with ONLY the JSON object, no other text.",
                session_id=state.session_id(),
                append_system=ROLE_PROMPT,
                model=CONCIERGE_MODEL,
            )
            state.save_session(retry.get("session_id"))
            reply, actions, notes = validate_reply(extract_json(retry["result"]))
    except Exception as exc:
        log(f"message {msg.msg_id}: agent failed — {exc}")
        state.claim(msg)
        _send_safely(transport, msg.chat_jid, "Sorry — I hit an error handling that message. Nothing was changed; please try again.")
        return

    # Claim before executing: a crash from here on can not replay actions.
    state.claim(msg)
    notes = execute_actions(actions, base_url) + notes
    text = reply if not notes else reply + "\n" + "\n".join(notes)
    _send_safely(transport, msg.chat_jid, text)


def _send_safely(transport: Transport, chat_jid: str, text: str) -> None:
    # The message is already claimed — a failed send is logged, never retried
    # with re-executed actions.
    try:
        transport.send(chat_jid, text)
    except TransportError as exc:
        log(f"send to {chat_jid} failed: {exc}")


def poll_once(transport: Transport, state: ConciergeState, base_url: str = HORIZON_URL) -> int:
    """One poll pass; returns how many messages went through the agent."""
    handled = 0
    for msg in transport.fetch_new(state.cursor):
        if state.is_processed(msg.msg_id):
            state.claim(msg)  # advance the cursor past an already-done message
            continue
        if not msg.text.strip():
            state.claim(msg)  # media/empty — nothing to interpret
            continue
        if not chat_allowed(msg.chat_jid):
            state.claim(msg)  # unlisted group — not our channel, stay silent
            continue
        if not sender_allowed(msg.sender_jid):
            log(f"dropping message {msg.msg_id} from non-allowlisted sender {normalize_jid(msg.sender_jid)}")
            state.claim(msg)
            continue
        log(f"processing {msg.msg_id} from {normalize_jid(msg.sender_jid)}: {msg.text[:80]!r}")
        process_message(msg, transport, state, base_url)
        handled += 1
    return handled


def make_transport() -> Transport:
    if config.FARM_WA_TRANSPORT == "mcp_bridge":
        if not config.WA_DB_PATH:
            raise SystemExit("WA_DB_PATH must point at the whatsapp-mcp bridge's messages.db (see farm/README.md)")
        from .whatsapp.mcp_bridge import BridgeTransport

        return BridgeTransport(config.WA_DB_PATH, config.WA_BRIDGE_URL, command_chats=set(config.FARM_WA_GROUP_JIDS))
    raise SystemExit(
        f"unknown FARM_WA_TRANSPORT '{config.FARM_WA_TRANSPORT}' (cloud_api arrives with the Option B cutover)"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--once", action="store_true", help="one poll pass and exit (testing)")
    args = parser.parse_args()

    ensure_dirs()
    if not config.FARM_WA_ALLOWED_JIDS:
        # Deny-all would just burn polls; refuse to start so the
        # misconfiguration is visible in the tmux pane and the log.
        raise SystemExit("FARM_WA_ALLOWED_JIDS is empty — set the allowlist before enabling the concierge")
    transport = make_transport()
    state = ConciergeState(slugify(args.project), transport)
    log(f"concierge up for project '{args.project}' (cursor {state.cursor}, poll every {config.FARM_WA_POLL_S}s)")

    while True:
        try:
            poll_once(transport, state)
        except TransportError as exc:
            log(f"transport error (bridge down or re-pair needed?): {exc}")
        except Exception as exc:
            log(f"poll error: {exc}")
        if args.once:
            return
        time.sleep(config.FARM_WA_POLL_S)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted — exiting (farmd's watchdog will restart this agent)")
        sys.exit(130)
