"""HZ-349: an item that changes scripts/checks/ also gets its own scripts run.

Main's configured commands (`git show origin/main:scripts/checks/<slot>.sh`)
run first and alone decide pass or fail, as HZ-245 requires. The branch's
version then runs in the same slot, workspace and env, recorded as a separate
"branch" test run. Each run's JUnit — including Gradle's build/test-results —
is collected straight after it, before the next run can clean it.

The fixture is a real git clone with origin/main, so the change detection
and the `git show origin/main:` commands run for real."""

import subprocess
import time
from pathlib import Path

import pytest

from farm import check_record, check_slots, checks
from farm.checks import CheckFailure, branch_commands, run_checks


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)


def git(cwd, *args):
    return subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def write(root: Path, files: dict[str, str]) -> None:
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)


def junit(names: list[str], failing: tuple[str, ...] = ()) -> str:
    cases = "".join(
        f'<testcase classname="LedgerTest" name="{n}" time="0.01">{"<failure/>" if n in failing else ""}</testcase>'
        for n in names
    )
    return f'<testsuite name="LedgerTest">{cases}</testsuite>'


# A stand-in for Gradle: `sh gradlew test <names...>` writes one JUnit file
# under build/test-results/test/, as Gradle's test task does; with
# --up-to-date it leaves an existing report untouched, as an UP-TO-DATE task
# does. No real Gradle is needed.
GRADLEW = """\
up=0
if [ "$1" = "--up-to-date" ]; then up=1; shift; fi
shift
out=build/test-results/test/TEST-LedgerTest.xml
if [ "$up" = 1 ] && [ -f "$out" ]; then echo "> Task :test UP-TO-DATE"; exit 0; fi
mkdir -p build/test-results/test
cases=""
for n in "$@"; do cases="$cases<testcase classname=\\"LedgerTest\\" name=\\"$n\\" time=\\"0.01\\"/>"; done
echo "<testsuite name=\\"LedgerTest\\">$cases</testsuite>" > "$out"
"""


def make_ws(tmp_path: Path, main_files: dict[str, str], branch_files: dict[str, str] | None = None) -> Path:
    """origin/main holds main_files; the returned clone is on an item branch
    with branch_files written on top, uncommitted (as the implement step
    checks them)."""
    seed = tmp_path / "seed"
    seed.mkdir(parents=True)
    git(seed, "init", "-q", "-b", "main")
    write(seed, {"gradlew": GRADLEW, ".gitignore": "build/\n", **main_files})
    git(seed, "add", "-A")
    git(seed, "commit", "-qm", "main")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(origin), str(ws)], check=True)
    git(ws, "checkout", "-q", "-b", "horizon/ls-98")
    write(ws, branch_files or {})
    return ws


def main_cmd(slot: str) -> str:
    return f"git show origin/main:scripts/checks/{slot}.sh | sh"


class Spy:
    """Wraps checks._run_bounded: records each call's argv, cwd, env and
    budget, then runs it for real."""

    def __init__(self, monkeypatch):
        self.calls = []
        real = checks._run_bounded

        def spy(cmd, ws, budget, env):
            self.calls.append({"argv": list(cmd), "ws": ws, "env": dict(env), "budget": budget})
            return real(cmd, ws, budget, env)

        monkeypatch.setattr(checks, "_run_bounded", spy)

    @property
    def argvs(self):
        return [c["argv"][2] for c in self.calls]


def check(ws, configured, **kwargs):
    test_runs: list = []
    branch_notes: list = []
    logs: list = []
    note = run_checks(
        ws, log=logs.append, configured=configured, test_runs=test_runs, branch_notes=branch_notes, **kwargs
    )
    return note, test_runs, branch_notes, logs


def by_label(test_runs):
    return {run["label"]: run for run in test_runs}


# ---- metric 1: main decides; the branch run is recorded beside it ----


def test_main_fails_and_branch_passes_so_the_check_fails_after_main_rerun_then_branch(tmp_path, monkeypatch):
    ws = make_ws(
        tmp_path,
        {"scripts/checks/test.sh": "echo main-version; exit 1\n"},
        {"scripts/checks/test.sh": "echo branch-version; exit 0\n"},
    )
    spy = Spy(monkeypatch)
    slots_entered = []
    real_slot = check_slots.check_slot

    def counting_slot(*a, **k):
        slots_entered.append(1)
        return real_slot(*a, **k)

    monkeypatch.setattr(check_slots, "check_slot", counting_slot)
    test_runs: list = []
    branch_notes: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured={"test": main_cmd("test")}, test_runs=test_runs, branch_notes=branch_notes)

    assert "main-version" in err.value.tail
    # Main, main's rerun (unchanged: a pipe), then the branch — never a
    # branch argv on the rerun.
    assert spy.argvs == [main_cmd("test"), main_cmd("test"), "cat scripts/checks/test.sh | sh"]
    runs = by_label(test_runs)
    assert [r["label"] for r in test_runs] == ["main", "branch"]
    assert {row["status"] for row in runs["main"]["tests"]} == {"fail"}
    assert [row["status"] for row in runs["branch"]["tests"]] == ["pass"]
    assert runs["main"]["check_run"] != runs["branch"]["check_run"]
    assert branch_notes == ["branch: test.sh passed, no per-test reports"]
    # Guardrail 2: same workspace, same env, the slot's budget; one slot.
    assert len({str(c["ws"]) for c in spy.calls}) == 1
    main_env, branch_env = spy.calls[0]["env"], spy.calls[2]["env"]
    main_env.pop(checks.TEST_REPORT_DIR_ENV)
    branch_env.pop(checks.TEST_REPORT_DIR_ENV)
    assert main_env == branch_env
    assert spy.calls[0]["budget"] == spy.calls[2]["budget"] == 600
    assert slots_entered == [1]


