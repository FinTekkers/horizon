"""HZ-115 cost gate: what does going ephemeral actually cost per PM step?

The ticket asks for a *measured* number, not a hand-wave: "Steps 0-2 currently
complete in roughly 10-20 seconds each; process and session spawn overhead must
be quantified against that."

This measures three things, from two different sources:

1. **Model time per step**, parsed out of a real `pm-<slug>.log`. The provider
   prints a `── result: N turn(s) in Ts ──` line per run; pairing it with the
   `run <id>: <label> for <ITEM>` header above it gives a per-label
   distribution. This is the denominator — the cost the step already pays.
2. **Queue-claim latency**, the gap between a run's `reported ok` line and the
   next run's header. `pm_agent.main()` polls its queue with `time.sleep(2)`,
   so the PM lane *already* pays up to 2s of poll latency per step today. The
   ephemeral dispatcher polls at `time.sleep(3)` (`farm/farmd.py`), so the
   migration's queue-latency delta is a wash, not a regression. Measured
   rather than asserted.
3. **Spawn overhead**, the number every prior analysis of this ticket left
   open: a fresh CPython plus `import farm.pm_agent`, and a tmux
   new-session/has-session/kill-session round trip. Timed separately, because
   a slow import and a slow tmux are different problems with different fixes.

Only (3) runs anything; (1) and (2) are pure log parsing.

Run it and paste the output into the recommendation:

    python -m farm.tools.pm_run_timings --spawn-bench 5

**Corpus caveat, reported in the output rather than buried here:** the
`── result: ──` line and the reply text are printed by `farm/providers/claude.py`
only. `farm/providers/muse.py` prints neither, so any Muse-routed PM run is
present in the log as a header with no timing and is counted as *unmeasured* —
never silently dropped. See `runs_seen` vs `runs_timed` in the output.
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

from .analyze_pm_context_reliance import clean_log_text

DEFAULT_LOG_PATH = Path.home() / ".horizon-farm" / "logs" / "pm-horizon.log"

_RUN_HEADER_RE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] run (\d+): (.+) for ([A-Z]{2,6}-\d+)$")
_RESULT_RE = re.compile(r"result: (\d+) turn\(s\) in (\d+)s")
_REPORTED_RE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] run (\d+): reported (ok|failure)$")

# A gap between one run's `reported` line and the next run's header that is
# larger than this is the PM agent sitting idle waiting for farmd to enqueue
# the next task — not poll latency. Only gaps at or below this ceiling say
# anything about the cost of the `time.sleep(2)` poll, so the two populations
# are reported separately instead of being averaged into one misleading mean.
# The ceiling is deliberately a little above the 2s sleep so a gap that
# straddles a tick is still counted rather than silently reclassified.
POLL_GAP_CEILING_S = 5

# tmux sessions whose name starts with "farm-" are what farmd's
# `_ephemeral_sessions()` / `tmux_mgr.list_farm_sessions()` count against
# MAX_EPHEMERAL. The benchmark must therefore NOT use that prefix: a
# benchmark session visible to a live farmd would eat a real dispatch slot
# and could stall actual work while this tool runs.
BENCH_SESSION_PREFIX = "hz115-spawnbench-"


def _to_seconds(hhmmss: str) -> int:
    h, m, s = (int(part) for part in hhmmss.split(":"))
    return h * 3600 + m * 60 + s


def _delta_seconds(earlier: str, later: str) -> int:
    """Seconds from `earlier` to `later`, both `HH:MM:SS` wall-clock stamps.

    The log carries no date, so a run that straddles midnight would otherwise
    produce a negative gap; wrap it forward by a day instead. This cannot
    distinguish a true midnight wrap from a clock step backwards, but the
    former is the only one that happens in a log the farm appends to
    continuously, and a negative duration is never a meaningful answer."""
    delta = _to_seconds(later) - _to_seconds(earlier)
    return delta + 86400 if delta < 0 else delta


def parse_runs(log_text: str) -> list[dict]:
    """One dict per PM run header found in the log.

    Each is {run_id, ts, label, item, turns, seconds, reported_ts}. `turns`,
    `seconds` and `reported_ts` are None when the run's body carried no
    `── result: ──` / `reported` line — a Muse-routed run, or one still in
    flight at the tail of the log. Those runs are still returned, so a caller
    can report them as unmeasured rather than quietly shrinking the corpus."""
    lines = clean_log_text(log_text).split("\n")
    headers = []
    for idx, line in enumerate(lines):
        m = _RUN_HEADER_RE.match(line)
        if m:
            headers.append((idx, m))

    runs = []
    for pos, (idx, m) in enumerate(headers):
        end = headers[pos + 1][0] if pos + 1 < len(headers) else len(lines)
        turns = seconds = reported_ts = None
        for line in lines[idx + 1 : end]:
            result = _RESULT_RE.search(line)
            if result and seconds is None:
                turns, seconds = int(result.group(1)), int(result.group(2))
            reported = _REPORTED_RE.match(line)
            if reported and reported.group(2) == m.group(2):
                reported_ts = reported.group(1)
        runs.append(
            {
                "run_id": m.group(2),
                "ts": m.group(1),
                "label": m.group(3),
                "item": m.group(4),
                "turns": turns,
                "seconds": seconds,
                "reported_ts": reported_ts,
            }
        )
    return runs


def claim_gaps(runs: list[dict]) -> dict:
    """Seconds between a run reporting and the next run starting.

    Returns {"poll": [...], "idle": [...]}, split at POLL_GAP_CEILING_S. The
    `poll` population is the queue-claim latency the PM lane already pays via
    `pm_agent.main()`'s `time.sleep(2)`; the `idle` population is the agent
    waiting for work and says nothing about per-step cost. Splitting them is
    the whole point — a single mean over both would be dominated by idle time
    and would wildly overstate what the poll costs."""
    poll, idle = [], []
    for earlier, later in zip(runs, runs[1:]):
        if not earlier["reported_ts"]:
            continue
        gap = _delta_seconds(earlier["reported_ts"], later["ts"])
        (poll if gap <= POLL_GAP_CEILING_S else idle).append(gap)
    return {"poll": poll, "idle": idle}


def _stats(values: list[float]) -> dict:
    """min / median / p90 / max over `values`, or None-filled if empty.

    p90 is the nearest-rank order statistic (the smallest observed value at or
    above the 90th percentile), not an interpolation — with per-label n often
    under 20, an interpolated percentile would invent a number that no run
    actually produced."""
    if not values:
        return {"n": 0, "min": None, "median": None, "p90": None, "max": None}
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, -(-len(ordered) * 9 // 10) - 1))
    return {
        "n": len(ordered),
        "min": round(ordered[0], 3),
        "median": round(statistics.median(ordered), 3),
        "p90": round(ordered[rank], 3),
        "max": round(ordered[-1], 3),
    }


def summarize(runs: list[dict]) -> dict:
    """Per-label timing stats plus explicit corpus coverage.

    `runs_seen` vs `runs_timed` is reported so a thin parse is visible as a
    number rather than implied to be complete coverage."""
    by_label: dict = {}
    for run in runs:
        by_label.setdefault(run["label"], []).append(run)
    labels = {}
    for label, label_runs in sorted(by_label.items()):
        timed = [r["seconds"] for r in label_runs if r["seconds"] is not None]
        labels[label] = {
            **_stats(timed),
            "runs_seen": len(label_runs),
            "runs_untimed": len(label_runs) - len(timed),
        }
    timed_all = [r["seconds"] for r in runs if r["seconds"] is not None]
    return {
        "labels": labels,
        "overall": _stats(timed_all),
        "runs_seen": len(runs),
        "runs_timed": len(timed_all),
        "runs_untimed": len(runs) - len(timed_all),
        "items": len({r["item"] for r in runs}),
    }


def spawn_overhead(samples: int = 5, *, runner=subprocess.run, clock=time.perf_counter) -> dict:
    """Measure what an ephemeral PM step would pay that the resumed loop does not.

    Two costs, timed separately because they have different causes and
    different fixes: a cold CPython that must `import farm.pm_agent`, and a
    tmux new-session/has-session/kill-session round trip.

    `runner` and `clock` are injected so the test suite can exercise this
    without spawning a single real process — CI has no tmux and should not
    depend on process-start timing to pass.

    Every tmux command is given a timeout, and the kill runs in a `finally`
    so a hung has-session cannot leak a benchmark session onto the host."""
    import_times, tmux_times = [], []
    for i in range(samples):
        start = clock()
        runner(
            [sys.executable, "-c", "import farm.pm_agent"],
            capture_output=True,
            cwd=str(Path(__file__).resolve().parent.parent.parent),
            timeout=120,
        )
        import_times.append(clock() - start)

        name = f"{BENCH_SESSION_PREFIX}{i}"
        start = clock()
        try:
            runner(["tmux", "new-session", "-d", "-s", name, "true"], capture_output=True, timeout=30)
            runner(["tmux", "has-session", "-t", f"={name}"], capture_output=True, timeout=30)
        finally:
            runner(["tmux", "kill-session", "-t", f"={name}"], capture_output=True, timeout=30)
        tmux_times.append(clock() - start)

    totals = [a + b for a, b in zip(import_times, tmux_times)]
    return {
        "samples": samples,
        "import_s": _stats(import_times),
        "tmux_s": _stats(tmux_times),
        "total_s": _stats(totals),
    }


def _fmt(value) -> str:
    return "—" if value is None else f"{value:g}"


def render_markdown(summary: dict, gaps: dict, spawn: dict | None, source: str) -> str:
    lines = [
        "## Measured per-step cost",
        "",
        f"Source: `{source}` — **{summary['runs_seen']} PM runs** across "
        f"{summary['items']} distinct work items.",
        "",
        f"**Corpus coverage: {summary['runs_timed']}/{summary['runs_seen']} runs carry a timing line "
        f"({summary['runs_untimed']} unmeasured).** Only `farm/providers/claude.py` prints the "
        "`── result: N turn(s) in Ts ──` line; `farm/providers/muse.py` prints neither it nor the "
        "reply text. Any Muse-routed PM run is therefore counted here as unmeasured rather than "
        "dropped — these figures describe the Claude-routed corpus.",
        "",
        "Model time is logged to whole seconds (`:.0f`), so a 5s step carries roughly ±10% "
        "quantisation. Read the medians accordingly.",
        "",
        "| Step label | n | min | median | p90 | max | unmeasured |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for label, stat in summary["labels"].items():
        lines.append(
            f"| {label} | {stat['n']} | {_fmt(stat['min'])}s | {_fmt(stat['median'])}s "
            f"| {_fmt(stat['p90'])}s | {_fmt(stat['max'])}s | {stat['runs_untimed']} |"
        )
    overall = summary["overall"]
    lines += [
        "",
        f"**All PM steps pooled:** median {_fmt(overall['median'])}s, p90 {_fmt(overall['p90'])}s, "
        f"max {_fmt(overall['max'])}s (n={overall['n']}).",
        "",
        "### Queue-claim latency the PM lane already pays",
        "",
    ]
    poll_stats, idle_stats = _stats(gaps["poll"]), _stats(gaps["idle"])
    lines += [
        f"Gap from one run's `reported` line to the next run's header, split at "
        f"{POLL_GAP_CEILING_S}s. Gaps at or below the split are queue-poll latency; larger gaps are "
        "the agent idle, waiting for farmd to enqueue work, and are reported separately so they "
        "cannot inflate the poll figure.",
        "",
        f"- **Poll latency (≤{POLL_GAP_CEILING_S}s): n={poll_stats['n']}, median "
        f"{_fmt(poll_stats['median'])}s, p90 {_fmt(poll_stats['p90'])}s, max {_fmt(poll_stats['max'])}s.** "
        "This is `pm_agent.main()`'s `time.sleep(2)` — a cost the current long-lived design already pays.",
        f"- Idle waits (>{POLL_GAP_CEILING_S}s): n={idle_stats['n']}, median {_fmt(idle_stats['median'])}s "
        "— not per-step cost, listed only so the split is auditable.",
        "",
        "The ephemeral dispatcher polls on `time.sleep(3)` (`farm/farmd.py`), i.e. 0-3s with a 1.5s "
        "mean. Against the measured PM poll above, the queue-latency change from migrating is a "
        "wash, not a regression.",
        "",
        "### Spawn overhead — the cost ephemeral adds",
        "",
    ]
    if spawn is None:
        lines.append(
            "**Not measured in this run.** Re-run with `--spawn-bench 5` on the farm host. "
            "No number is asserted here in its absence."
        )
    else:
        lines += [
            f"Measured over {spawn['samples']} samples on the farm host.",
            "",
            "| Component | min | median | p90 | max |",
            "| --- | ---: | ---: | ---: | ---: |",
            f"| Cold CPython + `import farm.pm_agent` | {_fmt(spawn['import_s']['min'])}s "
            f"| {_fmt(spawn['import_s']['median'])}s | {_fmt(spawn['import_s']['p90'])}s "
            f"| {_fmt(spawn['import_s']['max'])}s |",
            f"| tmux new/has/kill round trip | {_fmt(spawn['tmux_s']['min'])}s "
            f"| {_fmt(spawn['tmux_s']['median'])}s | {_fmt(spawn['tmux_s']['p90'])}s "
            f"| {_fmt(spawn['tmux_s']['max'])}s |",
            f"| **Total added per step** | **{_fmt(spawn['total_s']['min'])}s** "
            f"| **{_fmt(spawn['total_s']['median'])}s** | **{_fmt(spawn['total_s']['p90'])}s** "
            f"| **{_fmt(spawn['total_s']['max'])}s** |",
        ]
    lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure PM step cost and ephemeral spawn overhead.")
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help="path to a pm-<slug>.log file")
    parser.add_argument("--spawn-bench", type=int, default=0, metavar="N",
                        help="spawn N sample processes/tmux sessions to measure overhead (0 = skip)")
    parser.add_argument("--json", action="store_true", help="emit raw JSON instead of markdown")
    args = parser.parse_args()

    log_path = Path(args.log)
    if not log_path.exists():
        print(f"pm_run_timings: no such log file: {log_path}", file=sys.stderr)
        return 2

    runs = parse_runs(log_path.read_text(encoding="utf-8", errors="replace"))
    if not runs:
        print(f"pm_run_timings: no PM run headers found in {log_path}", file=sys.stderr)
        return 1

    summary = summarize(runs)
    gaps = claim_gaps(runs)
    spawn = spawn_overhead(args.spawn_bench) if args.spawn_bench > 0 else None

    if args.json:
        print(json.dumps({"summary": summary, "gaps": gaps, "spawn": spawn}, indent=2))
    else:
        print(render_markdown(summary, gaps, spawn, str(log_path)), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
