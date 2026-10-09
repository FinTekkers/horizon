"""HZ-366: a failed check's message starts with one line saying what failed —
the runner's counts and the first failing tests — so the step's event, the
pause banner and the Autopilot ping (each shows only the start of it) lead
with the result, not with an earlier command's all-pass summary.

fixtures/check_output/hz365_e2e.txt is HZ-365's real check result as the farm
logged it on 9 Oct (the digest of `npm run test:e2e`, host paths replaced by
<ws>). hz365_message.txt is the message run_checks builds from it; the server
tests (fail route, caretaker ping) read that same file, so the wording each
side expects cannot drift apart."""

import os
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, failure_digest, failure_headline, run_checks

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "check_output"
HZ365_OUTPUT = FIXTURES / "hz365_e2e.txt"
HZ365_MESSAGE = FIXTURES / "hz365_message.txt"


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


def junit(path: Path, cases: list[tuple[str, str]], file: str = "e2e/tests/a.spec.js") -> Path:
    """A JUnit report with one <testcase> per (title, status)."""
    body = {"fail": "<failure/>", "skip": "<skipped/>", "pass": ""}
    rows = "".join(f'<testcase name="{title}" file="{file}">{body[status]}</testcase>' for title, status in cases)
    path.write_text(f'<testsuites><testsuite name="s">{rows}</testsuite></testsuites>')
    return path


def row(test: str, status: str, file: str | None = "a.spec.js", suite: str | None = "s") -> dict:
    return {"suite": suite, "file": file, "test": test, "status": status}


def fake_npm(tmp_path: Path, monkeypatch, body: str) -> None:
    """An `npm` on PATH that runs `body`, so the command shown is the real
    `npm run test:e2e --silent` HZ-365 ran."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    npm = bin_dir / "npm"
    npm.write_text(f"#!/bin/sh\n{body}\n")
    npm.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")


# ---- metric 1: stored per-test results ----


def test_headline_from_stored_rows():
    rows = [row(f"failing test number {i}", "fail") for i in range(7)]
    rows += [row(f"passing {i}", "pass") for i in range(71)]
    rows += [row("skipped one", "skip")]
    # _test_rows()'s one row for a command with no report: not a test.
    rows += [row("sh -c npm run test:e2e --silent", "fail", file=None, suite=None)]

    headline = failure_headline(rows, "", "sh -c npm run test:e2e --silent")

    assert "\n" not in headline
    assert headline.startswith("e2e: 7 failed, 71 passed: a.spec.js ")
    assert headline.count('"') == 10  # exactly 5 tests, quoted
    assert headline.endswith(", …")
    assert len(headline) <= checks.HEADLINE_MAX_CHARS


def test_stored_rows_take_their_line_from_the_playwright_location():
    rows = [row("HZ-365: Amend the rule asks for the gate PIN", "fail", file=None, suite="31-rule-block.spec.js")]
    output = "  1 failed\n    [chromium] › tests/31-rule-block.spec.js:154:1 › HZ-365: Amend the rule asks for the gate PIN\n"

    headline = failure_headline(rows, output, "npm run test:e2e")

    assert headline == 'e2e: 1 failed, 0 passed: tests/31-rule-block.spec.js:154 "HZ-365: Amend the rule asks for the gate PIN"'


def test_a_long_command_synthetic_row_never_counts(ws, monkeypatch):
    """The stored row's `test` is the command cut at TEST_NAME_MAX_CHARS, so it
    can't be told apart by comparing it with the command."""
    command = f"x={'a' * (checks.TEST_NAME_MAX_CHARS + 50)}; echo boom; exit 1"
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    rows = test_runs[0]["tests"]
    assert len(rows) == 1 and rows[0]["test"] != f"sh -c {command}"
    assert failure_headline(rows, "boom", f"sh -c {command}") is None
    assert err.value.headline == ""
    assert str(err.value) == f"repo checks failed (sh -c {command}):\n{failure_digest('boom')}"


# ---- metric 2: the runner's own summary ----

PLAYWRIGHT = """\
  1) [chromium] › tests/a.spec.js:12:3 › suite › opens the page ───────
    Error: expect(locator).toBeVisible() failed
  3 failed
    [chromium] › tests/a.spec.js:12:3 › suite › opens the page
    [chromium] › tests/a.spec.js:40:3 › suite › saves the form
    [chromium] › tests/b.spec.js:7:1 › signs in
  1 flaky
    [chromium] › tests/c.spec.js:9:1 › sometimes slow
  20 passed (41.2s)
"""

NODE_TAP = """\
TAP version 13
ok 1 - parses an empty file
not ok 2 - rejects a bad PIN
  ---
  ...
not ok 3 - keeps the queue order # took 12ms
# tests 9
# pass 7
# fail 2
"""

NODE_SPEC = """\
✔ parses an empty file (1.2ms)
✖ rejects a bad PIN (3.4ms)
ℹ tests 5
ℹ pass 4
ℹ fail 1
✖ failing tests:
✖ rejects a bad PIN (3.4ms)
"""

PYTEST = """\
........F....F
FAILED farm/tests/test_a.py::test_one - AssertionError: no
FAILED farm/tests/test_b.py::test_two[case] - KeyError: 'x'
2 failed, 120 passed, 3 skipped in 4.20s
"""

GRADLE = """\
> Task :app:test

LedgerTest > postsAJournal() FAILED
    org.opentest4j.AssertionFailedError at LedgerTest.java:42

12 tests completed, 1 failed, 2 skipped

> Task :app:test FAILED

BUILD FAILED in 9s
"""


