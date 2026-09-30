"""Live check for HZ-140: no running agent session holds a credential that
could approve a gate.

farm/tests/test_tmux_env.py proves tmux_mgr.agent_env() excludes those
credentials. This is the other half — the same assertion against sessions
that are actually running right now, which is the only thing that catches a
session started before the upgrade (tmux sessions keep the environment they
were launched with; farmd's teardown has to run for the new policy to apply).

What it can and cannot tell you. It judges each session against the policy that
launched it (tmux_mgr.SESSION_ENV_GRANTS), so the concierge holding
WA_APPROVAL_SECRET is not a leak — that grant is the design. It is reported on
its own GRANT line rather than passed over silently, because "clean" must not
be read as "no process here can approve a gate": the concierge can, by design,
and every farm session runs as the same OS user. Only an *unexpected* holder is
a leak and only a leak sets the exit status.

Prints NAMES only, never values — a leak report must not itself leak.

Usage (from the repo root):

    farm/.venv/bin/python -m farm.tools.check_session_env

Exit status: 0 if no session holds a credential it was not granted, 1 otherwise.
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


def agent_sessions() -> list[str]:
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith(tmux_mgr.AGENT_SESSION_PREFIXES)]


def _hits(sessions: list[str] | None, wanted) -> dict[str, dict[int, list[str]]]:
    """{session: {pid: [names held]}}, for whichever set `wanted(session)` names."""
    if sessions is None:
        sessions = agent_sessions()
    report: dict[str, dict[int, list[str]]] = {}
    for session in sessions:
        names = wanted(session)
        if not names:
            continue
        found = {pid: leaked_names(pid, names) for pid in session_pids(session)}
        found = {pid: held for pid, held in found.items() if held}
        if found:
            report[session] = found
    return report


def scan(sessions: list[str] | None = None) -> dict[str, dict[int, list[str]]]:
    """{session: {pid: [leaked names]}} for every session holding a credential
    it was NOT granted. This is the only thing that sets the exit status."""
    return _hits(sessions, forbidden_names)


def grants_held(sessions: list[str] | None = None) -> dict[str, dict[int, list[str]]]:
    """{session: {pid: [granted names]}} for every session holding a credential
    it WAS granted. Not a leak, and reported anyway: the concierge really can
    approve a gate, and a bare "clean" would read as though nothing here could."""
    return _hits(sessions, tmux_mgr.granted_names)


def main() -> int:
    report = scan()
    grants = grants_held()
    for session, hits in sorted(grants.items()):
        for pid, names in sorted(hits.items()):
            print(f"GRANT {session} pid {pid}: {', '.join(names)} (expected — this session is the approval path)")
    if not report:
        print("check_session_env: clean — no agent session holds a credential it was not granted")
        if grants:
            print(
                "check_session_env: the GRANT lines above are by design; a same-uid agent can still read "
                "those processes' /proc environ, which needs a separate uid to close (see farm/README.md)"
            )
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
