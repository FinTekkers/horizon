"""HZ-590: a red check's failing tests re-run on origin/<default branch>, in
a scratch worktree, before any fix turn. Real git and a real pytest on main;
only the failing test IDs ever run there, and anything short of every
failing test failing on main twice is "unclear" — never a pause."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from farm import base_check, check_slots, checks, premerge, validate, workspaces
from farm.base_check import FAILS_ON_MAIN, PASSES_ON_MAIN, UNCLEAR, narrow_command
from farm.checks import CheckFailure
from farm.tests.test_workspaces import git, make_repo_hub

REPO = "acme/demo"
ITEM = "HZ-590"
# The item's configured test line: pytest's default (xunit2) JUnit report, so
# no row has a file and matching goes through the classname.
PYTEST = f"{sys.executable} -m pytest -q --junitxml=$HORIZON_TEST_REPORT_DIR/pytest.xml"
FAILING = "def test_y():\n    assert 1 == 2\n"
PASSING = "def test_ok():\n    assert True\n"


@pytest.fixture
def hub(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    for module in (workspaces, premerge, validate):
        monkeypatch.setattr(module, "WORKSPACES_DIR", root)
    for name in ("FARM_CHECK_CMD", check_slots.IN_CHECKS_ENV, base_check.TIMEOUT_ENV, "FARM_CHECK_RERUN"):
        monkeypatch.delenv(name, raising=False)
    hub, _origin = make_repo_hub(tmp_path)
    return hub


def push_main(tmp_path, files: dict[str, str]) -> None:
    """Commits `files` on the seed and pushes them to origin's main — the hub
    has not fetched them, so the base check must."""
    seed = tmp_path / "seed"
    for path, text in files.items():
        (seed / path).parent.mkdir(parents=True, exist_ok=True)
        (seed / path).write_text(text)
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "main moves on")
    git(seed, "push", str(tmp_path / "origin.git"), "main")


def row(test, classname="tests.test_m", file=None, suite="pytest"):
    return {"suite": suite, "file": file, "classname": classname, "test": test, "status": "fail"}


def failure(rows, line=PYTEST, slot="test"):
    return CheckFailure(
        "repo checks failed: test: 1 failed\n(sh -c pytest)\nFAILED",
        "FAILED",
        command="sh -c pytest",
        failed_tests=rows,
        argv=["sh", "-c", line],
        slot=slot,
    )


def run(item_ws, fail, configured=None, **kwargs):
    logs = []
    verdict = base_check.check_on_base(
        REPO,
        ITEM,
        fail,
        item_ws=item_ws,
        configured=configured if configured is not None else {"test": PYTEST},
        test_env_file=None,
        deadline=kwargs.pop("deadline", None) or (base_check.time.monotonic() + 900),
        log=logs.append,
    )
    return verdict, logs


@pytest.fixture
def scratch_runs(monkeypatch):
    """Every scratch worktree the base check makes: its run id and path."""
    made = []
    real = validate.scratch_worktree

    def spy(repo_full, run_id, sha, forbidden=(), **kwargs):
        made.append({"run_id": run_id, "path": validate.validate_path(repo_full, run_id), "forbidden": list(forbidden)})
        return real(repo_full, run_id, sha, forbidden, **kwargs)

    monkeypatch.setattr(validate, "scratch_worktree", spy)
    return made


@pytest.fixture
def attempts(monkeypatch):
    """The argv of every command the base run executes."""
    seen = []
    real = checks._attempt

    def spy(cmd, *args, **kwargs):
        seen.append(list(cmd))
        return real(cmd, *args, **kwargs)

    monkeypatch.setattr(checks, "_attempt", spy)
    return seen


def item_worktree(hub):
    ws = workspaces.ensure_item_worktree(REPO, ITEM)
    (ws / "uncommitted.txt").write_text("the item's own work\n")
    (ws / "README.md").write_text("# edited, not committed\n")
    return ws


def snapshot(ws):
    def out(*args):
        return subprocess.run(["git", "-C", str(ws), *args], check=True, capture_output=True, text=True).stdout

    return out("status", "--porcelain"), out("rev-parse", "HEAD"), out("rev-parse", "--abbrev-ref", "HEAD")


# ---- metric 1: a test that really fails on main ----


def test_a_test_that_fails_on_main_too_is_fails_on_main_and_the_item_worktree_is_untouched(
    hub, tmp_path, scratch_runs
):
    push_main(tmp_path, {"pytest.ini": "[pytest]\n", "tests/test_m.py": FAILING + PASSING})
    ws = item_worktree(hub)
    before = snapshot(ws)

    verdict, logs = run(ws, failure([row("test_y")]))

    assert verdict.verdict == FAILS_ON_MAIN, (verdict, logs)
    assert verdict.tests == ["tests.test_m::test_y"]
    # The uppercase item id still makes a valid scratch path (validate._RUN_RE).
    (made,) = scratch_runs
    assert made["run_id"].startswith("base-hz-590-")
    assert validate._RUN_RE.match(made["run_id"])
    assert made["forbidden"] == [str(ws)]
    # Guardrail 2: a separate checkout, removed after; the item's is unchanged.
    assert not made["path"].exists()
    assert snapshot(ws) == before
    assert list(Path(validate.tempfile.gettempdir()).glob(f"{validate.CHECKS_HOME_PREFIX}{made['run_id']}-*")) == []


# ---- metric 2: only the failing IDs run on main ----


def test_a_test_that_passes_on_main_runs_only_install_and_the_failing_ids(hub, tmp_path, attempts):
    push_main(tmp_path, {"pytest.ini": "[pytest]\n", "tests/test_m.py": "def test_a():\n    pass\n\ndef test_b():\n    pass\n"})
    configured = {"install": "true", "test": f"{PYTEST}\necho second-test-line", "lint": "exit 9", "e2e": "exit 9"}

    verdict, logs = run(hub, failure([row("test_a")]), configured=configured)

    assert verdict.verdict == PASSES_ON_MAIN, (verdict, logs)
    narrowed = f"{sys.executable} -m pytest -q --junitxml=$HORIZON_TEST_REPORT_DIR/pytest.xml tests/test_m.py::test_a"
    assert attempts == [["sh", "-c", "true"], ["sh", "-c", narrowed]]


# ---- metric 4 and guardrail 3: anything short of all failing on main ----


def test_some_failing_on_main_and_some_passing_is_unclear(hub, tmp_path):
    push_main(tmp_path, {"pytest.ini": "[pytest]\n", "tests/test_m.py": FAILING + PASSING})

    verdict, logs = run(hub, failure([row("test_y"), row("test_ok")]))

    assert verdict.verdict == UNCLEAR, (verdict, logs)
    assert "1 of 2" in verdict.detail and "test_ok" in verdict.detail


def test_a_test_flaky_on_main_is_rerun_and_passes_on_main(hub, tmp_path, attempts):
    # Fails on an assertion the first time, passes the second: HZ-589 would
    # not rerun it, the base run always does.
    flaky = "from pathlib import Path\n\ndef test_y():\n    marker = Path('ran-once')\n    first = not marker.exists()\n    marker.write_text('x')\n    assert not first\n"
    push_main(tmp_path, {"pytest.ini": "[pytest]\n", "tests/test_m.py": flaky})

    verdict, logs = run(hub, failure([row("test_y")]))

    assert verdict.verdict == PASSES_ON_MAIN, (verdict, logs)
    # Rerun as is: the same failing ID, nothing wider.
    assert len(attempts) == 2 and attempts[1] == attempts[0]
    assert attempts[0][2].endswith(" tests/test_m.py::test_y")


@pytest.mark.parametrize(
    "case",
    ["unmappable-compound-script", "file-missing-on-main", "no-row-on-main", "install-fails-on-main"],
)
def test_unclear_cases(hub, tmp_path, case):
    push_main(tmp_path, {"pytest.ini": "[pytest]\n", "tests/test_m.py": FAILING})
    fail, configured = failure([row("test_y")]), {"test": PYTEST}
    if case == "unmappable-compound-script":
        fail = failure([row("test_y")], line=f"true && {PYTEST}")
    elif case == "file-missing-on-main":
        fail = failure([row("test_y", classname="tests.test_gone")])
    elif case == "no-row-on-main":
        fail = failure([row("test_renamed_away")])
    else:
        configured = {"install": "exit 3", "test": PYTEST}

    verdict, logs = run(hub, fail, configured=configured)

    assert verdict.verdict == UNCLEAR, (verdict, logs)


def test_a_base_run_that_runs_out_of_time_is_unclear(hub, tmp_path, monkeypatch):
    push_main(tmp_path, {"tests/test_m.py": FAILING})

    def slow(*_a, **_k):
        raise CheckFailure("repo checks timed out after 1s: sh -c pytest", command="sh -c pytest", reason="timed_out")

    monkeypatch.setattr(base_check, "run_checks", slow)
    verdict, _ = run(hub, failure([row("test_y")]))
    assert verdict.verdict == UNCLEAR
    assert "timed_out" in verdict.detail


@pytest.mark.parametrize("where", ["git-fetch", "worktree-add"])
def test_a_git_error_is_unclear_and_never_raises(hub, monkeypatch, where):
    if where == "git-fetch":

        def broken(path, *args):
            raise subprocess.TimeoutExpired(["git", *args], base_check.GIT_TIMEOUT_S)

        monkeypatch.setattr(base_check, "_git", broken)
    else:

        def broken(*_a, **_k):
            raise RuntimeError("git worktree add failed: fatal")

        monkeypatch.setattr(validate, "scratch_worktree", broken)

    verdict, _ = run(hub, failure([row("test_y")]))
    assert verdict.verdict == UNCLEAR
    assert verdict.tests == ["tests.test_m::test_y"]


def test_the_kill_switch_returns_before_any_git_call(hub, monkeypatch):
    monkeypatch.setenv(base_check.TIMEOUT_ENV, "0")
    monkeypatch.setattr(base_check, "_git", lambda *a: pytest.fail("git ran with the base check off"))
    verdict, _ = run(hub, failure([row("test_y")]))
    assert verdict.verdict == UNCLEAR


# ---- guardrail 4: every runner, mapped by runner, never by repo ----


def _tree(tmp_path, files):
    for path, text in files.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text)
    return tmp_path


@pytest.mark.parametrize(
    "line,rows,expected",
    [
        pytest.param(
            "python -m pytest -q tests/",
            [row("test_y", classname="tests.test_m.TestThing")],
            "python -m pytest -q tests/test_m.py::TestThing::test_y",
            id="pytest-classname",
        ),
        pytest.param(
            "pytest -k fast tests",
            [row("test_y", file="tests/test_m.py", classname="tests.test_m")],
            "pytest -k fast tests/test_m.py::test_y",
            id="pytest-file",
        ),
        pytest.param(
            "npx playwright test --project chromium e2e/",
            [row("filters › shows (all) rows | 2.0", classname="board.spec.ts", suite="board.spec.ts")],
            "npx playwright test --project chromium board.spec.ts -g 'shows \\(all\\) rows \\| 2\\.0'",
            id="playwright",
        ),
        pytest.param(
            "node --test --test-reporter=tap test/",
            [row("a.b(c)", file="test/x.test.mjs", classname=None, suite="x")],
            "node --test --test-reporter=tap '--test-name-pattern=a\\.b\\(c\\)' test/x.test.mjs",
            id="node-test",
        ),
        pytest.param(
            "vitest run src",
            [row("AdminPage > renders [x]", classname="src/a.test.jsx", suite="src/a.test.jsx")],
            "vitest run src/a.test.jsx -t 'renders \\[x\\]'",
            id="vitest",
        ),
        pytest.param(
            "jest --ci",
            [row("adds+1", classname="src/a.test.jsx", suite="sum")],
            "jest --ci src/a.test.jsx -t 'adds\\+1'",
            id="jest",
        ),
        pytest.param(
            "./gradlew --no-daemon :ledger:test",
            [row("credits()", classname="org.x.LedgerTest", suite="org.x.LedgerTest")],
            "./gradlew --no-daemon :ledger:test --tests org.x.LedgerTest.credits",
            id="gradle",
        ),
        pytest.param(
            "npm --prefix ui test --silent",
            [row("AdminPage > renders", classname=None, file="ui/src/a.test.jsx", suite="x")],
            "npm --prefix ui test --silent -- src/a.test.jsx -t renders",
            id="npm-script",
        ),
        pytest.param("make test", [row("test_y")], None, id="unknown-runner"),
        pytest.param("npm test", [row("t", file="ui/src/a.test.jsx")], None, id="npm-script-selecting-its-own-tests"),
    ],
)
def test_narrow_command_maps_failing_rows_to_each_runners_ids(tmp_path, line, rows, expected):
    ws = _tree(
        tmp_path,
        {
            "tests/test_m.py": "",
            "test/x.test.mjs": "",
            "src/a.test.jsx": "",
            "ui/src/a.test.jsx": "",
            "ui/package.json": json.dumps({"scripts": {"test": "vitest run"}}),
            "package.json": json.dumps({"scripts": {"test": "vitest run src"}}),
        },
    )
    narrowed = narrow_command(["sh", "-c", line], rows, ws)
    assert narrowed == (None if expected is None else ["sh", "-c", expected])


def test_narrowing_keeps_a_report_dir_variable_unquoted(tmp_path):
    ws = _tree(tmp_path, {"tests/test_m.py": ""})
    narrowed = narrow_command(["sh", "-c", PYTEST], [row("test_y")], ws)
    assert narrowed[2].endswith("--junitxml=$HORIZON_TEST_REPORT_DIR/pytest.xml tests/test_m.py::test_y")


# ---- the pause message survives the server's 200-char cause cap ----


def test_the_fails_on_main_headline_names_the_first_test_within_200_chars():
    long_title = "board.spec.ts::" + "filters the portfolio by every currency and keeps the totals " * 3
    long_title = long_title[:150]
    tests = [long_title, *(f"tests/test_{i}.py::test_{i}" for i in range(6))]

    headline = base_check.fails_on_main_headline(tests)
    first_line = checks._cap_words(f"{checks.HEADLINE_PREFIX}{headline}", 200)  # splitCheckError's capWords

    assert first_line == f"{checks.HEADLINE_PREFIX}{headline}", "nothing is cut"
    assert "fails on main as well" in first_line
    assert first_line.endswith(", not caused by this item")
    shown = headline.count("`") // 2
    assert f"(and {len(tests) - shown} more)" in headline
    assert long_title[:10] in headline
    # Every whole name fits when the names are short.
    assert base_check.fails_on_main_headline(["a::b"]) == "fails on main as well: `a::b`, not caused by this item"
