"""HZ-605: a failed check lists its failing tests above the log tail — each
as `<suite> › <test> — <first failure-message line>`, at most 10, then
`+N more` — and test_result stores that line. HZ-950: the line is the
failure's reason plus its Expected and Received lines, for every runner.

The list is built from the JUnit rows run_checks already holds when it
raises CheckFailure, so it lands in both the message (the build step's /fail
error) and the tail (pre-merge's gate message)."""

import os
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET
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


# ---- metric 4: a multi-line message stores its reason and values as one line ----


def test_a_multi_line_failure_message_stores_its_reason_and_values(ws, tmp_path):
    path = tmp_path / "r.xml"
    path.write_text(
        '<testsuite name="S">'
        '<testcase name="multi"><failure message="line one&#10;line two">trace</failure></testcase>'
        '<testcase name="blank first"><error message="&#10;  &#13;&#10;the real line&#13;&#10;next"/></testcase>'
        '<testcase name="text only"><failure>\n  first text line\nsecond</failure></testcase>'
        '<testcase name="nothing"><failure/></testcase>'
        '<testcase name="long"><failure message="' + "x" * 1000 + '"/></testcase>'
        '<testcase name="labelled"><failure message="noise&#10;Error: boom&#10;more&#10;Expected: 4242&#10;Received: 1717"/></testcase>'
        '<testcase name="passes"/>'
        "</testsuite>"
    )

    messages = {row["test"]: row["failure_message"] for row in parse_junit(path, ws)}

    # No error or assertion line, no labelled value: the first line, as before.
    assert messages["multi"] == "line one"
    # HZ-950: the error line, then the Expected and Received lines.
    assert messages["labelled"] == "Error: boom · Expected: 4242 · Received: 1717"
    assert messages["blank first"] == "the real line"
    # No message attribute: the first line of the failure's text.
    assert messages["text only"] == "first text line"
    assert messages["nothing"] is None
    assert messages["passes"] is None


def test_the_stored_row_carries_the_reason_cut_to_the_cap(ws, tmp_path, monkeypatch):
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


# ---- HZ-750: a test case's source line, for a targeted run only ----


def test_parse_junit_keeps_a_valid_line_and_drops_pytests_and_the_stored_rows_never_carry_it(ws, tmp_path):
    path = tmp_path / "r.xml"
    path.write_text(
        '<testsuite name="S">'
        '<testcase name="kept" file="e2e/a.spec.ts" line="12"><failure/></testcase>'
        '<testcase name="word" file="e2e/a.spec.ts" line="x"><failure/></testcase>'
        '<testcase name="negative" file="e2e/a.spec.ts" line="-1"><failure/></testcase>'
        '<testcase name="huge" file="e2e/a.spec.ts" line="99999999"><failure/></testcase>'
        '<testcase name="none" file="e2e/b.spec.ts"><failure/></testcase>'
        # pytest's line attribute is 0-based: dropped, not shifted.
        '<testcase name="test_y" classname="tests.test_x" file="tests/test_x.py" line="0"><failure/></testcase>'
        '<testcase name="test_z" classname="tests.test_x" file="tests/test_x.py" line="7"><failure/></testcase>'
        "</testsuite>"
    )

    rows = parse_junit(path, ws)
    lines = {row["test"]: row["line"] for row in rows}

    assert lines == {"kept": 12, "word": None, "negative": None, "huge": None, "none": None, "test_y": None, "test_z": None}
    stored = checks._test_rows(rows, "sh -c e2e", 1, 0.1, attempt=1, secrets={})
    assert all("line" not in row for row in stored)


# ---- HO-898: a plain pytest gets a JUnit report from the check runner ----

REPO_ROOT = Path(__file__).resolve().parents[2]
PY = shlex.quote(sys.executable)


def pytest_ws(ws: Path, body: str) -> Path:
    """A tiny pytest project. The empty pytest.ini pins rootdir to `ws`, so
    the classname (and so the suite) is `test_m` wherever ws lives."""
    (ws / "pytest.ini").write_text("")
    (ws / "test_m.py").write_text(body)
    return ws


FAIL_AND_PASS = "def test_fail():\n    assert 1 == 2\n\n\ndef test_ok():\n    pass\n"


def stored_rows(test_runs: list) -> list[dict]:
    return [row for run in test_runs for row in run["tests"]]


