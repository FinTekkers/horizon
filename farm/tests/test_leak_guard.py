"""HZ-190: the host leak guard itself — a guard that never fires would pass
every run silently, so prove it fails the process and names what leaked."""

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from contextlib import contextmanager
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
    socket_dir = tempfile.mkdtemp(prefix="hz-tmux-", dir=tempfile.gettempdir())
    try:
        assert leak_guard.host_farm_sessions({"PATH": os.environ["PATH"], "TMUX_TMPDIR": socket_dir}) == set()
    finally:
        shutil.rmtree(socket_dir, ignore_errors=True)


def _wait_for_test_env(proc: subprocess.Popen, deadline_s: float = 10.0) -> None:
    """Block until proc's /proc environ holds this run's FARM_HOME and stub URL.

    HZ-260: Popen returns once exec has closed the CLOEXEC error pipe, but the
    kernel publishes the new environ later in execve, so an early read is empty.
    """
    want = {key: os.environ[key] for key in ("FARM_HOME", "HORIZON_URL")}
    deadline = time.monotonic() + deadline_s
    while True:
        if proc.poll() is not None:
            missing = f"process exited with {proc.returncode}"
        else:
            environ = leak_guard._proc_environ(proc.pid)
            wrong = [key for key, value in want.items() if environ.get(key) != value]
            if not wrong:
                return
            missing = "/proc environ unreadable or empty" if not environ else f"{', '.join(wrong)} missing or different"
        if time.monotonic() >= deadline:
            pytest.fail(f"pid {proc.pid}: {missing} after {deadline_s}s")
        time.sleep(0.01)


@contextmanager
def _child_with_test_env(deadline_s: float = 10.0):
    proc = subprocess.Popen(["sleep", "30"])
    try:
        _wait_for_test_env(proc, deadline_s)
        yield proc
    finally:
        proc.kill()
        proc.wait(timeout=15)


@pytest.fixture
def child_with_test_env():
    """A process whose /proc environ holds this run's FARM_HOME and stub URL
    (our own /proc entry shows the env we were exec'd with, not conftest's).
    Waits until exec has published that environ before handing out the pid."""
    with _child_with_test_env() as proc:
        yield proc.pid


def test_waiting_on_a_dead_child_fails_naming_the_pid():
    proc = subprocess.Popen(["true"])
    proc.wait(timeout=15)
    with pytest.raises(pytest.fail.Exception) as failed:
        _wait_for_test_env(proc, deadline_s=0.2)
    assert str(proc.pid) in str(failed.value)
    assert "exited" in str(failed.value)


def test_waiting_on_an_empty_environ_fails_naming_the_pid(monkeypatch):
    monkeypatch.setattr(leak_guard, "_proc_environ", lambda pid: {})
    proc = subprocess.Popen(["sleep", "30"])
    try:
        with pytest.raises(pytest.fail.Exception) as failed:
            _wait_for_test_env(proc, deadline_s=0.2)
        assert str(proc.pid) in str(failed.value)
        assert "unreadable or empty" in str(failed.value)
    finally:
        proc.kill()
        proc.wait(timeout=15)


def test_waiting_on_a_different_farm_home_names_the_variable(monkeypatch):
    monkeypatch.setattr(
        leak_guard, "_proc_environ", lambda pid: {"FARM_HOME": "/other", "HORIZON_URL": os.environ["HORIZON_URL"]}
    )
    proc = subprocess.Popen(["sleep", "30"])
    try:
        with pytest.raises(pytest.fail.Exception) as failed:
            _wait_for_test_env(proc, deadline_s=0.2)
        assert "FARM_HOME missing or different" in str(failed.value)
        assert "HORIZON_URL" not in str(failed.value)
    finally:
        proc.kill()
        proc.wait(timeout=15)


def test_a_failed_wait_still_kills_and_reaps_the_child(monkeypatch):
    monkeypatch.setattr(leak_guard, "_proc_environ", lambda pid: {})
    seen = []
    real_wait = _wait_for_test_env

    def wait_and_record(proc, deadline_s):
        seen.append(proc)
        real_wait(proc, deadline_s)

    monkeypatch.setattr(sys.modules[__name__], "_wait_for_test_env", wait_and_record)
    with pytest.raises(pytest.fail.Exception):
        with _child_with_test_env(deadline_s=0.2):
            pass
    (proc,) = seen
    assert proc.returncode is not None


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
