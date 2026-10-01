"""Farm configuration — all via environment, safe defaults for local dev."""

import json
import os
from pathlib import Path

FARM_PORT = int(os.environ.get("FARM_PORT", "4100"))
HORIZON_URL = os.environ.get("HORIZON_URL", "http://localhost:3001")
# farmd's credential for /api/farm/* on the Node server. HZ-140: farmd is the
# only farm process that holds it — tmux_mgr.py refuses to forward it into any
# agent session, so a step agent can no longer read it out of its own env.
SHARED_SECRET = os.environ.get("FARM_SHARED_SECRET", "dev-secret")
# HZ-140: the ONLY credential that can approve a gate, and the only one the
# concierge holds. No dev default on purpose — unset means WhatsApp approvals
# refuse (the server answers 503), never silently succeed.
WA_APPROVAL_SECRET = os.environ.get("WA_APPROVAL_SECRET", "")

FARM_HOME = Path(os.environ.get("FARM_HOME", str(Path.home() / ".horizon-farm")))
QUEUE_DIR = FARM_HOME / "queue"
STATE_DIR = FARM_HOME / "state"
LOGS_DIR = FARM_HOME / "logs"
WORKSPACES_DIR = FARM_HOME / "workspaces"

# Override with a fake binary in tests (farm/tests/fake_claude).
CLAUDE_BIN = os.environ.get("FARM_CLAUDE_BIN", "claude")
# HZ-5: "sdk" streams agent activity live via claude-agent-sdk; "subprocess"
# is the rollback lever restoring the silent `claude -p` path. Only affects
# the claude provider's own internals — unrelated to FARM_PROVIDER below.
FARM_RUNNER = os.environ.get("FARM_RUNNER", "sdk")
PM_MODEL = os.environ.get("FARM_PM_MODEL")  # None -> CLI default
# HZ-187: model for step agents and conflict resolution (Claude provider only).
STEP_MODEL = os.environ.get("FARM_STEP_MODEL") or None  # unset/empty -> CLI default
# HZ-188: how long an implement/review step waits for the item's workspace
# lock (farm/workspaces.py item_lock) while a conflict resolver still holds it
# — e.g. the server timed out a resolve and sent the item back while farmd
# was finishing. Kept short: the wait runs inside the step's own server-side
# execution timer (50 min for implement against a 45 min agent budget), so a
# long wait would just turn into a timeout. Past it the step fails with
# "workspace busy" and never touches the worktree.
ITEM_LOCK_WAIT_S = int(os.environ.get("FARM_ITEM_LOCK_WAIT_S", "300"))
STEP_TIMEOUT_S = int(os.environ.get("FARM_STEP_TIMEOUT_S", "900"))
MAX_TURNS = int(os.environ.get("FARM_MAX_TURNS", "8"))

# HZ-101: how often farmd reconciles claimed runs against live tmux sessions
# (session gone -> report the run failed instead of waiting for the server's
# execution timer), and how long a just-claimed run is given before its
# missing session is treated as proof of death rather than "still launching".
RECONCILE_INTERVAL_S = int(os.environ.get("FARM_RECONCILE_INTERVAL_S", "60"))
RECONCILE_GRACE_S = int(os.environ.get("FARM_RECONCILE_GRACE_S", "90"))

# HZ-130: how long a PM task file must stay unusable before the PM reports it
# to the server instead of retrying it. An unusable file is never deleted
# unreported, and never retried forever — this is the bound between those two.
# Measured from the file's mtime rather than an in-memory poll counter, so a
# PM restart (the watchdog revives it every 15s) cannot reset it to zero.
# Must stay well under the server's own FARM_QUEUE_TIMEOUT_MS (10 minutes,
# server/src/config.js) so the PM's specific report wins the race against a
# generic `never_picked_up`. Raise it to retry-effectively-forever without a
# deploy; the file is kept either way.
PM_MALFORMED_GRACE_S = int(os.environ.get("FARM_PM_MALFORMED_GRACE_S", "30"))

# ---- HZ-154: the scoped merge-conflict path ----
# Caps on what the narrow path will even attempt. Above either, the conflict
# escalates straight to the full implement cycle — a 30-file conflict is not a
# "small merge conflict" and pretending otherwise would put a whole
# re-implementation behind a scoped review that only reads the resolution.
CONFLICT_MAX_FILES = int(os.environ.get("FARM_CONFLICT_MAX_FILES", "5"))
# Counted as every line inside a conflict region, each side separately
# (farm/conflict_hunks.py's Hunk.size) — what a human actually reads.
CONFLICT_MAX_LINES = int(os.environ.get("FARM_CONFLICT_MAX_LINES", "60"))
# Both agent calls happen inside ONE synchronous /conflicts/resolve request,
# so these two plus the repo's own check suite must stay well under the
# server's FARM_CONFLICT_RESOLVE_TIMEOUT_MS (50 min, server/src/config.js):
# 10 + 8 + 10 = 28 min of budget against a 50 min ceiling.
CONFLICT_AGENT_TIMEOUT_S = int(os.environ.get("FARM_CONFLICT_AGENT_TIMEOUT_S", "600"))
CONFLICT_REVIEW_TIMEOUT_S = int(os.environ.get("FARM_CONFLICT_REVIEW_TIMEOUT_S", "480"))
# Rollback lever: 0 restores HZ-92's mechanical-only behaviour exactly, with
# no code change and nothing to unwind (there is no new table or row).
CONFLICT_SCOPED_ENABLED = os.environ.get("FARM_CONFLICT_SCOPED_ENABLED", "1").strip().lower() in ("1", "true", "yes")

# HZ-83: which provider farm/agent_runner.py's run_agent() dispatches to.
# "claude" is the default, keeping today's behaviour completely unchanged
# when nothing is configured. See docs/providers/muse-code.md for "muse".
FARM_PROVIDER = os.environ.get("FARM_PROVIDER", "claude")
# The real binary resolves as a bare "muse" under the farm's PATH via the
# /usr/local/bin/muse symlink — see docs/providers/muse-code.md. Tests mock
# subprocess.run directly (farm/tests/test_providers_muse.py) rather than
# using a fake binary, since the CLI's output is a JSONL event stream, not
# fake_claude's simple `-p` envelope.
FARM_MUSE_BIN = os.environ.get("FARM_MUSE_BIN", "muse")

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
