"""HZ-458: a red repo check goes back to the same agent session in the same
attempt, with the work intact, to fix just that failure; the checks then
re-run. FARM_FIX_LOOP_CAP (default 2) bounds the fix turns, each draws on the
step's turn cap and the agent time left (check time is not agent time), and a
fix that loosens the checks fails the attempt. After the cap, the attempt
fails exactly as before: salvage checkpoint, CheckFailure, no PR."""

import subprocess
import time
import types

import pytest

from farm import step_agent
from farm.step_agent import CheckFailure, execute
from farm.tests.test_step_agent import (
    _origin_rev,
    make_git_workspace,
    make_task,
    origin_body,
    origin_log,
    rev,
)

IMPLEMENT = step_agent.IMPLEMENT_LABEL
MAX_TURNS, BUDGET_S = step_agent.steps.budget_for_label(step_agent.steps.FARM_VIEWS["change"], IMPLEMENT)


def _task(**item):
    task = make_task(11, IMPLEMENT, repo="acme/demo")
    task["item"].update(item)
    return task


@pytest.fixture
def ws_origin(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.delenv("FARM_FIX_LOOP_CAP", raising=False)
    return ws, origin


@pytest.fixture
def check_rounds(monkeypatch):
    """Wraps the real run_checks: one entry per check round, holding the
    raised CheckFailure (or None for green)."""
    rounds = []
    real = step_agent.run_checks

    def wrapped(*args, **kwargs):
        try:
            note = real(*args, **kwargs)
        except CheckFailure as exc:
            rounds.append(exc)
            raise
        rounds.append(None)
        return note

    monkeypatch.setattr(step_agent, "run_checks", wrapped)
    return rounds


@pytest.fixture
def agent_calls(monkeypatch):
    """Records each run_agent call's prompt and kwargs, then runs the real one
    (fake_claude through the subprocess provider)."""
    calls = []
    real = step_agent.run_agent

    def wrapped(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        return real(prompt, **kwargs)

    monkeypatch.setattr(step_agent, "run_agent", wrapped)
    return calls


def _seeded_bug_check(tmp_path):
    """A check that logs what origin holds for the item's branch and HEAD,
    then fails while the seeded bug is on disk."""
    log = tmp_path / "check-log"
    cmd = (
        f"echo \"$(git ls-remote origin refs/heads/horizon/t-1 | cut -f1) $(git rev-parse HEAD)\" >> {log}; "
        "if [ -f seeded_bug.txt ]; then echo 'ok 1 - fine'; echo 'not ok 2 - seeded bug still present'; "
        "echo '# fail 1'; exit 1; fi; echo 'ok 1 - fine'"
    )
    return cmd, log


# ---- metric 3: red check -> fix in the same attempt ----


def test_a_red_check_goes_back_to_the_same_session_and_the_item_submits_on_attempt_1(
    tmp_path, ws_origin, monkeypatch, check_rounds, agent_calls, checks_notify
):
    ws, origin = ws_origin
    cmd, log = _seeded_bug_check(tmp_path)
    monkeypatch.setenv("FARM_CHECK_CMD", cmd)
    pushes = []
    real_push = step_agent._push_with_lease
    monkeypatch.setattr(
        step_agent, "_push_with_lease", lambda ws_, item, branch, lease_sha: pushes.append(lease_sha) or real_push(ws_, item, branch, lease_sha)
    )

    task = _task(desc="Deliver the thing HZ458_SEEDED_BUG")
    result = execute(task)  # one execute(): one step run, attempt 1

    # The checks ran twice: red on the seeded bug, then green on the fix.
    assert [exc is None for exc in check_rounds] == [False, True]
    first, fix = agent_calls
    # The fix turn got the existing check-failure digest, in the same session.
    digest = check_rounds[0].digest
    assert "not ok 2 - seeded bug still present" in digest
    assert digest in fix["prompt"]
    assert fix["session_id"] == "fake-session-hz458"
    assert first.get("session_id") is None
    # Guardrail 3: the fix turn draws on the step's turn cap (fake_claude used 7).
    assert first["max_turns"] == MAX_TURNS
    assert fix["max_turns"] == MAX_TURNS - 7
    assert "fix loops: 1" in result["summary"]
    assert result["artifacts"]["branch"] == "horizon/t-1"
    assert not (ws / "seeded_bug.txt").exists()

    # HZ-456 on every round: at each check, origin already held the commit
    # under test — round 2's fix commit included, not just round 1's.
    logged = [line.split() for line in log.read_text().splitlines()]
    round_1_head, round_2_head = logged[0][1], logged[-1][1]
    assert round_1_head != round_2_head
    assert all(remote == head for remote, head in logged)
    assert rev(ws, "HEAD") == round_2_head == _origin_rev(origin)
    # Round 2's pre-check push leased on round 1's pushed commit; the final
    # push leases on what round 2 left there.
    assert pushes == ["", round_1_head, round_2_head]
    # Two farm commits, each published once and never amended: the work, then the fix.
    assert origin_log(origin).splitlines()[:3] == ["T-1: Test item (Horizon Eng agent)"] * 2 + ["initial"]
    # The server's step clock was paused around both check rounds.
    assert checks_notify == [(1, "start"), (1, "end"), (1, "start"), (1, "end")]


def test_check_time_is_not_agent_time_for_the_fix_turn(ws_origin, monkeypatch, checks_notify):
    """Metric 5, farm clock: checks longer than the agent time left still
    leave the fix turn the agent time that was left before them."""
    ws, _ = ws_origin
    now = [1000.0]
    clock = types.SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith("_")})
    clock.monotonic = lambda: now[0]
    monkeypatch.setattr(step_agent, "time", clock)
    agent_s, check_s = 1000, BUDGET_S  # the checks alone outlast the whole step budget
    calls = []

    def run_agent(prompt, **kwargs):
        calls.append(kwargs)
        now[0] += agent_s if len(calls) == 1 else 10
        (ws / "work.txt").write_text(f"round {len(calls)}\n")
        return {"result": '{"summary": "built it"}', "session_id": "s-1", "num_turns": 5}

    def run_checks(*args, **kwargs):
        now[0] += check_s
        if len(calls) == 1:
            raise CheckFailure("repo checks failed (sh -c npm test):\nnot ok 1 - x", "not ok 1 - x")
        return "1 repo check(s) passed"

    monkeypatch.setattr(step_agent, "run_agent", run_agent)
    monkeypatch.setattr(step_agent, "run_checks", run_checks)

    result = execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    assert "fix loops: 1" in result["summary"]
    assert calls[1]["timeout_s"] == BUDGET_S - agent_s
    assert calls[1]["timeout_s"] >= step_agent.FIX_TURN_MIN_S
    assert calls[1]["session_id"] == "s-1"


