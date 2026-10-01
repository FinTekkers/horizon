"""HZ-144: reconstructing the cap4-nolimit baseline from farm session logs.

The "before" half of success metric 4 is already on disk — the farm has run at
FARM_MAX_EPHEMERAL=4 with no check limiter for its whole life, and every run
timestamped its check commands. These tests pin the parser against the real
shapes those logs take, including the two failures from 30 Sept 2026, because
a baseline that silently mis-parses is worse than no baseline: it produces a
number nobody can tell is wrong.
"""

import textwrap

import pytest

from farm.tools import backfill_check_metrics as backfill


def _log(body: str) -> str:
    return textwrap.dedent(body).strip() + "\n"


PASSING_BLOCK = _log(
    """
    [17:53:40] run 1058: starting
    [17:54:01] checks: running npm install --no-audit --no-fund
    [17:54:02] checks: running npm test --silent
    [17:55:57] checks: running npm run test:e2e --silent
    [17:57:08] checks: running /opt/horizon/farm/.venv/bin/python -m pytest -q
    [17:58:13] publish_screenshots: pushed 21 screenshot(s) to e2e-artifacts/hz-130
    [17:58:19] run 1058: reported ok
    """
)


def test_a_passing_block_yields_one_record_with_per_command_durations():
    (record,) = backfill.parse_session_log(PASSING_BLOCK, source="farm-run-hz-130-s11-a1.log", day="2026-09-29")

    assert record["outcome"] == "pass"
    assert record["item_id"] == "HZ-130"
    assert [c["cmd"] for c in record["commands"]] == [
        "npm install --no-audit --no-fund",
        "npm test --silent",
        "npm run test:e2e --silent",
        "/opt/horizon/farm/.venv/bin/python -m pytest -q",
    ]
    # Each command is bounded by the next; the last by the line that closed
    # the block. 1s + 115s + 71s + 65s.
    assert [c["duration_s"] for c in record["commands"]] == [1.0, 115.0, 71.0, 65.0]
    assert all(c["returncode"] == 0 for c in record["commands"])


def test_the_baseline_record_says_there_was_no_limiter_rather_than_implying_one():
    """These runs predate the limiter. 0/disabled is the fact; a slot_wait of
    0.0 is not an approximation because there was nothing to queue for."""
    (record,) = backfill.parse_session_log(PASSING_BLOCK, day="2026-09-29")
    assert record["max_concurrent_checks"] == 0
    assert record["slot_mode"] == "disabled"
    assert record["slot_wait_s"] == 0.0
    assert record["slot_wait_timed_out"] is False


def test_memory_and_load_are_none_not_zero():
    """They were never sampled. Zero would read as "the host had no free
    memory", which is a measurement claim this cannot make — the reporter
    prints None as an em dash instead."""
    (record,) = backfill.parse_session_log(PASSING_BLOCK, day="2026-09-29")
    assert record["mem_available_low_kb"] is None
    assert record["load_start"] is None and record["load_end"] is None


def test_the_playwright_global_timeout_failure_is_classified_as_contention():
    """The literal 30 Sept 2026 failure at load ~8, verbatim from the log —
    and note the signature lines carry NO timestamp prefix, because the check
    subprocess writes them. A tail built only from timestamped lines would
    drop every signature and report this as `other`."""
    text = _log(
        """
        [14:48:58] checks: running npm install --no-audit --no-fund
        [14:48:59] checks: running npm test --silent
        [14:51:17] checks: running npm run test:e2e --silent
        [14:53:12] run 944: FAILED — repo checks failed (npm run test:e2e --silent): blank banner (2.2s)
          ✓  28 [chromium] › tests/13-pause-reason.spec.js:89:1 › a paused run (1.6s)
        Timed out waiting 85s for the test suite to run
        """
    )
    (record,) = backfill.parse_session_log(text, source="farm-run-hz-139-s11-a1.log", day="2026-09-30")
    assert record["outcome"] == "contention"
    assert record["run_id"] == "944"
    assert record["commands"][-1]["returncode"] == 1
    # Everything before the failing command demonstrably exited 0, or the next
    # would never have started.
    assert [c["returncode"] for c in record["commands"][:-1]] == [0, 0]