def spy(monkeypatch, name: str, record):
    """Wrap checks.<name>, call through, and hand its arguments to record."""
    real = getattr(checks, name)

    def wrapper(*args, **kwargs):
        record(*args, **kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(checks, name, wrapper)


def test_r1_a_plain_pytest_stores_a_row_per_test_and_lists_the_failure(ws, monkeypatch):
    """Metric 1: no report option, one failing and one passing test."""
    pytest_ws(ws, FAIL_AND_PASS)
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q")
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    stored = {(row["suite"], row["test"]): row["status"] for row in stored_rows(test_runs)}
    assert stored == {("test_m", "test_fail"): "fail", ("test_m", "test_ok"): "pass"}
    assert "failing tests (1):" in str(err.value)
    assert "\ntest_m › test_fail — assert 1 == 2\n" in str(err.value)


def test_r2_a_nested_run_checks_never_writes_over_the_outer_report(tmp_path):
    """The farm runs Horizon's suite with PYTEST_ADDOPTS naming a report.
    conftest drops it, so R1's own run_checks keeps its rows and the outer
    report holds only the outer run's test."""
    outer = tmp_path / "outer.xml"
    node = f"{Path(__file__).relative_to(REPO_ROOT)}::test_r1_a_plain_pytest_stores_a_row_per_test_and_lists_the_failure"
    env = {**os.environ, "PYTEST_ADDOPTS": f"--junitxml={shlex.quote(str(outer))}"}

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", node],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    cases = ET.parse(outer).getroot().iter("testcase")
    assert [case.get("name") for case in cases] == ["test_r1_a_plain_pytest_stores_a_row_per_test_and_lists_the_failure"]


def test_r3_a_commands_own_junitxml_wins_and_each_test_is_stored_once(ws, monkeypatch):
    """Metric 2: the command's --junitxml beats PYTEST_ADDOPTS, so the farm's
    report is never written and the workspace report is read once."""
    pytest_ws(ws, FAIL_AND_PASS)
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q --junitxml=junit.xml")
    report_dir_files: list = []
    spy(monkeypatch, "_report_rows", lambda report_dir, *_, **__: report_dir_files.append(sorted(report_dir.iterdir())))
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert report_dir_files == [[]]
    assert sorted(case.get("name") for case in ET.parse(ws / "junit.xml").getroot().iter("testcase")) == [
        "test_fail",
        "test_ok",
    ]
    identities = [checks._identity(row) for row in stored_rows(test_runs)]
    assert sorted(identities) == [("test_m", None, "test_fail"), ("test_m", None, "test_ok")]


def test_r4_an_inherited_junitxml_passes_through_unchanged(ws, tmp_path, monkeypatch):
    """Metric 3: the inherited value is kept byte for byte and its report
    lands where it says. That path is outside every scanned one, so only the
    command row is stored (the metric 2 path limit)."""
    pytest_ws(ws, FAIL_AND_PASS)
    own = tmp_path / "own.xml"
    inherited = f"--junitxml={own}"
    monkeypatch.setenv("PYTEST_ADDOPTS", inherited)
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q")
    child_envs: list = []
    spy(monkeypatch, "_run_bounded", lambda cmd, ws, timeout_s, env: child_envs.append(env))
    report_dir_files: list = []
    spy(monkeypatch, "_report_rows", lambda report_dir, *_, **__: report_dir_files.append(sorted(report_dir.iterdir())))
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert [env["PYTEST_ADDOPTS"] for env in child_envs] == [inherited]
    assert own.is_file()
    assert report_dir_files == [[]]
    stored = stored_rows(test_runs)
    assert len(stored) == 1 and stored[0]["test"] == stored[0]["command"] and stored[0]["status"] == "fail"


def test_a_timed_out_command_reads_its_reports_as_stopped_before_cleanup(ws, monkeypatch):
    """HZ-948: on a timeout the report dir is still there when it is read,
    and the JSON-lines pass is asked for the cut-off row."""
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    monkeypatch.setenv("FARM_CHECK_CMD", 'touch "$HORIZON_TEST_REPORT_DIR/r.jsonl"; sleep 30')
    report_dir_files: list = []
    spy(monkeypatch, "_report_rows", lambda report_dir, *_, **__: report_dir_files.append(sorted(report_dir.iterdir())))
    stopped: list = []
    spy(monkeypatch, "_jsonl_rows", lambda *_, **kwargs: stopped.append(kwargs.get("stopped")))

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None)

    assert err.value.reason == "timed_out"
    assert [[path.name for path in files] for files in report_dir_files] == [["r.jsonl"]]
    assert stopped == [True]