def test_main_passes_and_branch_fails_so_the_check_passes(tmp_path):
    ws = make_ws(
        tmp_path,
        {"scripts/checks/test.sh": "exit 0\n"},
        {"scripts/checks/test.sh": "echo broken; exit 3\n"},
    )

    note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    assert note == "1 repo check(s) passed"
    assert check_record.checks_ran(note) is True
    runs = by_label(test_runs)
    assert [row["status"] for row in runs["branch"]["tests"]] == ["fail"]
    assert runs["branch"]["commands"] == [
        {"command": "sh -c cat scripts/checks/test.sh | sh", "attempt": 1, "exit_code": 3}
    ]
    assert branch_notes == ["branch: test.sh failed (exit 3), no per-test reports"]


def test_no_change_under_scripts_checks_records_no_branch_run(tmp_path):
    ws = make_ws(tmp_path, {"scripts/checks/test.sh": "exit 0\n"}, {"src/app.txt": "changed\n"})

    note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    assert note == "1 repo check(s) passed"
    assert [r["label"] for r in test_runs] == ["main"]
    assert branch_notes == []


def test_gradle_results_are_collected_per_run_before_the_branch_cleans_them(tmp_path):
    main_tests = ["credits", "debits"]
    branch_tests = ["credits", "debits", "fx", "accruals", "rounding"]
    ws = make_ws(
        tmp_path,
        {"scripts/checks/test.sh": f"sh gradlew test {' '.join(main_tests)}\n"},
        {"scripts/checks/test.sh": f"rm -rf build/test-results\nsh gradlew test {' '.join(branch_tests)}\n"},
    )

    _note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    runs = by_label(test_runs)
    assert sorted(row["test"] for row in runs["main"]["tests"]) == sorted(main_tests)
    assert sorted(row["test"] for row in runs["branch"]["tests"]) == sorted(branch_tests)
    assert {row["file"] for row in runs["branch"]["tests"]} == {None}
    assert branch_notes == ["branch: test.sh passed, 5/5 tests passed"]


def test_gradle_up_to_date_on_the_branch_says_results_were_reused_never_a_silent_zero(tmp_path):
    ws = make_ws(
        tmp_path,
        {"scripts/checks/test.sh": "sh gradlew test credits debits\n"},
        {"scripts/checks/test.sh": "echo branch tweak\nsh gradlew --up-to-date test credits debits\n"},
    )

    _note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    runs = by_label(test_runs)
    assert len(runs["main"]["tests"]) == 2
    # Main's untouched XML is never counted as the branch's.
    [row] = runs["branch"]["tests"]
    assert row["test"] == row["command"] == "sh -c cat scripts/checks/test.sh | sh"
    assert row["status"] == "pass"
    assert branch_notes == ["branch: test.sh passed, no new test reports — results reused from main's run, not counted here"]


def test_only_changed_slots_run_on_the_branch_in_slot_order_after_all_of_main(tmp_path, monkeypatch):
    scripts = {f"scripts/checks/{slot}.sh": f"echo main-{slot}\n" for slot in ("install", "test", "lint")}
    ws = make_ws(
        tmp_path,
        scripts,
        {"scripts/checks/lint.sh": "echo branch-lint\n", "scripts/checks/test.sh": "echo branch-test\n"},
    )
    spy = Spy(monkeypatch)
    configured = {"install": main_cmd("install"), "test": main_cmd("test"), "lint": main_cmd("lint"), "e2e": None}

    _note, test_runs, branch_notes, _logs = check(ws, configured)

    assert spy.argvs == [
        main_cmd("install"),
        main_cmd("test"),
        main_cmd("lint"),
        "cat scripts/checks/test.sh | sh",
        "cat scripts/checks/lint.sh | sh",
    ]
    assert [row["test"] for row in by_label(test_runs)["branch"]["tests"]] == [
        "sh -c cat scripts/checks/test.sh | sh",
        "sh -c cat scripts/checks/lint.sh | sh",
    ]
    assert branch_notes[-1] == "branch: not re-run, unchanged on this branch: install.sh"


