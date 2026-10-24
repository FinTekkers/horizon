"""HZ-571: a check, pre-merge or capture run does not start while the host is
short of memory, and starts as soon as memory recovers.

Memory is faked through FARM_MEMINFO_PATH (a test-only seam) pointing at a
tmp_path file, so nothing here depends on the real host's free memory. Every
test sets the threshold itself: conftest.py turns the gate off for the rest
of the suite, and a test that inherited that would pass with the gate off.

No fixed sleeps decide a "held" assertion: each one first waits, with a
deadline, until the run's waiting marker says it is waiting on memory.
"""

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from farm import check_metrics, check_slots, checks, farmd
from farm.config import QUEUE_DIR
from farm.tests.test_checks_headline import OK, SCREENSHOTS_JSON, entry, manifest

client = TestClient(farmd.app)

TOTAL_KB = 16_000_000


@pytest.fixture(autouse=True)
def gate(tmp_path, monkeypatch):
    """A throwaway FARM_HOME and a fake meminfo file at 50% free."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    monkeypatch.delenv("FARM_CHECK_SLOT_WAIT_MAX_S", raising=False)
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "15")
    meminfo = tmp_path / "meminfo"
    monkeypatch.setenv(check_slots.MEMINFO_PATH_ENV, str(meminfo))
    set_free(meminfo, 50)
    return meminfo


def set_free(meminfo, pct: float) -> None:
    available = int(TOTAL_KB * pct / 100)
    meminfo.write_text(f"MemTotal:       {TOTAL_KB} kB\nMemFree:        1000 kB\nMemAvailable:   {available} kB\n")


def wait_until(fn, timeout_s: float = 10.0, what: str = "condition"):
    until = time.monotonic() + timeout_s
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() > until:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.05)


def marker_for(run_id, waiting_on: str = "memory"):
    return next(
        (w for w in check_slots.waiting_runs() if w.get("run_id") == run_id and w.get("waiting_on") == waiting_on),
        None,
    )


def start(fn, **kwargs) -> tuple[threading.Thread, dict]:
    """Runs fn(**kwargs) in a thread; the outcome lands in the dict."""
    out: dict = {}

    def run():
        try:
            out["result"] = fn(**kwargs)
        except BaseException as exc:  # noqa: BLE001 — reported by the test
            out["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, out


def finish(thread: threading.Thread, out: dict, timeout_s: float = 15.0):
    thread.join(timeout_s)
    assert not thread.is_alive(), "the run never finished"
    if "error" in out:
        raise out["error"]
    return out.get("result")


# ---- metric 1: a queued check waits, shows the figure, then starts ----


@pytest.fixture
def active_dir():
    path = QUEUE_DIR / "runs" / "active"
    path.mkdir(parents=True, exist_ok=True)
    yield path
    for f in path.glob("571*.json"):
        f.unlink(missing_ok=True)


def test_a_check_waits_for_memory_shows_the_figure_and_starts_once_memory_recovers(
    tmp_path, gate, monkeypatch, active_dir
):
    run_id = 571001
    # A claimed run: matched by neither queue glob, so only the marker can
    # make /runs/status say anything but "running".
    (active_dir / f"{run_id}.json").write_text(json.dumps({"run_id": run_id}))
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    set_free(gate, 10)
    logs: list = []

    thread, out = start(checks.run_checks, ws=tmp_path, log=logs.append, run_id=run_id, item_id="HZ-571")
    wait_until(lambda: marker_for(run_id), what="the memory marker")
    assert not sentinel.exists(), "the check started below the threshold"
    res = client.post("/runs/status", json={"run_ids": [run_id]})
    assert res.json() == {
        "states": {str(run_id): {"state": "queued", "reason": "waiting for memory (10% free, 1.5 GB)"}}
    }

    set_free(gate, 50)
    note = finish(thread, out)
    assert sentinel.exists()
    assert "passed" in note
    assert check_slots.waiting_runs() == []
    res = client.post("/runs/status", json={"run_ids": [run_id]})
    assert res.json() == {"states": {str(run_id): {"state": "running"}}}


def test_still_short_of_memory_at_the_ceiling_fails_timed_out_without_running(tmp_path, gate, monkeypatch):
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "1")
    set_free(gate, 5)

    with pytest.raises(checks.CheckFailure) as caught:
        checks.run_checks(tmp_path, log=lambda *_: None, run_id="m1-ceiling")

    assert caught.value.reason == "timed_out"
    assert "memory" in caught.value.headline and "5% free" in caught.value.headline
    assert not sentinel.exists()
    assert check_slots.waiting_runs() == []


def test_memory_dropping_during_a_slot_wait_fails_closed_at_the_ceiling_never_open(tmp_path, gate, monkeypatch):
    """The slot path fails open at the ceiling; memory is re-read before that
    branch, so a run short of memory never takes it."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "4")
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    run_id = "m1-slot-ceiling"

    with check_slots.check_slot(run_id="holder") as held:
        assert held.mode == "held"
        thread, out = start(checks.run_checks, ws=tmp_path, log=lambda *_: None, run_id=run_id)
        wait_until(lambda: marker_for(run_id, "slot"), what="the slot marker")
        set_free(gate, 5)
        wait_until(lambda: marker_for(run_id, "memory"), what="the marker to move to memory")
        with pytest.raises(checks.CheckFailure) as caught:
            finish(thread, out)

    assert caught.value.reason == "timed_out"
    assert "memory" in caught.value.headline
    assert not sentinel.exists(), "the slot path failed open while memory was low"


