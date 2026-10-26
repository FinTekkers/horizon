"""HZ-589: a failing check is rerun only when its failure looks flaky.

When every failing test in the JUnit failed on an assertion, the failure would
repeat: the command runs once and the CheckFailure goes straight to the fix
turn. A timeout, a browser or page crash, a connection error, an unclassified
failure or no per-test results at all still rerun once, as HZ-327 does. Each
decision is one log line.

The stub commands keep their attempt counter and fixture XML OUTSIDE the
workspace, as in test_checks_flake.py."""

import re
import subprocess
from pathlib import Path

import pytest

from farm import check_metrics, check_slots, checks
from farm.checks import CheckFailure, run_checks

DECISION = re.compile(r"^checks: .*(not re-running|re-running it once)")
OLD_LINE = "failed — rerunning it once"


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def records(monkeypatch):
    """The metrics records run_checks writes, captured instead of appended."""
    seen: list[dict] = []
    monkeypatch.setattr(check_metrics, "append_record", lambda record, *a, **k: seen.append(record))
    return seen


class Stub:
    """A check command whose behaviour depends on which attempt this is."""

    def __init__(self, tmp_path: Path, attempts: dict[int, str]):
        root = tmp_path / "stub"
        root.mkdir(exist_ok=True)
        self.counter = root / "attempts"
        script = root / "check.sh"
        cases = "\n".join(f"  {n}) {body} ;;" for n, body in attempts.items())
        script.write_text(
            f"n=$(cat {self.counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > {self.counter}\n"
            f"case $n in\n{cases}\nesac\n"
        )
        self.command = f"sh {script}"

    @property
    def runs(self) -> int:
        return int(self.counter.read_text()) if self.counter.exists() else 0


def xml_file(tmp_path: Path, name: str, cases: list[tuple[str, str]]) -> Path:
    """A JUnit report: each case is (test name, inner XML; "" for a pass)."""
    body = "".join(f'<testcase classname="e2e" name="{test}" time="0.1">{inner}</testcase>' for test, inner in cases)
    path = tmp_path / f"{name}.xml"
    path.write_text(f'<testsuites><testsuite name="board" file="e2e/board.spec.js">{body}</testsuite></testsuites>')
    return path


def writes(report: Path, code: int) -> str:
    return f'cp {report} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit {code}'


def check(ws, stub: Stub, **kwargs):
    flakes: list = []
    test_runs: list = []
    logs: list = []
    note = run_checks(ws, log=logs.append, configured={"e2e": stub.command}, flakes=flakes, test_runs=test_runs, **kwargs)
    return note, flakes, test_runs, logs


def failing(ws, stub: Stub, **kwargs):
    flakes: list = []
    test_runs: list = []
    logs: list = []
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=logs.append, configured={"e2e": stub.command}, flakes=flakes, test_runs=test_runs, **kwargs)
    return err.value, flakes, test_runs, logs


def decisions(logs: list[str]) -> list[str]:
    return [line for line in logs if DECISION.search(line)]


def failure(message: str = "", text: str = "", type_: str = "") -> str:
    attrs = "".join(f' {k}="{v}"' for k, v in (("message", message), ("type", type_)) if v)
    return f"<failure{attrs}>{text}</failure>"


PW_ASSERTION = failure(
    "expect(received).toBe(expected)",
    "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 2",
)
PW_EXPECT_WAIT = failure(
    "Timed out 5000ms waiting for expect(locator).toHaveText(expected)",
    'Error: Timed out 5000ms waiting for expect(locator).toHaveText(expected)\n\nExpected: "Done"\nReceived: "Pending"',
)
FLAKY = {
    "test-limit": failure("Test timeout of 30000ms exceeded."),
    "action-limit": failure("locator.click: Timeout 30000ms exceeded."),
    checks.FAILURE_CRASH: failure("page.goto: Target page, context or browser has been closed"),
    checks.FAILURE_NETWORK: failure("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/"),
}


# ---- metric 1: an all-assertion failure runs once and goes to the fix turn ----


