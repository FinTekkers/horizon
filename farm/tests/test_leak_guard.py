"""HZ-190: the host leak guard itself — a guard that never fires would pass
every run silently, so prove it fails the process and names what leaked."""

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from farm.tests import leak_guard

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_diff_sessions_splits_attributed_leaks_from_warnings():
    before = {"farm-pm-horizon"}
    after = {"farm-pm-horizon", "farm-pm-fintekkers", "farm-run-x-s1-a1", "whatsapp-bridge"}
    leaks, warnings = leak_guard.diff_sessions(before, after, lambda name: name == "farm-pm-fintekkers")
    assert leaks == ["farm-pm-fintekkers"]
    # Unattributed is still listed, never dropped; non-farm and pre-existing
    # sessions are not the guard's business.
    assert warnings == ["farm-run-x-s1-a1"]


def test_new_state_files_lists_only_additions():
    assert leak_guard.new_state_files({"a", "b"}, {"a", "b", "c"}) == ["c"]
    assert leak_guard.new_state_files({"a", "b"}, {"a"}) == []


def test_state_files_of_a_missing_dir_is_empty(tmp_path):
    assert leak_guard.state_files([tmp_path / "nope"]) == set()


def test_host_farm_sessions_without_a_tmux_binary_is_none(tmp_path):
    assert leak_guard.host_farm_sessions({"PATH": str(tmp_path)}) is None


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
def test_host_farm_sessions_with_no_server_running_is_empty():
    socket_dir = tempfile.mkdtemp(prefix="hz-tmux-", dir="/tmp")
    try:
        assert leak_guard.host_farm_sessions({"PATH": os.environ["PATH"], "TMUX_TMPDIR": socket_dir}) == set()
    finally:
        shutil.rmtree(socket_dir, ignore_errors=True)


@pytest.fixture
def child_with_test_env():
    """A process whose /proc environ holds this run's FARM_HOME and stub URL
    (our own /proc entry shows the env we were exec'd with, not conftest's)."""
    proc = subprocess.Popen(["sleep", "30"])
    try:
        yield proc.pid
    finally:
        proc.kill()
        proc.wait(timeout=15)


def _panes(monkeypatch, pid):
    def run(argv, *args, **kwargs):
        return subprocess.CompletedProcess(argv, 0, f"{pid}\n", "")

    monkeypatch.setattr(
        leak_guard, "subprocess", SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired)
    )


@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="/proc is Linux-only")
def test_a_session_holding_the_test_farm_home_or_stub_url_is_attributed(monkeypatch, child_with_test_env):
    _panes(monkeypatch, child_with_test_env)
    env = {"PATH": os.environ["PATH"]}
    assert leak_guard.session_attributed_to_tests("farm-pm-x", env, os.environ["FARM_HOME"], "nope")
    assert leak_guard.session_attributed_to_tests("farm-pm-x", env, "/nonexistent", os.environ["HORIZON_URL"])
    assert not leak_guard.session_attributed_to_tests("farm-pm-x", env, "/nonexistent", "nope")


def test_an_unreadable_pane_environ_is_not_attributed(monkeypatch):
    _panes(monkeypatch, 2**31 - 1)  # no such pid
    assert not leak_guard.session_attributed_to_tests(
        "farm-pm-x", {}, os.environ["FARM_HOME"], os.environ["HORIZON_URL"]
    )


def _run_guarded_suite(tmp_path, after_sessions, write_state_file):
    """A throwaway pytest run with the real LeakGuard plugin and a stub lister."""
    state = tmp_path / "state"
    state.mkdir()
    (tmp_path / "pytest.ini").write_text("[pytest]\n")
    (tmp_path / "conftest.py").write_text(
        textwrap.dedent(
            f"""
            from pathlib import Path
            from farm.tests.leak_guard import LeakGuard

            _snapshots = iter([set(), {after_sessions!r}])

            def pytest_configure(config):
                config.pluginmanager.register(
                    LeakGuard(
                        lambda: next(_snapshots),
                        lambda name: name == "farm-pm-fintekkers",
                        [Path(__file__).parent / "state"],
                    ),
                    "stub-leak-guard",
                )
            """
        )
    )
    body = '(Path(__file__).parent / "state" / "concierge-session-e2e.txt").write_text("x")' if write_state_file else "pass"
    (tmp_path / "test_inner.py").write_text(f"from pathlib import Path\n\n\ndef test_inner():\n    {body}\n")
    env = dict(os.environ, PYTHONPATH=str(REPO_ROOT))
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(tmp_path)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_the_guard_fails_the_run_and_names_every_leak(tmp_path):
    result = _run_guarded_suite(
        tmp_path, after_sessions={"farm-pm-fintekkers", "farm-run-unrelated"}, write_state_file=True
    )
    out = result.stdout
    assert result.returncode == 1, out + result.stderr
    assert "LEAKED tmux session (created by this test run): farm-pm-fintekkers" in out
    assert "concierge-session-e2e.txt" in out
    assert "WARNING new farm-* tmux session not attributed to this run: farm-run-unrelated" in out
    # Listed for the operator, never deleted.
    assert (tmp_path / "state" / "concierge-session-e2e.txt").exists()


def test_the_guard_passes_a_clean_run_and_only_warns_on_unattributed(tmp_path):
    result = _run_guarded_suite(tmp_path, after_sessions={"farm-run-unrelated"}, write_state_file=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "farm-run-unrelated" in result.stdout
    assert "LEAKED" not in result.stdout
