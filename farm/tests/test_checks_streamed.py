"""HZ-948: a check command killed at its time limit keeps its results. The
streamed `*.jsonl` lines written before the kill (and the XML) become rows,
plus one failing `running when stopped: <test>` row for the test it cut off;
the check still fails as timed out and its CheckFailure carries the failing
rows. The group gets a short SIGTERM before the SIGKILL, so a runner can
flush. A missing or broken report only loses detail, never changes the
verdict.

The commands are real `sh` scripts killed for real: FARM_CHECK_TIMEOUT_S=2,
so the SIGTERM grace is 0.2 s."""

import json
import os
import time
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, parse_jsonl, run_checks

STOPPED = checks.STOPPED_TEST_PREFIX
TIMED_OUT = "timed_out"


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv(checks.TERM_GRACE_ENV, raising=False)
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "2")
    # One attempt: the rows stored are the first run's.
    monkeypatch.setenv(checks.RERUN_ENV, "0")


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


def finished(name: str, file: str = "tests/a.test.js", status: str = "pass", failure=None) -> dict:
    return {"event": "finished", "name": name, "file": file, "status": status, "duration_ms": 5, "failure": failure}


def started(name: str, file: str = "tests/a.test.js") -> dict:
    return {"event": "started", "name": name, "file": file}


def jsonl(path: Path, lines: list) -> Path:
    """A report: dicts are written as JSON lines, strings verbatim."""
    path.write_text("".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines))
    return path


def copy(*reports: Path) -> str:
    return "; ".join(f'cp {r} "$HORIZON_TEST_REPORT_DIR/{r.name}"' for r in reports)


def run(ws, monkeypatch, command: str, *, fails: bool = True):
    """(stored rows, log lines, the CheckFailure when `fails`)."""
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    test_runs: list = []
    logged: list[str] = []
    err = None
    if fails:
        with pytest.raises(CheckFailure) as info:
            run_checks(ws, log=logged.append, test_runs=test_runs)
        err = info.value
    else:
        run_checks(ws, log=logged.append, test_runs=test_runs)
    return [row for entry in test_runs for row in entry["tests"]], logged, err


def killed(ws, tmp_path, monkeypatch, lines: list):
    """Writes `lines` as the report, then sleeps past the limit."""
    return run(ws, monkeypatch, f"{copy(jsonl(tmp_path / 'r.jsonl', lines))}; sleep 30")


def stopped_rows(stored: list[dict]) -> list[dict]:
    return [row for row in stored if row["test"].startswith(STOPPED)]


# ---- metrics 1 and 2: finished rows survive the kill, one cut-off row ----


def test_a_killed_command_stores_every_finished_test_and_one_cut_off_row(ws, tmp_path, monkeypatch):
    stored, _, _ = killed(
        ws,
        tmp_path,
        monkeypatch,
        [
            started("adds"),
            finished("adds"),
            started("posts"),
            finished("posts", status="fail", failure="AssertionError: expected 1 but was 2"),
            finished("skips", status="skip"),
            started("hangs"),
        ],
    )

    assert {(r["test"], r["status"]) for r in stored} == {
        ("adds", "pass"),
        ("posts", "fail"),
        ("skips", "skip"),
        (f"{STOPPED}hangs", "fail"),
    }
    # Finished start+end pairs are never the cut-off test.
    assert [r["test"] for r in stopped_rows(stored)] == [f"{STOPPED}hangs"]
    assert stopped_rows(stored)[0]["file"] == "tests/a.test.js"


def test_with_two_open_tests_only_the_last_started_is_named(ws, tmp_path, monkeypatch):
    stored, _, _ = killed(ws, tmp_path, monkeypatch, [started("A"), started("B")])

    assert [r["test"] for r in stopped_rows(stored)] == [f"{STOPPED}B"]
    assert len(stored) == 1


# ---- metric 3: the failure still raises, carrying the rows ----


def test_the_timed_out_failure_carries_the_failing_streamed_and_cut_off_rows(ws, tmp_path, monkeypatch):
    _, _, err = killed(
        ws,
        tmp_path,
        monkeypatch,
        [finished("adds"), finished("posts", status="fail", failure="expected 1 but was 2"), started("hangs")],
    )

    assert err.reason == TIMED_OUT
    assert sorted(r["test"] for r in err.failed_tests) == ["posts", f"{STOPPED}hangs"]
    assert all(r["status"] == "fail" for r in err.failed_tests)
    assert "repo checks timed out after 2s" in str(err)
    assert f"tests/a.test.js › {STOPPED}hangs — {checks.STOPPED_MESSAGE}" in str(err)
    assert "failing tests (2):" in err.tail


