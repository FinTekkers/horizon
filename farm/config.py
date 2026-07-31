"""Farm configuration — all via environment, safe defaults for local dev."""

import json
import os
from pathlib import Path

FARM_PORT = int(os.environ.get("FARM_PORT", "4100"))
HORIZON_URL = os.environ.get("HORIZON_URL", "http://localhost:3001")
SHARED_SECRET = os.environ.get("FARM_SHARED_SECRET", "dev-secret")

FARM_HOME = Path(os.environ.get("FARM_HOME", str(Path.home() / ".horizon-farm")))
QUEUE_DIR = FARM_HOME / "queue"
STATE_DIR = FARM_HOME / "state"
LOGS_DIR = FARM_HOME / "logs"
WORKSPACES_DIR = FARM_HOME / "workspaces"

# Override with a fake binary in tests (farm/tests/fake_claude).
CLAUDE_BIN = os.environ.get("FARM_CLAUDE_BIN", "claude")
# HZ-5: "sdk" streams agent activity live via claude-agent-sdk; "subprocess"
# is the rollback lever restoring the silent `claude -p` path.
FARM_RUNNER = os.environ.get("FARM_RUNNER", "sdk")
PM_MODEL = os.environ.get("FARM_PM_MODEL")  # None -> CLI default
STEP_TIMEOUT_S = int(os.environ.get("FARM_STEP_TIMEOUT_S", "900"))
MAX_TURNS = int(os.environ.get("FARM_MAX_TURNS", "8"))


# ---- WhatsApp concierge (HZ-7) ----
# Off by default: the concierge only launches with FARM_WA_ENABLED=1 AND a
# non-empty sender allowlist. An empty allowlist means deny-all, never
# allow-all.
FARM_WA_ENABLED = os.environ.get("FARM_WA_ENABLED", "0").strip().lower() in ("1", "true", "yes")
FARM_WA_TRANSPORT = os.environ.get("FARM_WA_TRANSPORT", "mcp_bridge")
FARM_WA_POLL_S = int(os.environ.get("FARM_WA_POLL_S", "5"))
FARM_WA_ALLOWED_JIDS = [j.strip() for j in os.environ.get("FARM_WA_ALLOWED_JIDS", "").split(",") if j.strip()]
# Group chats the concierge serves (comma-separated jids like
# 1203...@g.us). Group messages are only processed when the group is
# listed here AND the sender is allowlisted; the owner's own messages in
# a listed group count as commands too.
FARM_WA_GROUP_JIDS = [j.strip() for j in os.environ.get("FARM_WA_GROUP_JIDS", "").split(",") if j.strip()]
# mcp_bridge transport: the whatsapp-mcp bridge's REST endpoint and SQLite store.
WA_BRIDGE_URL = os.environ.get("WA_BRIDGE_URL", "http://localhost:8080")
WA_DB_PATH = os.environ.get("WA_DB_PATH", "")
CONCIERGE_MODEL = os.environ.get("FARM_CONCIERGE_MODEL")  # None -> CLI default

# HZ-15: create work items and approve gates from WhatsApp.
# Where the web UI lives — texted back as a deep link (e.g. "HZ-7" ->
# f"{FARM_UI_URL}/hz-7"). Separate from the server's own UI_URL: this is the
# farm's Python process, a different env than the Node server.
FARM_UI_URL = os.environ.get("FARM_UI_URL", "http://localhost:5173").rstrip("/")
# jid -> display name (e.g. {"15551112222": "David"}), so every wizard/gate
# reply can say whose turn it is and never let one sender's answers or
# approvals bleed into another's.
FARM_WA_SENDER_NAMES = json.loads(os.environ.get("FARM_WA_SENDER_NAMES", "{}"))
# Stale conversation state expires instead of hijacking an unrelated later
# message from the same sender.
FARM_WA_WIZARD_TTL_S = int(os.environ.get("FARM_WA_WIZARD_TTL_S", "1800"))
FARM_WA_CHOICE_TTL_S = int(os.environ.get("FARM_WA_CHOICE_TTL_S", "600"))


def ensure_dirs() -> None:
    for d in (QUEUE_DIR / "pm", STATE_DIR, LOGS_DIR, WORKSPACES_DIR):
        d.mkdir(parents=True, exist_ok=True)


def slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
