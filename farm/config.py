"""Farm configuration — all via environment, safe defaults for local dev."""

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
PM_MODEL = os.environ.get("FARM_PM_MODEL")  # None -> CLI default
STEP_TIMEOUT_S = int(os.environ.get("FARM_STEP_TIMEOUT_S", "900"))
MAX_TURNS = int(os.environ.get("FARM_MAX_TURNS", "8"))


def ensure_dirs() -> None:
    for d in (QUEUE_DIR / "pm", STATE_DIR, LOGS_DIR, WORKSPACES_DIR):
        d.mkdir(parents=True, exist_ok=True)


def slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