def test_r5_inherited_options_still_apply_and_the_supplied_report_is_stored(ws, monkeypatch):
    """Metric 4 and the env-copy guardrail: inherited -x stops the run at the
    first failure, and the farm's report is still written and read."""
    # Order matters: -x stops after test_fail_a, so test_fail_b and test_ok
    # never run and are not in the report.
    pytest_ws(
        ws,
        "def test_fail_a():\n    assert 1 == 2\n\n\n"
        "def test_fail_b():\n    assert 3 == 4\n\n\n"
        "def test_ok():\n    pass\n",
    )
    monkeypatch.setenv("PYTEST_ADDOPTS", "-x")
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q")
    calls: list = []
    spy(monkeypatch, "_run_bounded", lambda cmd, ws, timeout_s, env: calls.append((dict(env), env)))
    parents: list = []
    real_attempt_env = checks._attempt_env

    def attempt_env(env, report_dir):
        parents.append((dict(env), env, report_dir))
        return real_attempt_env(env, report_dir)

    monkeypatch.setattr(checks, "_attempt_env", attempt_env)
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert [(row["test"], row["status"]) for row in stored_rows(test_runs)] == [("test_fail_a", "fail")]
    (child, child_obj), = calls
    (parent_snapshot, parent_obj, report_dir), = parents
    assert child["PYTEST_ADDOPTS"] == "-x --junitxml='$HORIZON_TEST_REPORT_DIR/pytest.xml'"
    assert child["HORIZON_TEST_REPORT_DIR"] == str(report_dir)
    assert child_obj is not parent_obj and parent_obj == parent_snapshot
    added = {k: v for k, v in child.items() if parent_snapshot.get(k) != v}
    assert set(added) == {"HORIZON_TEST_REPORT_DIR", "PYTEST_ADDOPTS"}
    assert set(parent_snapshot) - set(child) == set()
    assert os.environ["PYTEST_ADDOPTS"] == "-x"


@pytest.mark.parametrize(
    "inherited",
    [
        "--junit-xml=x",
        "--junit-xml x",
        "--junitxml x",
        "--junitxml=x",
        "-q --junitxml=x -x",
        "-p no:junitxml",
        "-pno:junitxml",
        "-k 'a",
    ],
)
def test_r6_pytest_addopts_leaves_these_inherited_values_alone(inherited, tmp_path, monkeypatch):
    monkeypatch.delenv(checks.PYTEST_JUNIT_ENV, raising=False)
    assert checks._pytest_addopts(inherited, str(tmp_path / "pytest.xml")) is None


@pytest.mark.parametrize("inherited", [None, "", "  "])
def test_r6_pytest_addopts_with_nothing_inherited_is_just_the_quoted_flag(inherited, tmp_path, monkeypatch):
    monkeypatch.delenv(checks.PYTEST_JUNIT_ENV, raising=False)
    report = str(tmp_path / "with space" / "pytest.xml")

    result = checks._pytest_addopts(inherited, report)

    assert result == f"--junitxml={shlex.quote(report)}"
    assert shlex.split(result) == [f"--junitxml={report}"]


def test_r6_pytest_addopts_keeps_inherited_options_in_front(tmp_path, monkeypatch):
    monkeypatch.delenv(checks.PYTEST_JUNIT_ENV, raising=False)
    report = str(tmp_path / "with space" / "pytest.xml")

    result = checks._pytest_addopts("-x -k 'a or b'", report)

    assert result.startswith("-x -k 'a or b' ")
    assert shlex.split(result) == ["-x", "-k", "a or b", f"--junitxml={report}"]


def test_r6_the_kill_switch_turns_the_injection_off(tmp_path, monkeypatch):
    monkeypatch.setenv(checks.PYTEST_JUNIT_ENV, "0")
    assert checks._pytest_addopts(None, checks.PYTEST_REPORT) is None
    assert checks._pytest_addopts("-x", checks.PYTEST_REPORT) is None
    assert "PYTEST_ADDOPTS" not in checks._attempt_env({"A": "1"}, tmp_path)