def test_the_branch_run_leaves_mains_rows_exactly_as_they_were(tmp_path):
    files = {"scripts/checks/test.sh": "sh gradlew test credits debits\n"}
    alone = make_ws(tmp_path / "alone", files, {"src/x.txt": "x\n"})
    with_branch = make_ws(tmp_path / "with", files, {"scripts/checks/test.sh": "rm -rf build\nsh gradlew test a b c\n"})

    _n, alone_runs, _b, _l = check(alone, {"test": main_cmd("test")})
    _n, branch_runs, _b, _l = check(with_branch, {"test": main_cmd("test")})

    strip = lambda rows: [{k: v for k, v in r.items() if k != "duration_ms"} for r in rows]  # noqa: E731
    assert strip(by_label(branch_runs)["main"]["tests"]) == strip(by_label(alone_runs)["main"]["tests"])
    assert by_label(branch_runs)["main"]["label"] == "main"


# ---- guardrail 4: a branch run never fails, blocks or retries anything ----


def test_a_branch_run_past_the_slot_budget_is_a_failed_branch_run_not_a_failed_check(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    ws = make_ws(tmp_path, {"scripts/checks/test.sh": "exit 0\n"}, {"scripts/checks/test.sh": "sleep 5\n"})
    spy = Spy(monkeypatch)

    note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    assert note == "1 repo check(s) passed"
    assert len(spy.calls) == 2  # no rerun of the branch command
    assert spy.calls[1]["budget"] == 1
    assert [row["status"] for row in by_label(test_runs)["branch"]["tests"]] == ["fail"]
    assert by_label(test_runs)["branch"]["commands"][0]["exit_code"] is None
    assert branch_notes == ["branch: test.sh failed (timed out after 1s)"]


def test_a_branch_command_that_crashes_is_a_failed_branch_run(tmp_path, monkeypatch):
    ws = make_ws(tmp_path, {"scripts/checks/test.sh": "exit 0\n"}, {"scripts/checks/test.sh": "echo branch; exit 0\n"})
    real = checks._run_bounded

    def crash_on_branch(cmd, cwd, budget, env):
        if cmd[2].startswith("cat "):
            raise RuntimeError("fork failed")
        return real(cmd, cwd, budget, env)

    monkeypatch.setattr(checks, "_run_bounded", crash_on_branch)

    note, test_runs, branch_notes, _logs = check(ws, {"test": main_cmd("test")})

    assert note == "1 repo check(s) passed"
    assert [row["status"] for row in by_label(test_runs)["branch"]["tests"]] == ["fail"]
    assert branch_notes == ["branch: test.sh failed (could not run: RuntimeError: fork failed)"]


def test_no_time_left_records_a_failed_branch_run_and_spawns_nothing(tmp_path, monkeypatch):
    ws = make_ws(tmp_path, {"scripts/checks/test.sh": "exit 0\n"}, {"scripts/checks/test.sh": "echo branch; exit 0\n"})
    monkeypatch.setattr(checks, "_run_bounded", lambda *a: pytest.fail("nothing may run with no time left"))
    notes: list = []

    branch_run = checks._run_branch_pass(
        ws,
        {"test": main_cmd("test")},
        {"scripts/checks/test.sh"},
        env={},
        timeout_s=600,
        deadline=time.monotonic() - 1,
        commit_sha=None,
        tree_sha=None,
        secrets={},
        branch_notes=notes,
        log=lambda *_: None,
    )

    assert [row["status"] for row in branch_run["tests"]] == ["fail"]
    assert notes == ["branch: test.sh failed (no time left in the check budget, not run)"]


def test_without_test_runs_there_is_no_branch_run(tmp_path, monkeypatch):
    """validate.py's shape: no lists, so nothing is recorded and the branch's
    scripts never run."""
    ws = make_ws(tmp_path, {"scripts/checks/test.sh": "exit 0\n"}, {"scripts/checks/test.sh": "exit 1\n"})
    spy = Spy(monkeypatch)
    assert run_checks(ws, log=lambda *_: None, configured={"test": main_cmd("test")}) == "1 repo check(s) passed"
    assert spy.argvs == [main_cmd("test")]


# ---- the rewrite is narrow ----


@pytest.mark.parametrize(
    "line, rewritten",
    [
        ("git show origin/main:scripts/checks/test.sh | bash", "cat scripts/checks/test.sh | bash"),
        ("bash <(git show origin/main:scripts/checks/test.sh) --fast", "bash <(cat scripts/checks/test.sh) --fast"),
        ("./gradlew clean && git show origin/main:scripts/checks/test.sh | sh -s -- x", "./gradlew clean && cat scripts/checks/test.sh | sh -s -- x"),
    ],
)
def test_branch_commands_rewrite_only_the_main_script_reference(line, rewritten):
    [(slot, _n, _count, argv, scripts)], unchanged = branch_commands({"test": line}, {"scripts/checks/test.sh"})
    assert (slot, argv, scripts, unchanged) == ("test", ["sh", "-c", rewritten], ["test.sh"], [])


def test_a_command_naming_scripts_checks_another_way_is_logged_and_not_run():
    logs: list = []
    commands, _unchanged = branch_commands({"test": "bash scripts/checks/test.sh"}, {"scripts/checks/test.sh"}, logs.append)
    assert commands == []
    assert any("not as `git show origin/main:<path>`" in line for line in logs)