def test_all_assertion_failures_run_once_and_raise(ws, tmp_path, records):
    report = xml_file(tmp_path, "a", [("shows the total", PW_ASSERTION), ("loads", "")])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: "exit 0"})

    err, flakes, test_runs, logs = failing(ws, stub)

    assert stub.runs == 1
    assert flakes == []
    assert test_runs[0]["commands"] == [{"command": f"sh -c {stub.command}", "attempt": 1, "exit_code": 1}]
    assert records[-1]["commands"][-1]["rerun"] == {"skipped": "failed on assertions"}
    assert "shows the total" in (err.headline or "") + (err.tail or "")
    assert decisions(logs) == ["checks: e2e failed on assertions in 1 test; not re-running"]


def test_a_playwright_expect_wait_counts_as_an_assertion(ws, tmp_path):
    report = xml_file(tmp_path, "a", [("shows done", PW_EXPECT_WAIT)])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: "exit 0"})

    _err, _flakes, _runs, logs = failing(ws, stub)

    assert stub.runs == 1
    assert decisions(logs) == ["checks: e2e failed on assertions in 1 test; not re-running"]


# ---- metric 2: a flaky kind beside an assertion reruns once ----


@pytest.mark.parametrize("kind", list(FLAKY))
def test_a_flaky_kind_plus_an_assertion_reruns_once(ws, tmp_path, kind):
    report = xml_file(tmp_path, "a", [("asserts", PW_ASSERTION), ("wobbles", FLAKY[kind])])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: writes(report, 1), 3: "exit 0"})

    _err, flakes, test_runs, _logs = failing(ws, stub)

    assert stub.runs == 2
    assert flakes == []
    assert [c["attempt"] for c in test_runs[0]["commands"]] == [1, 2]


def test_a_flaky_failure_classifies_by_kind():
    def kind(inner: str) -> str | None:
        return checks._failure_kind(checks.ET.fromstring(f"<testcase>{inner}</testcase>"))

    assert kind(FLAKY["test-limit"]) == checks.FAILURE_SLOW
    assert kind(FLAKY["action-limit"]) == checks.FAILURE_SLOW
    assert kind(FLAKY[checks.FAILURE_CRASH]) == checks.FAILURE_CRASH
    assert kind(FLAKY[checks.FAILURE_NETWORK]) == checks.FAILURE_NETWORK
    assert kind(PW_ASSERTION) == checks.FAILURE_ASSERTION
    assert kind(PW_EXPECT_WAIT) == checks.FAILURE_ASSERTION
    assert kind("<failure/>") == checks.FAILURE_UNKNOWN
    assert kind("") is None


# ---- metric 3: nothing to judge from reruns once ----


@pytest.mark.parametrize("shape", ["no-xml", "all-pass-xml"])
def test_no_per_test_results_reruns_once(ws, tmp_path, shape):
    first = "exit 1"
    if shape == "all-pass-xml":
        first = writes(xml_file(tmp_path, "a", [("loads", ""), ("renders", "")]), 1)
    stub = Stub(tmp_path, {1: first, 2: "exit 1"})

    _err, _flakes, _runs, logs = failing(ws, stub)

    assert stub.runs == 2
    assert decisions(logs) == ["checks: e2e failed with no per-test results; re-running it once on the same tree"]


def test_an_unclassified_failure_reruns_once(ws, tmp_path):
    report = xml_file(tmp_path, "a", [("asserts", PW_ASSERTION), ("odd", "<failure/>")])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: writes(report, 1)})

    _err, _flakes, _runs, logs = failing(ws, stub)

    assert stub.runs == 2
    assert decisions(logs) == [
        "checks: e2e failed with an unclassified failure in 1 of 2 tests; re-running it once on the same tree"
    ]


# ---- metric 4: one log line per decision, naming check, reason and count ----


@pytest.mark.parametrize(
    "cases, line",
    [
        (
            [("a", PW_ASSERTION), ("b", PW_ASSERTION), ("c", PW_EXPECT_WAIT)],
            "checks: e2e failed on assertions in 3 tests; not re-running",
        ),
        (
            [("a", PW_ASSERTION), ("b", FLAKY["test-limit"])],
            "checks: e2e failed with a timeout in 1 of 2 tests; re-running it once on the same tree",
        ),
        (
            [("a", FLAKY[checks.FAILURE_CRASH]), ("b", FLAKY[checks.FAILURE_NETWORK])],
            "checks: e2e failed with a browser or page crash in 1 of 2 tests; re-running it once on the same tree",
        ),
        (
            [("a", FLAKY[checks.FAILURE_NETWORK]), ("b", PW_ASSERTION), ("c", PW_ASSERTION)],
            "checks: e2e failed with a connection or network error in 1 of 3 tests; re-running it once on the same tree",
        ),
        (
            [("a", failure("Error: boom"))],
            "checks: e2e failed with an unclassified failure in 1 of 1 test; re-running it once on the same tree",
        ),
    ],
)
def test_each_decision_logs_exactly_one_line(ws, tmp_path, cases, line):
    report = xml_file(tmp_path, "a", cases)
    stub = Stub(tmp_path, {1: writes(report, 1), 2: writes(report, 1)})

    _err, _flakes, _runs, logs = failing(ws, stub)

    assert decisions(logs) == [line]
    assert not any(OLD_LINE in entry for entry in logs)


