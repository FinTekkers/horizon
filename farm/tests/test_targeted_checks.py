"""HZ-750: on a fix round, an opted-in slot first re-runs only last round's
failing tests, passed as data in HORIZON_FAILED_TESTS. A red targeted run is
the round's result and the next fix turn starts; a green one is followed by
the full checks, and only a full green is green. Anything doubtful runs the
full checks exactly as before."""

import json
import subprocess
import types
from pathlib import Path

import pytest

from farm import check_metrics, check_slots, checks, login_env, step_agent, targeted_checks
from farm.checks import CheckFailure, run_checks
from farm.step_agent import execute
from farm.tests.test_step_agent import make_git_workspace, make_task

IMPLEMENT = step_agent.IMPLEMENT_LABEL
ENV = targeted_checks.FAILED_TESTS_ENV
TWO_ROWS = [
    {"suite": "a", "file": "e2e/a.spec.ts", "line": 12, "test": "opens", "status": "fail"},
    {"suite": "b", "file": "e2e/b.spec.ts", "line": None, "test": "saves", "status": "fail"},
]


def git(ws, *args):
    return subprocess.run(["git", "-C", str(ws), *args], check=True, capture_output=True, text=True).stdout.strip()


# ---- the list and the fallbacks (metric 4) ----


def test_failed_tests_value_is_file_or_file_line_per_line_deduped():
    rows = [*TWO_ROWS, {"file": "e2e/b.spec.ts", "line": None}, {"file": "e2e/a.spec.ts", "line": 12}]
    assert targeted_checks.failed_tests_value(rows) == "e2e/a.spec.ts:12\ne2e/b.spec.ts"


@pytest.fixture
def repo(tmp_path):
    """A git workspace with a committed base and one fix commit on top of
    it; `fix(path)` makes that commit touch `path`."""
    ws = tmp_path / "repo"
    ws.mkdir()
    git(ws, "init", "-q", "-b", "main")
    git(ws, "config", "user.email", "t@example.com")
    git(ws, "config", "user.name", "T")
    (ws / "README.md").write_text("x\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-qm", "base")
    base = git(ws, "rev-parse", "HEAD")

    def fix(path="src/app.js"):
        target = ws / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixed\n")
        git(ws, "add", "-A")
        git(ws, "commit", "-qm", "fix")
        return base

    return types.SimpleNamespace(ws=ws, fix=fix)


def _red(slot="e2e", rows=TWO_ROWS, reason="failed"):
    return CheckFailure("repo checks failed", "digest", slot=slot, failed_tests=rows, reason=reason)


