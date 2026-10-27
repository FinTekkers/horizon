"""HZ-605: a failed check lists its failing tests above the log tail — each
as `<suite> › <test> — <first failure-message line>`, at most 10, then
`+N more` — and test_result stores that first line.

The list is built from the JUnit rows run_checks already holds when it
raises CheckFailure, so it lands in both the message (the build step's /fail
error) and the tail (pre-merge's gate message)."""

import subprocess
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import HEADLINE_PREFIX, CheckFailure, failing_tests_block, output_tail, parse_junit, run_checks


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)
    # One attempt: the rows and output shown are the first run's.
    monkeypatch.setenv(checks.RERUN_ENV, "0")


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


def report(path: Path, cases: list[tuple[str, str, str | None]], suite: str = "LedgerTest") -> Path:
    """A JUnit report: one failing <testcase> per (suite, test, message);
    message None writes a <failure> with no message and no text."""
    body = []
    for case_suite, test, message in cases:
        failure = "<failure/>" if message is None else f'<failure message="{message}">stack trace</failure>'
        body.append(f'<testsuite name="{case_suite}"><testcase name="{test}">{failure}</testcase></testsuite>')
    body.append(f'<testsuite name="{suite}"><testcase name="passes"/></testsuite>')
    path.write_text(f"<testsuites>{''.join(body)}</testsuites>")
    return path


def fail_with(ws, monkeypatch, command: str) -> CheckFailure:
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)
    return err.value


def rows(count: int, message: str | None = "boom") -> list[dict]:
    return [
        {"suite": "S", "file": None, "test": f"t{i}", "status": "fail", "failure_message": message}
        for i in range(1, count + 1)
    ]


# ---- metric 1: three failing tests, above the log tail ----


def test_three_failing_tests_are_listed_above_the_log_tail(ws, tmp_path, monkeypatch):
    xml = report(
        tmp_path / "r.xml",
        [
            ("PositionAPIGRPCImplPriceLookbackTest", "search_sameDayPrice_valuedWithoutWarning", "MARKET_VALUE set on the bond"),
            ("PositionAPIGRPCImplPriceLookbackTest", "search_olderPrice_warns", "expected a warning&#10;but got none"),
            ("LedgerTest", "posts_once", "expected 1 but was 2"),
        ],
    )
    noise = "; ".join(f"echo out-line-{i}" for i in range(1, 61))

    exc = fail_with(ws, monkeypatch, f'cp {xml} "$HORIZON_TEST_REPORT_DIR/r.xml"; {noise}; exit 1')

    block = (
        "failing tests (3):\n"
        "PositionAPIGRPCImplPriceLookbackTest › search_sameDayPrice_valuedWithoutWarning — MARKET_VALUE set on the bond\n"
        "PositionAPIGRPCImplPriceLookbackTest › search_olderPrice_warns — expected a warning\n"
        "LedgerTest › posts_once — expected 1 but was 2"
    )
    assert exc.tail.startswith(block + "\n")
    # Guardrail 1: the log tail stays, below the list, unchanged.
    assert exc.tail[len(block) + 1 :] == output_tail("\n".join(f"out-line-{i}" for i in range(1, 61)))
    assert exc.tail.index("failing tests (3):") < exc.tail.index("out-line-60")


# ---- metric 2: at most 10, then +N more ----


def test_twelve_failing_tests_list_exactly_ten_then_plus_two_more():
    block = failing_tests_block(rows(12), secrets={})

    lines = block.split("\n")
    assert lines[0] == "failing tests (12):"
    assert lines[1:11] == [f"S › t{i} — boom" for i in range(1, 11)]
    assert lines[11:] == ["+2 more"]


def test_ten_failing_tests_have_no_more_line_and_passes_are_never_listed():
    passing = [{**row, "status": "pass"} for row in rows(3)]
    block = failing_tests_block(rows(10) + passing, secrets={})
    assert block.split("\n")[0] == "failing tests (10):"
    assert len(block.split("\n")) == 11 and "more" not in block


# ---- metric 3: the build step's message lists them above the digest ----


def test_the_check_message_lists_the_failing_tests_between_the_command_and_the_digest(ws, tmp_path, monkeypatch):
    xml = report(tmp_path / "r.xml", [("LedgerTest", "posts_once", "expected 1 but was 2")])

    exc = fail_with(ws, monkeypatch, f"cp {xml} \"$HORIZON_TEST_REPORT_DIR/r.xml\"; echo 'not ok 1 - posts_once'; exit 1")

    lines = str(exc).split("\n")
    assert lines[0].startswith(HEADLINE_PREFIX)
    assert lines[1].startswith("(sh -c cp ")
    assert lines[2:4] == ["failing tests (1):", "LedgerTest › posts_once — expected 1 but was 2"]
    assert "\n".join(lines[4:]) == exc.digest
    assert "not ok 1 - posts_once" in exc.digest


# ---- metric 4: only the first line of a multi-line message is stored ----


def test_a_multi_line_failure_message_stores_only_its_first_line(ws, tmp_path):
    path = tmp_path / "r.xml"
    path.write_text(
        '<testsuite name="S">'
        '<testcase name="multi"><failure message="line one&#10;line two">trace</failure></testcase>'
        '<testcase name="blank first"><error message="&#10;  &#13;&#10;the real line&#13;&#10;next"/></testcase>'
        '<testcase name="text only"><failure>\n  first text line\nsecond</failure></testcase>'
        '<testcase name="nothing"><failure/></testcase>'
        '<testcase name="long"><failure message="' + "x" * 1000 + '"/></testcase>'
        '<testcase name="passes"/>'
        "</testsuite>"
    )

    messages = {row["test"]: row["failure_message"] for row in parse_junit(path, ws)}

    assert messages["multi"] == "line one"
    assert messages["blank first"] == "the real line"
    # No message attribute: the first line of the failure's text.
    assert messages["text only"] == "first text line"
    assert messages["nothing"] is None
    assert messages["passes"] is None


