"""HZ-144: the cross-process cap on concurrent check suites.

Every test here redirects FARM_HOME to tmp_path. The repo whose checks the
farm runs is Horizon itself, so a test that touched the real $FARM_HOME would
take slots away from live farm runs — and would fail or hang depending on
what else is running, which is the worst kind of flake.

Nothing here sleeps for more than a few seconds. Where a timeout is the thing
under test, the *argument* is asserted rather than the wall clock (see
test_queue_wait_does_not_eat_the_check_timeout): a test that proved the 600s
budget by waiting 600s would be unrunnable inside the very check suite it
protects.
"""

import json
import os
import signal
import subprocess
import sys
import textwrap
import time

import pytest

from farm import check_slots, config

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(autouse=True)
def isolated_slot_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    # The farm's own check subprocess sets this, and the suite may be running
    # as exactly that subprocess — clear it so these tests exercise the real
    # limiter. test_nested_acquisition_is_a_no_op sets it back on purpose.
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_MAX_CONCURRENT_CHECKS", raising=False)
    monkeypatch.delenv("FARM_CHECK_SLOT_WAIT_MAX_S", raising=False)
    # HZ-571: these tests are about slots, not the real host's free memory.
    monkeypatch.setenv(check_slots.MEM_THRESHOLD_ENV, "0")
    return tmp_path


# ---- configuration is read at call time, and validated there ----


def test_the_limit_defaults_to_two():
    assert check_slots.slot_limit() == check_slots.DEFAULT_LIMIT == 2


def test_the_limit_is_env_configurable(monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "3")
    assert check_slots.slot_limit() == 3


