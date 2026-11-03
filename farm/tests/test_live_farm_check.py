"""HZ-716: a repo's checks fail when they touched the live farmd.

run_checks() notes horizon-farm's MainPID (and its start time) before the
checks and again after (farm/live_farm.py). A stand-in `sleep` plays the
live farmd here: conftest's no_live_farm stub is overridden to name it.

The stand-in is started through a shell that exits at once, so this test is
not its parent: once killed it is reaped by init and really goes, as farmd
would under systemd. The zombie case keeps one unreaped on purpose.
"""

import os
import re
import signal
import subprocess
import time
from pathlib import Path

import pytest

from farm import check_slots, checks, live_farm
from farm.checks import CheckFailure, run_checks

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    # The deploy carve-out reads $HORIZON_STATE_DIR/self-deploy.log: never
    # the host's real one.
    monkeypatch.setenv("HORIZON_STATE_DIR", str(tmp_path / "horizon-state"))


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def stand_in():
    """Starts stand-in farmds that are not this process's children."""
    pids: list[int] = []

    def start() -> int:
        out = subprocess.run(
            ["sh", "-c", "sleep 600 >/dev/null 2>&1 </dev/null & echo $!"],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        pid = int(out.stdout)
        pids.append(pid)
        return pid

    yield start
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def live(monkeypatch, pid):
    monkeypatch.setattr(live_farm, "main_pid", lambda: pid)


def failure(ws, command, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)
    return err.value


@pytest.mark.parametrize(
    "command",
    ["kill {pid}", "kill {pid}; exit 1", "kill {pid}; sleep 30"],
    ids=["passing", "failing", "timing-out"],
)
def test_checks_that_kill_the_live_farmd_fail(ws, monkeypatch, stand_in, command):
    """Metric 3: killed — whether the checks then pass, fail or time out."""
    pid = stand_in()
    live(monkeypatch, pid)
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "3")

    exc = failure(ws, command.format(pid=pid), monkeypatch)

    assert exc.headline == f"{live_farm.TOUCHED}: farmd {pid} is gone"
    assert live_farm.TOUCHED in str(exc)
    assert exc.command == "live farm"


def test_a_zombie_farmd_counts_as_gone(ws, monkeypatch):
    """Metric 3: a killed farmd its parent has not reaped yet is gone."""
    proc = subprocess.Popen(["sleep", "600"])
    try:
        live(monkeypatch, proc.pid)
        exc = failure(ws, f"kill {proc.pid}; sleep 0.5", monkeypatch)
        assert exc.headline == f"{live_farm.TOUCHED}: farmd {proc.pid} is gone"
    finally:
        proc.kill()
        proc.wait()


def replaced_after(monkeypatch, tmp_path, first, second) -> Path:
    """main_pid() names `first` until the flag file exists, then `second`."""
    flag = tmp_path / "replaced"
    monkeypatch.setattr(live_farm, "main_pid", lambda: second if flag.exists() else first)
    return flag


def test_checks_that_replace_the_live_farmd_fail(ws, monkeypatch, stand_in, tmp_path):
    """Metric 3: replaced by a new pid, with no deploy log to explain it."""
    first, second = stand_in(), stand_in()
    flag = replaced_after(monkeypatch, tmp_path, first, second)

    exc = failure(ws, f"touch {flag}; kill {first}", monkeypatch)

    assert exc.headline == f"{live_farm.TOUCHED}: farmd {first} was replaced by {second}"


def test_checks_that_leave_the_live_farmd_alone_pass(ws, monkeypatch, stand_in):
    """Metric 3: untouched passes."""
    live(monkeypatch, stand_in())
    monkeypatch.setenv("FARM_CHECK_CMD", "true")

    assert run_checks(ws, log=lambda *_: None) == "1 repo check(s) passed"


def test_no_live_farmd_before_the_checks_skips_the_check(ws, monkeypatch, stand_in):
    """Guardrail 2: with no farmd running before, nothing is watched — even a
    farmd that appears during the checks does not fail them."""
    pid = stand_in()
    calls = []
    monkeypatch.setattr(live_farm, "main_pid", lambda: calls.append(1) or (pid if len(calls) > 1 else None))
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    lines: list[str] = []

    assert run_checks(ws, log=lambda line: lines.append(str(line))) == "1 repo check(s) passed"
    assert not any(live_farm.TOUCHED in line for line in lines)


def test_a_deploy_restart_during_the_checks_passes(ws, monkeypatch, stand_in, tmp_path):
    """Metric 3: a release restarts horizon-farm, and self-deploy.log was
    written during the checks — not the tests' doing."""
    first, second = stand_in(), stand_in()
    flag = replaced_after(monkeypatch, tmp_path, first, second)
    log_file = tmp_path / "horizon-state" / "self-deploy.log"
    log_file.parent.mkdir()
    monkeypatch.setenv("FARM_CHECK_CMD", f"echo DEPLOY OK >>{log_file}; touch {flag}; kill {first}")
    lines: list[str] = []

    assert run_checks(ws, log=lambda line: lines.append(str(line))) == "1 repo check(s) passed"
    assert any("a deploy did it" in line for line in lines)


def test_an_old_deploy_log_does_not_excuse_a_replaced_farmd(ws, monkeypatch, stand_in, tmp_path):
    """Metric 3: the carve-out never turns a real kill into a pass — a log
    last written well before the checks does not count."""
    first, second = stand_in(), stand_in()
    flag = replaced_after(monkeypatch, tmp_path, first, second)
    log_file = tmp_path / "horizon-state" / "self-deploy.log"
    log_file.parent.mkdir()
    log_file.write_text("DEPLOY OK\n")
    old = time.time() - live_farm.DEPLOY_GRACE_S - 3600
    os.utime(log_file, (old, old))

    exc = failure(ws, f"touch {flag}; kill {first}", monkeypatch)

    assert exc.headline == f"{live_farm.TOUCHED}: farmd {first} was replaced by {second}"


def test_deploy_doc_matches_farm_env_values_without_grep():
    """Metric 4: DEPLOY.md's Verify block never passes a farm.env value to
    grep (or any command) as an argument."""
    doc = (REPO_ROOT / "infra" / "host" / "DEPLOY.md").read_text()
    block = re.search(r"### Verify \(success metrics 4 and 5\)\n\n```bash\n(.*?)```", doc, re.S)
    assert block, "Verify (success metrics 4 and 5) block not found"
    body = block.group(1)
    assert '[[ $args == *"$value"* ]]' in body
    assert not [line for line in body.splitlines() if "grep" in line and "$value" in line]