# ---- metric 4 / R4: XML and JSON lines are a union, each test once ----


def test_xml_and_jsonl_are_merged_and_a_shared_test_is_stored_once_from_the_xml(ws, tmp_path, monkeypatch):
    xml = tmp_path / "r.xml"
    xml.write_text('<testsuite name="ledger"><testcase name="posts once" file="tests/ledger.test.js"/></testsuite>')
    report = jsonl(
        tmp_path / "r.jsonl",
        [
            finished("posts once", file="tests/ledger.test.js", status="fail", failure="streamed"),
            finished("only streamed", file="tests/ledger.test.js"),
        ],
    )

    stored, _, _ = run(ws, monkeypatch, f"{copy(xml, report)}; exit 1")

    tests = sorted((r["test"], r["status"], r["suite"]) for r in stored)
    assert tests == [("only streamed", "pass", None), ("posts once", "pass", "ledger")]


def test_a_playwright_junit_row_with_no_file_matches_the_streamed_line_by_its_suite(ws, tmp_path, monkeypatch):
    """HZ-949: Playwright's junit names the spec file only as the testsuite;
    e2e/jsonl-reporter.js writes that same name as `file`."""
    xml = tmp_path / "e2e.xml"
    xml.write_text('<testsuite name="05-board.spec.js"><testcase name="board › shows lanes"/></testsuite>')
    report = jsonl(tmp_path / "e2e.jsonl", [finished("board › shows lanes", file="05-board.spec.js")])

    stored, _, _ = run(ws, monkeypatch, f"{copy(xml, report)}; exit 1")

    assert [(r["test"], r["suite"]) for r in stored] == [("board › shows lanes", "05-board.spec.js")]


# ---- metric 5: a cut last line ----


def test_a_cut_last_line_is_skipped_and_the_earlier_lines_are_kept(tmp_path):
    whole = jsonl(tmp_path / "r.jsonl", [finished("one"), started("two"), finished("two", status="fail", failure="x")])
    report = tmp_path / "cut.jsonl"
    report.write_text(whole.read_text() + json.dumps(started("three"))[:25])

    rows, bad, cut_off = parse_jsonl(report, tmp_path)

    assert [(r["test"], r["status"]) for r in rows] == [("one", "pass"), ("two", "fail")]
    assert bad == 1
    assert cut_off is None


# ---- guardrail 2: the SIGTERM grace, then always the group SIGKILL ----


