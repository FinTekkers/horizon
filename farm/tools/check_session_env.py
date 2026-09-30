"""Live check for HZ-140: no running agent session holds a credential that
could approve a gate.

farm/tests/test_tmux_env.py proves tmux_mgr.agent_env() excludes those
credentials. This is the other half — the same assertion against sessions
that are actually running right now, which is the only thing that catches a
session started before the upgrade (tmux sessions keep the environment they
were launched with; farmd's teardown has to run for the new policy to apply).

Prints NAMES only, never values — a leak report must not itself leak.

Usage (from the repo root):

    farm/.venv/bin/python -m farm.tools.check_session_env

Exit status: 0 clean, 1 if any session holds a credential it shouldn't.
"""

import subprocess
import sys

from .. import tmux_mgr


def forbidden_names(session_name: str) -> frozenset[str]:
    """Credentials this session must not hold. The concierge's grant (see
    tmux_mgr.SESSION_ENV_GRANTS) is subtracted, so it is judged by the same
    policy that launched it rather than a second, driftable copy."""
    return frozenset(tmux_mgr.NEVER_FORWARD - tmux_mgr.granted_names(session_name))


def session_pids(session: str) -> list[int]:
    """Every pane process in the session, plus its descendants — the agent's
    real work happens in children of the pane's shell."""
    result = subprocess.run(
        ["tmux", "list-panes", "-t", f"={session}", "-F", "#{pane_pid}"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        return []
    pids: list[int] = []
    for line in result.stdout.split():
        try:
            pid = int(line)
        except ValueError:
            continue
        pids.append(pid)
        pids.extend(_descendants(pid))
    # Stable order, no duplicates (a pid can be reached twice via the tree).
    return sorted(dict.fromkeys(pids))


def _descendants(pid: int) -> list[int]:
    result = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        return []
    out: list[int] = []
    for line in result.stdout.split():
        try:
            child = int(line)
        except ValueError:
            continue
        out.append(child)
        out.extend(_descendants(child))
    return out


def env_names(pid: int) -> set[str]:
    """Variable NAMES in /proc/<pid>/environ. Values are read (the file gives
    us no choice) but never returned, printed or logged."""
    try:
        with open(f"/proc/{pid}/environ", "rb") as fh:
            blob = fh.read()
    except OSError:
        # Process exited between listing and reading, or we can't read it.
        # Either way there is nothing to report, and neither is a crash.
        return set()
    return names_in_environ(blob)


def names_in_environ(blob: bytes) -> set[str]:
    names = set()
    for entry in blob.split(b"\0"):
        if not entry or b"=" not in entry:
            continue
        names.add(entry.split(b"=", 1)[0].decode("utf-8", "replace"))
    return names


def leaked_names(pid: int, forbidden: frozenset[str]) -> list[str]:
    return sorted(env_names(pid) & forbidden)


def scan(sessions: list[str] | None = None) -> dict[str, dict[int, list[str]]]:
    """{session: {pid: [leaked names]}} for every session with a leak."""
    if sessions is None:
        sessions = [s for s in tmux_mgr.list_farm_sessions() if s.startswith(tmux_mgr.AGENT_SESSION_PREFIXES)]
    report: dict[str, dict[int, list[str]]] = {}
    for session in sessions:
        forbidden = forbidden_names(session)
        if not forbidden:
            continue
        hits = {pid: leaked_names(pid, forbidden) for pid in session_pids(session)}
        hits = {pid: names for pid, names in hits.items() if names}
        if hits:
            report[session] = hits
    return report


def main() -> int:
    report = scan()
    if not report:
        print("check_session_env: clean — no agent session holds a gate-approving credential")
        return 0
    for session, hits in sorted(report.items()):
        for pid, names in sorted(hits.items()):
            print(f"LEAK {session} pid {pid}: {', '.join(names)}")
    print(
        "check_session_env: restart farmd so its teardown kills pre-upgrade sessions "
        "(they keep the environment they were launched with)"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