def test_r6_a_report_dir_with_a_space_still_gets_the_report(ws, tmp_path, monkeypatch):
    """The injected path is expanded by pytest itself, never split by it, so
    a report dir with a space in it still receives the report."""
    spaced = tmp_path / "with space"
    spaced.mkdir()
    monkeypatch.setattr(checks.tempfile, "tempdir", str(spaced))
    pytest_ws(ws, FAIL_AND_PASS)
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q")
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert sorted(row["test"] for row in stored_rows(test_runs)) == ["test_fail", "test_ok"]


def test_o1_a_pytest_failure_of_assertions_only_is_not_rerun(ws, monkeypatch):
    """Flag 2: the new rows reach _rerun_verdict, so an all-assertion pytest
    failure runs once and logs why."""
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)
    pytest_ws(ws, FAIL_AND_PASS)
    monkeypatch.setenv("FARM_CHECK_CMD", f"{PY} -m pytest -q")
    logs: list[str] = []
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=logs.append, test_runs=test_runs)

    assert any(line.endswith("failed on assertions in 1 test; not re-running") for line in logs), logs
    assert not any("re-running it once" in line for line in logs)
    assert {row["attempt"] for row in stored_rows(test_runs)} == {1}


# ---- HZ-950: every runner's failure stores its expected and received values ----

FIXTURES = Path(__file__).parent / "fixtures" / "junit"
REPORTER = REPO_ROOT / "server" / "scripts" / "junit-reporter.mjs"
RUNNERS = ["pytest", "node-test", "vitest", "playwright"]


def fixture_reasons(runner: str, ws: Path, junit: list[dict] | None = None) -> list[str]:
    """The stored (redacted, capped) reason of each failing case in one
    runner's captured report: expected 4242, received 1717."""
    junit = junit if junit is not None else parse_junit(FIXTURES / f"{runner}-failure.xml", ws)
    stored = checks._test_rows(junit, "cmd", 1, 0.1, attempt=1, secrets={})
    return [row["failure_message"] for row in stored if row["status"] == "fail"]


@pytest.mark.parametrize("runner", RUNNERS)
def test_each_runners_failure_stores_both_values_under_the_cap(runner, ws):
    reasons = fixture_reasons(runner, ws)

    assert reasons
    for reason in reasons:
        assert len(reason) <= checks.FAILURE_MESSAGE_MAX_CHARS
        if runner == "pytest":
            # pytest names both values in its assert line, unlabelled.
            assert reason == "assert 1717 == 4242"
            continue
        *_, expected, received = reason.split(checks.REASON_JOINER)
        assert "4242" in expected and "1717" not in expected, reason
        assert "1717" in received and "4242" not in received, reason
        if runner != "vitest":  # vitest's own message line names both values too.
            assert reason.count("4242") == reason.count("1717") == 1, reason


def test_a_playwright_title_over_200_chars_still_leaves_both_values_stored(ws):
    junit = parse_junit(FIXTURES / "playwright-failure.xml", ws)

    assert len(junit[0]["test"]) > 200
    assert fixture_reasons("playwright", ws, junit) == [
        "expect(received).toBe(expected) // Object.is equality · Expected: 4242 · Received: 1717"
    ]


def test_node_tests_strictly_equal_heading_never_hides_the_expected_value(ws):
    """Node's `Expected values to be strictly equal:` heading matches
    Expected; the stored reason must still carry the reporter's value line."""
    (reason,) = fixture_reasons("node-test", ws)

    assert "Expected: 4242" in reason and "Received: 1717" in reason
    assert reason.count("Expected values to be strictly equal:") == 1


def test_vitests_bare_diff_headers_store_their_value_lines(ws):
    reasons = fixture_reasons("vitest", ws)

    assert reasons[1].endswith(" · - 4242 · + 1717")
    assert all("- Expected" not in r and "+ Received" not in r for r in reasons)
    assert reasons[0].endswith(' · -   "balance": 4242, · +   "balance": 1717,')


