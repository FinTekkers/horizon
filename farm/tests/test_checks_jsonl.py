"""HZ-955: checks also read streamed JSON-lines reports (`*.jsonl`) from
$HORIZON_TEST_REPORT_DIR — one row per `finished` line, capped and stored
like a JUnit row. A bad line or file is logged and skipped and never changes
the check's verdict; a test an XML report already has is stored once."""

import json
import shlex
import sys
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, run_checks

PY = shlex.quote(sys.executable)


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)
    # One attempt: the rows stored are the first run's.
    monkeypatch.setenv(checks.RERUN_ENV, "0")


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


def finished(name: str, file: str = "tests/a.test.js", status: str = "pass", duration_ms=5, failure=None) -> dict:
    return {"event": "finished", "name": name, "file": file, "status": status, "duration_ms": duration_ms, "failure": failure}


def started(name: str, file: str = "tests/a.test.js") -> dict:
    return {"event": "started", "name": name, "file": file}


def jsonl(path: Path, lines: list) -> Path:
    """A report: dicts are written as JSON, strings verbatim."""
    path.write_text("".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines))
    return path


def run(ws, monkeypatch, command: str, *, fails: bool) -> tuple[list[dict], list[str], CheckFailure | None]:
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


def copy(*reports: Path, exit_code: int = 0) -> str:
    return "; ".join([*(f'cp {r} "$HORIZON_TEST_REPORT_DIR/{r.name}"' for r in reports), f"exit {exit_code}"])


# ---- metric 1: one row per finished line ----


def test_three_finished_lines_store_three_rows_with_their_fields(ws, tmp_path, monkeypatch):
    report = jsonl(
        tmp_path / "r.jsonl",
        [
            started("adds"),
            finished("adds", duration_ms=12),
            finished("skips", file="tests/b.test.js", status="skip", duration_ms=0),
            finished("fails", status="fail", duration_ms=40, failure="expected 1 to equal 2"),
        ],
    )

    stored, _, _ = run(ws, monkeypatch, copy(report), fails=False)

    got = {(r["file"], r["test"]): (r["status"], r["duration_ms"], r["suite"]) for r in stored}
    assert got == {
        ("tests/a.test.js", "adds"): ("pass", 12, None),
        ("tests/b.test.js", "skips"): ("skip", 0, None),
        ("tests/a.test.js", "fails"): ("fail", 40, None),
    }
    assert all("failure_kind" not in r and "classname" not in r and "line" not in r for r in stored)


def test_a_failing_jsonl_test_is_listed_in_the_check_failure(ws, tmp_path, monkeypatch):
    report = jsonl(
        tmp_path / "r.jsonl",
        [finished("posts once", file="tests/ledger.test.js", status="fail", failure="\nexpected 1 but was 2\n  at x.js:1")],
    )

    stored, _, err = run(ws, monkeypatch, copy(report, exit_code=1), fails=True)

    assert "failing tests (1):\ntests/ledger.test.js › posts once — expected 1 but was 2" in str(err)
    assert [r["failure_message"] for r in stored] == ["expected 1 but was 2"]


# ---- metric 2: the same caps as a JUnit row ----


def test_failure_text_is_cut_to_300_and_name_to_500(ws, tmp_path, monkeypatch):
    report = jsonl(tmp_path / "r.jsonl", [finished("n" * 900, status="fail", failure="f" * 1000)])

    stored, _, _ = run(ws, monkeypatch, copy(report), fails=False)

    assert len(stored) == 1
    assert stored[0]["test"] == "n" * 500
    assert stored[0]["failure_message"] == "f" * 300


# ---- metric 3: a started-only test stores no row ----


def test_a_started_only_test_stores_no_row_and_the_rest_of_the_file_is_stored(ws, tmp_path, monkeypatch):
    report = jsonl(
        tmp_path / "r.jsonl",
        [started("one"), finished("one"), started("hangs"), started("two"), finished("two", status="fail", failure="no")],
    )

    stored, _, _ = run(ws, monkeypatch, copy(report), fails=False)

    assert sorted((r["test"], r["status"]) for r in stored) == [("one", "pass"), ("two", "fail")]


# ---- metric 4 / guardrail 2: bad lines and files never change the verdict ----

GOOD = [finished("kept one"), finished("kept two", status="skip")]


@pytest.mark.parametrize("exit_code", [0, 1])
@pytest.mark.parametrize(
    "case, lines, expected, warning",
    [
        ("one bad line", [GOOD[0], "{not json", GOOD[1]], {"kept one", "kept two"}, "skipped 1 malformed line(s)"),
        ("garbage file", ["garbage", "[1, 2]", "{]"], set(), "could not read test report r.jsonl"),
        ("oversize file", GOOD, set(), "could not read test report r.jsonl"),
    ],
)
def test_a_bad_report_is_logged_and_the_verdict_is_unchanged(
    ws, tmp_path, monkeypatch, case, lines, expected, warning, exit_code
):
    report = jsonl(tmp_path / "r.jsonl", lines)
    if case == "oversize file":
        monkeypatch.setattr(checks, "REPORT_FILE_MAX_BYTES", 10)

    stored, logged, err = run(ws, monkeypatch, copy(report, exit_code=exit_code), fails=exit_code == 1)

    assert (err is not None) == (exit_code == 1)
    tests = {r["test"] for r in stored if r["file"] is not None}
    assert tests == expected
    if not expected:
        # Only the command's own row, as with no report at all.
        assert [r["file"] for r in stored] == [None]
        assert stored[0]["status"] == ("fail" if exit_code else "pass")
    assert any(warning in line and "the check's result is unchanged" in line for line in logged)