@pytest.mark.parametrize(
    "case,changes,kwargs,expected",
    [
        ("opted in", "src/app.js", {}, None),
        ("kill switch", "src/app.js", {"env": "0"}, "FARM_TARGETED_CHECKS is off"),
        ("first run", "src/app.js", {"rounds": 0}, "the first check run"),
        ("no failure yet", "src/app.js", {"failure": None}, "the first check run"),
        ("not opted in", "src/app.js", {"slots": ["test"]}, "the e2e slot is not opted in"),
        ("no slots", "src/app.js", {"slots": []}, "the e2e slot is not opted in"),
        ("lint slot", "src/app.js", {"failure": _red(slot="lint"), "slots": ["lint"]}, "not a test slot"),
        ("FARM_CHECK_CMD", "src/app.js", {"failure": _red(slot=None)}, "not a test slot"),
        ("did not run to a result", "src/app.js", {"failure": _red(reason="timed_out")}, "did not reach a test result"),
        ("empty list", "src/app.js", {"failure": _red(rows=[])}, "empty, unreadable or over the cap"),
        ("row without a file", "src/app.js", {"failure": _red(rows=[{"test": "t", "classname": "c"}])}, "unreadable"),
        ("parent dir", "src/app.js", {"failure": _red(rows=[{"file": "../x"}])}, "unreadable"),
        ("nested parent dir", "src/app.js", {"failure": _red(rows=[{"file": "e2e/../../x.ts"}])}, "unreadable"),
        ("absolute path", "src/app.js", {"failure": _red(rows=[{"file": "/etc/passwd"}])}, "unreadable"),
        ("newline", "src/app.js", {"failure": _red(rows=[{"file": "e2e/a.ts\nrm -rf /"}])}, "unreadable"),
        ("colon", "src/app.js", {"failure": _red(rows=[{"file": "e2e/a.ts:3"}])}, "unreadable"),
        (
            "over 200 entries",
            "src/app.js",
            {"failure": _red(rows=[{"file": f"e2e/t{i}.spec.ts"} for i in range(201)])},
            "over the cap",
        ),
        (
            "over 16 KB",
            "src/app.js",
            {"failure": _red(rows=[{"file": f"e2e/{i}{'x' * 200}.spec.ts"} for i in range(100)])},
            "over the cap",
        ),
        ("lockfile changed", "package-lock.json", {}, "changed package-lock.json, so the install must run"),
        ("nested manifest", "web/package.json", {}, "changed web/package.json"),
        ("requirements", "requirements-dev.txt", {}, "changed requirements-dev.txt"),
        ("branch scripts", "scripts/checks/e2e.sh", {}, "the branch's check scripts must run"),
        ("bad base", "src/app.js", {"fix_base": "0" * 40}, "could not tell what the fix turn changed"),
    ],
)
def test_skip_reason_runs_the_full_checks_for_every_doubtful_case(repo, monkeypatch, case, changes, kwargs, expected):
    monkeypatch.setenv("FARM_TARGETED_CHECKS", kwargs.get("env", "1"))
    base = repo.fix(changes)
    why = targeted_checks.skip_reason(
        kwargs.get("failure", _red()),
        kwargs.get("slots", ["e2e"]),
        rounds=kwargs.get("rounds", 1),
        ws=repo.ws,
        fix_base=kwargs.get("fix_base", base),
    )
    if expected is None:
        assert why is None
    else:
        assert why is not None and expected in why, why


def test_the_scrub_covers_the_variable():
    assert ENV in checks.config.CHECK_SUBPROCESS_SCRUB


# ---- the fix loop, with run_checks stubbed (metrics 1-4, guardrail 3) ----


@pytest.fixture
def loop(tmp_path, monkeypatch):
    """execute() on the implement step with run_checks and run_agent stubbed.
    Set `outcomes`: one per run_checks call, None for green or a callable
    returning the CheckFailure. `calls` holds each run_checks call's kwargs;
    `events` the order of checks, agent turns and finalize_branch."""
    ws, _ = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo_, item_id: ws)
    monkeypatch.delenv("FARM_FIX_LOOP_CAP", raising=False)
    monkeypatch.delenv("FARM_TARGETED_CHECKS", raising=False)
    state = types.SimpleNamespace(ws=ws, outcomes=[], calls=[], prompts=[], events=[], logged=[], edit=None)

    def run_agent(prompt, **kwargs):
        state.prompts.append(prompt)
        state.events.append("agent")
        (ws / "work.txt").write_text(f"round {len(state.prompts)}\n")
        if state.edit and len(state.prompts) > 1:
            state.edit(ws)
        return {"result": '{"summary": "built it"}', "session_id": "s-1", "num_turns": 5}

    def fake_run_checks(ws_, log, **kwargs):
        state.calls.append(kwargs)
        state.events.append(f"checks:{kwargs.get('only_slot') or 'full'}")
        outcome = state.outcomes[len(state.calls) - 1]
        if outcome is not None:
            raise outcome()
        return "4 repo check(s) passed"

    def fake_check_on_base(repo_full, item_id, failure, **kwargs):
        return step_agent.base_check.BaseVerdict(step_agent.base_check.PASSES_ON_MAIN, [], "passes on main")

    real_finalize = step_agent.finalize_branch
    monkeypatch.setattr(step_agent, "run_agent", run_agent)
    monkeypatch.setattr(step_agent, "run_checks", fake_run_checks)
    monkeypatch.setattr(step_agent.base_check, "check_on_base", fake_check_on_base)
    monkeypatch.setattr(
        step_agent, "finalize_branch", lambda *a, **k: state.events.append("finalize") or real_finalize(*a, **k)
    )
    real_log = step_agent.log
    monkeypatch.setattr(step_agent, "log", lambda msg: (state.logged.append(msg), real_log(msg)))

    def task(targeted_slots=("e2e",)):
        t = make_task(11, IMPLEMENT, repo="acme/demo")
        if targeted_slots is not None:
            t["targeted_slots"] = list(targeted_slots)
        return t

    state.task = task
    return state


