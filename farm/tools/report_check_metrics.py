"""Read back what farm/check_metrics.py recorded (HZ-144 success metric 4).

Point-in-time report, modelled on farm/tools/measure_text_caps.py — nothing
here runs on a schedule and nothing is aggregated continuously. It reads
$FARM_HOME/logs/check-metrics.jsonl and prints, per measurement phase: run
count, median and p95 check duration, host-wide free-memory low-water mark,
load average, queue wait, and a tally per outcome.

Usage (from the repo root):

    farm/.venv/bin/python -m farm.tools.report_check_metrics
    farm/.venv/bin/python -m farm.tools.report_check_metrics --markdown

The three phases the item's baseline needs, in order:

    cap4-nolimit   FARM_MAX_EPHEMERAL=4  FARM_MAX_CONCURRENT_CHECKS=0
    cap4-limit2    FARM_MAX_EPHEMERAL=4  FARM_MAX_CONCURRENT_CHECKS=2
    cap6-limit2    FARM_MAX_EPHEMERAL=6  FARM_MAX_CONCURRENT_CHECKS=2

The first phase matters: with the limiter already on, the "before" number
would not be today's behaviour, and a regression could not be attributed to
the cap rather than the limiter. Set FARM_CHECK_METRICS_PHASE in
/etc/horizon/farm.env alongside the other two and restart farmd — see
docs/hz-144-check-concurrency-measurement.md.

A phase with fewer than MIN_RUNS agent runs is flagged, not quietly reported:
a median over three runs must not read like a result.
"""

import argparse
from pathlib import Path

from .. import check_metrics

# The item's success metric says "each over at least 20 real runs".
MIN_RUNS = 20

# Every phase label the measurement protocol uses, in the order they are
# collected, so the report shows a phase that was never collected as absent
# rather than omitting the row entirely.
EXPECTED_PHASES = ("cap4-nolimit", "cap4-limit2", "cap6-limit2")


