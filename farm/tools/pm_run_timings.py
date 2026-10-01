"""HZ-115 cost gate: what does going ephemeral cost per PM step?

Measures, from a real `pm-<slug>.log` plus an optional benchmark:

1. Model time per step — the provider's `── result: N turn(s) in Ts ──` line,
   paired with the `run <id>: <label> for <ITEM>` header above it.
2. Queue-claim latency — `reported` line to the next run's header. The PM
   loop's `time.sleep(2)` poll is a cost the current design already pays.
3. Spawn overhead (`--spawn-bench N`) — a cold CPython importing
   farm.pm_agent, and a tmux new/has/kill round trip, timed separately.

Only farm/providers/claude.py prints the `result:` line, so a Muse-routed run
is a bare header: counted as unmeasured, never dropped.

    python -m farm.tools.pm_run_timings --spawn-bench 5
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

from .analyze_pm_context_reliance import _RUN_HEADER_RE, clean_log_text

DEFAULT_LOG_PATH = Path.home() / ".horizon-farm" / "logs" / "pm-horizon.log"
_RESULT_RE = re.compile(r"result: (\d+) turn\(s\) in (\d+)s")
_REPORTED_RE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] run (\d+): reported (ok|failure)$")

# A larger gap is the agent idle, waiting for work — not poll latency. Kept a
# little above the 2s sleep so a gap straddling a tick still counts as poll.
POLL_GAP_CEILING_S = 5

# farmd counts every `farm-` tmux session against MAX_EPHEMERAL; a benchmark
# session with that prefix would eat a real dispatch slot on a live host.
BENCH_SESSION_PREFIX = "hz115-spawnbench-"


def _to_seconds(hhmmss: str) -> int:
    h, m, s = (int(part) for part in hhmmss.split(":"))
    return h * 3600 + m * 60 + s


def _delta_seconds(earlier: str, later: str) -> int:
    """Seconds between two `HH:MM:SS` stamps; the log has no date, so a
    negative delta is a midnight wrap."""
    delta = _to_seconds(later) - _to_seconds(earlier)
    return delta + 86400 if delta < 0 else delta


def parse_runs(log_text: str) -> list[dict]:
    """{run_id, ts, label, item, turns, seconds, reported_ts} per run header;
    the last three are None when the run logged no timing."""
    lines = clean_log_text(log_text).split("\n")
    headers = [(i, m) for i, line in enumerate(lines) if (m := _RUN_HEADER_RE.match(line))]
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
        runs.append({"run_id": m.group(2), "ts": m.group(1), "label": m.group(3), "item": m.group(4),
                     "turns": turns, "seconds": seconds, "reported_ts": reported_ts})
    return runs


def claim_gaps(runs: list[dict]) -> dict:
    """{"poll": [...], "idle": [...]}, split at POLL_GAP_CEILING_S so idle time
    cannot inflate the poll figure."""
    poll, idle = [], []
    for earlier, later in zip(runs, runs[1:]):
        if earlier["reported_ts"]:
            gap = _delta_seconds(earlier["reported_ts"], later["ts"])
            (poll if gap <= POLL_GAP_CEILING_S else idle).append(gap)
    return {"poll": poll, "idle": idle}


def _stats(values: list[float]) -> dict:
    """n/min/median/p90/max; p90 is nearest-rank, so it is a value a run produced."""
    if not values:
        return {"n": 0, "min": None, "median": None, "p90": None, "max": None}
    ordered = sorted(values)
    rank = max(0, -(-len(ordered) * 9 // 10) - 1)
    return {"n": len(ordered), "min": round(ordered[0], 3), "median": round(statistics.median(ordered), 3),
            "p90": round(ordered[rank], 3), "max": round(ordered[-1], 3)}


def summarize(runs: list[dict]) -> dict:
    by_label: dict = {}
    for run in runs:
        by_label.setdefault(run["label"], []).append(run)
    labels = {}
    for label, label_runs in sorted(by_label.items()):
        timed = [r["seconds"] for r in label_runs if r["seconds"] is not None]
        labels[label] = {**_stats(timed), "runs_seen": len(label_runs),
                         "runs_untimed": len(label_runs) - len(timed)}
    timed_all = [r["seconds"] for r in runs if r["seconds"] is not None]
    return {"labels": labels, "overall": _stats(timed_all), "runs_seen": len(runs),
            "runs_timed": len(timed_all), "runs_untimed": len(runs) - len(timed_all),
            "items": len({r["item"] for r in runs})}


def spawn_overhead(samples: int = 5, *, runner=subprocess.run, clock=time.perf_counter) -> dict:
    """Time a cold `import farm.pm_agent` and a tmux round trip, separately.
    `runner`/`clock` are injected so tests spawn nothing. Every call has a
    timeout, and the kill runs in `finally` so no bench session leaks."""
    import_times, tmux_times = [], []
    for i in range(samples):
        start = clock()
        runner([sys.executable, "-c", "import farm.pm_agent"], capture_output=True,
               cwd=str(Path(__file__).resolve().parent.parent.parent), timeout=120)
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
    return {"samples": samples, "import_s": _stats(import_times), "tmux_s": _stats(tmux_times),
            "total_s": _stats(totals)}


def _fmt(value) -> str:
    return "—" if value is None else f"{value:g}s"


def _row(name: str, s: dict) -> str:
    return f"| {name} | {_fmt(s['min'])} | {_fmt(s['median'])} | {_fmt(s['p90'])} | {_fmt(s['max'])} |"


def render_markdown(summary: dict, gaps: dict, spawn: dict | None, source: str) -> str:
    overall, poll, idle = summary["overall"], _stats(gaps["poll"]), _stats(gaps["idle"])
    lines = [
        "## Measured per-step cost", "",
        f"Source: `{source}` — **{summary['runs_seen']} PM runs** across {summary['items']} work items.", "",
        f"**Corpus coverage: {summary['runs_timed']}/{summary['runs_seen']} runs carry a timing line "
        f"({summary['runs_untimed']} unmeasured).** Only `farm/providers/claude.py` prints it; "
        "`farm/providers/muse.py` does not, so a Muse-routed run is counted as unmeasured rather than "
        "dropped. Times are whole seconds (`:.0f`): ±10% on a 5s step.", "",
        "| Step label | n | min | median | p90 | max | unmeasured |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for label, s in summary["labels"].items():
        lines.append(f"| {label} | {s['n']} | {_fmt(s['min'])} | {_fmt(s['median'])} | {_fmt(s['p90'])} "
                     f"| {_fmt(s['max'])} | {s['runs_untimed']} |")
    lines += [
        "", f"**All PM steps pooled:** median {_fmt(overall['median'])}, p90 {_fmt(overall['p90'])}, "
        f"max {_fmt(overall['max'])} (n={overall['n']}).", "",
        "### Queue-claim latency the PM lane already pays", "",
        f"- **Poll latency (≤{POLL_GAP_CEILING_S}s): n={poll['n']}, median {_fmt(poll['median'])}, "
        f"p90 {_fmt(poll['p90'])}, max {_fmt(poll['max'])}** — `pm_agent.main()`'s `time.sleep(2)`.",
        f"- Idle waits (>{POLL_GAP_CEILING_S}s): n={idle['n']}, median {_fmt(idle['median'])} — not "
        "per-step cost, listed so the split is auditable.",
        "", "The ephemeral dispatcher polls on `time.sleep(3)` (`farm/farmd.py`): 0-3s, mean 1.5s.", "",
        "### Spawn overhead — the cost ephemeral adds", "",
    ]
    if spawn is None:
        lines.append("**Not measured in this run.** Re-run with `--spawn-bench 5` on the farm host.")
    else:
        lines += [f"Measured over {spawn['samples']} samples.", "",
                  "| Component | min | median | p90 | max |", "| --- | ---: | ---: | ---: | ---: |",
                  _row("Cold CPython + `import farm.pm_agent`", spawn["import_s"]),
                  _row("tmux new/has/kill round trip", spawn["tmux_s"]),
                  _row("**Total added per step**", spawn["total_s"])]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure PM step cost and ephemeral spawn overhead.")
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help="path to a pm-<slug>.log file")
    parser.add_argument("--spawn-bench", type=int, default=0, metavar="N",
                        help="spawn N sample processes/tmux sessions (0 = skip)")
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
    summary, gaps = summarize(runs), claim_gaps(runs)
    spawn = spawn_overhead(args.spawn_bench) if args.spawn_bench > 0 else None
    if args.json:
        print(json.dumps({"summary": summary, "gaps": gaps, "spawn": spawn}, indent=2))
    else:
        print(render_markdown(summary, gaps, spawn, str(log_path)), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