def e2e_red(rows=TWO_ROWS):
    return lambda: CheckFailure("repo checks failed: e2e: 2 failed\nE2E-DIGEST", "E2E-DIGEST", slot="e2e", failed_tests=rows)


def lint_red():
    return CheckFailure("repo checks failed: lint: exited 1\nLINT-DIGEST", "LINT-DIGEST", slot="lint")


def test_the_fix_round_first_runs_only_the_failed_slot_with_its_tests_in_the_env(loop):
    """Metric 1, and metric 4's first run: round 1 is the full checks with no
    variable; round 2 runs the e2e slot alone with each failing test's file
    and line, then (green) the full checks."""
    loop.outcomes = [e2e_red(), None, None]

    result = execute(loop.task())

    first, targeted, full = loop.calls
    assert first["only_slot"] is None and not first.get("child_env")
    assert first["capture_screenshots"] is True and first["check_scope"] == "full"
    assert targeted["only_slot"] == "e2e"
    assert targeted["child_env"] == {"HORIZON_FAILED_TESTS": "e2e/a.spec.ts:12\ne2e/b.spec.ts"}
    assert targeted["capture_screenshots"] is False and targeted["check_scope"] == "targeted"
    assert targeted["configured"] is None  # the task's own commands, as the full run gets
    # Metric 2, green: the full checks follow, then the branch is finalized.
    assert full["only_slot"] is None and not full.get("child_env") and full["capture_screenshots"] is True
    assert loop.events == ["agent", "checks:full", "agent", "checks:e2e", "checks:full", "finalize"]
    assert "fix loops: 1" in result["summary"]


def test_a_red_targeted_run_ends_the_round_and_the_next_fix_turn_gets_its_failure(loop):
    """Metric 2, red: no full run in that round; the fix turn starts next."""
    second = lambda: CheckFailure("repo checks failed: e2e: 1 failed\nSTILL-RED", "STILL-RED", slot="e2e", failed_tests=TWO_ROWS[:1])
    loop.outcomes = [e2e_red(), second, None, None]

    result = execute(loop.task())

    assert loop.events == [
        "agent", "checks:full",
        "agent", "checks:e2e",
        "agent", "checks:e2e", "checks:full",
        "finalize",
    ]  # fmt: skip
    assert "STILL-RED" in loop.prompts[2]
    # Round 3's list is round 2's (targeted) failures.
    assert loop.calls[2]["child_env"] == {ENV: "e2e/a.spec.ts:12"}
    assert "fix loops: 2" in result["summary"]


def test_a_targeted_pass_then_a_red_full_run_is_red_and_the_next_round_runs_full(loop):
    """Metric 3 below the cap: targeted green, full red on lint — no
    finalize, the next fix turn names lint, and round 3 runs full because
    lint is not opted in."""
    loop.outcomes = [e2e_red(), None, lint_red, None]

    execute(loop.task())

    assert loop.events == [
        "agent", "checks:full",
        "agent", "checks:e2e", "checks:full",
        "agent", "checks:full",
        "finalize",
    ]  # fmt: skip
    assert "LINT-DIGEST" in loop.prompts[2]
    assert any(line == "targeted checks: skipped — the lint check is not a test slot" for line in loop.logged)


