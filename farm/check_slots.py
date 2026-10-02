"""HZ-144: a cross-process cap on how many repo check suites run at once.

An agent step is cheap while it waits on the model API and expensive only
while it runs the checked repo's own tests (`npm test`, pytest, a Vite build,
Playwright driving Chromium). Raising FARM_MAX_EPHEMERAL therefore needs a
*separate* limit on the expensive part, or six agents reaching their checks
together would oversubscribe this host's 2 vCPUs. On 30 Sept 2026 that was
observed live: at load ~8 the Playwright suite failed its own
`globalTimeout: 85_000` with "Timed out waiting 85s for the test suite to run".

Why a file lock. Every step runs as its own OS process in its own tmux session
(farm/farmd.py's _claim_and_launch), and the conflict resolver runs in farmd's
process, so only a filesystem lock can serialise them — an in-process
semaphore would see one holder per process and cap nothing. This mirrors
farm/workspaces.py's hub_lock().

Three properties are structural here rather than bookkeeping to get right:

  * **Queue wait is outside FARM_CHECK_TIMEOUT_S.** The slot is acquired
    before farm/checks.py starts any command, so waiting for a slot cannot
    eat the budget the checks themselves get. (HZ-144 guardrail 2.)
  * **A dead holder cannot wedge a slot.** flock() is released by the kernel
    when the holding fd closes, including on SIGKILL. Slot files are never
    cleaned up because their *contents* are not the state — the kernel's lock
    table is.
  * **Nested acquisition is a no-op.** The repo these checks run against is
    Horizon itself, whose own suite calls run_checks(). An inner call inside
    an outer run's slot would wait for a slot the outer run is still holding,
    and that wait is (by design) outside the check timeout, so nothing would
    bound it — a deadlock caused by the limiter. farm/checks.py marks the
    check subprocess with FARM_IN_CHECKS=1 and check_slot() returns
    immediately when it sees it.

The wait is bounded. An unbounded poll loop could outlive the Node server's
own step watchdog and resurface as a mystery `never_picked_up`, and a check
failure discards the whole attempt (checks run before commit/push), so the
expensive outcome is failing, not waiting. Past FARM_CHECK_SLOT_WAIT_MAX_S
the run proceeds *without* a slot, loudly, and the record says so — one run
over the ceiling is a number to report, not a reason to throw away an
attempt's work.

That escape hatch is only safe while it stays rare: a ceiling that ordinary
queueing can reach would disable the limiter exactly when the host is most
loaded. It is therefore sized against the measured cost of a real check suite
rather than picked round — see the derivation above DEFAULT_WAIT_CEILING_S.
"""

import contextlib
import fcntl
import json
import os
import random
import time
from dataclasses import dataclass
from pathlib import Path

from . import config

# Set by farm/checks.py on the check subprocess only — never forwarded into a
# tmux session, never written to farm.env. Its presence means "you are already
# running inside someone's check slot"; see the nesting note above.
IN_CHECKS_ENV = "FARM_IN_CHECKS"

DEFAULT_LIMIT = 2

# ---- How the wait ceiling below is derived, and why it is not 600s ----
#
# The ceiling is a LAST RESORT, not a queueing policy. Past it a run proceeds
# with no slot at all, so if ordinary queueing can reach it, the limiter stops
# limiting exactly when the host is busiest — three or more check suites on 2
# vCPUs, which is the oversubscription HZ-144 guardrail 1 exists to prevent.
# So the ceiling has to sit ABOVE the worst *legitimate* queue and BELOW the
# step watchdog that would kill the run anyway.
#
# Lower bound — the worst wait that is normal rather than pathological.
# MEASURED_SUITE_S is the p95 check duration over the 40 most recent real farm
# runs at cap 4 with no limiter (farm/tools/backfill_check_metrics.py; numbers
# in docs/hz-144-check-concurrency-measurement.md). p95 not median, because the
# run this ceiling has to survive is the slow one in front of it.
MEASURED_SUITE_S = 302.0
CONTENTION_FACTOR = 1.5  # what a suite costs while sharing 2 vCPUs with one other
WORST_QUEUE_DEPTH = 2  # at cap 6 / limit 2 the 6th arrival has two waves ahead of it
# => 2 x 302 x 1.5 = 906s of queueing that is the limiter working as designed.
#
# Upper bound — the run must still finish inside the server's watchdog:
#   server/src/orchestrator.js floors the implement step at 50 min (3000s),
#   the agent itself may take FARM_STEP_TIMEOUT_S (900s) before checks start,
#   and the checks then need their own ~600s budget. 900 + 1200 + 600 = 2700s.
#
# 1200s satisfies both, with ~32% margin over the 906s floor. If fail-open
# events show up in a measurement window anyway, that is NOT a reason to raise
# this — it means the farm is over its check capacity, and the reporter counts
# them (`Unthrottled` column) precisely so the finding is visible.
DEFAULT_WAIT_CEILING_S = 1200.0
POLL_S = 1.0
# A polling flock is not FIFO, so a run can in principle be starved by luckier
# neighbours. Jitter spreads the retries instead of locking several waiters
# into the same rhythm; slot_wait_s in the metrics is how starvation would be
# detected, and the ceiling above is what bounds it.
POLL_JITTER = 0.5
# A waiting marker whose writer died between the liveness check and the unlink
# would otherwise be reported forever. Belt as well as braces alongside the
# pid check.
MARKER_MAX_AGE_S = 3600.0


