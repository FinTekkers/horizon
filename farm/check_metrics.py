"""HZ-144: one JSONL record per check run, so the cap raise can be measured
instead of assumed.

The item's success metric asks for peak memory, load average, median and p95
check duration, check timeouts and queue wait, over at least 20 real runs,
before and after. Nothing in the farm recorded any of that, so this writes it
at the only place that knows all of it: farm/checks.py, around the check
commands themselves.

Read it back with `python -m farm.tools.report_check_metrics`.

Two measurement choices worth stating plainly, because the obvious versions
of both are wrong:

**Memory is sampled host-wide, not per-process.** The natural reach is
`resource.getrusage(RUSAGE_CHILDREN).ru_maxrss`, but that is a high-water mark
across every child reaped since process start (so in step_agent the model CLI
usually dominates the check commands), it never decreases, and it is per
process — while the OOM risk this item is about is host-wide across six
agents. So the record carries the *minimum* `MemAvailable` from /proc/meminfo
seen across the check window. Sampled at command boundaries, not continuously:
a trough entirely inside one command is missed. That is a known floor on the
resolution, not a claim of exactness.

**The outcome classifier is heuristic.** It reads the failing command's output
tail and its exit status, so it can only recognise failure shapes that have
already been seen on this host. It exists to separate "the checks found a real
bug" from "the farm's own configuration broke the checks" — the two failure
modes observed on 30 Sept 2026 — and an unrecognised failure is reported as
`other`, never guessed into a friendlier class.
"""

import json
import os
import re
import time
from pathlib import Path

from . import check_slots, config

# Which measurement phase a record belongs to. Set on the host for the
# duration of a measurement window; unset is honest rather than defaulted to
# a phase name that would silently mix windows together.
PHASE_ENV = "FARM_CHECK_METRICS_PHASE"

# Every known-contention signature seen on this host, as literals from the
# real failures rather than invented patterns:
#   - e2e/playwright.config.js's own globalTimeout firing (the 30 Sept
#     failure at load ~8). Deliberately matched, never raised: it is the
#     contention detector this item relies on (HZ-144 guardrail 3).
#   - a port collision between concurrent runs. PORT_OFFSET in
#     e2e/playwright.config.js is a hash of the worktree path modulo 1000, so
#     more concurrent runs means more collisions, and each webServer command
#     starts with `fuser -k` on its port — the loser gets its server killed
#     mid-suite. Low probability, and caused by concurrency, so it belongs
#     here and never in `other`.
CONTENTION_PATTERNS = (
    re.compile(r"Timed out waiting \d+s for the test suite to run"),
    re.compile(r"is already used"),
    re.compile(r"EADDRINUSE"),
)

# The farm's own capacity settings reaching the checked repo's tests — the
# 30 Sept failure mode that farm/config.py's CHECK_SUBPROCESS_SCRUB closes.
# If this class ever appears again, a seam has regressed.
LEAKAGE_PATTERNS = (
    re.compile(r"MAX_EPHEMERAL\s*=="),
    re.compile(r"MAX_CONCURRENT_CHECKS\s*=="),
)

OUTCOMES = ("pass", "timeout", "oom", "contention", "leakage", "other")


def metrics_path() -> Path:
    """Read at call time, like check_slots.slot_dir() and for the same
    reason — tests must be able to redirect FARM_HOME per test."""
    return config.farm_home() / "logs" / "check-metrics.jsonl"


def mem_available_kb() -> int | None:
    """Host-wide MemAvailable from /proc/meminfo, or None off Linux."""
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def load_average() -> float | None:
    try:
        return round(os.getloadavg()[0], 2)
    except OSError:
        return None


def classify_failure(tail: str, returncode: int | None) -> str:
    """Why a non-zero check failed, best-effort. See the docstring on why this
    is heuristic. Order matters: leakage and contention are recognised by
    signature, and only an unrecognised failure falls through to `other`."""
    text = tail or ""
    if returncode is not None and returncode < 0:
        # Killed by a signal. On this host, under the load this item is
        # raising, SIGKILL on a test process is overwhelmingly the kernel OOM
        # killer — confirm a specific record with `journalctl -k | grep -i
        # "out of memory"`, since a human `kill -9` looks identical from here.
        return "oom"
    if any(p.search(text) for p in LEAKAGE_PATTERNS):
        return "leakage"
    if any(p.search(text) for p in CONTENTION_PATTERNS):
        return "contention"
    return "other"


def new_record(*, run_id=None, item_id=None, caller: str = "step_agent", slot: check_slots.SlotHold) -> dict:
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": os.environ.get(PHASE_ENV) or "unlabelled",
        "run_id": run_id,
        "item_id": item_id,
        # step_agent's implement-step checks and conflict_resolver's
        # post-merge checks both take a slot, so the real concurrent-check
        # population is agents PLUS farmd. Labelled so the two are separable
        # in the report: only step_agent rows are "runs" for the 20-run count.
        "caller": caller,
        # No max_ephemeral field on purpose. A step agent cannot see the
        # farm's agent cap — farm/config.py's AGENT_NEVER_NEEDS strips it at
        # the tmux seam, which is the whole point of the leak fix — so
        # recording os.environ.get("FARM_MAX_EPHEMERAL") here would silently
        # write "4" during a cap-6 window. `phase` is the honest carrier for
        # which capacity a record was taken under, and is what the reporter
        # groups by.
        "max_concurrent_checks": slot.limit,
        "slot_mode": slot.mode,
        "slot_index": slot.slot_index,
        "slot_wait_s": round(slot.waited_s, 1),
        "slot_wait_timed_out": slot.timed_out,
        "load_start": load_average(),
        "commands": [],
        "outcome": "other",
    }


def append_record(record: dict, log=lambda *_: None) -> bool:
    """Append one record as one line. Returns whether it was written.

    Skipped entirely inside a check subprocess (FARM_IN_CHECKS). Horizon's own
    suite calls run_checks(), so without this guard every farm check run would
    append a handful of synthetic test records to the live metrics file and the
    "20 real runs" the success metric asks for would be diluted by them.

    A metrics write must never fail a check that passed: the file is
    instrumentation, not a deliverable. Hence one write of one already-built
    line (concurrent appends to O_APPEND stay whole at this size) and a narrow
    except that reports rather than swallows.
    """
    if os.environ.get(check_slots.IN_CHECKS_ENV):
        return False
    path = metrics_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as fh:
            fh.write(json.dumps(record) + "\n")
    except (OSError, TypeError, ValueError) as exc:
        log(f"check_metrics: could not record this check run to {path} ({exc}) — the checks themselves are unaffected")
        return False
    return True


def read_records(path: Path) -> tuple[list[dict], int]:
    """(records, lines skipped as malformed). A truncated final line from a
    killed writer must not take the whole report down with it."""
    records: list[dict] = []
    skipped = 0
    try:
        text = path.read_text()
    except OSError:
        return records, skipped
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            skipped += 1
            continue
        if isinstance(parsed, dict):
            records.append(parsed)
        else:
            skipped += 1
    return records, skipped