def test_a_line_without_a_string_file_is_bad_and_the_rest_are_stored(ws, tmp_path, monkeypatch):
    no_file = {k: v for k, v in finished("no file", status="fail").items() if k != "file"}
    report = jsonl(
        tmp_path / "r.jsonl",
        [no_file, finished("number file", file=7, status="fail"), finished("empty file", file=""), *GOOD],
    )

    stored, logged, err = run(ws, monkeypatch, copy(report, exit_code=1), fails=True)

    assert {r["test"] for r in stored} == {"kept one", "kept two"}
    assert any("skipped 3 malformed line(s) in test report r.jsonl" in line for line in logged)
    # None of the bad lines reached the failure list either.
    assert "failing tests" not in str(err)


# ---- metric 5: a test in both XML and JSON lines is one row ----


@pytest.mark.parametrize(
    "xml, name",
    [
        # A runner's JUnit with a file attribute.
        (
            '<testsuite name="ledger"><testcase name="posts once" file="tests/ledger.test.js"/></testsuite>',
            "posts once",
        ),
        # pytest's xunit2: no file, only the dotted classname.
        (
            '<testsuites><testsuite name="pytest">'
            '<testcase classname="tests.test_ledger" name="test_posts"/></testsuite></testsuites>',
            "test_posts",
        ),
        # A class-based pytest test, named Class::test in the JSON lines.
        (
            '<testsuites><testsuite name="pytest">'
            '<testcase classname="tests.test_ledger.TestY" name="test_a[1]"/></testsuite></testsuites>',
            "TestY::test_a[1]",
        ),
    ],
    ids=["file-attribute", "xunit2-classname", "class-name"],
)
def test_a_test_in_both_xml_and_jsonl_is_stored_once_as_its_xml_row(ws, tmp_path, monkeypatch, xml, name):
    file = "tests/ledger.test.js" if name == "posts once" else "tests/test_ledger.py"
    xml_report = tmp_path / "r.xml"
    xml_report.write_text(xml)
    report = jsonl(tmp_path / "r.jsonl", [finished(name, file=file, duration_ms=999), finished("only here", file=file)])

    stored, _, _ = run(ws, monkeypatch, copy(xml_report, report), fails=False)

    assert len(stored) == 2
    assert [r["test"] for r in stored][1] == "only here"
    # The XML row: its duration comes from the report's (absent) time.
    assert stored[0]["duration_ms"] is None


CONFTEST = '''
import json, os


def pytest_runtest_logreport(report):
    if report.when != "call" and not (report.when == "setup" and report.skipped):
        return
    file, _, name = report.nodeid.partition("::")
    status = "fail" if report.failed else "skip" if report.skipped else "pass"
    line = {"event": "finished", "name": name, "file": file, "status": status,
            "duration_ms": int(report.duration * 1000), "failure": str(report.longrepr) if report.failed else None}
    with open(os.path.join(os.environ["HORIZON_TEST_REPORT_DIR"], "r.jsonl"), "a") as out:
        out.write(json.dumps(line) + "\\n")
'''

TESTS = """
def test_fail():
    assert 1 == 2


def test_ok():
    pass


class TestY:
    def test_a(self):
        pass
"""


def test_a_real_pytest_run_writing_jsonl_stores_one_row_per_test(ws, monkeypatch):
    """The farm injects --junitxml into every pytest, so a JSON-lines plugin
    always meets pytest's own xunit2 report."""
    (ws / "pytest.ini").write_text("")
    (ws / "conftest.py").write_text(CONFTEST)
    (ws / "test_m.py").write_text(TESTS)

    stored, _, _ = run(ws, monkeypatch, f"{PY} -m pytest -q -p no:cacheprovider", fails=True)

    assert sorted((r["suite"], r["file"], r["test"], r["status"]) for r in stored) == [
        ("test_m", None, "test_fail", "fail"),
        ("test_m", None, "test_ok", "pass"),
        ("test_m.TestY", None, "test_a", "pass"),
    ]


# ---- guardrail 3: no workspace .jsonl is ever read ----


def test_a_workspace_jsonl_is_never_read(ws, monkeypatch):
    line = json.dumps(finished("from the workspace", status="fail", failure="x"))
    (ws / "test-results").mkdir()
    command = f"echo '{line}' > r.jsonl; echo '{line}' > test-results/r.jsonl; echo '{line}' > junit.jsonl; exit 0"

    stored, _, _ = run(ws, monkeypatch, command, fails=False)

    assert [r["file"] for r in stored] == [None]
    assert all(r["test"] != "from the workspace" for r in stored)
