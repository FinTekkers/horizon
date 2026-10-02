"""HZ-238: the session-wide backstop against farm tests leaking temp dirs.

On 2026-10-02 /tmp held ~59,600 leaked test dirs (~12 GB) and the root disk
filled. conftest.py now runs the whole suite inside its own sandbox — a
horizon-run-<pid>-* dir under the real temp root, exported as TMPDIR — so
every tempfile call in the suite, and in every child process it spawns,
lands there. This guard is what *notices* when something is left behind:
anything still inside the sandbox when the session ends was created by this
run, so the run fails (exit status 1) and names each entry.

It only ever reads. It never deletes a file or a dir, including the
leftovers it names: they stay for the operator to inspect.

Concurrency: other runs (and production) create horizon-* entries directly
in the real temp root all the time, so those can never fail this run. A new
prefixed entry there is listed as a warning only; another run's
horizon-run-* sandbox is not listed at all, and anything present at session
start is never mentioned.

Kept free of farm.* imports, like leak_guard.py, so a copy of the plugin can
be loaded into a throwaway pytest run (test_tmp_guard.py).
"""

from pathlib import Path

import pytest

# The prefixes HZ-238's success metric counts in /tmp. Part 9's npm guard
# (scripts/tmp-leak-guard.mjs) is to carry the same list — keep them equal.
TMP_PREFIXES = ("horizon-", "hz-tmux-", "claude-resume-", "pino-", "sonic-boom-", "thread-stream-")
SANDBOX_PREFIX = "horizon-run-"


def tmp_entries(root: Path, prefixes: tuple[str, ...] = TMP_PREFIXES) -> set[str]:
    """Names directly under `root` that start with one of `prefixes`."""
    try:
        return {p.name for p in root.iterdir() if p.name.startswith(prefixes)}
    except FileNotFoundError:
        return set()


def sandbox_leftovers(sandbox: Path) -> list[str]:
    """Sorted absolute paths of everything directly inside the run's sandbox.
    A missing sandbox holds nothing."""
    try:
        return sorted(str(p) for p in sandbox.iterdir())
    except FileNotFoundError:
        return []


def foreign_new_entries(before: set[str], after: set[str], own_sandbox: str) -> list[str]:
    """Prefixed names new in the real temp root since session start — minus
    this run's own sandbox and every other run's horizon-run-* sandbox."""
    return sorted(
        name for name in after - before if name != own_sandbox and not name.startswith(SANDBOX_PREFIX)
    )


class TmpLeakGuard:
    """A pytest plugin: register one instance from pytest_configure."""

    def __init__(self, real_tmp: Path, sandbox: Path) -> None:
        self.real_tmp = real_tmp
        self.sandbox = sandbox
        self._before: set[str] = set()
        self.leaks: list[str] = []
        self.warnings: list[str] = []

    def pytest_sessionstart(self, session: pytest.Session) -> None:
        self._before = tmp_entries(self.real_tmp)

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        self.leaks = sandbox_leftovers(self.sandbox)
        self.warnings = [
            str(self.real_tmp / name)
            for name in foreign_new_entries(self._before, tmp_entries(self.real_tmp), self.sandbox.name)
        ]
        if self.leaks and session.exitstatus in (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED):
            session.exitstatus = pytest.ExitCode.TESTS_FAILED

    def pytest_terminal_summary(self, terminalreporter) -> None:
        if not (self.leaks or self.warnings):
            return
        write = terminalreporter.write_line
        terminalreporter.section("HZ-238 /tmp leak guard")
        for path in self.leaks:
            write(f"LEAKED temp entry (created by this run, left in place): {path}", red=True)
        for path in self.warnings:
            write(f"WARNING new temp entry outside this run's sandbox (not attributed to it): {path}", yellow=True)
