"""Reconstruct the HZ-144 `cap4-nolimit` baseline from farm session logs.

Success metric 4 asks for before-and-after numbers over at least 20 real runs.
The "after" windows have to be collected forward in calendar time, but the
"before" window does not need to be: the farm has been running at
FARM_MAX_EPHEMERAL=4 with no check limiter for its whole life, and every one
of those runs left a timestamped record of its checks in
$FARM_HOME/logs/farm-run-*.log:

    [17:54:01] checks: running npm install --no-audit --no-fund
    [17:54:02] checks: running npm test --silent
    [17:55:57] checks: running npm run test:e2e --silent
    [17:57:08] checks: running /opt/.../python -m pytest -q
    [17:58:13] publish_screenshots: pushed 21 screenshot(s) ...

Consecutive `checks: running` lines bound each other, and the first line after
the block bounds the last command. So per-command durations, total check
duration and the pass/fail outcome are all recoverable — from real traffic, at
the real cap, with no limiter. That IS the baseline, and waiting days to
re-collect prospectively what is already on disk would be measurement theatre.

Run it, then read the result back through the normal reporter:

    farm/.venv/bin/python -m farm.tools.backfill_check_metrics -o /tmp/base.jsonl
    farm/.venv/bin/python -m farm.tools.report_check_metrics --path /tmp/base.jsonl

**What this cannot recover, stated rather than defaulted.** The logs predate
the instrumentation, so these fields are written as None and the reporter
prints them as "—" rather than a number that was never measured:

  * `mem_available_low_kb` and `load_start`/`load_end` — never logged.
    Memory and load for the "after" windows come from the live records; the
    baseline's comparison is on check DURATION, which is what metric 6 bounds.
  * `slot_wait_s` is 0.0, which is not an approximation: no limiter existed,
    so there was nothing to queue for.

Two further limits worth knowing before quoting a number from this:

  * Timestamps in the logs are HH:MM:SS with no date, so the date comes from
    the file's mtime and a block crossing midnight is corrected by a wrap
    rather than known exactly. One-second resolution also means a sub-second
    command reads as 0s.
  * The outcome classifier runs over the text that follows the failure marker,
    so it sees the same signatures as the live path — including the two real
    ones from 30 Sept 2026 (`assert 6 == 4` leakage, the Playwright
    `globalTimeout` contention), which is a useful check that the classifier
    recognises failures it did not invent.
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .. import check_metrics, config

# `[HH:MM:SS] rest`, after any terminal escape noise the session log picked up
# from the agent's TUI. Anchored on the bracket, not the line start.
LINE_RE = re.compile(r"\[(\d{2}):(\d{2}):(\d{2})\]\s?(.*)")
CHECK_START = "checks: running "
# Only these two mean "the checks themselves failed". A `run N: FAILED` for any
# other reason means the checks passed and the step died later, which is not a
# check outcome and must not be counted as one.
CHECK_FAILURE_RE = re.compile(r"repo checks (?:failed|timed out)")
RUN_ID_RE = re.compile(r"run (\d+):")
ITEM_RE = re.compile(r"farm-run-(.+?)-s\d+-a\d+")

# How much of the text after a failure marker to hand the classifier. Enough
# to reach a Playwright summary or a pytest assertion line, bounded so a log
# full of unrelated later output cannot drag in a false signature.
FAILURE_TAIL_CHARS = 4000

DEFAULT_PHASE = "cap4-nolimit"


def _seconds(h: int, m: int, s: int) -> int:
    return h * 3600 + m * 60 + s


def _delta(start: int, end: int) -> float:
    """Wall seconds between two same-day HH:MM:SS stamps, wrapping midnight.

    The logs carry no date. A negative delta therefore means the block crossed
    midnight, not that time ran backwards — one wrap is the only correction
    that is ever right, since no single check command runs for a day.
    """
    delta = end - start
    return float(delta + 86400 if delta < 0 else delta)


def parse_session_log(text: str, *, source: str = "", day: str = "") -> list[dict]:
    """Every check block in one session log, as check_metrics-shaped records.

    A block is a run of consecutive `checks: running` lines; the first
    timestamped line after it closes the final command.
    """
    # Each event keeps the index of the raw line it came from. The failure
    # output that the classifier needs — a Playwright summary, a pytest
    # assertion — is written by the check subprocess and carries NO timestamp
    # prefix, so a tail built only from timestamped events would silently drop
    # every signature and report real contention as `other`.
    lines = text.splitlines()
    events: list[tuple[int, str, int]] = []
    for position, raw in enumerate(lines):
        match = LINE_RE.search(raw)
        if match:
            h, m, s, rest = match.groups()
            events.append((_seconds(int(h), int(m), int(s)), rest.strip(), position))

    item = ITEM_RE.search(source)
    item_id = item.group(1).upper() if item else None

    records: list[dict] = []
    index = 0
    while index < len(events):
        if not events[index][1].startswith(CHECK_START):
            index += 1
            continue

        starts: list[tuple[int, str]] = []
        while index < len(events) and events[index][1].startswith(CHECK_START):
            at, line, _ = events[index]
            starts.append((at, line[len(CHECK_START) :].strip()))
            index += 1

        # The line that closes the block also says how it went. A block still
        # open at end-of-log (killed mid-check) has no end time and no
        # outcome, so it is dropped rather than guessed at.
        if index >= len(events):
            break
        closed_at, closing, closing_line_no = events[index]

        failed = bool(CHECK_FAILURE_RE.search(closing))
        commands = []
        for position, (at, cmd) in enumerate(starts):
            ends_at = starts[position + 1][0] if position + 1 < len(starts) else closed_at
            commands.append(
                {
                    "cmd": cmd,
                    "duration_s": round(_delta(at, ends_at), 1),
                    # The last command is the failing one when the block
                    # failed; every earlier one demonstrably exited 0, or the
                    # next would not have started.
                    "returncode": 1 if (failed and position == len(starts) - 1) else 0,
                }
            )

        if failed:
            tail = "\n".join(lines[closing_line_no:])[:FAILURE_TAIL_CHARS]
            outcome = "timeout" if "timed out" in closing else check_metrics.classify_failure(tail, 1)
        else:
            outcome = "pass"

        run_id = RUN_ID_RE.search(closing)
        records.append(
            {
                "ts": f"{day}T{starts[0][0] // 3600:02d}:{starts[0][0] % 3600 // 60:02d}:{starts[0][0] % 60:02d}Z",
                "phase": DEFAULT_PHASE,
                "run_id": run_id.group(1) if run_id else None,
                "item_id": item_id,
                "caller": "step_agent",
                # 0 is the honest value: these runs predate the limiter, so
                # there was no cap in force and nothing to wait for.
                "max_concurrent_checks": 0,
                "slot_mode": "disabled",
                "slot_index": None,
                "slot_wait_s": 0.0,
                "slot_wait_timed_out": False,
                # Never sampled at the time. None, not 0 — the reporter prints
                # "—" for these, which is the truthful reading.
                "load_start": None,
                "load_end": None,
                "mem_available_low_kb": None,
                "commands": commands,
                "outcome": outcome,
                "backfilled_from": source or None,
            }
        )
        index += 1

    return records


def backfill(logs_dir: Path, *, phase: str = DEFAULT_PHASE, last: int | None = None) -> list[dict]:
    """Every check block under logs_dir, oldest first.

    `last` keeps only the most recent N. That is not trimming to taste: the
    check gate itself has grown over the farm's life (more suites, more e2e
    specs), so a median drawn from the whole history is a median of a smaller
    gate. Comparing a future cap-6 window against it would read the gate's own
    growth as a contention regression, which is the opposite of what metric 6
    is asking. The recent window is the like-for-like one.
    """
    records: list[dict] = []
    for path in sorted(logs_dir.glob("farm-run-*.log")):
        try:
            text = path.read_text(errors="replace")
            day = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")
        except OSError:
            continue
        for record in parse_session_log(text, source=path.name, day=day):
            record["phase"] = phase
            records.append(record)
    records.sort(key=lambda r: r["ts"])
    return records[-last:] if last and last > 0 else records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--logs-dir", default=None, help="default: $FARM_HOME/logs")
    parser.add_argument("--phase", default=DEFAULT_PHASE, help=f"phase label to write (default: {DEFAULT_PHASE})")
    parser.add_argument(
        "--last",
        type=int,
        default=None,
        help="keep only the most recent N check runs — the like-for-like window, since the gate itself has grown",
    )
    parser.add_argument("-o", "--out", default="-", help="JSONL output path, or - for stdout")
    args = parser.parse_args()

    logs_dir = Path(args.logs_dir) if args.logs_dir else config.farm_home() / "logs"
    records = backfill(logs_dir, phase=args.phase, last=args.last)
    if not records:
        print(f"no check blocks found in {logs_dir}")
        return 1

    body = "".join(json.dumps(r) + "\n" for r in records)
    if args.out == "-":
        print(body, end="")
    else:
        Path(args.out).write_text(body)
        print(f"{len(records)} record(s) from {logs_dir} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