# ---- metric 2: captures and pre-merge runs wait too ----


def test_a_capture_waits_for_memory_and_runs_once_memory_recovers(tmp_path, gate, monkeypatch):
    ws = tmp_path / "ws"
    (ws / ".horizon").mkdir(parents=True)
    (ws / ".horizon" / "screenshots.json").write_text(json.dumps(SCREENSHOTS_JSON))
    captured: list = []

    def fake_capture(ws, cfg, *, log, **_):
        captured.append(time.monotonic())
        return manifest(*(entry(name, OK) for name in ("home", "admin", "list")))

    monkeypatch.setattr(checks, "_capture_screenshots", fake_capture)
    set_free(gate, 10)
    run_id = "m2-capture"

    thread, out = start(
        checks.run_checks,
        ws=ws,
        log=lambda *_: None,
        run_id=run_id,
        configured={"test": "true"},
        capture_screenshots=True,
    )
    wait_until(lambda: marker_for(run_id), what="the memory marker")
    assert captured == []

    set_free(gate, 50)
    finish(thread, out)
    assert len(captured) == 1


# ---- metric 3: running work is never touched ----


def test_memory_dropping_while_a_check_runs_leaves_it_to_finish_normally(tmp_path, gate, monkeypatch):
    # The check itself drops the faked figure below the threshold mid-run.
    available = int(TOTAL_KB * 0.05)
    script = tmp_path / "drop.sh"
    script.write_text(
        f"printf 'MemTotal: {TOTAL_KB} kB\\nMemAvailable: {available} kB\\n' > {gate}\nsleep 1\necho finished\nexit 0\n"
    )
    monkeypatch.setenv("FARM_CHECK_CMD", f"sh {script}")
    events: list = []

    note = checks.run_checks(tmp_path, log=lambda *_: None, run_id="m3", on_slot_event=events.append)

    assert "passed" in note
    assert check_slots.memory_reading().pct == pytest.approx(5.0)
    assert events == [], "a run that never waited hears no slot event"
    assert check_slots.waiting_runs() == []
    record = check_metrics.read_records(check_metrics.metrics_path())[0][-1]
    assert record["outcome"] == "pass"
    assert [c["returncode"] for c in record["commands"]] == [0]


# ---- metric 4: /farm/status reports the figure and the waiting count ----


def test_farm_status_reports_free_memory_and_two_runs_waiting_on_it(gate):
    set_free(gate, 10)

    def wait_in_slot(run_id):
        with check_slots.check_slot(run_id=run_id, poll_s=0.1) as slot:
            return slot.mode

    runs = [start(wait_in_slot, run_id=run_id) for run_id in ("m4-a", "m4-b")]
    wait_until(lambda: marker_for("m4-a") and marker_for("m4-b"), what="both memory markers")

    memory = client.get("/farm/status").json()["memory"]
    assert memory["available_pct"] == 10.0
    assert memory["available_kb"] == TOTAL_KB // 10
    assert memory["threshold_pct"] == 15
    assert memory["readable"] is True
    assert memory["waiting"] == 2

    set_free(gate, 50)
    assert [finish(*run) for run in runs] == ["held", "held"]
    assert client.get("/farm/status").json()["memory"]["waiting"] == 0


