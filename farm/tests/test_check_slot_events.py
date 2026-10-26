"""HZ-227: check_slot()'s on_event hook — the queued/granted signal the
pre-merge run streams to the server so a queued Accept never looks stuck.

Every test redirects FARM_HOME to tmp_path (and strips the inherited one from
any child it spawns), so nothing here touches the live farm's slots.
"""

import fcntl
import io
import json
import os
import signal
import subprocess
import sys
import textwrap
import threading
import time
from contextlib import redirect_stderr, redirect_stdout

import pytest

from farm import check_slots, premerge

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(autouse=True)
def isolated_slot_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.delenv("FARM_CHECK_SLOT_WAIT_MAX_S", raising=False)
    return tmp_path


def _hold_slot_0():
    """Holds slot 0 the way another farm process would: an flock on its own
    open file description, which conflicts even within this process."""
    directory = check_slots.slot_dir()
    directory.mkdir(parents=True, exist_ok=True)
    handle = open(directory / "slot-0", "a")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


def _release(handle):
    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


def _wait_for(predicate, timeout_s=10):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_a_queued_run_hears_queued_then_granted_in_order():
    events = []
    modes = []
    holder = _hold_slot_0()

    def run():
        with check_slots.check_slot(poll_s=0.05, on_event=events.append) as slot:
            modes.append(slot.mode)

    worker = threading.Thread(target=run)
    worker.start()
    try:
        assert _wait_for(lambda: events), "never announced the queue"
        assert events == [{"check_slot": "queued"}]
        assert modes == [], "got a slot while every slot was held"
    finally:
        _release(holder)
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert events == [{"check_slot": "queued"}, {"check_slot": "granted", "mode": "held"}]
    assert modes == ["held"]


def test_a_free_slot_emits_no_events():
    events = []
    with check_slots.check_slot(on_event=events.append) as slot:
        assert slot.mode == "held"
    assert events == []


def test_a_raising_listener_never_breaks_the_limiter():
    holder = _hold_slot_0()
    calls = []

    def boom(event):
        calls.append(event["check_slot"])
        raise RuntimeError("listener bug")

    result = {}

    def run():
        with check_slots.check_slot(poll_s=0.05, on_event=boom) as slot:
            result["mode"] = slot.mode
            result["busy"] = check_slots.busy_slots()

    worker = threading.Thread(target=run)
    worker.start()
    assert _wait_for(lambda: calls)
    _release(holder)
    worker.join(timeout=10)
    assert result == {"mode": "held", "busy": 1}
    assert calls == ["queued", "granted"]
    assert check_slots.busy_slots() == 0, "the slot was freed after the run"


WAITER = textwrap.dedent(
    """
    import json, sys
    from farm import check_slots
    def say(event):
        print(json.dumps(event), flush=True)
    with check_slots.check_slot(poll_s=0.05, item_id="HZ-T", caller="premerge", on_event=say) as slot:
        print(json.dumps({"mode": slot.mode}), flush=True)
    """
)


def test_a_run_killed_while_queued_leaves_the_queue_and_never_holds_a_slot(tmp_path):
    holder = _hold_slot_0()
    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    env["FARM_HOME"] = str(tmp_path)
    child = subprocess.Popen(
        [sys.executable, "-c", WAITER],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        assert json.loads(child.stdout.readline()) == {"check_slot": "queued"}
        assert [run["item_id"] for run in check_slots.waiting_runs()] == ["HZ-T"]
        assert check_slots.busy_slots() == 1
        child.send_signal(signal.SIGKILL)
        child.wait(timeout=10)
        assert child.stdout.read() == "", "a killed waiter was never granted a slot"
    finally:
        if child.poll() is None:
            child.kill()
        child.stdout.close()
        _release(holder)

    assert check_slots.waiting_runs() == []
    assert check_slots.busy_slots() == 0
    events = []
    with check_slots.check_slot(on_event=events.append) as slot:
        assert slot.mode == "held"
        assert check_slots.busy_slots() == 1
    assert events == []


def test_stderr_event_writes_one_prefixed_line_to_stderr_only():
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        premerge.stderr_event({"check_slot": "queued"})
    assert out.getvalue() == ""
    assert err.getvalue() == premerge.EVENT_PREFIX + '{"check_slot": "queued"}\n'


# ---- HZ-585: `ahead` on a SlotPolicy's queued events ----


def _ahead_waiter(run_id, events, done, policy):
    def go():
        try:
            with check_slots.check_slot(run_id=run_id, poll_s=0.05, on_event=events.append, policy=policy):
                pass
        except check_slots.SlotWaitExpired as exc:
            events.append({"expired": exc.waited_s})
        done.set()

    threading.Thread(target=go, daemon=True).start()


def test_report_ahead_counts_the_runs_that_started_waiting_first_and_is_not_resent_each_poll():
    policy = check_slots.SlotPolicy(report_ahead=True)
    holder = _hold_slot_0()
    first, second = [], []
    first_done, second_done = threading.Event(), threading.Event()
    try:
        _ahead_waiter("first", first, first_done, policy)
        assert _wait_for(lambda: first)
        _ahead_waiter("second", second, second_done, policy)
        assert _wait_for(lambda: second)
        time.sleep(0.5)  # ~10 polls each
        assert first == [{"check_slot": "queued", "ahead": 0}]
        assert second == [{"check_slot": "queued", "ahead": 1}]
    finally:
        _release(holder)
    assert first_done.wait(10) and second_done.wait(10)
    # Whichever was granted first, the second never counted more than one ahead
    # and the first never counted anyone.
    assert [e.get("ahead") for e in first if e["check_slot"] == "queued"] == [0]
    assert all(e.get("ahead") in (0, 1) for e in second if e["check_slot"] == "queued")


def test_a_run_that_waited_on_memory_first_queues_behind_runs_already_waiting_for_a_slot(tmp_path, monkeypatch):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 1000 kB\nMemAvailable: 50 kB\n")
    monkeypatch.setenv(check_slots.MEMINFO_PATH_ENV, str(meminfo))
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "15")
    policy = check_slots.SlotPolicy(report_ahead=True)
    holder = _hold_slot_0()
    late, slot_waiter = [], []
    late_done, slot_done = threading.Event(), threading.Event()
    try:
        _ahead_waiter("late", late, late_done, policy)
        assert _wait_for(lambda: any(e["check_slot"] == "memory" for e in late))
        # Memory recovers only after another run is already waiting for the slot.
        monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "0")
        _ahead_waiter("slot-waiter", slot_waiter, slot_done, policy)
        assert _wait_for(lambda: slot_waiter)
        meminfo.write_text("MemTotal: 1000 kB\nMemAvailable: 900 kB\n")
        assert _wait_for(lambda: any(e["check_slot"] == "queued" for e in late))
        assert [e for e in late if e["check_slot"] == "queued"][0] == {"check_slot": "queued", "ahead": 1}
    finally:
        _release(holder)
    assert late_done.wait(10) and slot_done.wait(10)


def test_a_policy_that_does_not_fail_open_raises_at_its_ceiling_and_holds_nothing():
    policy = check_slots.SlotPolicy(wait_ceiling_s=1, fail_open=False)
    holder = _hold_slot_0()
    events, done = [], threading.Event()
    try:
        _ahead_waiter("expiring", events, done, policy)
        assert done.wait(10)
    finally:
        _release(holder)
    assert events[-1]["expired"] >= 1
    assert not any(e.get("check_slot") == "granted" for e in events)
    assert check_slots.waiting_runs() == []
    assert check_slots.busy_slots() == 0
