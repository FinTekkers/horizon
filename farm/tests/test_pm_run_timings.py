"""Tests for farm/tools/pm_run_timings.py — HZ-115's cost gate.

Every test is hermetic: the log parsing runs on fixture text, and the spawn
benchmark is exercised through injected `runner`/`clock` fakes so the suite
never starts a process or a tmux session. CI has no tmux, and a test that
depended on real process-start timing would be flaky by construction.
"""

import pytest

from farm.tools.pm_run_timings import (
    BENCH_SESSION_PREFIX,
    POLL_GAP_CEILING_S,
    _delta_seconds,
    claim_gaps,
    main,
    parse_runs,
    render_markdown,
    spawn_overhead,
    summarize,
)

# Copied verbatim from ~/.horizon-farm/logs/pm-horizon.log, including the CR
# bytes and the ANSI cursor-show sequence tmux's pipe-pane leaves glued to the
# front of the `reported` line — if clean_log_text() ever stops handling
# those, this fixture catches it rather than a production log doing so.
REAL_LOG = (
    "[21:09:00] run 100: Summarize reviews & recommend for HZ-13\r\n"
    "[21:09:20] ── result: 1 turn(s) in 19s ──\r\n"
    "\x1b[?25h[21:09:20] run 100: reported ok\r\n"
    "[21:09:36] run 101: Define the outcome for HZ-14\r\n"
    "[21:09:47] ── result: 1 turn(s) in 11s ──\r\n"
    "\x1b[?25h[21:09:48] run 101: reported ok\r\n"
    "[21:09:48] run 102: Define how we measure success for HZ-14\r\n"
    "[21:10:02] ── result: 2 turn(s) in 13s ──\r\n"
    "\x1b[?25h[21:10:02] run 102: reported ok\r\n"
    "[21:10:04] run 103: Set guardrails for HZ-14\r\n"
    "[21:10:15] ── result: 1 turn(s) in 10s ──\r\n"
    "\x1b[?25h[21:10:15] run 103: reported ok\r\n"
)


def test_parse_runs_pairs_each_run_with_its_own_result_line():
    runs = parse_runs(REAL_LOG)
    assert [r["run_id"] for r in runs] == ["100", "101", "102", "103"]
    assert [r["seconds"] for r in runs] == [19, 11, 13, 10]
    assert [r["turns"] for r in runs] == [1, 1, 2, 1]
    assert runs[1]["label"] == "Define the outcome"
    assert runs[1]["item"] == "HZ-14"
    # The `reported` trailer must not be mistaken for a run header: it has no
    # " for <ITEM>" suffix, so four headers in means four runs out, not eight.
    assert len(runs) == 4


def test_a_run_that_logged_no_timing_is_counted_as_unmeasured_not_dropped():
    """Only farm/providers/claude.py prints the `result:` line; a Muse-routed
    PM run appears as a bare header. It must still be counted, or a partial
    corpus silently reads as a complete one."""
    log = REAL_LOG + "[21:11:00] run 104: Set guardrails for HZ-15\r\n"
    runs = parse_runs(log)

    assert len(runs) == 5
    assert runs[-1]["seconds"] is None
    assert runs[-1]["turns"] is None

    summary = summarize(runs)
    assert summary["runs_seen"] == 5
    assert summary["runs_timed"] == 4
    assert summary["runs_untimed"] == 1
    assert summary["labels"]["Set guardrails"]["runs_untimed"] == 1
    # The silent run contributes to runs_seen but not to the timing stats.
    assert summary["labels"]["Set guardrails"]["n"] == 1


def test_coverage_and_the_claude_only_caveat_are_reported_not_implied():
    runs = parse_runs(REAL_LOG + "[21:11:00] run 104: Set guardrails for HZ-15\r\n")
    md = render_markdown(summarize(runs), claim_gaps(runs), None, "fixture.log")

    assert "4/5 runs carry a timing line" in md
    assert "1 unmeasured" in md
    assert "muse.py" in md
    assert "unmeasured rather than" in md
    # With no --spawn-bench, the tool must say so rather than imply a number.
    assert "Not measured in this run" in md


def test_summarize_groups_by_label_and_reports_every_step():
    summary = summarize(parse_runs(REAL_LOG))
    assert set(summary["labels"]) == {
        "Summarize reviews & recommend",
        "Define the outcome",
        "Define how we measure success",
        "Set guardrails",
    }
    assert summary["labels"]["Define the outcome"]["median"] == 11
    assert summary["items"] == 2


def test_claim_gaps_separates_the_two_second_poll_from_idle_waiting():
    """The whole point of the split: averaging a 2s poll together with a
    9-minute idle wait would report an overhead that nothing actually pays."""
    runs = parse_runs(REAL_LOG)
    gaps = claim_gaps(runs)

    # 21:09:20 -> 21:09:36 = 16s (idle); :48 -> :48 = 0s; 21:10:02 -> :04 = 2s.
    assert sorted(gaps["poll"]) == [0, 2]
    assert gaps["idle"] == [16]
    assert all(g <= POLL_GAP_CEILING_S for g in gaps["poll"])