@pytest.mark.parametrize(
    ("output", "shown", "expected"),
    [
        (
            PLAYWRIGHT,
            "sh -c npm run test:e2e --silent",
            'e2e: 3 failed, 20 passed: tests/a.spec.js:12 "opens the page", :40 "saves the form", '
            'tests/b.spec.js:7 "signs in"',
        ),
        (NODE_TAP, "sh -c npm test", 'test: 2 failed, 7 passed: "rejects a bad PIN", "keeps the queue order"'),
        (NODE_SPEC, "node --test", 'node: 1 failed, 4 passed: "rejects a bad PIN"'),
        (
            PYTEST,
            "sh -c /venv/bin/python -m pytest -q",
            'pytest: 2 failed, 120 passed: farm/tests/test_a.py "test_one", farm/tests/test_b.py "test_two[case]"',
        ),
        (GRADLE, "sh -c ./gradlew check", 'gradle: 1 failed, 9 passed: LedgerTest "postsAJournal()"'),
    ],
    ids=["playwright", "node-tap", "node-spec", "pytest", "gradle"],
)
def test_headline_from_runner_summary(output, shown, expected):
    assert failure_headline([], output, shown) == expected


def test_names_with_no_count_never_get_a_count():
    assert failure_headline([], "not ok 1 - the one\n", "sh -c npm test") == 'test: failed: "the one"'


def test_hz365_output_leads_with_what_failed(ws, tmp_path, monkeypatch):
    fake_npm(tmp_path, monkeypatch, f"cat {HZ365_OUTPUT}; exit 1")
    monkeypatch.setenv("FARM_CHECK_CMD", "npm run test:e2e --silent")

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)

    message = str(err.value)
    assert "2 failed" in message[:200]
    assert "31-rule-block.spec.js:131" in message[:200]
    assert message.splitlines()[0] == f"repo checks failed: {err.value.headline}"
    assert message.splitlines()[1] == "(sh -c npm run test:e2e --silent)"
    # The shared fixture the server's fail-route and caretaker tests read.
    assert message == HZ365_MESSAGE.read_text()


# ---- metric 3: zero-failure summaries go last ----


def test_digest_puts_zero_failure_summaries_last():
    output = "# tests 4\n# pass 4\n# fail 0\nsome context\nnot ok 7 - the real one\n  2 failed\n  71 passed (2.8m)\n"

    lines = failure_digest(output).splitlines()

    zero = [lines.index(line) for line in ("# tests 4", "# pass 4", "# fail 0", "  71 passed (2.8m)")]
    failing = [lines.index(line) for line in ("not ok 7 - the real one", "  2 failed")]
    assert min(zero) > max(failing)
    assert lines.index("some context") < lines.index("not ok 7 - the real one")


# ---- guardrails ----


def test_no_headline_keeps_todays_message(ws, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "echo something broke; exit 1")
    monkeypatch.setenv(checks.RERUN_ENV, "0")

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)

    digest = failure_digest("something broke")
    assert str(err.value) == f"repo checks failed (sh -c echo something broke; exit 1):\n{digest}"
    assert err.value.digest == digest and err.value.headline == ""


def test_no_headline_when_only_zero_failure_summaries():
    output = "# tests 4\n# pass 4\n# fail 0\nℹ fail 0\n  71 passed (2.8m)\n3 passed in 0.10s\n0 tests completed, 0 failed\n"
    assert failure_headline([], output, "sh -c npm test") is None


def test_headline_redacts_a_secret_in_a_stored_test_title(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_TOKEN", "abcd1234efgh")
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    report = junit(tmp_path / "r.xml", [("got abcd1234efgh back", "fail"), ("fine", "pass")])
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {report} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)

    assert "abcd1234efgh" not in str(err.value)
    assert err.value.headline == 'cp: 1 failed, 1 passed: e2e/tests/a.spec.js "got [redacted] back"'


# ---- guardrail: reruns unchanged, rows from the right attempt ----


def test_no_rerun_takes_the_headline_from_the_first_run(ws, tmp_path, monkeypatch):
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    report = junit(tmp_path / "r.xml", [("one", "fail"), ("two", "fail"), ("three", "pass")])
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {report} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')
    flakes: list = []
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, flakes=flakes, test_runs=test_runs)

    assert err.value.headline.startswith("cp: 2 failed, 1 passed: ")
    assert flakes == []
    assert {r["attempt"] for r in test_runs[0]["tests"]} == {1}


def test_a_failed_rerun_takes_the_headline_from_the_rerun(ws, tmp_path, monkeypatch):
    first = junit(tmp_path / "first.xml", [("one", "fail"), ("two", "fail"), ("three", "pass")])
    second = junit(tmp_path / "second.xml", [("one", "fail"), ("two", "pass"), ("three", "pass")])
    counter = tmp_path / "attempts"
    script = tmp_path / "check.sh"
    script.write_text(
        f"n=$(cat {counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {counter}\n"
        f'if [ $n = 1 ]; then cp {first} "$HORIZON_TEST_REPORT_DIR/r.xml"; '
        f'else cp {second} "$HORIZON_TEST_REPORT_DIR/r.xml"; fi\nexit 1\n'
    )
    monkeypatch.setenv("FARM_CHECK_CMD", f"sh {script}")
    flakes: list = []
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, flakes=flakes, test_runs=test_runs)

    assert counter.read_text().strip() == "2"  # one rerun, as before
    assert flakes == []
    assert [r["attempt"] for r in test_runs[0]["tests"]] == [1, 1, 1, 2, 2, 2]
    assert err.value.headline == 'sh: 1 failed, 2 passed: e2e/tests/a.spec.js "one"'