def test_farm_status_memory_block_on_an_unreadable_meminfo(tmp_path, monkeypatch):
    monkeypatch.setenv(check_slots.MEMINFO_PATH_ENV, str(tmp_path / "missing"))
    memory = client.get("/farm/status").json()["memory"]
    assert memory == {
        "available_kb": None,
        "total_kb": None,
        "available_pct": None,
        "threshold_pct": 15,
        "readable": False,
        "waiting": 0,
    }


# ---- metric 5: the one threshold setting ----


def test_a_threshold_of_30_holds_a_check_at_20_percent(tmp_path, gate, monkeypatch):
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "30")
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    set_free(gate, 20)
    run_id = "m5-30"

    thread, out = start(checks.run_checks, ws=tmp_path, log=lambda *_: None, run_id=run_id)
    wait_until(lambda: marker_for(run_id), what="the memory marker")
    assert not sentinel.exists()

    set_free(gate, 50)
    finish(thread, out)
    assert sentinel.exists()


def test_unset_the_default_is_15_percent_14_holds_and_16_starts(tmp_path, gate, monkeypatch):
    monkeypatch.delenv(check_slots.MEM_THRESHOLD_ENV)
    assert check_slots.mem_threshold_pct() == 15
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    set_free(gate, 14)
    run_id = "m5-default"

    thread, out = start(checks.run_checks, ws=tmp_path, log=lambda *_: None, run_id=run_id)
    wait_until(lambda: marker_for(run_id), what="the memory marker")
    assert not sentinel.exists()

    set_free(gate, 16)
    finish(thread, out)
    assert sentinel.exists()


@pytest.mark.parametrize(("raw", "expected"), [("abc", 15), ("101", 15), ("0", 0), ("-1", -1)])
def test_a_bad_threshold_falls_back_to_15_and_zero_turns_the_gate_off(monkeypatch, raw, expected):
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, raw)
    logs: list = []
    assert check_slots.mem_threshold_pct(logs.append) == expected
    assert bool(logs) == (expected == 15)


def test_threshold_zero_starts_a_run_even_at_one_percent(gate, monkeypatch):
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "0")
    set_free(gate, 1)
    with check_slots.check_slot(run_id="off") as slot:
        assert slot.mode == "held" and slot.waited_s < 1


# ---- guardrail 1: nested runs are not held ----


@pytest.mark.parametrize("limit", ["1", "0"])
def test_a_nested_run_is_never_held_with_the_limiter_on_or_off(gate, monkeypatch, limit):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", limit)
    monkeypatch.setenv(check_slots.IN_CHECKS_ENV, "1")
    set_free(gate, 5)

    started = time.monotonic()
    with check_slots.check_slot(run_id="nested") as slot:
        assert slot.mode == "nested"
        assert slot.waited_s == 0.0
        record = check_metrics.new_record(run_id="nested", slot=slot)
    assert time.monotonic() - started < 0.5
    assert record["slot_mode"] == "nested"
    assert json.loads(json.dumps(record))["slot_wait_s"] == 0.0
    assert not check_slots._waiting_dir().exists()


# ---- guardrail 4: a read failure never holds work ----


@pytest.mark.parametrize(
    "content",
    [None, "MemTotal: 16000000 kB\nMemFree: 1 kB\n", "MemTotal: 0 kB\nMemAvailable: 0 kB\n", "garbage\n"],
    ids=["missing-file", "no-memavailable", "memtotal-zero", "unparseable"],
)
def test_an_unreadable_meminfo_logs_a_warning_once_and_lets_the_check_start(tmp_path, gate, monkeypatch, content):
    if content is None:
        gate.unlink()
    else:
        gate.write_text(content)
    sentinel = tmp_path / "ran"
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {sentinel}")
    logs: list = []

    started = time.monotonic()
    checks.run_checks(tmp_path, log=logs.append, run_id="g4")

    assert time.monotonic() - started < 5
    assert sentinel.exists()
    warnings = [line for line in logs if "cannot read available memory" in line]
    assert len(warnings) == 1, logs
    assert "WARNING" in warnings[0]


def test_check_metrics_reads_memory_through_the_same_reader(gate):
    set_free(gate, 25)
    assert check_metrics.mem_available_kb() == TOTAL_KB // 4
