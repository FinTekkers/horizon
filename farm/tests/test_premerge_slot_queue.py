"""HZ-585: the pre-merge run at Accept queues for a check slot like every
other check run, and its checks' budget starts once it holds the slot.

Every test runs the real premerge_check() (or the real CLI) against a fixture
hub, with FARM_HOME — and so the slot directory — in tmp_path. Slots are held
by real flocks, as another farm process would hold them.
"""

import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from farm import check_slots, premerge, workspaces
from farm.tests.test_premerge import REPO, sha
from farm.tests.test_workspaces import make_repo_hub


@pytest.fixture
def farm(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root)
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_SLOT_WAIT_MAX_S", raising=False)
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    make_repo_hub(tmp_path)
    return tmp_path


def _tip(farm):
    return sha(farm / "seed")


def _hold(index):
    directory = check_slots.slot_dir()
    directory.mkdir(parents=True, exist_ok=True)
    handle = open(directory / f"slot-{index}", "a")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


def _release(handle):
    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


def _wait_for(predicate, timeout_s=20):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class Run:
    """premerge_check() on a thread, with the events it would send the server."""

    def __init__(self, farm, item_id, command, **kw):
        self.events = []
        self.result = None
        tip = _tip(farm)
        kw.setdefault("timeout_s", 600)

        def go():
            self.result = premerge.premerge_check(
                REPO,
                item_id,
                tip,
                tip,
                log=lambda *_: None,
                on_slot_event=self.events.append,
                configured={"test": command},
                **kw,
            )

        self.thread = threading.Thread(target=go, daemon=True)
        self.thread.start()

    def queued(self):
        return any(e.get("check_slot") == "queued" for e in self.events)

    def join(self, timeout_s=60):
        self.thread.join(timeout_s)
        assert not self.thread.is_alive(), "the pre-merge run never finished"
        return self.result


def _touch(path: Path) -> str:
    return f"touch {path}"


# ---- metric 1: no checks while every slot is held ----


def test_with_both_slots_held_the_checks_do_not_start_until_one_frees(farm):
    started = farm / "started"
    held = [_hold(0), _hold(1)]
    try:
        run = Run(farm, "HZ-1", _touch(started))
        assert _wait_for(run.queued), run.events
        time.sleep(1)
        assert not started.exists(), "checks ran with every slot held"
    finally:
        _release(held.pop())
    result = run.join()
    _release(held.pop())
    assert result["ok"] is True, result
    assert started.exists()
    assert [e["check_slot"] for e in run.events] == ["queued", "granted", "held"]


# ---- metric 2: the budget starts at the grant ----


def test_a_queued_run_gets_its_whole_budget_from_the_grant(farm, monkeypatch):
    """A 3 s budget, a 3 s queue and a 2 s check: counted from the start, the
    budget would be spent before the check ended."""
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    held = [_hold(0), _hold(1)]
    run = Run(farm, "HZ-2", "sleep 2", timeout_s=3)
    try:
        assert _wait_for(run.queued)
        time.sleep(3)
    finally:
        for handle in held:
            _release(handle)
    result = run.join()
    assert result["ok"] is True, result


def test_the_budget_still_binds_after_the_grant(farm, monkeypatch):
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    held = [_hold(0), _hold(1)]
    run = Run(farm, "HZ-3", "sleep 10", timeout_s=2)
    try:
        assert _wait_for(run.queued)
        time.sleep(1)
    finally:
        for handle in held:
            _release(handle)
    granted = time.monotonic()
    result = run.join()
    assert result["reason"] == "timed_out", result
    assert time.monotonic() - granted < 8


# ---- metric 3: never more checks than slots ----


def test_three_runs_started_together_never_run_more_checks_than_the_limit(farm):
    log = farm / "inflight.log"
    command = f"echo s >> {log}; sleep 1; echo e >> {log}"
    runs = [Run(farm, f"HZ-{n}", command) for n in (10, 11, 12)]
    results = [run.join() for run in runs]
    assert all(r["ok"] for r in results), results
    inflight = peak = 0
    for line in log.read_text().split():
        inflight += 1 if line == "s" else -1
        peak = max(peak, inflight)
    assert peak == check_slots.slot_limit() == 2
    assert any(run.queued() for run in runs), "no run ever queued"


# ---- metric 4: every exit frees the slot for the next run ----


