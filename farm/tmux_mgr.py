"""Thin tmux wrapper — sessions are the unit of agent isolation/observability.

Session naming:
  farm-daemon              farmd itself (started by run.sh)
  farm-pm-<project>        the long-running PM agent
  farm-concierge-<project> the WhatsApp concierge (FARM_WA_ENABLED=1)
  farm-run-<...>           ephemeral per-step agents (phase 2+)
"""

import os
import shlex
import subprocess


def _tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=15)


def session_exists(name: str) -> bool:
    return _tmux("has-session", "-t", f"={name}").returncode == 0


def _farm_env_prefix() -> str:
    """tmux sessions inherit the tmux *server's* environment, not ours — so
    every FARM_* / HORIZON_URL var must ride along in the command itself."""
    pairs = {k: v for k, v in os.environ.items() if k.startswith(("FARM_", "WA_", "CLAUDE_")) or k == "HORIZON_URL"}
    if not pairs:
        return ""
    return "env " + " ".join(f"{k}={shlex.quote(v)}" for k, v in pairs.items()) + " "


def new_session(name: str, command: str, cwd: str, log_file: str | None = None) -> None:
    if session_exists(name):
        kill_session(name)
    result = _tmux("new-session", "-d", "-s", name, "-c", cwd, _farm_env_prefix() + command)
    if result.returncode != 0:
        raise RuntimeError(f"tmux new-session failed for {name}: {result.stderr.strip()}")
    if log_file:
        _tmux("pipe-pane", "-t", name, "-o", f"cat >> '{log_file}'")


def kill_session(name: str) -> None:
    _tmux("kill-session", "-t", f"={name}")


def list_farm_sessions() -> list[str]:
    result = _tmux("list-sessions", "-F", "#{session_name}")
    if result.returncode != 0:
        return []
    return [s for s in result.stdout.splitlines() if s.startswith("farm-")]


# Only agent sessions are ever torn down — never daemons (positive match, so
# a differently-named farmd session can't kill itself).
AGENT_SESSION_PREFIXES = ("farm-pm-", "farm-run-", "farm-concierge-")


def kill_all_farm_sessions() -> list[str]:
    killed = []
    for name in list_farm_sessions():
        if name.startswith(AGENT_SESSION_PREFIXES):
            kill_session(name)
            killed.append(name)
    return killed
