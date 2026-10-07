"""HZ-327: the farm's one rerun of a failing check, the flake records it
makes, and the per-test rows every check run stores.

The stub commands keep their attempt counter and their inputs OUTSIDE the
workspace, so nothing the test does edits the tree being checked."""

import re
import subprocess
import time
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, flaky_test_name, rerun_command, run_checks

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_XML = Path(__file__).resolve().parent / "fixtures" / "junit" / "report.xml"


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    """Own slot dir per test, the real limiter, and the rerun at its default
    (unset), which is what the first case below proves is on."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


class Stub:
    """A check command whose behaviour depends on which attempt this is."""

    def __init__(self, tmp_path: Path, attempts: dict[int, str]):
        root = tmp_path / "stub"
        root.mkdir(exist_ok=True)
        self.counter = root / "attempts"
        self.argv_log = root / "argv"
        script = root / "check.sh"
        cases = "\n".join(f"  {n}) {body} ;;" for n, body in attempts.items())
        script.write_text(
            f'n=$(cat {self.counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > {self.counter}\n'
            f'echo "$@" >> {self.argv_log}\ncase $n in\n{cases}\nesac\n'
        )
        self.command = f"sh {script}"

    @property
    def runs(self) -> int:
        return int(self.counter.read_text()) if self.counter.exists() else 0


def check(ws, monkeypatch, stub: Stub, **kwargs):
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    flakes: list = []
    test_runs: list = []
    logs: list = []
    note = run_checks(ws, log=logs.append, flakes=flakes, test_runs=test_runs, **kwargs)
    return note, flakes, test_runs, logs


def git(ws, *args):
    return subprocess.run(
        ["git", "-C", str(ws), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


# ---- metric 1: the rerun ----


def test_fail_then_pass_passes_with_two_runs_one_flake_and_both_outputs(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "echo first-attempt-output; exit 1", 2: "echo second-attempt-output; exit 0"})

    note, flakes, _runs, logs = check(ws, monkeypatch, stub)

    assert note == "1 repo check(s) passed"
    assert stub.runs == 2
    assert len(flakes) == 1
    assert "first-attempt-output" in flakes[0]["first_output"]
    assert "second-attempt-output" in flakes[0]["rerun_output"]
    assert flakes[0]["command"] == f"sh -c {stub.command}"
    assert any("failed then passed on rerun" in line for line in logs)


def test_fail_twice_raises_as_today_and_records_no_flake(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "echo boom; exit 1", 2: "echo boom again; exit 1"})

    with pytest.raises(CheckFailure) as err:
        check(ws, monkeypatch, stub)

    assert err.value.reason == "failed"
    assert "boom again" in err.value.tail
    assert stub.runs == 2


def test_fail_twice_leaves_the_flakes_list_empty(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "exit 1", 2: "exit 1"})
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    flakes: list = []
    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, flakes=flakes)
    assert flakes == []


@pytest.mark.parametrize(
    "cmd, rerun",
    [
        (["sh", "-c", "python -m pytest -q"], ["sh", "-c", "python -m pytest -q --lf"]),
        (["sh", "-c", "npx playwright test"], ["sh", "-c", "npx playwright test --last-failed"]),
        (["sh", "-c", "npm test"], ["sh", "-c", "npm test"]),
        (["sh", "-c", "npm test && pytest -q"], ["sh", "-c", "npm test && pytest -q"]),
        (["sh", "-c", "pytest -q --lf"], ["sh", "-c", "pytest -q --lf"]),
        (["/usr/bin/python3", "-m", "pytest", "-q"], ["/usr/bin/python3", "-m", "pytest", "-q", "--lf"]),
    ],
)
def test_rerun_command_narrows_only_where_the_runner_can(cmd, rerun):
    assert rerun_command(cmd) == rerun


@pytest.mark.parametrize(
    "output, name",
    [
        ("ok 1 - fine\n✖ the board stream carries no step output at all (12.3ms)\n", "the board stream carries no step output at all"),
        ("✖ failing tests:\n\n✖ a later name (4ms)", "a later name"),
        ("ok 1 - fine\nnot ok 2 - the board stream carries no step output at all\n", "the board stream carries no step output at all"),
        ("FAILED farm/tests/test_x.py::test_y - AssertionError", "farm/tests/test_x.py::test_y"),
        ("  ✘  3 [chromium] › tests/01-board.spec.js:10:5 › board › shows items (1.2s)", "shows items"),
        ("all good\n12 passed", None),
    ],
)
def test_flaky_test_name_reads_the_failing_test_or_none(output, name):
    assert flaky_test_name(output) == name


def test_a_flake_with_no_report_is_named_from_the_output(ws, tmp_path, monkeypatch):
    stub = Stub(
        tmp_path,
        {1: "echo '✖ the board stream carries no step output at all (12.3ms)'; exit 1", 2: "exit 0"},
    )
    _note, flakes, _runs, _logs = check(ws, monkeypatch, stub)
    assert [f["test"] for f in flakes] == ["the board stream carries no step output at all"]


def test_an_oversize_flake_is_capped_after_redaction_and_the_list_at_twenty(ws, tmp_path, monkeypatch):
    long_line = "x" * 300
    failing = "".join(f'<testcase name="t{i}" time="0.1"><failure/></testcase>' for i in range(25))
    passing = "".join(f'<testcase name="t{i}" time="0.1"/>' for i in range(25))
    (tmp_path / "first.xml").write_text(f"<testsuites><testsuite name='s'>{failing}</testsuite></testsuites>")
    (tmp_path / "second.xml").write_text(f"<testsuites><testsuite name='s'>{passing}</testsuite></testsuites>")
    loud = f'for i in $(seq 1 2000); do echo "$i {long_line}"; done'
    stub = Stub(
        tmp_path,
        {
            1: f'{loud}; cp {tmp_path / "first.xml"} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1',
            2: f'{loud}; cp {tmp_path / "second.xml"} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 0',
        },
    )

    _note, flakes, _runs, _logs = check(ws, monkeypatch, stub)

    assert len(flakes) == checks.FLAKES_MAX == 20
    for flake in flakes:
        assert len(flake["first_output"]) <= checks.FLAKE_OUTPUT_MAX_CHARS
        assert len(flake["rerun_output"]) <= checks.FLAKE_OUTPUT_MAX_CHARS
        assert len(flake["test"]) <= checks.FLAKE_TEST_MAX_CHARS
        assert len(flake["command"]) <= checks.FLAKE_COMMAND_MAX_CHARS
    assert "2000 " in flakes[0]["first_output"]  # the tail is what is kept


def test_a_rerun_that_times_out_is_a_real_failure_not_a_timeout(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    stub = Stub(tmp_path, {1: "echo first; exit 1", 2: "sleep 5"})
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    flakes: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, flakes=flakes)

    assert err.value.reason == "failed"
    assert flakes == []
    assert stub.runs == 2


# ---- guardrails ----


def test_playwright_retries_stay_zero():
    config = (REPO_ROOT / "e2e" / "playwright.config.js").read_text()
    assert re.search(r"^\s*retries:\s*0,", config, re.MULTILINE)


def test_the_rerun_is_on_the_same_tree_with_no_edits_in_between(ws, tmp_path, monkeypatch):
    (ws / "a.txt").write_text("hello\n")
    git(ws, "init", "-q")
    git(ws, "add", "-A")
    git(ws, "commit", "-qm", "base")
    (ws / "a.txt").write_text("uncommitted work\n")  # the implement step tests uncommitted work
    head, status = git(ws, "rev-parse", "HEAD"), git(ws, "status", "--porcelain")
    stub = Stub(tmp_path, {1: "exit 1", 2: "exit 0"})

    _note, flakes, test_runs, _logs = check(ws, monkeypatch, stub)

    assert stub.runs == 2
    assert git(ws, "rev-parse", "HEAD") == head
    assert git(ws, "status", "--porcelain") == status
    assert flakes[0]["commit_sha"] == head.strip()
    assert flakes[0]["tree_sha"] == test_runs[0]["tree_sha"] is not None


def test_a_first_run_timeout_never_reruns_or_records_a_flake(ws, tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    stub = Stub(tmp_path, {1: "sleep 5", 2: "exit 0"})
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    flakes: list = []
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, flakes=flakes, test_runs=test_runs)

    assert err.value.reason == "timed_out"
    assert stub.runs == 1
    assert flakes == []
    assert test_runs[0]["tests"] == []  # a timeout is no test result either


def test_a_missing_runner_never_runs_or_records_a_flake(ws, monkeypatch):
    class NoRunners:
        TimeoutExpired = subprocess.TimeoutExpired
        PIPE = subprocess.PIPE

        @staticmethod
        def Popen(cmd, **_kwargs):
            raise FileNotFoundError(cmd[0])

    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")
    monkeypatch.setattr(checks, "subprocess", NoRunners)
    flakes: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, flakes=flakes)

    assert err.value.reason == "none_ran"
    assert flakes == []


def test_a_command_the_shell_cannot_find_is_not_rerun(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "exit 127", 2: "exit 0"})
    with pytest.raises(CheckFailure):
        check(ws, monkeypatch, stub)
    assert stub.runs == 1


def test_a_planted_token_never_reaches_either_flake_output(ws, tmp_path, monkeypatch):
    secret = "ghp_" + "b2" * 18
    monkeypatch.setenv("GITHUB_TOKEN", secret)
    (tmp_path / "leak").write_text(secret)
    stub = Stub(
        tmp_path,
        {1: f'echo "token: $(cat {tmp_path / "leak"})"; exit 1', 2: f'echo "token: $(cat {tmp_path / "leak"})"; exit 0'},
    )

    _note, flakes, _runs, _logs = check(ws, monkeypatch, stub)

    assert secret not in flakes[0]["first_output"] and secret not in flakes[0]["rerun_output"]
    assert "token: [redacted]" in flakes[0]["first_output"]


# ---- metric 4: per-test rows from JUnit XML ----


def test_fixture_xml_gives_the_expected_rows(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: f'test -n "$HORIZON_TEST_REPORT_DIR" && cp {FIXTURE_XML} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 0'})

    _note, _flakes, test_runs, _logs = check(ws, monkeypatch, stub)

    command = f"sh -c {stub.command}"
    assert len(test_runs) == 1 and test_runs[0]["check_run"]
    assert test_runs[0]["tests"] == [
        {"suite": None, "file": "server/test/item-stream.test.mjs", "test": "the board stream carries no step output at all",
         "status": "fail", "duration_ms": 12, "command": command, "attempt": 1},
        {"suite": "stream > deltas", "file": "server/test/item-stream.test.mjs", "test": "a delta names the changed item",
         "status": "pass", "duration_ms": 4, "command": command, "attempt": 1},
        {"suite": "stream > deltas", "file": "server/test/item-stream.test.mjs", "test": "a todo case",
         "status": "skip", "duration_ms": 0, "command": command, "attempt": 1},
        {"suite": "src/components/AdminPage.test.jsx", "file": None, "test": "AdminPage > renders",
         "status": "fail", "duration_ms": 250, "command": command, "attempt": 1},
    ]


def test_an_absolute_report_path_inside_the_workspace_is_stored_relative(ws, tmp_path, monkeypatch):
    xml = f'<testsuites><testcase name="t" file="{ws}/server/test/a.test.mjs" time="0.001"/></testsuites>'
    (tmp_path / "abs.xml").write_text(xml)
    stub = Stub(tmp_path, {1: f'cp {tmp_path / "abs.xml"} "$HORIZON_TEST_REPORT_DIR/r.xml"'})

    _note, _flakes, test_runs, _logs = check(ws, monkeypatch, stub)

    assert test_runs[0]["tests"][0]["file"] == "server/test/a.test.mjs"


def test_a_malformed_report_is_logged_and_leaves_the_result_unchanged(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: 'echo "<testsuites><testcase" > "$HORIZON_TEST_REPORT_DIR/bad.xml"; exit 0'})

    note, _flakes, test_runs, logs = check(ws, monkeypatch, stub)

    assert note == "1 repo check(s) passed"
    assert any("could not read test report bad.xml" in line for line in logs)
    assert [row["test"] for row in test_runs[0]["tests"]] == [f"sh -c {stub.command}"]


def test_a_malformed_report_on_a_failing_command_still_fails(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: 'echo "<oops" > "$HORIZON_TEST_REPORT_DIR/bad.xml"; exit 1', 2: "exit 1"})
    with pytest.raises(CheckFailure) as err:
        check(ws, monkeypatch, stub)
    assert err.value.reason == "failed"


def test_a_command_with_no_report_stores_one_row_for_the_command(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "exit 0"})

    _note, _flakes, test_runs, _logs = check(ws, monkeypatch, stub)

    [row] = test_runs[0]["tests"]
    assert row["test"] == row["command"] == f"sh -c {stub.command}"
    assert (row["suite"], row["file"], row["status"], row["attempt"]) == (None, None, "pass", 1)
    assert isinstance(row["duration_ms"], int)


def test_a_failed_run_still_stores_its_rows(ws, tmp_path, monkeypatch):
    stub = Stub(tmp_path, {1: "exit 1", 2: "exit 1"})
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    test_runs: list = []
    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)
    assert [(r["status"], r["attempt"]) for r in test_runs[0]["tests"]] == [("fail", 1), ("fail", 2)]


def test_the_report_dir_is_removed_after_the_command(ws, tmp_path, monkeypatch):
    seen = tmp_path / "seen-dir"
    stub = Stub(tmp_path, {1: f'echo "$HORIZON_TEST_REPORT_DIR" > {seen}'})
    check(ws, monkeypatch, stub)
    report_dir = Path(seen.read_text().strip())
    assert report_dir.name.startswith("horizon-test-report-") and not report_dir.exists()
    assert not str(report_dir).startswith(str(ws))


# ---- metric 5: a rerun flake names the test its report names ----


def test_a_rerun_flake_names_the_test_from_the_report(ws, tmp_path, monkeypatch):
    first = '<testsuites><testsuite name="g" file="f.test.mjs"><testcase name="flaky one"><failure/></testcase><testcase name="steady"/></testsuite></testsuites>'
    second = '<testsuites><testsuite name="g" file="f.test.mjs"><testcase name="flaky one"/></testsuite></testsuites>'
    (tmp_path / "first.xml").write_text(first)
    (tmp_path / "second.xml").write_text(second)
    stub = Stub(
        tmp_path,
        {
            1: f'cp {tmp_path / "first.xml"} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1',
            2: f'cp {tmp_path / "second.xml"} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 0',
        },
    )

    _note, flakes, test_runs, _logs = check(ws, monkeypatch, stub)

    assert [(f["suite"], f["file"], f["test"]) for f in flakes] == [("g", "f.test.mjs", "flaky one")]
    assert flakes[0]["check_run"] == test_runs[0]["check_run"]
    rows = [(r["test"], r["status"], r["attempt"]) for r in test_runs[0]["tests"]]
    assert rows == [("flaky one", "fail", 1), ("steady", "pass", 1), ("flaky one", "pass", 2)]


def test_recording_nothing_when_no_lists_are_passed(ws, tmp_path, monkeypatch):
    """validate.py and the other existing callers pass no lists: the rerun
    still happens, nothing is collected, and no tree snapshot is taken."""
    stub = Stub(tmp_path, {1: "exit 1", 2: "exit 0"})
    monkeypatch.setenv("FARM_CHECK_CMD", stub.command)
    monkeypatch.setattr(checks.check_record, "tested_commit", lambda *a, **k: pytest.fail("no snapshot without lists"))
    assert run_checks(ws, log=lambda *_: None) == "1 repo check(s) passed"
    assert stub.runs == 2


def test_recording_adds_little_time_to_a_run(ws, tmp_path, monkeypatch):
    (ws / "a.txt").write_text("x\n")
    git(ws, "init", "-q")
    git(ws, "add", "-A")
    git(ws, "commit", "-qm", "base")
    stub = Stub(tmp_path, {1: f'cp {FIXTURE_XML} "$HORIZON_TEST_REPORT_DIR/r.xml"'})

    started = time.monotonic()
    check(ws, monkeypatch, stub)
    assert time.monotonic() - started < 5
