"""HZ-144: the measurement, and the classifier the added metric is read off.

Success metric 5 is "zero out-of-memory kills and zero check timeouts
attributable to contention", and the human feedback added "zero check
failures attributable to configuration leakage or contention". Neither is
readable off a tally that lumps everything into one bucket, so the classifier
has a class per failure shape — and tests, because a misclassification is
invisible: it produces a confident number that is wrong.
"""

import json
import os

import pytest

from farm import check_metrics, check_slots, checks
from farm.tools import report_check_metrics as reporter


@pytest.fixture(autouse=True)
def isolated_metrics(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(check_metrics.PHASE_ENV, raising=False)
    monkeypatch.delenv("FARM_MAX_CONCURRENT_CHECKS", raising=False)
    return tmp_path


# ---- classification ----


def test_a_playwright_global_timeout_tail_is_contention():
    """The literal 30 Sept failure: e2e/playwright.config.js's own
    globalTimeout firing at load ~8. That value stays where it is and is
    treated as the contention detector (HZ-144 guardrail 3) — classified, not
    raised away."""
    tail = "Running 14 tests using 1 worker\nTimed out waiting 85s for the test suite to run"
    assert check_metrics.classify_failure(tail, 1) == "contention"


def test_a_port_collision_between_concurrent_runs_is_contention():
    """PORT_OFFSET in e2e/playwright.config.js is a hash of the worktree path
    modulo 1000, so more concurrent runs means more collisions — and each
    webServer starts with `fuser -k` on its port, so the loser's server is
    actively killed mid-suite. Caused by concurrency, so never `other`."""
    assert check_metrics.classify_failure("Error: http://localhost:3057 is already used", 1) == "contention"
    assert check_metrics.classify_failure("Error: listen EADDRINUSE :::4351", 1) == "contention"


def test_a_capacity_assertion_tail_is_leakage():
    tail = "E   assert 6 == 4\nE    +  where 6 = farmd.MAX_EPHEMERAL == 4"
    assert check_metrics.classify_failure(tail, 1) == "leakage"


def test_a_negative_returncode_is_an_oom_kill():
    """An OOM-killed pytest or Chromium returns -9 and prints nothing useful,
    so without this class metric 5 ("zero out-of-memory kills") would be
    unmeasurable — every kill would land in `other`."""
    assert check_metrics.classify_failure("", -9) == "oom"
    assert check_metrics.classify_failure("Timed out waiting 85s for the test suite to run", -9) == "oom"


def test_an_unrecognised_failure_is_other_and_not_guessed():
    assert check_metrics.classify_failure("AssertionError: expected 3 got 4", 1) == "other"
    assert check_metrics.classify_failure("", 1) == "other"


def test_every_classification_is_a_declared_outcome():
    samples = [("", -9), ("MAX_EPHEMERAL == 4", 1), ("is already used", 1), ("boom", 1)]
    for tail, code in samples:
        assert check_metrics.classify_failure(tail, code) in check_metrics.OUTCOMES


# ---- the record ----


def test_a_passing_run_records_durations_load_memory_and_the_slot(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setenv(check_metrics.PHASE_ENV, "cap4-limit2")

    checks.run_checks(tmp_path, log=lambda *_: None, run_id="r-91", item_id="HZ-150")

    records, skipped = check_metrics.read_records(check_metrics.metrics_path())
    assert skipped == 0 and len(records) == 1
    record = records[0]
    assert record["outcome"] == "pass"
    assert record["phase"] == "cap4-limit2"
    assert record["run_id"] == "r-91" and record["item_id"] == "HZ-150"
    assert record["caller"] == "step_agent"
    assert record["slot_mode"] == "held" and record["slot_index"] == 0
    assert record["slot_wait_s"] == 0.0 and record["slot_wait_timed_out"] is False
    assert record["max_concurrent_checks"] == 2
    assert [c["returncode"] for c in record["commands"]] == [0]
    assert record["commands"][0]["duration_s"] >= 0


def test_the_record_carries_a_host_wide_free_memory_low_water_mark(tmp_path, monkeypatch):
    """Not ru_maxrss: that is a per-process high-water mark across every
    child reaped since process start and never decreases, while the OOM risk
    this item raises is host-wide across six agents."""
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    checks.run_checks(tmp_path, log=lambda *_: None)
    record = check_metrics.read_records(check_metrics.metrics_path())[0][0]
    assert record["mem_available_low_kb"] == pytest.approx(check_metrics.mem_available_kb(), rel=0.5)
    assert record["load_start"] is not None and record["load_end"] is not None


def test_a_failing_run_is_recorded_with_its_classified_outcome(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'Timed out waiting 85s for the test suite to run' && exit 1")
    with pytest.raises(checks.CheckFailure):
        checks.run_checks(tmp_path, log=lambda *_: None)
    record = check_metrics.read_records(check_metrics.metrics_path())[0][0]
    assert record["outcome"] == "contention"


def test_a_timed_out_run_is_recorded_as_a_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "sleep 5")
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    with pytest.raises(checks.CheckFailure):
        checks.run_checks(tmp_path, log=lambda *_: None)
    record = check_metrics.read_records(check_metrics.metrics_path())[0][0]
    assert record["outcome"] == "timeout"
    assert record["commands"][0]["timed_out"] is True


def test_a_repo_with_no_checks_records_nothing(tmp_path):
    """No commands means no slot taken and no measurement — a record here
    would be a zero-duration run inflating the count toward 20."""
    assert checks.run_checks(tmp_path, log=lambda *_: None) == "no repo checks detected"
    assert not check_metrics.metrics_path().exists()


def test_a_metrics_write_failure_never_fails_a_passing_check(tmp_path, monkeypatch):
    """The file is instrumentation, not a deliverable. Checks run before
    commit/push, so failing here would discard an attempt's work over a
    read-only log directory."""
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setattr(check_metrics, "metrics_path", lambda: tmp_path / "nope" / "x" / "m.jsonl")
    monkeypatch.setattr(check_metrics.Path, "mkdir", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))

    logged = []
    assert "passed" in checks.run_checks(tmp_path, log=logged.append)
    assert any("could not record this check run" in line for line in logged)


def test_a_record_that_will_not_serialise_is_reported_not_raised(tmp_path):
    logged = []
    assert check_metrics.append_record({"ts": object()}, log=logged.append) is False
    assert any("could not record" in line for line in logged)


def test_concurrent_writers_each_append_one_whole_json_line(tmp_path):
    """One write() of one already-built line, in append mode — so two farm
    runs finishing together cannot interleave into an unparseable file."""
    for i in range(4):
        assert check_metrics.append_record({"run_id": i, "outcome": "pass", "commands": []}) is True
    records, skipped = check_metrics.read_records(check_metrics.metrics_path())
    assert skipped == 0
    assert sorted(r["run_id"] for r in records) == [0, 1, 2, 3]


def test_reading_a_missing_file_is_empty_not_an_error(tmp_path):
    assert check_metrics.read_records(tmp_path / "absent.jsonl") == ([], 0)


# ---- the reporter ----


def _record(**kw):
    base = {
        "phase": "cap4-nolimit",
        "caller": "step_agent",
        "outcome": "pass",
        "slot_wait_s": 0.0,
        "load_end": 1.0,
        "mem_available_low_kb": 2_000_000,
        "commands": [{"cmd": "npm test", "duration_s": 10.0, "returncode": 0}],
    }
    return {**base, **kw}


def test_the_reporter_flags_a_phase_with_fewer_than_twenty_runs(tmp_path, capsys):
    """Metric 4 says "each over at least 20 real runs". A median over three
    runs must not read like a result."""
    path = tmp_path / "m.jsonl"
    path.write_text("\n".join(json.dumps(_record()) for _ in range(3)) + "\n")
    records, _ = check_metrics.read_records(path)
    report = reporter.by_phase(records)
    assert report["cap4-nolimit"]["runs"] == 3
    assert report["cap4-nolimit"]["enough_runs"] is False
    text = reporter.render(report, 0, path, markdown=False)
    assert "fewer than the 20" in text


def test_twenty_runs_is_enough_runs(tmp_path):
    records = [_record() for _ in range(20)]
    assert reporter.summarise(records)["enough_runs"] is True


def test_the_reporter_groups_by_phase_in_measurement_order(tmp_path):
    records = [
        _record(phase="cap6-limit2"),
        _record(phase="cap4-nolimit"),
        _record(phase="cap4-limit2"),
        _record(phase="something-else"),
    ]
    assert list(reporter.by_phase(records)) == [
        "cap4-nolimit",
        "cap4-limit2",
        "cap6-limit2",
        "something-else",
    ]


def test_an_uncollected_phase_is_named_as_missing(tmp_path):
    path = tmp_path / "m.jsonl"
    text = reporter.render(reporter.by_phase([_record(phase="cap4-nolimit")]), 0, path, markdown=False)
    assert "not yet collected: cap4-limit2, cap6-limit2" in text


def test_the_reporter_skips_a_malformed_line_and_says_how_many(tmp_path):
    path = tmp_path / "m.jsonl"
    path.write_text(json.dumps(_record()) + "\n{truncated by a killed writer\n[]\n")
    records, skipped = check_metrics.read_records(path)
    assert len(records) == 1 and skipped == 2
    assert "2 malformed line(s)" in reporter.render(reporter.by_phase(records), skipped, path, markdown=False)


def test_conflict_resolver_records_are_separable_from_agent_runs(tmp_path):
    """farm/conflict_resolver.py is a second run_checks() caller, running in
    farmd's own process. It takes a slot like anything else, but it is not an
    agent run — so it must not pad the 20-run count."""
    summary = reporter.summarise([_record(), _record(caller="conflict_resolver")])
    assert summary["runs"] == 1
    assert summary["resolver_runs"] == 1


def test_check_duration_excludes_the_slot_wait(tmp_path):
    """Mixing the two would hide the regression this measurement looks for,
    and would make the limiter look like it slowed the checks down when it
    only queued them."""
    record = _record(slot_wait_s=120.0, commands=[{"duration_s": 30.0}, {"duration_s": 12.0}])
    assert reporter.check_duration_s(record) == 42.0
    summary = reporter.summarise([record])
    assert summary["median_check_s"] == 42.0
    assert summary["median_wait_s"] == 120.0


def test_the_added_metric_counts_leakage_contention_and_oom_together(tmp_path):
    """"Zero check failures attributable to configuration leakage or
    contention" — read straight off the tally, not inferred. An OOM kill
    counts: under this load it is a contention outcome."""
    records = [
        _record(outcome="pass"),
        _record(outcome="other"),
        _record(outcome="contention"),
        _record(outcome="leakage"),
        _record(outcome="oom"),
        _record(outcome="timeout"),
    ]
    summary = reporter.summarise(records)
    assert summary["config_or_contention_failures"] == 3
    assert summary["timeouts"] == 1
    assert summary["oom_kills"] == 1


def test_percentiles_and_peaks_come_from_the_recorded_values(tmp_path):
    """Nearest-rank percentile over exactly the 20 samples the metric asks
    for: p95 is the 19th of 20, not the max. No numpy in
    farm/requirements.txt, and at this sample size the interpolation choice
    is noise next to the sample size itself."""
    records = [_record(commands=[{"duration_s": float(d)}], load_end=float(d)) for d in range(1, 21)]
    summary = reporter.summarise(records)
    assert summary["median_check_s"] == 11.0
    assert summary["p95_check_s"] == 19.0
    assert summary["peak_load"] == 20.0


def test_an_empty_phase_reports_dashes_rather_than_crashing(tmp_path):
    summary = reporter.summarise([])
    assert summary["runs"] == 0 and summary["median_check_s"] is None
    assert "—" in reporter.render({"cap4-nolimit": summary}, 0, tmp_path / "m.jsonl", markdown=False)


def _phase(name, duration, count=20):
    return [_record(phase=name, commands=[{"duration_s": duration}]) for _ in range(count)]


def test_metric_six_is_computed_not_eyeballed(tmp_path):
    """The 50%-slower bound, read off the tool rather than off two numbers in
    a table."""
    records = _phase("cap4-nolimit", 100.0) + _phase("cap6-limit2", 140.0)
    text = reporter.render(reporter.by_phase(records), 0, tmp_path / "m.jsonl", markdown=False)
    assert "= 1.40x — within the 1.5x bound" in text


def test_metric_six_names_the_over_budget_case_and_what_to_do(tmp_path):
    records = _phase("cap4-nolimit", 100.0) + _phase("cap6-limit2", 200.0)
    text = reporter.render(reporter.by_phase(records), 0, tmp_path / "m.jsonl", markdown=False)
    assert "= 2.00x — OVER the 1.5x bound" in text
    assert "recommend a larger instance" in text
    assert "do not provision one" in text


def test_metric_six_is_silent_until_both_windows_exist(tmp_path):
    """An incomplete measurement must not produce a verdict in either
    direction."""
    text = reporter.render(reporter.by_phase(_phase("cap6-limit2", 200.0)), 0, tmp_path / "m.jsonl", markdown=False)
    assert "metric 6" not in text


def test_metric_six_flags_a_ratio_drawn_from_too_few_runs(tmp_path):
    records = _phase("cap4-nolimit", 100.0, count=3) + _phase("cap6-limit2", 110.0, count=3)
    text = reporter.render(reporter.by_phase(records), 0, tmp_path / "m.jsonl", markdown=False)
    assert "metric 6" in text
    assert "not yet a result" in text


def test_the_markdown_form_is_a_table_for_the_pr_body(tmp_path):
    text = reporter.render(reporter.by_phase([_record()]), 0, tmp_path / "m.jsonl", markdown=True)
    assert text.startswith("| Phase |")
    assert "| --- |" in text


def test_the_reporter_exits_nonzero_when_nothing_has_been_recorded(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["report_check_metrics", "--path", str(tmp_path / "absent.jsonl")])
    assert reporter.main() == 1
    assert "no check runs recorded" in capsys.readouterr().out


def test_the_reporter_reads_farm_home_by_default(tmp_path, monkeypatch, capsys):
    check_metrics.append_record(_record())
    monkeypatch.setattr("sys.argv", ["report_check_metrics"])
    assert reporter.main() == 0
    out = capsys.readouterr().out
    assert "cap4-nolimit" in out
    assert str(check_metrics.metrics_path()) in out