def _branch_ws(tmp_path: Path, branch_script: str) -> Path:
    """A clone whose origin/main test.sh passes, with the item branch's own
    test.sh written on top (uncommitted, as the implement step checks it)."""

    def git(cwd, *args):
        subprocess.run(
            ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
            capture_output=True,
            check=True,
        )

    seed = tmp_path / "seed"
    (seed / "scripts" / "checks").mkdir(parents=True)
    (seed / "scripts" / "checks" / "test.sh").write_text("exit 0\n")
    git(seed, "init", "-q", "-b", "main")
    git(seed, "add", "-A")
    git(seed, "commit", "-qm", "main")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(origin), str(clone)], check=True)
    git(clone, "checkout", "-q", "-b", "horizon/hz-589")
    (clone / "scripts" / "checks" / "test.sh").write_text(branch_script)
    return clone


def test_the_branch_pass_does_not_rerun_an_all_assertion_failure(tmp_path):
    report = xml_file(tmp_path, "a", [("shows the total", PW_ASSERTION)])
    counter = tmp_path / "branch-runs"
    clone = _branch_ws(
        tmp_path, f'echo x >> {counter}; cp {report} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1\n'
    )
    logs: list = []
    test_runs: list = []
    branch_notes: list = []

    with pytest.raises(CheckFailure):
        run_checks(
            clone,
            log=logs.append,
            configured={"test": "git show origin/main:scripts/checks/test.sh | sh"},
            test_runs=test_runs,
            branch_notes=branch_notes,
        )

    assert len(counter.read_text().splitlines()) == 1
    branch = next(run for run in test_runs if run["label"] == "branch")
    assert [c["attempt"] for c in branch["commands"]] == [1]
    assert decisions(logs) == ["checks: branch test.sh failed on assertions in 1 test; not re-running"]
    assert not any(OLD_LINE in entry for entry in logs)


# ---- guardrails ----


def test_rerun_off_still_runs_a_flaky_failure_once(ws, tmp_path, monkeypatch):
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    report = xml_file(tmp_path, "a", [("wobbles", FLAKY["test-limit"])])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: "exit 0"})

    _err, _flakes, _runs, logs = failing(ws, stub)

    assert stub.runs == 1
    assert decisions(logs) == []


def test_a_slow_failure_that_passes_on_rerun_is_still_a_flake(ws, tmp_path):
    first = xml_file(tmp_path, "first", [("wobbles", FLAKY["test-limit"])])
    second = xml_file(tmp_path, "second", [("wobbles", "")])
    stub = Stub(tmp_path, {1: writes(first, 1), 2: writes(second, 0)})

    note, flakes, _runs, _logs = check(ws, stub)

    assert note == "1 repo check(s) passed"
    assert stub.runs == 2
    assert [f["test"] for f in flakes] == ["wobbles"]


@pytest.mark.parametrize("repo", ["FinTekkers/horizon", "FinTekkers/ui-service"])
def test_every_repo_skips_an_all_assertion_rerun(ws, tmp_path, repo):
    report = xml_file(tmp_path, "a", [("shows the total", PW_ASSERTION)])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: "exit 0"})

    failing(ws, stub, repo=repo)

    assert stub.runs == 1


def test_stored_rows_never_carry_the_failure_kind(ws, tmp_path):
    report = xml_file(tmp_path, "a", [("asserts", PW_ASSERTION), ("wobbles", FLAKY["test-limit"]), ("loads", "")])
    stub = Stub(tmp_path, {1: writes(report, 1), 2: writes(report, 1)})

    _err, _flakes, test_runs, _logs = failing(ws, stub)

    rows = test_runs[0]["tests"]
    assert len(rows) == 6
    assert all("failure_kind" not in row for row in rows)