def test_a_targeted_pass_then_a_red_full_run_at_the_cap_fails_with_no_finalize(loop, monkeypatch):
    """Metric 3 at the cap: the CheckFailure is the full run's; nothing is
    finalized, pushed for review or reported as a pass."""
    monkeypatch.setenv("FARM_FIX_LOOP_CAP", "1")
    loop.outcomes = [e2e_red(), None, lint_red]
    posted = []
    monkeypatch.setattr(step_agent, "post_result", posted.append)

    with pytest.raises(CheckFailure, match="LINT-DIGEST"):
        execute(loop.task())

    assert loop.events == ["agent", "checks:full", "agent", "checks:e2e", "checks:full"]
    assert "finalize" not in loop.events
    assert posted == []


@pytest.mark.parametrize(
    "case,slots,red,why",
    [
        ("not opted in", ["test"], e2e_red(), "the e2e slot is not opted in"),
        ("empty JUnit list", ["e2e"], e2e_red(rows=[]), "empty, unreadable or over the cap"),
        ("parent dir row", ["e2e"], e2e_red(rows=[{"file": "../x", "status": "fail"}]), "unreadable"),
        ("201 rows", ["e2e"], e2e_red(rows=[{"file": f"e2e/{i}.spec.ts"} for i in range(201)]), "over the cap"),
    ],
)
def test_a_doubtful_round_runs_the_full_checks_as_today(loop, case, slots, red, why):
    """Metric 4, through the loop: the fix round's first run is the full one,
    and the log says why."""
    loop.outcomes = [red, None]

    execute(loop.task(slots))

    assert [call["only_slot"] for call in loop.calls] == [None, None]
    assert all(not call.get("child_env") for call in loop.calls)
    skipped = [line for line in loop.logged if line.startswith("targeted checks: skipped — ")]
    assert skipped[0] == "targeted checks: skipped — the first check run of this step"
    assert why in skipped[1], skipped


def test_a_repo_with_no_opted_in_slot_runs_and_logs_as_today(loop):
    loop.outcomes = [e2e_red(), None]

    execute(loop.task(targeted_slots=None))

    assert [call["only_slot"] for call in loop.calls] == [None, None]
    assert not [line for line in loop.logged if line.startswith("targeted checks:")]


def test_a_fix_that_changes_a_lockfile_runs_the_full_checks(loop):
    loop.outcomes = [e2e_red(), None]
    loop.edit = lambda ws: (ws / "package-lock.json").write_text("{}\n")

    execute(loop.task())

    assert [call["only_slot"] for call in loop.calls] == [None, None]
    assert any("changed package-lock.json" in line for line in loop.logged)


@pytest.mark.parametrize("opted", [True, False], ids=["opted-in", "not-opted-in"])
def test_the_fix_turn_count_at_the_cap_is_the_same_opted_in_or_not(loop, monkeypatch, opted):
    """Guardrail 3: a targeted run is part of its round. Cap 2 with e2e
    always red: 1 + 2 check rounds and 1 + 2 agent calls either way."""
    monkeypatch.setenv("FARM_FIX_LOOP_CAP", "2")
    loop.outcomes = [e2e_red()] * 3

    with pytest.raises(CheckFailure, match="E2E-DIGEST"):
        execute(loop.task(["e2e"] if opted else None))

    assert len(loop.prompts) == 1 + 2
    assert [call["only_slot"] for call in loop.calls] == ([None, "e2e", "e2e"] if opted else [None, None, None])
    assert any(line.startswith("fix loop: no fix turn — 2 of 2 fix turn(s) used") for line in loop.logged)


# ---- real check runs: isolation, the env, the record (metrics 2, 5; guardrails 1, 2, 4) ----