def test_claim_gaps_wraps_forward_over_midnight_instead_of_going_negative():
    log = (
        "[23:59:58] run 1: Set guardrails for HZ-1\r\n"
        "[23:59:59] ── result: 1 turn(s) in 1s ──\r\n"
        "[23:59:59] run 1: reported ok\r\n"
        "[00:00:01] run 2: Set guardrails for HZ-2\r\n"
    )
    assert claim_gaps(parse_runs(log))["poll"] == [2]
    assert _delta_seconds("23:59:59", "00:00:01") == 2


class _FakeRunner:
    """Records calls instead of spawning anything."""

    def __init__(self):
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        return None


def test_spawn_overhead_reports_every_sample_and_spawns_nothing_real():
    runner = _FakeRunner()
    ticks = iter(range(100))

    result = spawn_overhead(samples=3, runner=runner, clock=lambda: next(ticks))

    assert result["samples"] == 3
    assert result["import_s"]["n"] == 3
    assert result["tmux_s"]["n"] == 3
    assert result["total_s"]["n"] == 3
    # 3 samples x (1 python + 3 tmux) = 12 calls, and not one real process.
    assert len(runner.calls) == 12
    assert sum(1 for argv, _ in runner.calls if argv[0] == "tmux") == 9


def test_spawn_overhead_times_import_and_tmux_separately():
    """A slow import and a slow tmux are different problems; billing one to
    the other would send the follow-up ticket after the wrong fix."""
    runner = _FakeRunner()
    # Import legs advance the clock by 10, tmux legs by 1.
    deltas = iter([0, 10, 10, 11, 11, 21, 21, 22])
    result = spawn_overhead(samples=2, runner=runner, clock=lambda: next(deltas))

    assert result["import_s"]["median"] == 10
    assert result["tmux_s"]["median"] == 1
    assert result["total_s"]["median"] == 11


def test_the_benchmark_session_is_invisible_to_farmds_slot_accounting():
    """tmux_mgr.list_farm_sessions() counts every session whose name starts
    with "farm-" against MAX_EPHEMERAL. A benchmark session using that prefix
    would eat a real dispatch slot on a live host and could stall actual work
    while this tool runs. It must not."""
    from farm import tmux_mgr

    assert not BENCH_SESSION_PREFIX.startswith("farm-")
    assert not f"{BENCH_SESSION_PREFIX}0".startswith(tmux_mgr.AGENT_SESSION_PREFIXES)

    runner = _FakeRunner()
    spawn_overhead(samples=2, runner=runner, clock=lambda: 0.0)
    session_names = [
        argv[argv.index("-s") + 1]
        for argv, _ in runner.calls
        if argv[0] == "tmux" and argv[1] == "new-session"
    ]
    assert session_names == [f"{BENCH_SESSION_PREFIX}0", f"{BENCH_SESSION_PREFIX}1"]
    assert not any(name.startswith("farm-") for name in session_names)


def test_every_spawned_command_carries_a_timeout():
    """An un-timed subprocess in a measurement tool can hang the farm host
    indefinitely; there is no supervisor around this script."""
    runner = _FakeRunner()
    spawn_overhead(samples=2, runner=runner, clock=lambda: 0.0)
    assert runner.calls
    for argv, kwargs in runner.calls:
        assert kwargs.get("timeout"), f"no timeout on {argv}"


def test_the_bench_session_is_killed_even_when_has_session_raises():
    """The kill sits in a `finally`, so a failing probe cannot leak a tmux
    session onto the host."""
    killed = []

    def flaky(argv, **kwargs):
        argv = list(argv)
        if argv[:2] == ["tmux", "has-session"]:
            raise OSError("tmux went away")
        if argv[:2] == ["tmux", "kill-session"]:
            killed.append(argv[-1])
        return None

    with pytest.raises(OSError):
        spawn_overhead(samples=1, runner=flaky, clock=lambda: 0.0)
    assert killed == [f"={BENCH_SESSION_PREFIX}0"]


def test_a_missing_log_exits_non_zero_without_a_traceback(monkeypatch, capsys, tmp_path):
    missing = tmp_path / "nope.log"
    monkeypatch.setattr("sys.argv", ["pm_run_timings", "--log", str(missing)])
    assert main() == 2
    assert "no such log file" in capsys.readouterr().err


def test_a_log_with_no_pm_runs_exits_non_zero(monkeypatch, capsys, tmp_path):
    empty = tmp_path / "empty.log"
    empty.write_text("nothing resembling a PM run here\n")
    monkeypatch.setattr("sys.argv", ["pm_run_timings", "--log", str(empty)])
    assert main() == 1
    assert "no PM run headers" in capsys.readouterr().err


def test_main_renders_the_real_fixture_without_spawning_anything(monkeypatch, capsys, tmp_path):
    log = tmp_path / "pm.log"
    log.write_text(REAL_LOG)
    monkeypatch.setattr("sys.argv", ["pm_run_timings", "--log", str(log)])
    assert main() == 0
    out = capsys.readouterr().out
    assert "Measured per-step cost" in out
    assert "Define the outcome" in out
    assert "Not measured in this run" in out