@pytest.mark.parametrize("raw", ["abc", "", "   ", "2.5", "two"])
def test_a_malformed_limit_falls_back_to_the_default_and_says_so(monkeypatch, raw):
    """A bare int() here would raise ValueError inside every check on the
    host — a typo in farm.env must degrade to the default, loudly."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", raw)
    logged = []
    assert check_slots.slot_limit(logged.append) == 2
    # An empty/blank value is "unset", not a typo — no warning for those.
    assert bool(logged) is bool(raw.strip())


def test_a_negative_limit_is_the_documented_kill_switch(monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "-1")
    assert check_slots.slot_limit() == -1


def test_the_wait_ceiling_is_env_configurable(monkeypatch):
    assert check_slots.wait_ceiling_s() == check_slots.DEFAULT_WAIT_CEILING_S
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "5")
    assert check_slots.wait_ceiling_s() == 5.0


def test_the_default_wait_ceiling_is_above_the_worst_legitimate_queue():
    """Guardrail 1, enforced by a runner rather than by review.

    Past the ceiling a run proceeds with NO slot. So a ceiling that ordinary
    queueing can reach hands the host three-plus concurrent check suites on 2
    vCPUs — the limiter switching itself off exactly when the host is busiest,
    which is the oversubscription this item exists to prevent.

    The worst wait that is the limiter working *as designed* is the 6th
    arrival at cap 6 / limit 2: two waves of a real suite ahead of it, each
    slowed by sharing the box. Anything at or below that is a queue, not a
    pathology, and must not trip the escape hatch.
    """
    worst_legitimate_wait_s = (
        check_slots.WORST_QUEUE_DEPTH * check_slots.MEASURED_SUITE_S * check_slots.CONTENTION_FACTOR
    )
    assert worst_legitimate_wait_s == 906.0
    assert check_slots.DEFAULT_WAIT_CEILING_S > worst_legitimate_wait_s, (
        f"a {check_slots.DEFAULT_WAIT_CEILING_S:.0f}s ceiling is reachable by normal queueing "
        f"({worst_legitimate_wait_s:.0f}s at cap 6 / limit 2), so the limiter would fail open under load"
    )


def test_the_default_wait_ceiling_still_fits_inside_the_step_watchdog():
    """The other side of the same bound. A run that waits, then runs its
    checks, must still report before server/src/orchestrator.js's watchdog
    gives up — otherwise the ceiling trades an oversubscribed host for a
    `never_picked_up`, which is the failure this item is trying to REDUCE.

    Floors, not guesses: the implement step is floored at 50 min there, the
    agent itself may burn FARM_STEP_TIMEOUT_S first, and the checks then need
    their own FARM_CHECK_TIMEOUT_S budget.
    """
    implement_step_watchdog_s = 50 * 60
    agent_budget_s = config.STEP_TIMEOUT_S
    check_budget_s = 600
    assert agent_budget_s + check_slots.DEFAULT_WAIT_CEILING_S + check_budget_s < implement_step_watchdog_s


def test_slot_dir_is_read_at_call_time_not_import_time(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "elsewhere"))
    assert check_slots.slot_dir() == tmp_path / "elsewhere" / "locks" / "checks"


def test_slot_dir_works_with_farm_home_unset(monkeypatch):
    """FARM_HOME is optional and defaults in farm/config.py. An
    os.environ["FARM_HOME"] here would KeyError on any host or CI runner that
    never exported it — i.e. would crash every check."""
    monkeypatch.delenv("FARM_HOME", raising=False)
    assert check_slots.slot_dir().parts[-2:] == ("locks", "checks")


# ---- metric 2: no more than the configured number of check suites at once ----

# Acquires a slot, writes "acquired <n>" to a file, holds it, then exits. The
# file is how the parent observes overlap without the children needing to
# talk to each other.
HOLDER = textwrap.dedent(
    """
    import sys, time
    from farm import check_slots
    marker, hold_s, label = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    with check_slots.check_slot(run_id=label, poll_s=0.05) as slot:
        with open(marker, "a") as fh:
            fh.write(f"{label} {slot.mode} {slot.slot_index} {time.time()}\\n")
        time.sleep(hold_s)
    """
)


def _holder(marker, hold_s, label, env_extra=None):
    env = {**os.environ, "PYTHONPATH": REPO_ROOT, **(env_extra or {})}
    return subprocess.Popen(
        [sys.executable, "-c", HOLDER, str(marker), str(hold_s), label],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _lines(marker):
    return marker.read_text().splitlines() if marker.exists() else []


def _wait_for_lines(marker, count, timeout_s=10):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if len(_lines(marker)) >= count:
            return True
        time.sleep(0.05)
    return False


def test_only_the_configured_number_of_slots_are_held_at_once(tmp_path, monkeypatch):
    """Three processes, two slots: two start immediately and the third waits
    for a release. Each step runs as its own OS process, so this has to be
    proven across processes — an in-process lock would pass vacuously."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    marker = tmp_path / "acquired.txt"
    procs = [_holder(marker, 1.5, f"run-{i}") for i in range(3)]
    try:
        assert _wait_for_lines(marker, 2), "two slots should be taken straight away"
        # The excess run must still be waiting — this is the whole metric.
        time.sleep(0.5)
        assert len(_lines(marker)) == 2, f"a third slot was handed out: {_lines(marker)}"
        assert check_slots.busy_slots() == 2
        waiting = check_slots.waiting_runs()
        assert len(waiting) == 1 and waiting[0]["run_id"].startswith("run-")

        # ...and must get one once a holder releases.
        assert _wait_for_lines(marker, 3, timeout_s=15)
    finally:
        for p in procs:
            p.wait(timeout=30)
    labels = [line.split()[0] for line in _lines(marker)]
    modes = {line.split()[1] for line in _lines(marker)}
    assert sorted(labels) == ["run-0", "run-1", "run-2"]
    assert modes == {"held"}, f"a run bypassed the limiter: {_lines(marker)}"
    assert {line.split()[2] for line in _lines(marker)} <= {"0", "1"}