# ---- metric 4: the fix-loop cap ----


def test_an_always_red_check_runs_1_plus_cap_times_then_fails_as_before(
    tmp_path, ws_origin, monkeypatch, check_rounds, agent_calls
):
    ws, origin = ws_origin
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'not ok 1 - always red'; exit 1")
    spies, salvaged = [], []
    monkeypatch.setattr(step_agent, "finalize_branch", lambda *a, **k: spies.append("finalize_branch"))
    monkeypatch.setattr(step_agent, "publish_screenshots", lambda *a, **k: spies.append("publish_screenshots"))
    real_salvage = step_agent._salvage_checkpoint
    monkeypatch.setattr(
        step_agent, "_salvage_checkpoint", lambda *a, **k: salvaged.append(k.get("cause")) or real_salvage(*a, **k)
    )

    with pytest.raises(CheckFailure, match="^repo checks failed"):
        execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    assert len(check_rounds) == 1 + 2
    assert len(agent_calls) == 1 + 2
    # Each fix turn got its own round's digest.
    assert all(exc.digest in call["prompt"] for exc, call in zip(check_rounds, agent_calls[1:]))
    # Today's failure path: one checks-failed salvage, no finalize, no PR.
    assert salvaged == [step_agent.CAUSE_CHECKS_FAILED]
    assert spies == []
    assert "not ok 1 - always red" in step_agent._precheck_state(ws)[1]
    assert step_agent.CHECKPOINT_MARKER not in origin_log(origin)


def test_cap_0_restores_the_single_check_run(ws_origin, monkeypatch, check_rounds, agent_calls):
    monkeypatch.setenv("FARM_FIX_LOOP_CAP", "0")
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'not ok 1 - always red'; exit 1")

    with pytest.raises(CheckFailure, match="^repo checks failed"):
        execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    assert len(check_rounds) == 1
    assert len(agent_calls) == 1


# ---- guardrail 3: fix turns stay inside the turn cap ----


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param({"result": '{"summary": "built it"}', "session_id": "s-1"}, id="no-num-turns"),
        pytest.param({"result": '{"summary": "built it"}', "session_id": "s-1", "num_turns": MAX_TURNS}, id="all-turns-used"),
    ],
)
def test_no_fix_turn_without_turns_to_spare(ws_origin, monkeypatch, check_rounds, reply):
    ws, origin = ws_origin
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'not ok 1 - red'; exit 1")
    calls = []

    def run_agent(prompt, **kwargs):
        calls.append(kwargs)
        (ws / "work.txt").write_text("work\n")
        return dict(reply)

    monkeypatch.setattr(step_agent, "run_agent", run_agent)

    with pytest.raises(CheckFailure, match="^repo checks failed"):
        execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    assert len(check_rounds) == 1
    assert len(calls) == 1
    assert "not ok 1 - red" in step_agent._precheck_state(ws)[1]


