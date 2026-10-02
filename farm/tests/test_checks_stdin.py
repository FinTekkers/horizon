"""A check command never inherits a terminal on stdin (US-191).

Inside a step, the farm's stdin is the agent's tmux pty. A test runner that
sees a TTY assumes a human is watching: plain `vitest` (FinTekkers/ui-service's
`npm test`) then starts watch mode and never exits.
"""

import os
import pty
import sys
from pathlib import Path

from farm import checks


def test_a_check_reads_end_of_file_on_stdin_and_never_sees_a_tty(tmp_path, monkeypatch):
    # Give this process a real pty on fd 0, as the agent's tmux session does,
    # so the test fails if the child inherits it.
    master, slave = pty.openpty()
    saved = os.dup(0)
    os.dup2(slave, 0)
    try:
        probe = (
            "import os, sys; "
            "tty = os.isatty(0); data = sys.stdin.read(); "
            "sys.exit(3 if tty else (4 if data else 0))"
        )
        result = checks._run_bounded([sys.executable, "-c", probe], Path(tmp_path), 30, dict(os.environ))
    finally:
        os.dup2(saved, 0)
        os.close(saved)
        os.close(slave)
        os.close(master)
    assert result.returncode == 0, f"child saw a tty or non-empty stdin (exit {result.returncode})"


def test_a_check_runs_with_ci_set_so_older_runners_skip_watch_mode(tmp_path, monkeypatch):
    # vitest 0.34 (ui-service) picks watch mode whenever CI is unset.
    monkeypatch.delenv("CI", raising=False)
    env = checks._check_env()
    probe = "import os, sys; sys.exit(0 if os.environ.get('CI') == '1' else 5)"
    result = checks._run_bounded([sys.executable, "-c", probe], Path(tmp_path), 30, env)
    assert result.returncode == 0, "check child did not see CI=1"


def test_an_explicit_ci_value_is_kept(monkeypatch):
    monkeypatch.setenv("CI", "true")
    assert checks._check_env()["CI"] == "true"