def test_a_port_collision_between_concurrent_runs_is_classified_as_contention():
    """Five of these are in the real history at cap 4. PORT_OFFSET is a hash
    of the worktree path mod 1000, so concurrency causes them — which is why
    they must never land in `other`."""
    text = _log(
        """
        [19:33:10] checks: running npm run test:e2e --silent
        [19:34:00] run 482: FAILED — repo checks failed (npm run test:e2e --silent):
        Error: http://localhost:3057 is already used, make sure that nothing is running on the port/url
        """
    )
    (record,) = backfill.parse_session_log(text, day="2026-09-23")
    assert record["outcome"] == "contention"


def test_the_capacity_leak_failure_is_classified_as_leakage():
    """The other 30 Sept failure: FARM_MAX_EPHEMERAL=6 reached the inner
    pytest. If this class shows up after the scrub, a seam has regressed."""
    text = _log(
        """
        [14:52:41] checks: running /opt/horizon/farm/.venv/bin/python -m pytest -q
        [14:56:49] run 964: FAILED — repo checks failed (python -m pytest -q): still env-overridable.
        >       assert farmd.MAX_EPHEMERAL == 4
        E       assert 6 == 4
        """
    )
    (record,) = backfill.parse_session_log(text, day="2026-09-30")
    assert record["outcome"] == "leakage"


def test_a_check_timeout_is_classified_as_a_timeout():
    text = _log(
        """
        [21:39:11] checks: running npm test --silent
        [21:49:11] run 729: FAILED — repo checks timed out after 600s: npm test --silent
        """
    )
    (record,) = backfill.parse_session_log(text, day="2026-09-25")
    assert record["outcome"] == "timeout"
    assert record["commands"][0]["duration_s"] == 600.0


def test_a_step_that_failed_after_its_checks_passed_is_not_a_check_failure():
    """`run N: FAILED` is not the same fact as "the checks failed". Counting
    a push failure as a check failure would inflate exactly the tally the
    added metric is read off."""
    text = _log(
        """
        [10:00:00] checks: running npm test --silent
        [10:02:00] run 900: FAILED — could not push: non-fast-forward
        """
    )
    (record,) = backfill.parse_session_log(text, day="2026-09-25")
    assert record["outcome"] == "pass"
    assert record["commands"][0]["returncode"] == 0


def test_a_block_crossing_midnight_wraps_instead_of_going_negative():
    """The logs carry no date, so 23:59 -> 00:01 subtracts to -86280. One wrap
    is the only correction that is ever right: no check command runs a day."""
    text = _log(
        """
        [23:59:30] checks: running npm test --silent
        [00:01:30] run 7: reported ok
        """
    )
    (record,) = backfill.parse_session_log(text, day="2026-09-25")
    assert record["commands"][0]["duration_s"] == 120.0


def test_a_block_still_open_at_end_of_log_is_dropped_not_guessed_at():
    """A run killed mid-check has no end time and no outcome. Inventing either
    would put a fabricated duration into the baseline median."""
    text = _log(
        """
        [10:00:00] run 5: starting
        [10:00:01] checks: running npm test --silent
        """
    )
    assert backfill.parse_session_log(text, day="2026-09-25") == []


def test_two_separate_check_blocks_in_one_log_are_two_records():
    """An attempt that re-ran its checks is two measurements, not one."""
    text = _log(
        """
        [10:00:00] checks: running npm test --silent
        [10:01:00] run 5: reported ok
        [11:00:00] checks: running npm test --silent
        [11:03:00] run 6: reported ok
        """
    )
    records = backfill.parse_session_log(text, day="2026-09-25")
    assert [r["commands"][0]["duration_s"] for r in records] == [60.0, 180.0]


def test_a_log_with_no_checks_yields_nothing():
    assert backfill.parse_session_log("[10:00:00] run 5: starting\n", day="2026-09-25") == []


def test_terminal_escape_noise_before_the_timestamp_is_tolerated():
    """Session logs are a tmux capture, so the first line of a block routinely
    carries the agent TUI's leftover escape codes."""
    text = "[?25h[10:00:00] checks: running npm test --silent\n[10:00:30] run 5: reported ok\n"
    (record,) = backfill.parse_session_log(text, day="2026-09-25")
    assert record["commands"][0]["duration_s"] == 30.0