def test_a_token_in_a_received_value_across_the_cap_is_redacted_before_it(ws, tmp_path, monkeypatch):
    """Metric 5: the Playwright fixture with a token as its received value,
    placed so the joined reason crosses the 300 cut mid-token."""
    token = "ghp_" + "A1b2C3d4E5" * 4
    marker = "MARKER"
    template = (FIXTURES / "playwright-failure.xml").read_text()
    (head,) = fixture_reasons("playwright", ws, parse_junit(_write(tmp_path / "m.xml", template.replace("1717", marker)), ws))
    start = head.index(marker)
    pad = "y" * (checks.FAILURE_MESSAGE_MAX_CHARS - 5 - start - 1)
    xml = _write(tmp_path / "r.xml", template.replace("Received: 1717", f"Received: {pad} {token} and more"))
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {xml} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    raw = parse_junit(xml, ws)[0]["failure_message"]
    assert raw.index(token) < checks.FAILURE_MESSAGE_MAX_CHARS < raw.index(token) + len(token)
    (stored,) = [row["failure_message"] for row in stored_rows(test_runs) if row["status"] == "fail"]
    assert "ghp_" not in stored and "A1b2C3d4E5" not in stored
    assert stored.endswith(f"{pad} [redacted] and more"[: len(stored) - start])


def _write(path: Path, text: str) -> Path:
    path.write_text(text)
    return path


def node_report_command(ws: Path, body: str) -> str:
    """A node --test check of one test file in `ws`, reporting through the
    server's real JUnit reporter into the farm's report dir."""
    (ws / "case.test.mjs").write_text(f"import {{ test }} from 'node:test'\nimport assert from 'node:assert/strict'\n{body}\n")
    return (
        f"node --test --test-reporter={shlex.quote(str(REPORTER))} "
        '--test-reporter-destination="$HORIZON_TEST_REPORT_DIR/server.xml" case.test.mjs'
    )


def test_a_live_node_test_failure_stores_its_reason_through_the_real_reporter(ws, monkeypatch):
    """Metric 1, stored half: reporter and farm parser, end to end."""
    monkeypatch.delenv("NODE_TEST_CONTEXT", raising=False)
    command = node_report_command(ws, "test('posts once', () => { assert.strictEqual(1717, 4242) })")
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    (row,) = stored_rows(test_runs)
    assert row["status"] == "fail" and row["test"] == "posts once"
    reason = row["failure_message"]
    assert reason and reason.index("Expected: 4242") < reason.index("Received: 1717"), reason


def test_the_farm_parser_reads_the_real_reporters_escaped_message_back_exactly(ws, monkeypatch):
    """Metric 3: < > & " and a newline survive the reporter's XML and
    ElementTree, and the stored reason is still one line."""
    monkeypatch.delenv("NODE_TEST_CONTEXT", raising=False)
    command = node_report_command(ws, "test('escapes', () => { throw new Error('a<b>&\"c\\nd') })")
    report_dir = ws / "reports"
    report_dir.mkdir()
    env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "NODE_TEST_CONTEXT")}
    proc = subprocess.run(
        ["sh", "-c", command], cwd=ws, env={**env, "HORIZON_TEST_REPORT_DIR": str(report_dir)}, capture_output=True, timeout=60
    )

    assert proc.returncode == 1
    case = next(ET.parse(report_dir / "server.xml").getroot().iter("testcase"))
    assert case.find("failure").get("message") == 'a<b>&"c\nd'
    reason = checks._failure_message(case)
    assert "\n" not in reason and 'a<b>&"c' in reason


# ---- HZ-946: the row for a command with no report is flagged ----


@pytest.mark.parametrize("exit_code, status", [(0, "pass"), (1, "fail")])
def test_a_command_with_no_report_stores_one_flagged_row_named_after_it(ws, monkeypatch, exit_code, status):
    command = f"echo no report here; exit {exit_code}"
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    test_runs: list = []

    if exit_code:
        with pytest.raises(CheckFailure):
            run_checks(ws, log=lambda *_: None, test_runs=test_runs)
    else:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    [row] = test_runs[0]["tests"]
    assert row["no_report"] is True
    assert row["test"] == row["command"]
    assert row["suite"] is None and row["file"] is None
    assert row["status"] == status


def test_a_command_that_writes_junit_stores_rows_with_no_no_report_key(ws, tmp_path, monkeypatch):
    xml = report(tmp_path / "r.xml", [("S", "breaks", "boom")])
    monkeypatch.setenv("FARM_CHECK_CMD", f'cp {xml} "$HORIZON_TEST_REPORT_DIR/r.xml"; exit 1')
    test_runs: list = []

    with pytest.raises(CheckFailure):
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    stored = test_runs[0]["tests"]
    assert [row["test"] for row in stored] == ["breaks", "passes"]
    assert all("no_report" not in row for row in stored)
