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

HZ-571 adds a memory gate in front of the slot. On 24 Oct 2026 the host had
about 1.5 GB of 15.6 GB left before the kernel's OOM killer started on the
Fintekkers services, so a run does not *start* while MemAvailable is below
FARM_MIN_MEM_AVAILABLE_PCT of MemTotal. It only delays starts: once a run has
its slot, nothing here looks at memory again, so running work is never
signalled or paused. Unlike the slot wait, the memory wait fails CLOSED at
the ceiling (MemoryWaitExpired) — starting work during a leak is exactly the
harm the gate exists to prevent. A meminfo that cannot be read never holds
anything: it logs a warning and the run starts.

HZ-574 records who holds each slot, for Farm health. The lock itself still
says nothing about its holder, so a run that wins slot N writes a holder
record (locks/checks/holders/slot-N-<pid>-<run>.json) after the flock is
taken and deletes it before the flock is released. The record is display
only — nothing reads it to decide whether a run may start — and it carries
the check's slot label, never its command line, which may hold login values
(HZ-494). Like the waiting markers it gets no kernel self-heal, so a record
whose pid is dead is pruned on every read, and the next taker of the same
slot deletes whatever an earlier holder of that slot left behind. A record
that cannot be written or deleted is logged and never fails the run.
"""

import contextlib
import fcntl
import json
import math
import os
import random
import time
from dataclasses import dataclass, field
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
# HZ-574: a holder record not rewritten for this long is hidden (not deleted:
# its pid is alive and may still hold the lock). The age is measured from the
# last write, and run_checks() rewrites the record at every command boundary
# (SlotHold.set_label), so the longest gap is one command plus its rerun —
# 2 x FARM_CHECK_TIMEOUT_S, 1200s at the default — or one screenshot capture
# (600s). 4 h is far above both; past it a live holder only loses its detail
# on Farm health and reads "in use, no record".
HOLDER_MAX_AGE_S = 4 * 3600.0
HOLDER_LABEL_MAX = 60

# HZ-571: the one memory setting, in /etc/horizon/farm.env. <= 0 turns the
# gate off (the rollback switch, like FARM_MAX_CONCURRENT_CHECKS=0).
MEM_THRESHOLD_ENV = "FARM_MIN_MEM_AVAILABLE_PCT"
DEFAULT_MEM_THRESHOLD_PCT = 15
# TEST-ONLY: points the reader at a fake meminfo file. Never set it in
# farm.env — on the host the gate must read the kernel's own figures.
MEMINFO_PATH_ENV = "FARM_MEMINFO_PATH"
DEFAULT_MEMINFO_PATH = "/proc/meminfo"
_KB_PER_GB = 1024 * 1024


class WaitCancelled(Exception):
    """HZ-256: check_slot()'s `cancel` event was set while it waited for a
    slot. Raised instead of yielding, so nothing runs."""


@dataclass(frozen=True)
class MemReading:
    """Host-wide MemAvailable and MemTotal, in kB, from one meminfo read."""

    available_kb: int
    total_kb: int

    @property
    def pct(self) -> float:
        return 100.0 * self.available_kb / self.total_kb

    def describe(self) -> str:
        """e.g. "9% free, 1.4 GB". The percentage is floored, so a run held
        below a 15% threshold never reads "15% free"."""
        return f"{math.floor(self.pct)}% free, {self.available_kb / _KB_PER_GB:.1f} GB"


class MemoryWaitExpired(Exception):
    """HZ-571: memory stayed below the threshold past the wait ceiling.
    Raised instead of yielding, so nothing runs — the memory wait fails
    closed (see the module docstring)."""

    def __init__(self, reading: MemReading, waited_s: float, threshold_pct: int):
        super().__init__(f"waited {waited_s:.0f}s for memory ({reading.describe()}, needs {threshold_pct}%)")
        self.reading = reading
        self.waited_s = waited_s
        self.threshold_pct = threshold_pct


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
    # HZ-574: this hold's holder record, set on the `held` path only.
    _holder: Path | None = field(default=None, repr=False)
    _record: dict | None = field(default=None, repr=False)
    _log: object = field(default=None, repr=False)
    _written: bool = field(default=False, repr=False)
    _warned: bool = field(default=False, repr=False)

    @property
    def limited(self) -> bool:
        return self.mode == "held"

    def set_label(self, label: str) -> None:
        """Name what this hold is running now, e.g. "test slot, line 2", in
        its holder record. Pass the slot label only, never a command line.
        A no-op without a record; never raises."""
        if self.mode != "held" or self._record is None or self._holder is None:
            return
        if not isinstance(label, str):
            return
        self._record["label"] = label[:HOLDER_LABEL_MAX]
        self._write()

    def _write(self) -> None:
        if _write_holder(self._holder, self._record, self._log if not self._warned else None):
            self._written = True
        else:
            # Logged once per hold: an unwritable holders/ would otherwise
            # log at every command boundary.
            self._warned = True

    def _release(self) -> None:
        """Delete the record. Called before the flock is released."""
        if self._holder is not None and self._written:
            _clear_holder(self._holder, self._log)


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


def mem_threshold_pct(log=lambda *_: None) -> int:
    """HZ-571: the minimum MemAvailable, as a percentage of MemTotal, a run
    needs to start. <= 0 turns the gate off; a value that is not an integer,
    or is over 100 (which would hold every run), logs and uses the default."""
    value = int(_int_env(MEM_THRESHOLD_ENV, DEFAULT_MEM_THRESHOLD_PCT, log))
    if value > 100:
        log(f"check_slots: {MEM_THRESHOLD_ENV}={value} is over 100 — using the default of {DEFAULT_MEM_THRESHOLD_PCT}")
        return DEFAULT_MEM_THRESHOLD_PCT
    return value


def memory_reading() -> MemReading | None:
    """MemAvailable and MemTotal from /proc/meminfo (or FARM_MEMINFO_PATH in
    tests), or None when either is missing or unreadable, or MemTotal is 0.
    The farm's one meminfo reader: check_metrics.mem_available_kb() delegates
    here, so the gate and the metrics record never disagree."""
    path = os.environ.get(MEMINFO_PATH_ENV) or DEFAULT_MEMINFO_PATH
    fields: dict[str, int] = {}
    try:
        with open(path) as fh:
            for line in fh:
                name, _, rest = line.partition(":")
                if name in ("MemAvailable", "MemTotal"):
                    fields[name] = int(rest.split()[0])
    except (OSError, ValueError, IndexError):
        return None
    available, total = fields.get("MemAvailable"), fields.get("MemTotal")
    if available is None or not total or total <= 0:
        return None
    return MemReading(available_kb=available, total_kb=total)


def _waiting_dir() -> Path:
    return slot_dir() / "waiting"


def _marker_path(pid: int, run_id) -> Path:
    token = str(run_id or "unlabelled").replace("/", "-")[:60]
    return _waiting_dir() / f"{pid}-{token}.json"


def _write_marker(run_id, item_id, caller: str, waiting_on: str = "slot") -> Path | None:
    """Display only — nothing reads this to decide whether a run may start.
    /farm/status lists it, and farmd's /runs/status reads `waiting_on` to name
    the wait ("slot" or "memory", HZ-571) as a run's queued reason. A failure
    to write it must never stop a check from running. Rewritten in place when
    the wait moves between memory and a slot."""
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
                    "waiting_on": waiting_on,
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
        # A marker written before HZ-571 has no waiting_on: it waited on a slot.
        out.append({"waiting_on": "slot", **data, "waited_s": round(max(0.0, now - since), 1)})
    return out


def _holders_dir() -> Path:
    return slot_dir() / "holders"


def _holder_path(index: int, pid: int, run_id) -> Path:
    token = str(run_id or "unlabelled").replace("/", "-")[:60]
    return _holders_dir() / f"slot-{index}-{pid}-{token}.json"


def _write_holder(path: Path, record: dict, log) -> bool:
    """Write the record whole: to a temp file, then renamed into place, so a
    reader never sees half of it. False (logged when `log` is given) on any
    failure — a status file is never worth failing a check run over."""
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(record, default=str))
        os.replace(tmp, path)
    except (OSError, TypeError, ValueError) as exc:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        if log is not None:
            log(f"check_slots: could not write holder record ({exc}) — carrying on")
        return False
    return True


def _clear_holder(path: Path | None, log) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        if log is not None:
            log(f"check_slots: could not delete holder record ({exc}) — carrying on")


def _prune_holders(index: int, log) -> None:
    """Called only while this process holds slot `index`'s lock: every record
    for that slot is then an earlier holder's leftover, so none of them can
    belong to a live holder. Records of other slots go only when their pid is
    dead, as in holders()."""
    try:
        entries = list(_holders_dir().glob("slot-*.json"))
    except OSError:
        return
    mine = f"slot-{index}-"
    for path in entries:
        if path.name.startswith(mine):
            _clear_holder(path, log)
            continue
        try:
            pid = json.loads(path.read_text()).get("pid")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(pid, int) and not _pid_alive(pid):
            _clear_holder(path, log)


def holders() -> list[dict]:
    """Who holds each slot, for /farm/status: one row per slot, newest record
    first, sorted by slot.

    Never opens or locks a slot file, so a status read cannot delay a real
    take. Liveness comes from the recorded pid instead, as in waiting_runs():
    a record whose pid is dead is pruned. One not rewritten in
    HOLDER_MAX_AGE_S is hidden but kept, since its pid is alive. `busy` stays
    the kernel's answer (busy_slots()); this is display only.
    """
    try:
        entries = sorted(_holders_dir().glob("slot-*.json"))
    except OSError:
        return []
    now = time.time()
    newest: dict[int, dict] = {}
    for path in entries:
        try:
            data = json.loads(path.read_text())
            touched = path.stat().st_mtime
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        pid = data.get("pid")
        if not isinstance(pid, int) or not _pid_alive(pid):
            _clear_marker(path)
            continue
        index = data.get("slot")
        try:
            since = float(data.get("since") or 0)
        except (TypeError, ValueError):
            continue
        if not isinstance(index, int) or (now - max(since, touched)) > HOLDER_MAX_AGE_S:
            continue
        if index in newest and newest[index]["since"] >= since:
            continue
        newest[index] = {
            "slot": index,
            "run_id": data.get("run_id"),
            "item_id": data.get("item_id"),
            "caller": data.get("caller"),
            "label": data.get("label"),
            "since": since,
            "held_s": round(max(0.0, now - since), 1),
        }
    return [newest[index] for index in sorted(newest)]


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
    return {"limit": slot_limit(), "busy": busy_slots(), "waiting": waiting_runs(), "holders": holders()}


def memory_status() -> dict:
    """The additive `memory` block on /farm/status (HZ-571). Never raises:
    an unreadable meminfo reports readable=False with null figures, and a
    gate that is off reports threshold_pct 0."""
    reading = memory_reading()
    return {
        "available_kb": reading.available_kb if reading else None,
        "total_kb": reading.total_kb if reading else None,
        "available_pct": round(reading.pct, 1) if reading else None,
        "threshold_pct": max(0, mem_threshold_pct()),
        "readable": reading is not None,
        "waiting": sum(1 for w in waiting_runs() if w.get("waiting_on") == "memory"),
    }


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


class _MemoryGate:
    """One check_slot() call's view of the memory gate (HZ-571): whether the
    host is short of memory right now, warning about an unreadable meminfo
    once per call rather than once per poll."""

    def __init__(self, log, on_event):
        self.threshold = mem_threshold_pct(log)
        self._log = log
        self._on_event = on_event
        self._warned = False
        self._shown_pct: int | None = None

    def short(self) -> MemReading | None:
        """The reading when it is below the threshold, else None. An
        unreadable meminfo is None too: a read failure never holds work."""
        if self.threshold <= 0:
            return None
        reading = memory_reading()
        if reading is None:
            if not self._warned:
                self._warned = True
                path = os.environ.get(MEMINFO_PATH_ENV) or DEFAULT_MEMINFO_PATH
                self._log(
                    f"check_slots: WARNING cannot read available memory ({path}) — "
                    "starting without the memory check"
                )
            return None
        if reading.pct >= self.threshold:
            self._shown_pct = None
            return None
        return reading

    def announce(self, reading: MemReading) -> None:
        """Log and emit the figure on entering the wait, and again whenever
        the whole-percent figure changes — not on every poll."""
        shown = math.floor(reading.pct)
        if shown == self._shown_pct:
            return
        self._shown_pct = shown
        self._log(f"check_slots: waiting for memory ({reading.describe()}, needs {self.threshold}%)")
        _emit(
            self._on_event,
            "memory",
            available_pct=round(reading.pct, 1),
            available_kb=reading.available_kb,
            threshold_pct=self.threshold,
        )


@contextlib.contextmanager
def check_slot(
    *, log=lambda *_: None, run_id=None, item_id=None, caller="step_agent", poll_s=POLL_S, on_event=None, cancel=None
):
    """Hold one of FARM_MAX_CONCURRENT_CHECKS check slots for the duration.

    Yields a SlotHold. The limiter throttles work, it never refuses it: every
    early-return path below hands back a SlotHold whose `mode` records why no
    slot is held. The one exception is the memory gate (HZ-571), which raises
    MemoryWaitExpired rather than start work into a memory squeeze.

    Order: a nested run yields at once (the outer run already passed both
    gates). Every other run first waits while MemAvailable is below
    FARM_MIN_MEM_AVAILABLE_PCT — with the limiter switched off too — and only
    then tries for a slot. Memory is re-read before every slot try, so a run
    that waited for a slot cannot start into low memory; if memory drops while
    it waits for a slot, it goes back to waiting on memory. After the grant,
    memory is never looked at again: running work gets no signal.

    One clock: the memory wait and the slot wait share `started` and the one
    FARM_CHECK_SLOT_WAIT_MAX_S ceiling, so a run that waited 1100s for a slot
    has 100s of memory wait left. That is deliberate — the ceiling bounds the
    whole wait to start, which is what the step watchdog cares about. Memory
    is re-read before the ceiling branch, so the slot path's fail-open can
    never fire while memory is low.

    on_event (HZ-227) observes the queue: {"check_slot": "queued"} when every
    slot is busy, {"check_slot": "memory", "available_pct", "available_kb",
    "threshold_pct"} while memory is short (HZ-571), then {"check_slot":
    "granted", "mode": ...} once when the wait ends. A run that never waits
    emits nothing.

    cancel (HZ-256) is a threading.Event. Once it is set, a run still waiting
    raises WaitCancelled at once instead of waiting on. Only the conflict
    resolver passes one, so a deploy can stop it; None waits exactly as
    before.
    """
    limit = slot_limit(log)
    if os.environ.get(IN_CHECKS_ENV):
        # Already inside an outer run's slot — see the nesting note up top.
        # Checked before the kill switch since HZ-571: the memory gate below
        # applies with the limiter off, and a nested run must skip it too.
        yield SlotHold(mode="nested", limit=limit)
        return

    memory = _MemoryGate(log, on_event)
    directory = slot_dir()
    # What a run with enough memory gets when it cannot use the limiter.
    unthrottled = "disabled" if limit <= 0 else None
    if unthrottled is None:
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # No lock directory means no limiter. Failing the check instead
            # would discard a whole attempt's work over a filesystem problem
            # that has nothing to do with the code under test.
            log(f"check_slots: cannot create {directory} ({exc}) — running checks unthrottled")
            unthrottled = "fail-open"

    ceiling = wait_ceiling_s(log)
    started = time.monotonic()
    marker: Path | None = None
    # What this run is waiting on now: None, "memory" or "slot". Separate from
    # `marker` because _write_marker() can legitimately return None (a status
    # file is not worth failing over).
    waiting_on: str | None = None
    announced = False
    handle = index = None
    hold: SlotHold | None = None
    try:
        while True:
            short = memory.short()
            if short is None:
                if unthrottled is not None:
                    waited = time.monotonic() - started
                    _clear_marker(marker)
                    marker = None
                    if announced:
                        _emit(on_event, "granted", mode=unthrottled)
                    yield SlotHold(mode=unthrottled, waited_s=waited if announced else 0.0, limit=limit)
                    return
                handle, index = _try_slots(directory, limit)
                if handle is not None:
                    break
            waited = time.monotonic() - started
            if 0 < ceiling <= waited:
                if short is not None:
                    log(
                        f"check_slots: WARNING still short of memory after {waited:.0f}s "
                        f"({short.describe()}, needs {memory.threshold}%; "
                        f"FARM_CHECK_SLOT_WAIT_MAX_S={ceiling:.0f}) — not starting checks"
                    )
                    raise MemoryWaitExpired(short, waited, memory.threshold)
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
            now_on = "memory" if short is not None else "slot"
            if now_on != waiting_on:
                waiting_on = now_on
                announced = True
                marker = _write_marker(run_id, item_id, caller, waiting_on=now_on) or marker
                if now_on == "slot":
                    log(f"check_slots: all {limit} check slots busy — waiting for one")
                    _emit(on_event, "queued")
            if short is not None:
                memory.announce(short)
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
        # HZ-574: the holder record, written only now that the lock is ours.
        _prune_holders(index, log)
        hold = SlotHold(mode="held", slot_index=index, waited_s=waited, limit=limit)
        hold._holder = _holder_path(index, os.getpid(), run_id)
        hold._record = {
            "slot": index,
            "pid": os.getpid(),
            "run_id": run_id,
            "item_id": item_id,
            "caller": caller,
            "label": "starting",
            "since": time.time(),
        }
        hold._log = log
        hold._write()
        yield hold
    finally:
        _clear_marker(marker)
        try:
            if hold is not None:
                # Before LOCK_UN, so a record never outlives its lock.
                hold._release()
        finally:
            if handle is not None:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                finally:
                    handle.close()