def test_the_limiter_serialises_completely_at_a_limit_of_one(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    marker = tmp_path / "acquired.txt"
    procs = [_holder(marker, 0.6, f"run-{i}") for i in range(2)]
    try:
        assert _wait_for_lines(marker, 1)
        time.sleep(0.2)
        assert len(_lines(marker)) == 1
        assert _wait_for_lines(marker, 2, timeout_s=15)
    finally:
        for p in procs:
            p.wait(timeout=30)
    stamps = sorted(float(line.split()[3]) for line in _lines(marker))
    assert stamps[1] - stamps[0] >= 0.5, "the second run overlapped the first"


def test_lowering_the_limit_mid_flight_does_not_oversubscribe(tmp_path, monkeypatch):
    """An operator drops 2 -> 1 while both slots are held. Existing holders
    keep what they have (nothing can revoke a live flock), but a NEW run must
    only consider slot 0 — it must not be handed slot 1 just because the
    higher index happens to be free later."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    marker = tmp_path / "acquired.txt"
    holders = [_holder(marker, 2.0, f"hold-{i}") for i in range(2)]
    try:
        assert _wait_for_lines(marker, 2)
        monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
        assert _try_acquire(monkeypatch, ceiling_s=1) is None, "a new run was handed the retired slot 1"
    finally:
        for p in holders:
            p.wait(timeout=30)


def _try_acquire(monkeypatch, ceiling_s: int):
    """The slot index this process can get within ceiling_s, or None.

    Expressed through the real check_slot() with a low ceiling, so "could not
    get one" is observed as the fail-open path rather than by racing a thread
    against a blocking call.
    """
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", str(ceiling_s))
    with check_slots.check_slot(poll_s=0.05) as slot:
        return slot.slot_index if slot.mode == "held" else None


# ---- metric 3: queue wait is outside the check timeout ----


def test_queue_wait_does_not_eat_the_check_timeout(tmp_path, monkeypatch):
    """A run that waits longer than FARM_CHECK_TIMEOUT_S for a slot still
    gets its full check budget.

    Asserted on the timeout ARGUMENT each check command receives, not on elapsed
    wall clock: the property is structural (checks.py reads no clock until
    after the `with`), and proving it by waiting out a real 600s budget would
    make this test unrunnable inside the suite it protects.
    """
    from farm import checks

    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "2")
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    marker = tmp_path / "acquired.txt"

    # Hold the only slot for longer than the check timeout itself.
    holder = _holder(marker, 3.0, "hog")
    try:
        assert _wait_for_lines(marker, 1)

        seen = {}
        real_run = checks._run_bounded

        def spy(cmd, ws, timeout_s, env):
            seen["timeout"] = timeout_s
            return real_run(cmd, ws, timeout_s, env)

        monkeypatch.setattr(checks, "_run_bounded", spy)
        started = time.monotonic()
        note = checks.run_checks(tmp_path, log=lambda *_: None, run_id="waiter")
        waited = time.monotonic() - started
    finally:
        holder.wait(timeout=30)

    assert "passed" in note
    assert waited > 2, "the test did not actually wait past the check timeout"
    assert seen["timeout"] == 2, "the wait for a slot was charged against the check budget"


def test_the_check_timeout_default_is_not_raised_to_hide_contention(tmp_path, monkeypatch):
    """HZ-144 guardrail 3, enforced by a runner rather than by review: if
    checks are slow under load, that gets reported, not absorbed by a bigger
    budget."""
    from farm import checks

    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    seen = {}
    real_run = checks._run_bounded

    def spy(cmd, ws, timeout_s, env):
        seen["timeout"] = timeout_s
        return real_run(cmd, ws, timeout_s, env)

    monkeypatch.setattr(checks, "_run_bounded", spy)
    checks.run_checks(tmp_path, log=lambda *_: None)
    assert seen["timeout"] == 600


def test_the_e2e_contention_ceiling_is_not_raised_either():
    """The same guardrail, one layer out. e2e/playwright.config.js's
    globalTimeout is what actually fired on 30 Sept 2026 at load ~8, so it is
    this item's contention detector (farm/check_metrics.py classifies its
    message). Raising it would hide exactly what the measurement is for —
    enforced by a runner here rather than by review. main has since moved it
    from 85s to 180s, then to 360s, on its own evidence (see the comment
    above it); this item pins whatever main set and does not raise it further."""
    config_js = os.path.join(REPO_ROOT, "e2e", "playwright.config.js")
    with open(config_js) as fh:
        source = fh.read()
    assert "globalTimeout: 360_000" in source
    assert "workers: 1" in source, "the e2e suite must stay single-worker; it is not what oversubscribes the host"


# ---- the failure modes that must not wedge the farm ----


def test_a_sigkilled_holder_releases_its_slot(tmp_path, monkeypatch):
    """The reason this is an flock and not a lock file with a pid in it: the
    kernel drops the lock when the holder dies, so a killed agent can never
    wedge a slot and no reaper is needed."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    marker = tmp_path / "acquired.txt"
    holder = _holder(marker, 30.0, "doomed")
    try:
        assert _wait_for_lines(marker, 1)
        assert check_slots.busy_slots() == 1
        holder.send_signal(signal.SIGKILL)
        holder.wait(timeout=30)
    finally:
        if holder.poll() is None:
            holder.kill()
    assert _try_acquire(monkeypatch, ceiling_s=2) == 0