def _percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile. No numpy in farm/requirements.txt, and for
    ~20 samples the interpolation choice is noise next to the sample size."""
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def check_duration_s(record: dict) -> float:
    """Wall-clock spent *running* the checks: the sum of the commands, which
    deliberately excludes slot_wait_s. Mixing the two would hide exactly the
    regression this measurement is looking for (and would make the limiter
    look like it slowed the checks down when it only queued them)."""
    return sum(float(c.get("duration_s") or 0) for c in record.get("commands") or [])


def summarise(records: list[dict]) -> dict:
    agent_runs = [r for r in records if r.get("caller") != "conflict_resolver"]
    durations = [check_duration_s(r) for r in agent_runs if r.get("commands")]
    waits = [float(r.get("slot_wait_s") or 0) for r in agent_runs]
    mem = [r["mem_available_low_kb"] for r in agent_runs if r.get("mem_available_low_kb") is not None]
    loads = [r["load_end"] for r in agent_runs if r.get("load_end") is not None]
    outcomes = {name: 0 for name in check_metrics.OUTCOMES}
    for record in records:
        outcomes[record.get("outcome", "other")] = outcomes.get(record.get("outcome", "other"), 0) + 1
    return {
        "runs": len(agent_runs),
        "resolver_runs": len(records) - len(agent_runs),
        "enough_runs": len(agent_runs) >= MIN_RUNS,
        "median_check_s": _percentile(durations, 0.5),
        "p95_check_s": _percentile(durations, 0.95),
        "median_wait_s": _percentile(waits, 0.5),
        "p95_wait_s": _percentile(waits, 0.95),
        "mem_available_low_kb": min(mem) if mem else None,
        "peak_load": max(loads) if loads else None,
        "median_load": _percentile(loads, 0.5),
        "timeouts": outcomes.get("timeout", 0),
        "oom_kills": outcomes.get("oom", 0),
        # What the human-feedback metric asks for: failures caused by the
        # farm's own configuration or by contention, as opposed to a real
        # test failure. An OOM kill counts here — under this load it IS a
        # contention outcome, whatever else could produce a SIGKILL.
        "config_or_contention_failures": outcomes.get("contention", 0)
        + outcomes.get("leakage", 0)
        + outcomes.get("oom", 0),
        "outcomes": outcomes,
    }


def by_phase(records: list[dict]) -> dict[str, dict]:
    phases: dict[str, list[dict]] = {}
    for record in records:
        phases.setdefault(record.get("phase") or "unlabelled", []).append(record)
    ordered = [p for p in EXPECTED_PHASES if p in phases]
    ordered += sorted(p for p in phases if p not in EXPECTED_PHASES)
    return {name: summarise(phases[name]) for name in ordered}


def _fmt(value, unit: str = "") -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.1f}{unit}"
    return f"{value}{unit}"


def _fmt_mb(kb) -> str:
    return "—" if kb is None else f"{round(kb / 1024)} MB"


# Success metric 6: "Median check duration is no more than 50% slower than
# the recorded baseline."
MAX_SLOWDOWN = 1.5
BASELINE_PHASE = "cap4-nolimit"
TARGET_PHASE = "cap6-limit2"


def _verdict_lines(report: dict[str, dict]) -> list[str]:
    """Metric 6, computed rather than eyeballed off two numbers in a table.

    Silent unless both windows exist — an incomplete measurement must not
    produce a verdict, in either direction.
    """
    baseline, target = report.get(BASELINE_PHASE), report.get(TARGET_PHASE)
    if not baseline or not target or not baseline["median_check_s"] or not target["median_check_s"]:
        return []
    ratio = target["median_check_s"] / baseline["median_check_s"]
    verdict = "within" if ratio <= MAX_SLOWDOWN else "OVER"
    lines = [
        "",
        f"metric 6: median check duration {TARGET_PHASE} / {BASELINE_PHASE} = {ratio:.2f}x "
        f"— {verdict} the {MAX_SLOWDOWN:.2g}x bound",
    ]
    if not (baseline["enough_runs"] and target["enough_runs"]):
        lines.append("  ⚠ one or both windows are under the 20-run minimum, so this ratio is not yet a result")
    if ratio > MAX_SLOWDOWN:
        lines.append(
            "  the item's own instruction for this case: stop at the highest cap that stays inside the bound, "
            "record these numbers, and recommend a larger instance with them — do not provision one"
        )
    return lines


def render(report: dict[str, dict], skipped: int, source: Path, markdown: bool) -> str:
    rows = [
        ("Phase", "Agent runs", "Median check", "p95 check", "Median wait", "p95 wait", "Timeouts", "OOM", "Min MemAvail", "Peak load"),
    ]
    for phase, s in report.items():
        flag = "" if s["enough_runs"] else f" ⚠ <{MIN_RUNS}"
        rows.append(
            (
                phase,
                f"{s['runs']}{flag}",
                _fmt(s["median_check_s"], "s"),
                _fmt(s["p95_check_s"], "s"),
                _fmt(s["median_wait_s"], "s"),
                _fmt(s["p95_wait_s"], "s"),
                str(s["timeouts"]),
                str(s["oom_kills"]),
                _fmt_mb(s["mem_available_low_kb"]),
                _fmt(s["peak_load"]),
            )
        )

    lines: list[str] = []
    if markdown:
        lines.append("| " + " | ".join(rows[0]) + " |")
        lines.append("| " + " | ".join("---" for _ in rows[0]) + " |")
        lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    else:
        widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
        for row in rows:
            lines.append("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)))
    lines.append("")
    for phase, s in report.items():
        # The outcome tally covers EVERY check run in the phase, including the
        # conflict resolver's: a contention failure there is still a
        # contention failure. Only the duration/wait/memory columns above are
        # restricted to agent runs, because those are what metric 4 counts.
        lines.append(
            f"{phase}: outcomes over all {s['runs'] + s['resolver_runs']} check run(s) "
            f"{dict(sorted(s['outcomes'].items()))}; "
            f"{s['config_or_contention_failures']} failure(s) attributable to configuration leakage, "
            f"contention or OOM; {s['resolver_runs']} conflict-resolver run(s) excluded from the table above"
        )
        if not s["enough_runs"]:
            lines.append(
                f"  ⚠ {phase} has {s['runs']} agent run(s), fewer than the {MIN_RUNS} the success metric "
                "requires — these numbers are indicative, not a result"
            )
    lines += _verdict_lines(report)
    if skipped:
        lines.append(f"{skipped} malformed line(s) in {source} skipped")
    missing = [p for p in EXPECTED_PHASES if p not in report]
    if missing:
        lines.append(f"not yet collected: {', '.join(missing)}")
    lines.append(f"source: {source}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Report on recorded farm check runs (HZ-144).")
    parser.add_argument("--path", default=None, help="check-metrics.jsonl (default: $FARM_HOME/logs/)")
    parser.add_argument("--markdown", action="store_true", help="emit the table as markdown for the PR/doc")
    args = parser.parse_args()

    source = Path(args.path) if args.path else check_metrics.metrics_path()
    records, skipped = check_metrics.read_records(source)
    if not records:
        print(f"no check runs recorded in {source} yet")
        return 1
    print(render(by_phase(records), skipped, source, args.markdown), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