SLOT_SCRIPT = """#!/bin/sh
# Appends "<slot> <the variable, or ->" to the marker, then fails when the
# workspace holds flags/<slot>, writing a JUnit report of two failing tests.
slot="$1"
printf '%s %s\\n' "$slot" "$(printf '%s' "${HORIZON_FAILED_TESTS--}" | tr '\\n' '|')" >> "$MARKER"
if [ -f "flags/$slot" ]; then
  cat > "$HORIZON_TEST_REPORT_DIR/r.xml" <<XML
<testsuite name="$slot"><testcase name="opens" file="e2e/a.spec.ts" line="12"><failure message="no"/></testcase><testcase name="saves" file="e2e/b.spec.ts"><failure message="no"/></testcase></testsuite>
XML
  echo "not ok - $slot red"
  exit 1
fi
echo "ok - $slot"
"""


@pytest.fixture
def real(tmp_path, monkeypatch):
    """Real run_checks over four configured slots, each running SLOT_SCRIPT,
    in a per-test FARM_HOME (slots and the metrics file)."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv(ENV, raising=False)
    monkeypatch.setenv("FARM_DEP_CACHE", "0")
    monkeypatch.setenv(checks.RERUN_ENV, "0")
    script = tmp_path / "slot.sh"
    script.write_text(SLOT_SCRIPT)
    marker = tmp_path / "marker"
    monkeypatch.setenv("MARKER", str(marker))
    configured = {slot: f"sh {script} {slot}" for slot in ("install", "test", "lint", "e2e")}

    def lines():
        return marker.read_text().splitlines() if marker.exists() else []

    def records():
        return check_metrics.read_records(check_metrics.metrics_path())[0]

    return types.SimpleNamespace(configured=configured, marker=marker, lines=lines, records=records)


def test_a_red_targeted_round_runs_only_its_slot_and_records_both_scopes(tmp_path, monkeypatch, real):
    """Metric 2 (only the e2e slot runs: no install, no other slot) and
    metric 5 (each run's record and log line says targeted or full, and how
    long it took)."""
    ws, _ = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo_, item_id: ws)
    monkeypatch.delenv("FARM_FIX_LOOP_CAP", raising=False)
    monkeypatch.delenv("FARM_TARGETED_CHECKS", raising=False)
    monkeypatch.setattr(
        step_agent.base_check,
        "check_on_base",
        lambda *a, **k: step_agent.base_check.BaseVerdict(step_agent.base_check.PASSES_ON_MAIN, [], "passes"),
    )
    turns = []

    def run_agent(prompt, **kwargs):
        turns.append(prompt)
        with real.marker.open("a") as fh:
            fh.write("agent\n")
        (ws / "flags").mkdir(exist_ok=True)
        # Turns 1 and 2 leave e2e red; turn 3 fixes it.
        if len(turns) < 3:
            (ws / "flags" / "e2e").write_text("red\n")
        else:
            (ws / "flags" / "e2e").unlink()
            (ws / "flags" / "keep").write_text("x\n")
        return {"result": '{"summary": "built it"}', "session_id": "s-1", "num_turns": 5}

    monkeypatch.setattr(step_agent, "run_agent", run_agent)
    logged = []
    real_log = step_agent.log
    monkeypatch.setattr(step_agent, "log", lambda msg: (logged.append(msg), real_log(msg)))
    task = make_task(11, IMPLEMENT, repo="acme/demo")
    task["check_commands"] = real.configured
    task["targeted_slots"] = ["e2e"]

    result = execute(task)

    listed = "e2e/a.spec.ts:12|e2e/b.spec.ts"
    assert real.lines() == [
        "agent",
        "install -", "test -", "lint -", "e2e -",
        "agent",
        f"e2e {listed}",
        "agent",
        f"e2e {listed}",
        "install -", "test -", "lint -", "e2e -",
    ]  # fmt: skip
    assert "fix loops: 2" in result["summary"]
    assert "not ok - e2e red" in turns[2]

    records = [r for r in real.records() if r["item_id"] == "T-1"]
    assert [r["scope"] for r in records] == ["full", "targeted", "targeted", "full"]
    assert [r["outcome"] for r in records] == ["other", "other", "pass", "pass"]
    assert [r["targeted_tests"] for r in records] == [None, 2, 2, None]
    assert all(isinstance(r["duration_s"], float) and r["duration_s"] >= 0 for r in records)
    assert [len(r["commands"]) for r in records] == [4, 1, 1, 4]
    scoped = [line for line in logged if line.startswith("checks: scope=")]
    assert [line.split(" duration_s=")[0] for line in scoped] == [
        "checks: scope=full",
        "checks: scope=targeted slot=e2e tests=2",
        "checks: scope=targeted slot=e2e tests=2",
        "checks: scope=full",
    ]
    assert [line.rsplit(" result=", 1)[1] for line in scoped] == ["red", "red", "green", "green"]


def _ws(tmp_path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def test_a_targeted_run_hands_the_child_the_list_verbatim_and_never_through_the_shell(tmp_path, real):
    """Guardrails 1 and 4: a shell-shaped file name reaches the child as data
    and runs nothing; the command line and its record never carry it."""
    ws = _ws(tmp_path)
    evil = "e2e/a$(touch PWNED);b.spec.ts"
    value = targeted_checks.failed_tests_value([{"file": evil, "line": None}, {"file": "e2e/c.spec.ts", "line": 3}])
    assert value == f"{evil}\ne2e/c.spec.ts:3"
    out = tmp_path / "seen"
    configured = {**real.configured, "e2e": f"sh -c 'printf %s \"$HORIZON_FAILED_TESTS\" > {out}'"}
    logged = []

    note = run_checks(ws, logged.append, configured=configured, only_slot="e2e", check_scope="targeted", child_env={ENV: value})

    assert note == "1 repo check(s) passed"
    assert out.read_text() == value
    assert not list(tmp_path.rglob("PWNED")) and not (Path.cwd() / "PWNED").exists()
    assert real.lines() == []  # install, test and lint never ran
    assert not [line for line in logged if "PWNED" in line or "c.spec.ts" in line]
    (record,) = real.records()
    assert "PWNED" not in json.dumps(record["commands"]) and record["install"] is None
    assert record["scope"] == "targeted" and record["targeted_tests"] == 2


def test_a_stale_inherited_variable_never_reaches_a_full_run(tmp_path, monkeypatch, real):
    """Guardrail 2: only a targeted run's own child_env sets the variable."""
    monkeypatch.setenv(ENV, "e2e/stale.spec.ts")
    ws = _ws(tmp_path)

    run_checks(ws, lambda *_: None, configured=real.configured)

    assert real.lines() == ["install -", "test -", "lint -", "e2e -"]
    assert real.records()[0]["scope"] == "full" and real.records()[0]["targeted_tests"] is None


def test_a_test_env_file_can_never_set_the_variable(tmp_path, real):
    """Guardrail 2: the farm's value always wins, because a login file that
    names it is refused and nothing runs."""
    ws = _ws(tmp_path)
    env_file = tmp_path / "login.env"
    env_file.write_text("HORIZON_FAILED_TESTS=e2e/pinned.spec.ts\n")

    with pytest.raises(CheckFailure) as err:
        run_checks(
            ws,
            lambda *_: None,
            configured=real.configured,
            only_slot="e2e",
            check_scope="targeted",
            child_env={ENV: "e2e/a.spec.ts"},
            test_env_file=str(env_file),
        )

    assert err.value.command == login_env.COMMAND_LABEL
    assert real.lines() == []


def test_a_targeted_run_of_a_slot_with_no_command_runs_nothing(tmp_path, real):
    ws = _ws(tmp_path)

    with pytest.raises(CheckFailure, match="no e2e slot command") as err:
        run_checks(ws, lambda *_: None, configured={"test": real.configured["test"]}, only_slot="e2e")

    assert err.value.reason == "none_ran"
    assert real.lines() == []