def test_the_limit_zero_kill_switch_never_blocks(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "0")
    with check_slots.check_slot() as a, check_slots.check_slot() as b, check_slots.check_slot() as c:
        assert [a.mode, b.mode, c.mode] == ["disabled"] * 3
        assert not any(s.limited for s in (a, b, c))
    # ...and it leaves no lock directory behind to reason about.
    assert not (tmp_path / "locks").exists()


def test_nested_acquisition_is_a_no_op(monkeypatch):
    """The deadlock guard. Horizon's own suite calls run_checks(), so an inner
    call inside an outer run's slot would wait for a slot the outer run is
    holding — and that wait is deliberately outside the check timeout, so
    nothing would bound it."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv(check_slots.IN_CHECKS_ENV, "1")
    with check_slots.check_slot() as outer, check_slots.check_slot() as inner:
        assert outer.mode == inner.mode == "nested"
        assert outer.waited_s == 0.0


def test_a_run_that_waits_past_the_ceiling_proceeds_unthrottled_and_loudly(tmp_path, monkeypatch):
    """Fail-open, not fail-closed. Checks run before commit/push, so failing
    the run would discard a whole attempt's work; and an unbounded wait can
    outlive the server's step watchdog and resurface as `never_picked_up`."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "1")
    marker = tmp_path / "acquired.txt"
    holder = _holder(marker, 4.0, "hog")
    try:
        assert _wait_for_lines(marker, 1)
        logged = []
        with check_slots.check_slot(log=logged.append, poll_s=0.05) as slot:
            assert slot.mode == "fail-open"
            assert slot.timed_out is True
            assert slot.waited_s >= 1
        assert any("no capacity slot after" in line and "WARNING" in line for line in logged)
        # The warning is the whole point of fail-open: it must not be silent.
        assert any("over its check capacity" in line for line in logged)
    finally:
        holder.wait(timeout=30)


def test_an_unwritable_lock_directory_runs_unthrottled_rather_than_failing(tmp_path, monkeypatch):
    """A filesystem problem in the farm's own plumbing must not fail a check
    run — that would discard an attempt over something unrelated to the code
    under test."""
    blocker = tmp_path / "locks"
    blocker.write_text("not a directory")
    logged = []
    with check_slots.check_slot(log=logged.append) as slot:
        assert slot.mode == "fail-open"
    assert any("running checks unthrottled" in line for line in logged)


# ---- observability: waiting markers, which get no kernel self-heal ----