def test_the_stored_row_carries_the_first_line_only_cut_to_the_cap(ws, tmp_path, monkeypatch):
    xml = report(tmp_path / "r.xml", [("S", "multi", "line one&#10;line two"), ("S", "long", "x" * 1000)])
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {xml} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    stored = {row["test"]: row["failure_message"] for row in test_runs[0]["tests"]}
    assert stored == {"multi": "line one", "long": "x" * checks.FAILURE_MESSAGE_MAX_CHARS, "passes": None}


# ---- guardrail 3: no per-test results, or no message ----


def test_with_no_per_test_results_the_message_and_tail_are_as_before(ws, monkeypatch):
    output = "\n".join(f"line {i}" for i in range(1, 61)) + "\nnot ok 1 - x\n# fail 1"

    exc = fail_with(ws, monkeypatch, "for i in $(seq 1 60); do echo \"line $i\"; done; echo 'not ok 1 - x'; echo '# fail 1'; exit 1")

    assert "failing tests" not in str(exc) and "failing tests" not in exc.tail
    assert exc.tail == output_tail(output)
    assert str(exc) == f"{HEADLINE_PREFIX}{exc.headline}\n({exc.command})\n{exc.digest}"


def test_a_failing_test_with_no_stored_message_lists_without_the_dash():
    block = failing_tests_block(
        [
            {"suite": "S", "file": None, "test": "old row", "status": "fail"},
            {"suite": None, "file": "a.test.mjs", "test": "no suite", "status": "fail", "failure_message": None},
            # _test_rows()' row for a command with no report is not a test.
            {"suite": None, "file": None, "test": "sh -c npm test", "status": "fail", "failure_message": None},
        ],
        secrets={},
    )
    assert block == "failing tests (2):\nS › old row\na.test.mjs › no suite"


def test_a_secret_straddling_the_cut_is_redacted_before_it():
    secret = "s3cr3t-value-" * 3
    message = "y" * (checks.FAILURE_MESSAGE_MAX_CHARS - 10) + secret
    entry = failing_tests_block(rows(1, message), secrets={"T": secret})
    stored = checks._test_rows(
        [{"suite": "S", "file": None, "test": "t", "status": "fail", "duration_ms": 1, "failure_message": message}],
        "cmd",
        1,
        0.1,
        attempt=1,
        secrets={"T": secret},
    )
    assert "s3cr3t" not in entry and "s3cr3t" not in stored[0]["failure_message"]
    assert len(stored[0]["failure_message"]) == checks.FAILURE_MESSAGE_MAX_CHARS


def test_a_long_entry_is_cut_and_marked():
    block = failing_tests_block(rows(1, "y" * 500), secrets={})
    entry = block.split("\n")[1]
    assert len(entry) == checks.FAILING_TEST_LINE_MAX_CHARS and entry.endswith("…")


# ---- redaction: failure text is safe to store and show ----


def test_a_secret_in_a_failure_message_is_redacted_in_the_list_and_the_stored_row(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_TOKEN", "abcd1234efgh")
    xml = report(tmp_path / "r.xml", [("S", "leaks", "got abcd1234efgh back")])
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {xml} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert "abcd1234efgh" not in str(err.value) and "abcd1234efgh" not in err.value.tail
    assert "S › leaks — got [redacted] back" in err.value.tail
    assert [row["failure_message"] for row in test_runs[0]["tests"]] == ["got [redacted] back", None]


def _git(cwd, *args):
    return subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def test_a_secret_in_a_branch_commands_failure_message_is_redacted(tmp_path, monkeypatch):
    """R6: the branch command's first attempt (_run_branch_command) redacts
    the message in _branch_failure()'s list and in branch_run["tests"]."""
    monkeypatch.setenv("FAKE_TOKEN", "abcd1234efgh")
    seed = tmp_path / "seed"
    (seed / "scripts" / "checks").mkdir(parents=True)
    (seed / "scripts" / "checks" / "test.sh").write_text("exit 0\n")
    _git(seed, "init", "-q", "-b", "main")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "main")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(origin), str(ws)], check=True)
    _git(ws, "checkout", "-q", "-b", "horizon/hz-605")
    xml = '<testsuite name="LedgerTest"><testcase name="leaks"><failure message="token abcd1234efgh&#10;more"/></testcase></testsuite>'
    (ws / "scripts" / "checks" / "test.sh").write_text(f"echo '{xml}' > \"$HORIZON_TEST_REPORT_DIR/r.xml\"; exit 1\n")
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(
            ws,
            log=lambda *_: None,
            configured={"test": "git show origin/main:scripts/checks/test.sh | sh"},
            test_runs=test_runs,
            branch_notes=[],
        )

    assert err.value.headline.startswith("branch test.sh")
    assert "abcd1234efgh" not in str(err.value) and "abcd1234efgh" not in err.value.tail
    assert "failing tests (1):\nLedgerTest › leaks — token [redacted]" in str(err.value)
    assert err.value.tail.startswith("failing tests (1):\nLedgerTest › leaks — token [redacted]\n")
    branch = next(run for run in test_runs if run["label"] == "branch")
    assert [row["failure_message"] for row in branch["tests"]] == ["token [redacted]"]