class WaitCancelled(Exception):
    """HZ-256: check_slot()'s `cancel` event was set while it waited for a
    slot. Raised instead of yielding, so nothing runs."""


@dataclass
class SlotHold:
    """What a check run got, and what it paid for it.

    `mode` says which of the four paths was taken, so a metrics record can
    distinguish "the limiter let me straight through" from "the limiter is
    switched off" from "I gave up waiting" — three very different facts that
    a bare waited_s cannot tell apart.
    """

    mode: str  # held | disabled | nested | fail-open
    slot_index: int | None = None
    waited_s: float = 0.0
    limit: int = 0
    timed_out: bool = False

    @property
    def limited(self) -> bool:
        return self.mode == "held"


def slot_dir() -> Path:
    """Read at call time (config.farm_home(), not config.FARM_HOME) so a test
    can point this at tmp_path with monkeypatch.setenv. FARM_HOME is optional
    and has a default — os.environ["FARM_HOME"] here would crash every check
    on a host or CI runner that never exported it."""
    return config.farm_home() / "locks" / "checks"


def _int_env(name: str, default: int | float, log) -> int | float:
    """Validated at read time: a typo in farm.env must not raise inside every
    check on the host. Falls back to the default and says so."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        log(f"check_slots: {name}={raw!r} is not an integer — using the default of {default}")
        return default


def slot_limit(log=lambda *_: None) -> int:
    """How many check suites may run at once. <= 0 disables the limiter
    entirely — the documented kill switch, restoring pre-HZ-144 behaviour
    without a code revert."""
    return int(_int_env("FARM_MAX_CONCURRENT_CHECKS", DEFAULT_LIMIT, log))


def wait_ceiling_s(log=lambda *_: None) -> float:
    """How long a run may wait for a slot before proceeding without one.
    <= 0 means wait forever, which is a deliberate opt-in and not the
    default: see the module docstring on why waiting unbounded is worse than
    running unthrottled once."""
    return float(_int_env("FARM_CHECK_SLOT_WAIT_MAX_S", DEFAULT_WAIT_CEILING_S, log))


def _waiting_dir() -> Path:
    return slot_dir() / "waiting"


def _marker_path(pid: int, run_id) -> Path:
    token = str(run_id or "unlabelled").replace("/", "-")[:60]
    return _waiting_dir() / f"{pid}-{token}.json"


def _write_marker(run_id, item_id, caller: str) -> Path | None:
    """Observability only — nothing reads this to make a decision. A failure
    to write it must never stop a check from running."""
    path = _marker_path(os.getpid(), run_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "run_id": run_id,
                    "item_id": item_id,
                    "caller": caller,
                    "since": time.time(),
                }
            )
        )
    except OSError:
        return None
    return path


def _clear_marker(path: Path | None) -> None:
    if path is None:
        return
    with contextlib.suppress(OSError):
        path.unlink(missing_ok=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists, owned by someone else. Can't happen for farm sessions (all
        # one OS user) but "alive" is the honest answer.
        return True
    except OSError:
        return False
    return True


def waiting_runs() -> list[dict]:
    """Runs currently queued for a slot, for /farm/status.

    Unlike the slots themselves, marker files get no kernel self-heal: a
    waiter killed mid-wait leaves its file behind. So liveness is re-derived
    from the recorded pid on every read, and a stale marker is pruned rather
    than reported — otherwise status would show a phantom waiter forever.
    """
    out: list[dict] = []
    try:
        entries = sorted(_waiting_dir().glob("*.json"))
    except OSError:
        return out
    now = time.time()
    for path in entries:
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        pid = data.get("pid")
        since = float(data.get("since") or 0)
        stale = not isinstance(pid, int) or not _pid_alive(pid) or (now - since) > MARKER_MAX_AGE_S
        if stale:
            _clear_marker(path)
            continue
        out.append({**data, "waited_s": round(max(0.0, now - since), 1)})
    return out


def busy_slots() -> int:
    """How many slots are held right now, probed by trying each one
    non-blockingly and releasing immediately.

    Racy by nature — this is a status reading, never an admission decision
    (that is check_slot()'s job, where winning the lock and holding it are the
    same operation). flock offers no way to ask "is this locked?" without
    taking the lock, so a status read does momentarily hold a free slot; a run
    acquiring in that microsecond window simply loses one poll interval.
    """
    limit = slot_limit()
    if limit <= 0:
        return 0
    directory = slot_dir()
    busy = 0
    for index in range(limit):
        try:
            handle = open(directory / f"slot-{index}", "a")
        except OSError:
            continue
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            busy += 1
        finally:
            handle.close()
    return busy


def status() -> dict:
    """The additive `checks` block on /farm/status."""
    return {"limit": slot_limit(), "busy": busy_slots(), "waiting": waiting_runs()}


def _try_slots(directory: Path, limit: int):
    """First free slot as (open file handle, index), or (None, None).

    The handle is returned still holding the lock: releasing it to hand the
    index back would be a race, since another process could take the slot in
    between. The caller owns closing it.
    """
    for index in range(limit):
        try:
            handle = open(directory / f"slot-{index}", "a")
        except OSError:
            continue
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            continue
        return handle, index
    return None, None


def _emit(on_event, name: str, **fields) -> None:
    """Tell an observer about the queue (HZ-227). Fire-and-forget: a listener
    that raises must never stop, or fail, the check run it is watching."""
    if on_event is None:
        return
    try:
        on_event({"check_slot": name, **fields})
    except Exception:  # noqa: BLE001 — an observer can never break the limiter
        pass


@contextlib.contextmanager
def check_slot(
    *, log=lambda *_: None, run_id=None, item_id=None, caller="step_agent", poll_s=POLL_S, on_event=None, cancel=None
):
    """Hold one of FARM_MAX_CONCURRENT_CHECKS check slots for the duration.

    Yields a SlotHold. Always yields — the limiter throttles work, it never
    refuses it: every early-return path below hands back a SlotHold whose
    `mode` records why no slot is held.

    on_event (HZ-227) observes the queue: {"check_slot": "queued"} once when
    every slot is busy, then {"check_slot": "granted", "mode": ...} once when
    the wait ends. A run that never waits emits nothing.

    cancel (HZ-256) is a threading.Event. Once it is set, a run still waiting
    for a slot raises WaitCancelled at once instead of waiting on. Only the
    conflict resolver passes one, so a deploy can stop it; None waits exactly
    as before.
    """
    limit = slot_limit(log)
    if limit <= 0:
        yield SlotHold(mode="disabled", limit=limit)
        return
    if os.environ.get(IN_CHECKS_ENV):
        # Already inside an outer run's slot — see the nesting note up top.
        yield SlotHold(mode="nested", limit=limit)
        return

    directory = slot_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # No lock directory means no limiter. Failing the check instead would
        # discard a whole attempt's work over a filesystem problem that has
        # nothing to do with the code under test.
        log(f"check_slots: cannot create {directory} ({exc}) — running checks unthrottled")
        yield SlotHold(mode="fail-open", limit=limit)
        return

    ceiling = wait_ceiling_s(log)
    started = time.monotonic()
    marker: Path | None = None
    # Separate from `marker` because _write_marker() can legitimately return
    # None (a status file is not worth failing over). Keyed on `marker` alone,
    # a read-only lock directory would re-log the same line on every poll.
    announced = False
    handle = index = None
    try:
        while True:
            handle, index = _try_slots(directory, limit)
            if handle is not None:
                break
            waited = time.monotonic() - started
            if 0 < ceiling <= waited:
                log(
                    f"check_slots: WARNING no check slot after {waited:.0f}s "
                    f"(FARM_CHECK_SLOT_WAIT_MAX_S={ceiling:.0f}, limit={limit}) — "
                    "running checks unthrottled rather than discarding this attempt; "
                    "a repeated warning here means the farm is over its check capacity"
                )
                _clear_marker(marker)
                marker = None
                if announced:
                    _emit(on_event, "granted", mode="fail-open")
                yield SlotHold(mode="fail-open", waited_s=waited, limit=limit, timed_out=True)
                return
            if not announced:
                announced = True
                marker = _write_marker(run_id, item_id, caller)
                log(f"check_slots: all {limit} check slots busy — waiting for one")
                _emit(on_event, "queued")
            pause = poll_s * (1 + random.random() * POLL_JITTER)
            if cancel is None:
                time.sleep(pause)
            elif cancel.wait(pause):
                log("check_slots: cancelled while waiting for a check slot")
                raise WaitCancelled("cancelled while waiting for a check slot")

        waited = time.monotonic() - started
        _clear_marker(marker)
        marker = None
        if waited >= 1:
            log(f"check_slots: got check slot {index} after waiting {waited:.0f}s")
        if announced:
            _emit(on_event, "granted", mode="held")
        yield SlotHold(mode="held", slot_index=index, waited_s=waited, limit=limit)
    finally:
        _clear_marker(marker)
        if handle is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()
