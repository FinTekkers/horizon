"""HZ-190: the session-wide backstop against farm tests leaking onto the host.

The autouse FakeTmux in conftest.py is what *prevents* a test from reaching
real tmux; this guard is what *notices* if one ever does anyway — including a
test written after this file. It snapshots the host's tmux sessions and the
real farm state dirs when the run starts, diffs them when it ends, and fails
the run (exit status 1) naming every leak.

It only ever reads. It never kills a session or deletes a file: a stray
session or state file is listed for the operator, not cleaned up behind
their back — production state is not the test suite's to remove.

Attribution: production farmd creates farm-run-* sessions on this host all
the time, so "any new farm-* session" would fail runs at random. A new
session counts as a leak only when its pane environment carries this run's
FARM_HOME or the suite's stub HORIZON_URL — values only a test process holds.
Every other new farm-* session is still listed, as a warning.

Kept free of farm.* imports so a stub-driven copy of the plugin can be loaded
into a throwaway pytest run (test_leak_guard.py) without dragging farmd in.
"""

import subprocess
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

import pytest


def host_farm_sessions(env: Mapping[str, str]) -> set[str] | None:
    """farm-* session names on the tmux server `env` points at.

    None means tmux itself is unusable (not installed, hung) — the caller
    skips the session diff with a warning rather than crash the suite. A
    non-zero exit is "no server running", i.e. no sessions: an empty set.
    """
    try:
        result = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            env=dict(env),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return set()
    return {name for name in result.stdout.splitlines() if name.startswith("farm-")}


def state_files(dirs: Iterable[Path]) -> set[str]:
    """Every file path directly under each dir. A missing dir is empty."""
    found: set[str] = set()
    for d in dirs:
        if d.is_dir():
            found |= {str(p) for p in d.iterdir()}
    return found


def diff_sessions(
    before: set[str], after: set[str], is_attributed: Callable[[str], bool]
) -> tuple[list[str], list[str]]:
    """(leaks, warnings) among farm-* sessions present after but not before."""
    leaks: list[str] = []
    warnings: list[str] = []
    for name in sorted(after - before):
        if not name.startswith("farm-"):
            continue
        (leaks if is_attributed(name) else warnings).append(name)
    return leaks, warnings


def new_state_files(before: set[str], after: set[str]) -> list[str]:
    return sorted(after - before)


def _proc_environ(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return {}
    pairs = (entry.split(b"=", 1) for entry in raw.split(b"\0") if b"=" in entry)
    return {k.decode(errors="replace"): v.decode(errors="replace") for k, v in pairs}


def session_attributed_to_tests(
    name: str, env: Mapping[str, str], test_farm_home: str, stub_horizon_url: str
) -> bool:
    """Does any pane process of host session `name` hold a test-only value?

    Lists panes with `env` (the host's own TMUX/TMUX_TMPDIR) explicitly rather
    than the current process environment, which a real_tmux test may have
    pointed at a private socket. An unreadable /proc entry attributes nothing,
    so the session still surfaces — as a warning, never silently dropped.
    """
    try:
        result = subprocess.run(
            ["tmux", "list-panes", "-t", f"={name}", "-F", "#{pane_pid}"],
            env=dict(env),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    for line in result.stdout.split():
        if not line.isdigit():
            continue
        environ = _proc_environ(int(line))
        farm_home = environ.get("FARM_HOME", "")
        if farm_home and Path(farm_home).is_relative_to(test_farm_home):
            return True
        if environ.get("HORIZON_URL") == stub_horizon_url:
            return True
    return False


class LeakGuard:
    """A pytest plugin: register one instance from pytest_configure."""

    def __init__(
        self,
        list_sessions: Callable[[], set[str] | None],
        is_attributed: Callable[[str], bool],
        state_dirs: Iterable[Path],
    ) -> None:
        self._list_sessions = list_sessions
        self._is_attributed = is_attributed
        self._state_dirs = list(state_dirs)
        self._sessions_before: set[str] | None = None
        self._files_before: set[str] = set()
        self.leaks: list[str] = []
        self.warnings: list[str] = []
        self.stray_files: list[str] = []
        self.notes: list[str] = []

    def pytest_sessionstart(self, session: pytest.Session) -> None:
        self._sessions_before = self._list_sessions()
        self._files_before = state_files(self._state_dirs)

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        sessions_after = self._list_sessions()
        if self._sessions_before is None or sessions_after is None:
            self.notes.append("tmux unavailable — host session diff skipped")
        else:
            self.leaks, self.warnings = diff_sessions(self._sessions_before, sessions_after, self._is_attributed)
        self.stray_files = new_state_files(self._files_before, state_files(self._state_dirs))
        if (self.leaks or self.stray_files) and session.exitstatus in (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED):
            session.exitstatus = pytest.ExitCode.TESTS_FAILED

    def pytest_terminal_summary(self, terminalreporter) -> None:
        if not (self.leaks or self.stray_files or self.warnings or self.notes):
            return
        write = terminalreporter.write_line
        terminalreporter.section("HZ-190 host leak guard")
        for name in self.leaks:
            write(f"LEAKED tmux session (created by this test run): {name}", red=True)
        for path in self.stray_files:
            write(f"LEAKED file in a real farm state dir (left in place): {path}", red=True)
        for name in self.warnings:
            write(f"WARNING new farm-* tmux session not attributed to this run: {name}", yellow=True)
        for note in self.notes:
            write(f"WARNING {note}", yellow=True)