@pytest.mark.parametrize(
    "command, timeout_s, reason",
    [("true", 600, None), ("false", 600, "checks_failed"), ("sleep 30", 2, "timed_out")],
    ids=["pass", "fail", "budget-timeout"],
)
def test_a_finished_run_frees_its_slot_and_the_queued_run_starts(farm, monkeypatch, command, timeout_s, reason):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    gate = farm / "first-may-finish"
    started = farm / "second-started"
    first = Run(farm, "HZ-20", f"while [ ! -e {gate} ]; do sleep 0.05; done; {command}", timeout_s=timeout_s)
    assert _wait_for(lambda: check_slots.busy_slots() == 1)
    second = Run(farm, "HZ-21", _touch(started))
    assert _wait_for(second.queued)
    gate.touch()
    result = first.join()
    assert result.get("reason") == reason, result
    assert second.join()["ok"] is True
    assert started.exists()
    assert check_slots.busy_slots() == 0


def _cli(farm, item_id, command, *extra):
    tip = _tip(farm)
    # A SIGTERMed run cannot clean up its temp dirs; keep them in tmp_path.
    scratch = farm / "cli-tmp"
    scratch.mkdir(exist_ok=True)
    env = {**os.environ, "FARM_HOME": str(farm), "FARM_MAX_CONCURRENT_CHECKS": "1", "TMPDIR": str(scratch)}
    env.pop(check_slots.IN_CHECKS_ENV, None)
    return subprocess.Popen(
        [sys.executable, "-m", "farm.premerge", REPO, item_id, tip, "--base", tip, "--json",
         "--check-commands", json.dumps({"test": command}), *extra],
        cwd=str(premerge.RUNNING_CHECKOUT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )


def test_a_sigtermed_run_holding_the_slot_frees_it_and_the_queued_run_starts(farm, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    holding = farm / "holding"
    started = farm / "second-started"
    proc = _cli(farm, "HZ-30", f"touch {holding}; sleep 60")
    try:
        assert _wait_for(holding.exists, 60)
        second = Run(farm, "HZ-31", _touch(started))
        assert _wait_for(second.queued)
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(30)
        assert second.join()["ok"] is True
        assert started.exists()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()


def test_a_run_stopped_while_queued_leaves_the_queue_and_never_runs_its_checks(farm, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    never = farm / "stopped-ran"
    started = farm / "next-started"
    held = _hold(0)
    proc = _cli(farm, "HZ-40", _touch(never))
    try:
        assert _wait_for(lambda: any(w["item_id"] == "HZ-40" for w in check_slots.waiting_runs()), 60)
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(30)
        assert _wait_for(lambda: not any(w["item_id"] == "HZ-40" for w in check_slots.waiting_runs()))
        nxt = Run(farm, "HZ-41", _touch(started))
        assert _wait_for(nxt.queued)
    finally:
        _release(held)
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
    assert nxt.join()["ok"] is True
    assert started.exists()
    assert not never.exists(), "the stopped run ran its checks"


# ---- the wait never fails open; the memory gate still holds ----


def test_no_slot_within_the_queue_timeout_ends_slot_wait_expired_and_runs_nothing(farm, monkeypatch):
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    started = farm / "started"
    held = [_hold(0), _hold(1)]
    try:
        result = Run(farm, "HZ-50", _touch(started), queue_timeout_s=2).join()
    finally:
        for handle in held:
            _release(handle)
    assert result["ok"] is False and result["reason"] == "slot_wait_expired", result
    assert not started.exists()
    assert check_slots.waiting_runs() == []


def test_a_free_slot_does_not_skip_the_memory_gate(farm, monkeypatch):
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    meminfo = farm / "meminfo"
    meminfo.write_text("MemTotal: 16000000 kB\nMemAvailable: 1600000 kB\n")
    monkeypatch.setenv("FARM_MEMINFO_PATH", str(meminfo))
    monkeypatch.setenv("FARM_MIN_MEM_AVAILABLE_PCT", "15")
    started = farm / "started"
    assert check_slots.busy_slots() == 0
    run = Run(farm, "HZ-51", _touch(started), queue_timeout_s=2)
    result = run.join()
    assert result["ok"] is False and result["reason"] == "memory_wait_expired", result
    assert not started.exists()
    assert "held" not in [e["check_slot"] for e in run.events]


# ---- guardrail: no other lock while waiting ----


def test_a_queued_run_holds_no_hub_lock(farm):
    held = [_hold(0), _hold(1)]
    try:
        run = Run(farm, "HZ-60", "true")
        assert _wait_for(run.queued)
        took = []

        def take():
            with workspaces.hub_lock(REPO):
                took.append(True)

        taker = threading.Thread(target=take, daemon=True)
        taker.start()
        taker.join(5)
        assert took == [True], "hub_lock blocked behind a queued pre-merge run"
    finally:
        for handle in held:
            _release(handle)
    assert run.join()["ok"] is True