# ---- guardrail 4: a fix turn must not loosen the checks ----


def test_a_fix_turn_that_skips_a_test_fails_the_attempt_unchecked(ws_origin, monkeypatch, check_rounds):
    ws, origin = ws_origin
    (ws / "widget.test.mjs").write_text("test('renders', () => {})\n")
    subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(ws), "commit", "-qm", "a test"], check=True)
    subprocess.run(["git", "-C", str(ws), "push", "-q", "origin", "main"], check=True)
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'not ok 1 - renders'; exit 1")
    calls, spies = [], []

    def run_agent(prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            (ws / "widget.mjs").write_text("export const widget = 1\n")
        else:
            (ws / "widget.test.mjs").write_text("test.skip('renders', () => {})\n")
        return {"result": '{"summary": "built it"}', "session_id": "s-1", "num_turns": 5}

    monkeypatch.setattr(step_agent, "run_agent", run_agent)
    monkeypatch.setattr(step_agent, "finalize_branch", lambda *a, **k: spies.append("finalize_branch"))

    with pytest.raises(CheckFailure, match="^repo checks failed") as err:
        execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    # The loosened fix is never checked, finalized or pushed for review: it
    # is salvaged as a checks-failed checkpoint that names what it did.
    assert len(check_rounds) == 1
    assert spies == []
    assert "widget.test.mjs: added `test.skip('renders', () => {})`" in err.value.digest
    body = origin_body(origin)
    assert body.startswith("cause: checks-failed")
    assert "not ok 1 - renders" in body and "test.skip(" in body


def test_loosened_checks_flags_config_and_check_sections_but_not_ordinary_fixes(ws_origin):
    ws, _ = ws_origin
    files = {
        "pyproject.toml": "[project]\nname = 'x'\ndependencies = []\n\n[tool.pytest.ini_options]\naddopts = '-q'\n",
        "farm/tests/conftest.py": "import pytest\n",
        "playwright.config.js": "export default {}\n",
        "farm/tests/test_a.py": "def test_a():\n    assert True\n",
    }
    for path, text in files.items():
        (ws / path).parent.mkdir(parents=True, exist_ok=True)
        (ws / path).write_text(text)
    subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(ws), "commit", "-qm", "base"], check=True)
    base = rev(ws, "HEAD")

    def after(edits):
        subprocess.run(["git", "-C", str(ws), "reset", "-q", "--hard", base], check=True)
        for path, text in edits.items():
            if text is None:
                (ws / path).unlink()
            else:
                (ws / path).write_text(text)
        subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(ws), "commit", "-qm", "fix", "--allow-empty"], check=True)
        return step_agent._loosened_checks(ws, base)

    # Ordinary fixes: a dependency bump and a conftest fixture fix.
    assert after({"pyproject.toml": files["pyproject.toml"].replace("[]", "['httpx']")}) == []
    assert after({"farm/tests/conftest.py": "import pytest\n\n\n@pytest.fixture\ndef x():\n    return 1\n"}) == []
    # Loosening.
    assert after({"pyproject.toml": files["pyproject.toml"].replace("-q", "-q -k 'not slow'")}) == [
        "changed [tool.pytest.ini_options] in pyproject.toml"
    ]
    assert after({"farm/tests/conftest.py": "collect_ignore = ['test_a.py']\n"}) == [
        "farm/tests/conftest.py: added `collect_ignore = ['test_a.py']`"
    ]
    assert after({"playwright.config.js": "export default { retries: 5 }\n"}) == ["changed check config playwright.config.js"]
    assert after({"farm/tests/test_a.py": None}) == ["deleted test file farm/tests/test_a.py"]
    assert after({"farm/tests/test_a.py": "import pytest\n\n\n@pytest.mark.xfail\ndef test_a():\n    assert True\n"}) == [
        "farm/tests/test_a.py: added `@pytest.mark.xfail`"
    ]


def test_notify_checks_posts_to_farmd_and_fails_open(monkeypatch):
    real = _REAL_NOTIFY
    posted = []
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.append((url, json)))
    real(7, "start")
    assert posted == [(f"{step_agent.FARMD}/internal/steps/checks", {"run_id": 7, "phase": "start"})]

    def down(*a, **k):
        raise ConnectionError("farmd is down")

    monkeypatch.setattr(step_agent.httpx, "post", down)
    real(7, "end")  # never raises
    posted.clear()
    real(None, "start")  # no run id (a local run): nothing to tell
    assert posted == []


# Captured at import, before the autouse conftest stub replaces it per test.
_REAL_NOTIFY = step_agent._notify_checks
