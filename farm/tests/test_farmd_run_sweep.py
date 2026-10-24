"""HZ-569 metric line 3: a farmd restart mid-check leaves nothing of the
interrupted check running, and guardrail 4: it never touches a run that is
still active elsewhere.

A real farmd subprocess, in a FARM_HOME of its own and against a private tmux
server, owns a running check: its lease names farmd's pid and start time, as
the one conflict_resolver's run_checks() writes on farmd's thread does, and a
capture worker and an e2e server carry its tag. Next to it runs another
item's check, owned by a live step agent. farmd is SIGKILLed — what systemd's
KillMode=process does — and started again on the same FARM_HOME. Within 10 s
of that boot the interrupted check's processes are gone and logged; the
other item's are untouched."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from farm import procfs, run_reaper
from farm.tests.run_reaper_fakes import Procs, free_port, gone, make_app, port_binds, wait_until, write_lease

pytestmark = pytest.mark.real_tmux

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def procs(tmp_path):
    p = Procs(make_app(tmp_path / "app"))
    try:
        yield p
    finally:
        p.kill_all()


class Farmd:
    def __init__(self, home: Path, log_dir: Path):
        self.home = home
        self.log_dir = log_dir
        self.boots = 0
        self.proc: subprocess.Popen | None = None
        # Never the suite's or the host's farm: FARM_HOME is replaced, and no
        # outer run's tag rides along.
        self.env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", run_reaper.RUN_ENV)}
        self.env.update(FARM_HOME=str(home), PYTHONPATH=str(REPO_ROOT))

    @property
    def log(self) -> Path:
        return self.log_dir / f"farmd-{self.boots}.log"

    def boot(self, sweep_interval_s: str) -> None:
        self.boots += 1
        port = free_port()
        with open(self.log, "w") as out:
            self.proc = subprocess.Popen(
                [sys.executable, "-m", "farm.farmd"],
                cwd=str(REPO_ROOT),
                env={**self.env, "FARM_PORT": str(port), "FARM_RUN_SWEEP_INTERVAL_S": sweep_interval_s},
                stdout=out,
                stderr=subprocess.STDOUT,
            )

        def up():
            if self.proc.poll() is not None:
                raise AssertionError(f"farmd exited at boot: {self.log.read_text()[-2000:]}")
            try:
                return httpx.get(f"http://127.0.0.1:{port}/farm/status", timeout=2).status_code == 200
            except httpx.HTTPError:
                return False

        wait_until("farmd to answer", up, 30, 0.25)

    def kill(self) -> None:
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(10)

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.kill()


@pytest.fixture
def farmd(tmp_path):
    home = tmp_path / "farm-home"
    (home / "state").mkdir(parents=True)
    f = Farmd(home, tmp_path)
    try:
        yield f
    finally:
        f.stop()


def test_a_restarted_farmd_reaps_its_interrupted_check_and_spares_another_items(farmd, procs):
    runs = farmd.home / "state" / "runs"
    # The first farmd never sweeps on its own here, so nothing but the
    # second boot can have reaped what follows.
    farmd.boot(sweep_interval_s="3600")
    write_lease(runs, "chk-hz-569-resolver", farmd.proc.pid, item_id="HZ-569", worktree="/work/hz-569")
    port = free_port()
    interrupted = [procs.worker("chk-hz-569-resolver"), procs.server(port, "chk-hz-569-resolver")]
    step = procs.owner()  # another item's step agent, alive in its tmux session
    write_lease(runs, "chk-hz-570-step", step.pid, item_id="HZ-570", worktree="/work/hz-570")
    other = [procs.worker("chk-hz-570-step"), procs.server(free_port(), "chk-hz-570-step")]
    everything = interrupted + other
    wait_until("the checks' processes to start", lambda: all(run_reaper.kind_of(p.pid) for p in everything), 5)
    wait_until("the e2e server to listen", lambda: not port_binds(port), 5)

    farmd.kill()
    started = time.monotonic()
    farmd.boot(sweep_interval_s="3600")

    wait_until("the interrupted check's processes to be gone", lambda: all(gone(p.pid) for p in interrupted), 10)
    assert time.monotonic() - started <= 10
    wait_until(f"port {port} to bind again", lambda: port_binds(port), 10 - (time.monotonic() - started))
    assert all(procfs.alive(p.pid) for p in other), "a run whose owner is alive is never touched by a restart"
    assert run_reaper.lease_active(run_reaper.read_lease("chk-hz-570-step", runs))
    log = farmd.log.read_text()
    for proc, kind in zip(interrupted, ("capture_worker", "e2e_server")):
        assert f"run_reaper: killed {kind} pid={proc.pid} run=chk-hz-569-resolver item=HZ-569 worktree=/work/hz-569" in log