def test_a_marker_appears_while_waiting_and_is_gone_once_the_slot_is_won(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    marker = tmp_path / "acquired.txt"
    holder = _holder(marker, 1.2, "hog")
    try:
        assert _wait_for_lines(marker, 1)

        waited_seen = []

        def watcher(_msg):
            waited_seen.append(check_slots.waiting_runs())

        with check_slots.check_slot(log=watcher, run_id="r-91", item_id="HZ-150", poll_s=0.05) as slot:
            assert slot.mode == "held"
            assert check_slots.waiting_runs() == []
    finally:
        holder.wait(timeout=30)
    entries = [e for batch in waited_seen for e in batch]
    assert any(e["run_id"] == "r-91" and e["item_id"] == "HZ-150" for e in entries)
    assert all("waited_s" in e and e["pid"] > 0 for e in entries)


def test_a_marker_from_a_dead_pid_is_pruned_not_reported(tmp_path):
    """Unlike the slots, marker files have no kernel self-heal — a waiter
    killed mid-wait leaves its file behind. Without a liveness filter,
    /farm/status would show a phantom waiter forever."""
    waiting = check_slots.slot_dir() / "waiting"
    waiting.mkdir(parents=True)
    dead = waiting / "999999-r-dead.json"
    dead.write_text(json.dumps({"pid": 999999, "run_id": "r-dead", "since": time.time()}))
    live = waiting / f"{os.getpid()}-r-live.json"
    live.write_text(json.dumps({"pid": os.getpid(), "run_id": "r-live", "since": time.time()}))

    reported = check_slots.waiting_runs()

    assert [e["run_id"] for e in reported] == ["r-live"]
    assert not dead.exists(), "a stale marker should be pruned on read, not just hidden"


def test_a_marker_older_than_the_age_cutoff_is_pruned_even_if_its_pid_is_alive(tmp_path):
    """Belt as well as braces: pids are recycled, and our own pid would make
    an ancient marker look live forever."""
    waiting = check_slots.slot_dir() / "waiting"
    waiting.mkdir(parents=True)
    ancient = waiting / f"{os.getpid()}-r-ancient.json"
    ancient.write_text(
        json.dumps({"pid": os.getpid(), "run_id": "r-ancient", "since": time.time() - check_slots.MARKER_MAX_AGE_S - 1})
    )
    assert check_slots.waiting_runs() == []
    assert not ancient.exists()


def test_a_malformed_marker_is_skipped_not_crashed_on(tmp_path):
    waiting = check_slots.slot_dir() / "waiting"
    waiting.mkdir(parents=True)
    (waiting / "garbage.json").write_text("{not json")
    assert check_slots.waiting_runs() == []


def test_waiting_runs_is_empty_when_nothing_has_ever_run(tmp_path):
    assert check_slots.waiting_runs() == []
    assert check_slots.busy_slots() == 0


def test_status_reports_the_limit_busy_count_and_waiters(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    with check_slots.check_slot() as slot:
        assert slot.mode == "held"
        status = check_slots.status()
    assert status["limit"] == 2
    assert status["busy"] == 1
    assert status["waiting"] == []


# ---- HZ-592: every wait names what the capacity slot is for ----

WAIT_TABLE = {
    "step_agent": "waiting for a capacity slot to run checks",
    "premerge": "waiting for a capacity slot to run pre-merge checks (main + PR)",
    "conflict_resolver": "waiting for a capacity slot to re-check after rebasing",
    "screenshots": "waiting for a capacity slot to capture screenshots",
}


@pytest.mark.parametrize("caller", sorted(WAIT_TABLE))
def test_each_callers_wait_message_names_its_purpose(caller):
    assert check_slots.wait_message(caller) == WAIT_TABLE[caller]


@pytest.mark.parametrize("caller", sorted(check_slots.WAIT_PURPOSES))
def test_every_wait_message_reads_waiting_for_a_capacity_slot_to_a_purpose(caller):
    message = check_slots.wait_message(caller)
    assert message.startswith("waiting for a capacity slot to ")
    assert len(message) > len("waiting for a capacity slot to ")


@pytest.mark.parametrize("caller", ["someone_new", "", None, 7, "__class__"])
def test_an_unknown_caller_has_no_wait_message_and_never_raises(caller):
    """The wait path and /farm/status both call this, and status reads
    markers any farm build may have written — so it never raises."""
    assert check_slots.wait_message(caller) is None


def _callers_in_farm_code() -> dict[str, str]:
    """Every `caller` a farm module passes to run_checks() (or its
    _run_checks wrapper) or check_slot(), plus their defaults: {caller: where}."""
    import ast
    import pathlib

    found: dict[str, str] = {}
    for path in sorted(pathlib.Path(REPO_ROOT, "farm").glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
                if name not in ("run_checks", "_run_checks", "check_slot"):
                    continue
                for kw in node.keywords:
                    if kw.arg == "caller" and isinstance(kw.value, ast.Constant):
                        found[kw.value.value] = f"{path.name}:{node.lineno}"
            elif isinstance(node, ast.FunctionDef) and node.name in ("run_checks", "check_slot"):
                positional = node.args.args[len(node.args.args) - len(node.args.defaults) :]
                defaults = dict(zip([a.arg for a in positional], node.args.defaults))
                defaults.update((a.arg, d) for a, d in zip(node.args.kwonlyargs, node.args.kw_defaults))
                default = defaults.get("caller")
                if isinstance(default, ast.Constant):
                    found[default.value] = f"{path.name}:{node.lineno} (default)"
    return found


def test_every_caller_in_farm_code_names_its_purpose():
    """A new caller of run_checks()/check_slot() must add its purpose to
    WAIT_PURPOSES: a generic "waiting for a slot" is not allowed."""
    found = _callers_in_farm_code()
    # The scan itself must see today's callers, or it proves nothing.
    assert {"step_agent", "premerge", "conflict_resolver", "validate"} <= set(found), found
    missing = {caller: where for caller, where in found.items() if caller not in check_slots.WAIT_PURPOSES}
    assert missing == {}, f"add these callers to check_slots.WAIT_PURPOSES: {missing}"


def test_the_wait_log_line_names_the_callers_purpose(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    marker = tmp_path / "acquired.txt"
    holder = _holder(marker, 1.2, "hog")
    try:
        assert _wait_for_lines(marker, 1)
        logged = []
        with check_slots.check_slot(log=logged.append, caller="conflict_resolver", poll_s=0.05) as slot:
            assert slot.mode == "held"
    finally:
        holder.wait(timeout=30)
    assert (
        "check_slots: all 1 capacity slots busy — waiting for a capacity slot to re-check after rebasing" in logged
    ), logged
    assert any(line.startswith(f"check_slots: got capacity slot {slot.slot_index} after") for line in logged), logged


def test_farm_status_gives_each_slot_waiter_its_reason(tmp_path):
    waiting = check_slots.slot_dir() / "waiting"
    waiting.mkdir(parents=True)
    now = time.time()
    rows = {
        "r-pm": {"caller": "premerge", "waiting_on": "slot"},
        "r-mem": {"caller": "step_agent", "waiting_on": "memory"},
        "r-old": {"caller": "step_agent"},  # before HZ-571: a slot wait
        "r-new": {"caller": "someone_new", "waiting_on": "slot"},
    }
    for run_id, extra in rows.items():
        (waiting / f"{os.getpid()}-{run_id}.json").write_text(
            json.dumps({"pid": os.getpid(), "run_id": run_id, "since": now, **extra})
        )
    by_run = {w["run_id"]: w for w in check_slots.status()["waiting"]}
    assert by_run["r-pm"]["reason"] == WAIT_TABLE["premerge"]
    assert by_run["r-old"]["reason"] == WAIT_TABLE["step_agent"]
    assert "reason" not in by_run["r-mem"], "a memory wait is not a capacity-slot wait"
    assert "reason" not in by_run["r-new"], "an unknown caller gets no reason rather than breaking status"


# ---- HZ-574: holder records — who holds each slot, for Farm health ----

# Takes a slot as a labelled run, names a check in the record, writes
# "<run_id> <mode> <slot> <time>" to `out`, then holds until `release` exists.
# A release file rather than a timer, so "after one run releases" is a fact the
# test causes, not a sleep that a loaded host can outrun.
SIGNALLED_HOLDER = textwrap.dedent(
    """
    import os, sys, time
    from farm import check_slots
    out, release, run_id, item_id, caller, label = sys.argv[1:7]
    with check_slots.check_slot(run_id=run_id, item_id=item_id, caller=caller, poll_s=0.05) as slot:
        if label:
            slot.set_label(label)
        with open(out, "a") as fh:
            fh.write(f"{run_id} {slot.mode} {slot.slot_index} {time.time()}\\n")
        deadline = time.monotonic() + 60
        while not os.path.exists(release) and time.monotonic() < deadline:
            time.sleep(0.02)
    """
)


def _signalled_holder(out, release, run_id, item_id, caller, label=""):
    env = {**os.environ, "PYTHONPATH": REPO_ROOT}
    return subprocess.Popen(
        [sys.executable, "-c", SIGNALLED_HOLDER, str(out), str(release), run_id, item_id, caller, label],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _poll(predicate, timeout_s=15):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def _holder_files(slot=None):
    directory = check_slots.slot_dir() / "holders"
    pattern = f"slot-{slot}-*.json" if slot is not None else "slot-*.json"
    return sorted(directory.glob(pattern)) if directory.exists() else []


def _plant_holder(slot, pid, run_id, since=None, **extra):
    directory = check_slots.slot_dir() / "holders"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"slot-{slot}-{pid}-{run_id}.json"
    record = {
        "slot": slot,
        "pid": pid,
        "run_id": run_id,
        "item_id": extra.get("item_id", "HZ-9"),
        "caller": "step_agent",
        "label": "test slot",
        "since": time.time() if since is None else since,
    }
    path.write_text(json.dumps(record))
    return path


def _dead_pid():
    """The pid of a process this test SIGKILLed and reaped — truly dead."""
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    child.send_signal(signal.SIGKILL)
    child.wait(timeout=30)
    return child.pid


def test_two_holders_are_listed_with_their_slot_item_run_caller_label_and_start_and_a_third_waits(
    tmp_path, monkeypatch
):
    """HZ-574 metric 1, across three processes: two take both slots and a
    third waits. holders lists both with the right fields; once one releases,
    its record file is gone and it is no longer listed."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    out = tmp_path / "acquired.txt"
    release = {run: tmp_path / f"release-{run}" for run in ("901", "902", "903")}
    started = time.time()
    procs = [
        _signalled_holder(out, release["901"], "901", "HZ-101", "step_agent", "test slot, line 2"),
        _signalled_holder(out, release["902"], "902", "HZ-102", "premerge", "e2e slot"),
    ]
    try:
        assert _wait_for_lines(out, 2), "two slots should be taken straight away"
        procs.append(_signalled_holder(out, release["903"], "903", "HZ-103", "step_agent"))
        assert _poll(lambda: [w["run_id"] for w in check_slots.waiting_runs()] == ["903"]), "the third run should wait"

        status = check_slots.status()
        by_run = {h["run_id"]: h for h in status["holders"]}
        assert sorted(by_run) == ["901", "902"]
        acquired = {line.split()[0]: line.split() for line in _lines(out)}
        for run, item, caller, label in (
            ("901", "HZ-101", "step_agent", "test slot, line 2"),
            ("902", "HZ-102", "premerge", "e2e slot"),
        ):
            holder = by_run[run]
            assert holder["slot"] == int(acquired[run][2])
            assert holder["item_id"] == item
            assert holder["caller"] == caller
            assert holder["label"] == label
            assert started <= holder["since"] <= float(acquired[run][3])
            assert "pid" not in holder
        assert {h["slot"] for h in status["holders"]} == {0, 1}
        assert [w["run_id"] for w in status["waiting"]] == ["903"]

        released_slot = by_run["901"]["slot"]
        release["901"].write_text("")
        assert _poll(lambda: not any("-901." in p.name for p in _holder_files())), "901's record outlived its hold"
        assert "901" not in {h["run_id"] for h in check_slots.holders()}
        # The waiter took the freed slot and is listed in its place.
        assert _poll(lambda: {h["run_id"] for h in check_slots.holders()} == {"902", "903"})
        assert all("-903." in p.name for p in _holder_files(released_slot))
    finally:
        for path in release.values():
            path.write_text("")
        for p in procs:
            p.wait(timeout=30)
    assert _holder_files() == [], "every record goes with its release"


def test_a_holder_record_left_by_a_killed_process_is_not_listed_and_is_deleted_by_the_next_status_read(tmp_path):
    """HZ-574 metric 2: a holder killed mid-hold leaves its file, but the
    kernel freed its lock. A status read must neither report it nor keep it."""
    stale = _plant_holder(0, _dead_pid(), "r-killed")
    assert check_slots.status()["holders"] == []
    assert not stale.exists(), "the stale record should be deleted on read, not just hidden"


def test_a_holder_record_left_by_a_killed_process_is_deleted_by_the_next_slot_take(tmp_path, monkeypatch):
    """HZ-574 metric 2, the take path: the next run to win slot 0 deletes what
    a killed holder of slot 0 left, and only its own record is listed."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    stale = _plant_holder(0, _dead_pid(), "r-killed")
    with check_slots.check_slot(run_id="r-new", item_id="HZ-7") as slot:
        assert slot.mode == "held" and slot.slot_index == 0
        assert not stale.exists()
        assert [h["run_id"] for h in check_slots.holders()] == ["r-new"]


def test_a_holder_record_holds_only_the_allowed_keys_and_never_the_command_line(tmp_path, monkeypatch):
    """HZ-574 guardrail 1: the record names the slot, never the command, which
    may carry a login value. The command copies the live record out, so this
    reads exactly what Farm health would have read mid-run."""
    from farm import checks

    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    seen = tmp_path / "seen.json"
    holders_dir = check_slots.slot_dir() / "holders"
    command = f"echo TOKEN=abc123; cat {holders_dir}/*.json > {seen}"
    note = checks.run_checks(
        tmp_path, log=lambda *_: None, run_id="r-g1", item_id="HZ-574", configured={"test": command}, branch_gate=False
    )
    assert "passed" in note
    text = seen.read_text()
    record = json.loads(text)
    assert set(record) == {"slot", "pid", "run_id", "item_id", "caller", "label", "since"}
    assert record["label"] == "test slot"
    assert "abc123" not in text and "TOKEN" not in text
    assert _holder_files() == []


def test_an_unwritable_holder_record_never_stops_the_run_and_is_logged_once(tmp_path, monkeypatch):
    """HZ-574 guardrail 2, the write side: holders/ is a plain file, so every
    record write fails. The slot is still taken and every command runs; the
    failure is logged once, not at each of the three command boundaries."""
    from farm import checks

    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    check_slots.slot_dir().mkdir(parents=True)
    (check_slots.slot_dir() / "holders").write_text("not a directory")
    ran = tmp_path / "ran.txt"
    logged = []
    note = checks.run_checks(
        tmp_path,
        log=logged.append,
        configured={"test": "\n".join(f"echo {n} >> {ran}" for n in range(3))},
        branch_gate=False,
    )
    assert "passed" in note
    assert ran.read_text().split() == ["0", "1", "2"]
    assert len([line for line in logged if "could not write holder record" in line]) == 1, logged

    logged.clear()
    with check_slots.check_slot(log=logged.append) as slot:
        assert slot.mode == "held"
        for label in ("test slot", "lint slot", "e2e slot"):
            slot.set_label(label)
    assert len([line for line in logged if "could not write holder record" in line]) == 1, logged


def test_a_failed_holder_delete_still_releases_the_slot_and_is_logged(tmp_path, monkeypatch):
    """HZ-574 guardrail 2, the delete side: the record cannot be deleted on
    release. The `with` still exits cleanly, the lock is released (another
    process takes the slot at once) and one line is logged."""
    from pathlib import Path

    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    logged = []

    real_unlink = Path.unlink

    def refuse(self, missing_ok=False):
        raise PermissionError(f"refused: {self}")

    with check_slots.check_slot(log=logged.append, run_id="r-stuck") as slot:
        assert slot.mode == "held"
        monkeypatch.setattr(Path, "unlink", refuse)
    monkeypatch.setattr(Path, "unlink", real_unlink)
    assert len([line for line in logged if "could not delete holder record" in line]) == 1, logged

    out = tmp_path / "acquired.txt"
    release = tmp_path / "release"
    release.write_text("")
    taker = _signalled_holder(out, release, "r-next", "HZ-8", "step_agent")
    try:
        assert _wait_for_lines(out, 1, timeout_s=10), "the slot was not released"
    finally:
        taker.wait(timeout=30)
    assert _lines(out)[0].split()[1:3] == ["held", "0"]


def test_status_keeps_a_live_holders_record_and_hides_an_old_one_without_deleting_it(tmp_path, monkeypatch):
    """HZ-574 guardrail 3: cleanup never deletes the record of a slot whose
    lock is held. A live holder's record survives a status read; a live-pid
    record not rewritten in HOLDER_MAX_AGE_S is hidden but its file stays."""
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    ancient_since = time.time() - check_slots.HOLDER_MAX_AGE_S - 60
    ancient = _plant_holder(1, os.getpid(), "r-ancient", since=ancient_since)
    os.utime(ancient, (ancient_since, ancient_since))
    with check_slots.check_slot(run_id="r-live", item_id="HZ-5") as slot:
        assert slot.slot_index == 0
        listed = check_slots.status()["holders"]
        assert [h["run_id"] for h in listed] == ["r-live"]
        assert len(_holder_files(0)) == 1, "a status read deleted a held slot's record"
        assert ancient.exists(), "an old record with a live pid is hidden, not deleted"


def test_reading_holders_never_takes_a_lock(tmp_path, monkeypatch):
    """HZ-574 guardrail 3: a status read can never delay or deny a real take,
    because holders() never calls flock at all."""
    import fcntl

    _plant_holder(0, os.getpid(), "r-a")
    _plant_holder(1, _dead_pid(), "r-b")
    calls = []
    real = fcntl.flock
    monkeypatch.setattr(fcntl, "flock", lambda *a: calls.append(a) or real(*a))
    listed = check_slots.holders()
    assert [h["run_id"] for h in listed] == ["r-a"]
    assert calls == []