def test_a_command_ignoring_sigterm_is_still_killed(ws, tmp_path, monkeypatch):
    pid_file = tmp_path / "pid"
    started_at = time.monotonic()

    _, _, err = run(ws, monkeypatch, f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.1; done")

    assert err.reason == TIMED_OUT
    assert time.monotonic() - started_at < 2 + 10
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_a_line_written_on_sigterm_is_stored(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "5")
    last = jsonl(tmp_path / "last.jsonl", [finished("hangs")])
    first = jsonl(tmp_path / "first.jsonl", [started("hangs")])
    out = '"$HORIZON_TEST_REPORT_DIR/r.jsonl"'

    stored, _, err = run(
        ws,
        monkeypatch,
        f"trap 'cat {last} >> {out}; exit 143' TERM; cat {first} > {out}; while :; do sleep 0.1; done",
    )

    assert err.reason == TIMED_OUT
    assert [(r["test"], r["status"]) for r in stored] == [("hangs", "pass")]


# ---- guardrail 3: redact() and the JUnit limits ----


def test_streamed_names_and_messages_are_redacted_and_cut(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_TOKEN", "abcd1234efgh")
    stored, _, err = killed(
        ws,
        tmp_path,
        monkeypatch,
        [
            finished("n" * 900),
            finished("leaks abcd1234efgh", status="fail", failure="got abcd1234efgh back " + "f" * 1000),
            started("m" * 600),
        ],
    )

    by_name = {r["test"]: r for r in stored}
    assert "n" * checks.TEST_NAME_MAX_CHARS in by_name
    leak = by_name["leaks [redacted]"]
    assert leak["failure_message"].startswith("got [redacted] back")
    assert len(leak["failure_message"]) == checks.FAILURE_MESSAGE_MAX_CHARS
    assert not any("abcd1234efgh" in json.dumps(r) for r in stored)
    assert "abcd1234efgh" not in str(err) and "abcd1234efgh" not in err.tail
    cut_off = stopped_rows(stored)[0]["test"]
    assert cut_off == (STOPPED + "m" * 600)[: checks.TEST_NAME_MAX_CHARS]


def test_a_killed_run_stores_at_most_test_rows_max_rows(ws, tmp_path, monkeypatch):
    monkeypatch.setattr(checks, "TEST_ROWS_MAX", 3)

    stored, logged, _ = killed(ws, tmp_path, monkeypatch, [finished(f"t{i}") for i in range(5)])

    assert len(stored) == 3
    assert any("over 3 test results" in line for line in logged)


def test_an_oversize_streamed_report_is_skipped_and_logged(ws, tmp_path, monkeypatch):
    monkeypatch.setattr(checks, "REPORT_FILE_MAX_BYTES", 10)

    stored, logged, err = killed(ws, tmp_path, monkeypatch, [finished("adds"), started("hangs")])

    assert err.reason == TIMED_OUT
    assert stored == []
    assert any("could not read test report r.jsonl" in line for line in logged)


# ---- guardrail 4: the verdict never depends on the report ----


def test_the_verdict_comes_from_the_exit_code_never_the_report(ws, tmp_path, monkeypatch):
    garbage = jsonl(tmp_path / "g.jsonl", ["garbage", "{]", '{"event": "finished"'])
    all_pass = jsonl(tmp_path / "p.jsonl", [finished("adds"), finished("posts")])

    run(ws, monkeypatch, f"{copy(garbage)}; exit 0", fails=False)
    stored, _, err = run(ws, monkeypatch, f"{copy(all_pass)}; exit 1")

    assert err.reason == "failed"
    assert {r["status"] for r in stored} == {"pass"}


def test_a_reader_crash_on_a_kill_still_fails_as_timed_out(ws, tmp_path, monkeypatch):
    def crash(*_a, **_k):
        raise RuntimeError("reader broke")

    monkeypatch.setattr(checks, "parse_jsonl", crash)

    stored, logged, err = killed(ws, tmp_path, monkeypatch, [finished("adds"), started("hangs")])

    assert err.reason == TIMED_OUT
    assert err.failed_tests == []
    assert stored == []
    assert len([line for line in logged if "could not read the timed-out command's test reports" in line]) == 1


def test_a_normal_failure_with_an_open_test_gets_no_cut_off_row(ws, tmp_path, monkeypatch):
    report = jsonl(tmp_path / "r.jsonl", [finished("adds"), finished("posts", status="fail"), started("open")])

    stored, _, err = run(ws, monkeypatch, f"{copy(report)}; exit 1")

    assert err.reason == "failed"
    assert sorted(r["test"] for r in stored) == ["adds", "posts"]
    assert stopped_rows(stored) == []


# ---- the rerun verdict reads streamed failure kinds ----


def test_the_rerun_verdict_uses_streamed_failure_kinds(tmp_path):
    assertions = jsonl(
        tmp_path / "a.jsonl",
        [
            finished("one", status="fail", failure="AssertionError: expected 1 to equal 2"),
            finished("two", status="fail", failure="AssertionError [ERR_ASSERTION]: values differ"),
        ],
    )
    flaky = jsonl(
        tmp_path / "f.jsonl",
        [
            finished("one", status="fail", failure="AssertionError: expected 1 to equal 2"),
            finished("two", status="fail", failure="Error: connect ECONNREFUSED 127.0.0.1:5432"),
        ],
    )

    assertion_rows, _, _ = parse_jsonl(assertions, tmp_path)
    flaky_rows, _, _ = parse_jsonl(flaky, tmp_path)

    assert checks._rerun_verdict(assertion_rows, "npm test")[0] is False
    assert [r["failure_kind"] for r in flaky_rows] == [checks.FAILURE_ASSERTION, checks.FAILURE_NETWORK]
    rerun, why = checks._rerun_verdict(flaky_rows, "npm test")
    assert rerun is True and "a connection or network error in 1 of 2 tests" in why