def test_backfill_reads_only_agent_session_logs_from_a_directory(tmp_path):
    """The PM and concierge sessions run no repo checks; globbing them in
    would be harmless today and a silent miscount the day they do."""
    (tmp_path / "farm-run-hz-1-s11-a1.log").write_text(PASSING_BLOCK)
    (tmp_path / "concierge-horizon.log").write_text(PASSING_BLOCK)
    records = backfill.backfill(tmp_path)
    assert len(records) == 1
    assert records[0]["phase"] == "cap4-nolimit"


def test_the_phase_label_is_overridable(tmp_path):
    (tmp_path / "farm-run-hz-1-s11-a1.log").write_text(PASSING_BLOCK)
    assert backfill.backfill(tmp_path, phase="cap4-limit2")[0]["phase"] == "cap4-limit2"


def test_records_come_back_oldest_first_and_last_keeps_the_recent_window(tmp_path):
    """The check gate has grown over the farm's life, so a median over the
    whole history is a median of a smaller gate — and a future cap-6 window
    compared against it would read that growth as a contention regression."""
    text = _log(
        """
        [10:00:00] checks: running npm test --silent
        [10:01:00] run 1: reported ok
        [11:00:00] checks: running npm test --silent
        [11:05:00] run 2: reported ok
        [12:00:00] checks: running npm test --silent
        [12:10:00] run 3: reported ok
        """
    )
    (tmp_path / "farm-run-hz-1-s11-a1.log").write_text(text)

    assert [r["run_id"] for r in backfill.backfill(tmp_path)] == ["1", "2", "3"]
    assert [r["run_id"] for r in backfill.backfill(tmp_path, last=2)] == ["2", "3"]
    # A window larger than the history is the whole history, not an error.
    assert len(backfill.backfill(tmp_path, last=99)) == 3


def test_an_unreadable_log_is_skipped_rather_than_taking_the_run_down(tmp_path):
    (tmp_path / "farm-run-hz-1-s11-a1.log").write_text(PASSING_BLOCK)
    bad = tmp_path / "farm-run-hz-2-s11-a1.log"
    bad.write_text(PASSING_BLOCK)
    bad.chmod(0o000)
    try:
        assert len(backfill.backfill(tmp_path)) == 1
    finally:
        bad.chmod(0o600)


def test_records_feed_the_normal_reporter_unchanged(tmp_path):
    """One renderer for the baseline and for the live windows — otherwise the
    two halves of metric 4 would be computed by different code and the
    comparison would not mean anything."""
    from farm import check_metrics
    from farm.tools import report_check_metrics as reporter

    path = tmp_path / "farm-run-hz-1-s11-a1.log"
    path.write_text(PASSING_BLOCK)
    out = tmp_path / "m.jsonl"
    import json

    out.write_text("".join(json.dumps(r) + "\n" for r in backfill.backfill(tmp_path)))

    records, skipped = check_metrics.read_records(out)
    summary = reporter.by_phase(records)["cap4-nolimit"]
    assert skipped == 0
    assert summary["runs"] == 1
    assert summary["median_check_s"] == 252.0  # 1 + 115 + 71 + 65
    assert summary["mem_available_low_kb"] is None
    assert summary["unthrottled_runs"] == 0


def test_the_cli_reports_an_empty_directory_rather_than_writing_nothing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["backfill", "--logs-dir", str(tmp_path)])
    assert backfill.main() == 1
    assert "no check blocks found" in capsys.readouterr().out


def test_the_cli_writes_jsonl_one_record_per_line(tmp_path, monkeypatch, capsys):
    (tmp_path / "farm-run-hz-1-s11-a1.log").write_text(PASSING_BLOCK)
    out = tmp_path / "out.jsonl"
    monkeypatch.setattr("sys.argv", ["backfill", "--logs-dir", str(tmp_path), "-o", str(out)])
    assert backfill.main() == 0
    assert len(out.read_text().strip().splitlines()) == 1


@pytest.mark.parametrize("day", ["2026-09-29", "2026-01-01"])
def test_the_timestamp_combines_the_file_date_with_the_logged_time(day):
    (record,) = backfill.parse_session_log(PASSING_BLOCK, day=day)
    assert record["ts"] == f"{day}T17:54:01Z"
