"""HZ-456: the implement step pushes its committed work to the item's own
branch BEFORE the repo checks, so a step killed during them (its time limit,
a farm restart) leaves the work where the retry's prepare_branch resumes it.
"""

import json
import os
import signal
import subprocess
import time

import pytest

from farm import config as farm_config
from farm import farmd, pause, step_agent
from farm.config import QUEUE_DIR
from farm.tests.test_pause import (  # noqa: F401 — child_agents and cleanup_queue are fixtures
    ChildAgent,
    child_agents,
    cleanup_queue,
    linux_only,
    main_harness,
)
from farm.tests.test_step_agent import (
    _commits_over,
    _origin_rev,
    git,
    make_git_workspace,
    make_task,
    origin_log,
    precheck_state_text,
    rev,
)

IMPLEMENT = step_agent.IMPLEMENT_LABEL
FARM_SUBJECT = "T-1: Test item (Horizon Eng agent)"


def _kill(child, sig):
    """What farmd's kill_session does to a run's session: the step process
    and everything under it (the check commands) get `sig`, no handler runs."""
    for pid in pause.descendants(child.proc.pid):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    child.proc.send_signal(sig)
    child.proc.wait(timeout=30)


def _hanging_checks(tmp_path):
    """A check that records what origin holds for the item's branch, says it
    started, then hangs past any short time limit."""
    seen, ready = tmp_path / "remote-during-checks", tmp_path / "checks-started"
    cmd = f"git ls-remote origin refs/heads/horizon/t-1 | cut -f1 > {seen}; touch {ready}; sleep 60"
    return cmd, seen, ready


def _killed_env(tmp_path, cmd):
    """A killed step cleans up nothing, so its temp files go to tmp_path,
    never the suite's leak-guarded sandbox."""
    tmp = tmp_path / "child-tmp"
    tmp.mkdir()
    return {"FARM_CHECK_CMD": cmd, "TMPDIR": str(tmp)}


def _race_clone(tmp_path, origin):
    race = tmp_path / "race"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(race)], check=True, capture_output=True)
    git(race, "config", "user.email", "race@example.com")
    git(race, "config", "user.name", "Racer")
    return race


def _wrote(ws, name, text="work\n", **extra):
    def _agent(prompt, **kwargs):
        (ws / name).write_text(text)
        for fn in extra.values():
            fn()
        return {"result": '{"summary": "built it"}'}

    return _agent


@pytest.fixture
def ws_origin(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    return ws, origin


# ---- metric 1: pushed before checks ----


@linux_only
def test_a_step_killed_mid_check_leaves_its_commit_on_the_branch(tmp_path, child_agents):
    ws, origin = make_git_workspace(tmp_path)
    assert _origin_rev(origin) == "", "the branch must not exist before the step"
    cmd, seen, ready = _hanging_checks(tmp_path)
    child = ChildAgent(tmp_path, ws, run_id=9561, block="none", env=_killed_env(tmp_path, cmd))
    child_agents.append(child)
    child.wait_until(ready.exists, "the checks to start")

    _kill(child, signal.SIGHUP)

    head = rev(ws, "HEAD")
    assert git_subject(ws) == FARM_SUBJECT
    # The push happened before the checks: the check itself saw it.
    assert seen.read_text().strip() == head
    assert _origin_rev(origin) == head
    # No result was posted, so no PR can have been opened from it.
    assert not child.posted.exists()

    # The retry's prepare_branch checks out that commit, not origin/main.
    prepared = step_agent.prepare_branch(ws, make_task(11, IMPLEMENT, repo="acme/demo")["item"], rebase_checkpoint=True)
    assert prepared.lease_sha == head
    assert rev(ws, "HEAD") == head != rev(ws, "origin/main")


def git_subject(ws, ref="HEAD"):
    return subprocess.run(["git", "-C", str(ws), "log", "-1", "--format=%s", ref], capture_output=True, text=True).stdout.strip()


# ---- metric 2: checks pass, one commit ----


def test_passing_checks_push_one_commit_named_by_the_checked_tree_record(tmp_path, ws_origin, monkeypatch, pause_state):
    ws, origin = ws_origin
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setattr(step_agent, "run_agent", _wrote(ws, "work.txt"))
    task_file, _ = main_harness(tmp_path, monkeypatch)
    # The server opens the PR from the posted result's branch: record what
    # origin holds at that moment.
    posted = []
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.append((json, _origin_rev(origin))))

    assert step_agent.main() == 0

    [(result, remote_at_post)] = posted
    assert result["ok"] is True
    artifacts = result["artifacts"]
    assert artifacts["branch"] == "horizon/t-1"
    assert _commits_over(origin, "main") == 1
    assert remote_at_post == artifacts["checks_passed_sha"] == _origin_rev(origin)
    assert origin_log(origin).splitlines()[0] == FARM_SUBJECT
    assert not step_agent._git_path(ws, step_agent.PRECHECK_CHECKPOINT).exists()


# ---- metric 3: checks fail, salvage reuses the pushed commit ----


def test_failing_checks_leave_the_pushed_head_unchanged(ws_origin, monkeypatch, capsys):
    ws, origin = ws_origin
    before = ws.parent / "remote-before-failure"
    monkeypatch.setenv("FARM_CHECK_CMD", f"git ls-remote origin refs/heads/horizon/t-1 | cut -f1 > {before}; echo 'not ok 3 - widget'; exit 1")
    monkeypatch.setattr(step_agent, "run_agent", _wrote(ws, "work.txt"))

    with pytest.raises(step_agent.CheckFailure):
        step_agent.execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    pushed = before.read_text().strip()
    assert pushed and _origin_rev(origin) == pushed == rev(ws, "HEAD")
    assert _commits_over(origin, "main") == 1
    assert step_agent.CHECKPOINT_MARKER not in origin_log(origin).splitlines()[0]
    state = precheck_state_text(ws)
    assert state.splitlines()[:2] == [pushed, step_agent.CAUSE_CHECKS_FAILED]
    assert "not ok 3 - widget" in state
    assert "no commit made, nothing pushed" in capsys.readouterr().out


# ---- metric 4: farm restart, then the retry ----


@linux_only
def test_a_retry_after_the_step_is_killed_resumes_from_the_checkpoint(tmp_path, monkeypatch, child_agents, cleanup_queue):
    run_id = 9562
    cleanup_queue.append(run_id)
    ws, origin = make_git_workspace(tmp_path)
    cmd, _seen, ready = _hanging_checks(tmp_path)
    child = ChildAgent(tmp_path, ws, run_id=run_id, block="none", env=_killed_env(tmp_path, cmd), task_dir=QUEUE_DIR / "runs" / "active")
    child_agents.append(child)
    child.wait_until(ready.exists, "the checks to start")

    _kill(child, signal.SIGKILL)
    checkpoint = rev(ws, "HEAD")
    assert _origin_rev(origin) == checkpoint

    # farmd boots: the run's task file is still claimed, its session is gone.
    task = json.loads(child.task.read_text())
    task["claimed_at"] = time.time() - farm_config.RECONCILE_GRACE_S - 5
    child.task.write_text(json.dumps(task))
    reported = []
    monkeypatch.setattr(farmd, "_notify_started", lambda rid: True)
    monkeypatch.setattr(farmd, "_report_run_dead", lambda rid, name: reported.append((rid, name)) or True)

    farmd._reconcile_claimed_runs()

    assert [r for r in reported if r[0] == str(run_id)] == [(str(run_id), farmd._run_session_name(task))]
    assert not child.task.exists()

    # The server retries the step (not covered here): attempt 2 runs.
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    seen = {}

    def attempt_2(prompt, **kwargs):
        seen["head"] = rev(ws, "HEAD")
        seen["prompt"] = prompt
        (ws / "more.txt").write_text("checked again\n")
        return {"result": '{"summary": "re-checked"}'}

    monkeypatch.setattr(step_agent, "run_agent", attempt_2)
    retry = make_task(11, IMPLEMENT, repo="acme/demo")
    retry["attempt"] = 2
    result = step_agent.execute(retry)

    assert seen["head"] == checkpoint
    assert "stopped while the repo's checks were still running" in seen["prompt"]
    assert "paused_work.txt" in seen["prompt"]
    tip = _origin_rev(origin)
    assert result["artifacts"]["checks_passed_sha"] == tip
    assert subprocess.run(["git", "-C", str(ws), "merge-base", "--is-ancestor", checkpoint, tip]).returncode == 0


# ---- guardrail 1: only the item's own branch, never an open PR ----


def _pushed_pr_branch(ws):
    git(ws, "checkout", "-q", "-B", "horizon/t-1")
    (ws / "reviewed.txt").write_text("reviewed\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", FARM_SUBJECT)
    git(ws, "push", "-q", "origin", "horizon/t-1")
    return rev(ws, "HEAD")


def _fix_task(base):
    task = make_task(11, IMPLEMENT, repo="acme/demo")
    task["scope"] = {"mode": "fix", "base_sha": base, "findings": [{"file": "reviewed.txt", "summary": "x"}]}
    return task


def test_a_fix_pass_pushes_nothing_before_its_checks(ws_origin, monkeypatch, capsys):
    ws, origin = ws_origin
    pr_head = _pushed_pr_branch(ws)
    monkeypatch.setenv("FARM_CHECK_CMD", f'test "$(git ls-remote origin refs/heads/horizon/t-1 | cut -f1)" = {pr_head}')
    monkeypatch.setattr(step_agent, "run_agent", _wrote(ws, "reviewed.txt", "fixed\n"))

    result = step_agent.execute(_fix_task(pr_head))

    assert "a PR is open on horizon/t-1, nothing pushed before the checks" in capsys.readouterr().out
    assert result["artifacts"]["checks_passed_sha"] == _origin_rev(origin) != pr_head


def test_a_fix_pass_ignores_a_stale_precheck_file_at_its_head(ws_origin, monkeypatch):
    ws, origin = ws_origin
    pr_head = _pushed_pr_branch(ws)
    # An earlier implement attempt's record, naming the commit since finalized.
    step_agent._write_precheck_state(ws, pr_head, step_agent.CAUSE_CHECKS_FAILED, "not ok 9 - stale")
    assert step_agent._last_check_failure(ws) == ""
    monkeypatch.setenv("FARM_CHECK_CMD", f'test "$(git ls-remote origin refs/heads/horizon/t-1 | cut -f1)" = {pr_head}')
    seen = {}

    def _agent(prompt, **kwargs):
        seen["prompt"] = prompt
        (ws / "reviewed.txt").write_text("fixed\n")
        return {"result": '{"summary": "fixed"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)

    step_agent.execute(_fix_task(pr_head))

    assert "not ok 9 - stale" not in seen["prompt"]
    assert "checks failed" not in seen["prompt"]


# ---- guardrails 2 and 4: never over someone else's push; a failed push still runs the checks ----


def test_a_hand_pushed_commit_fails_the_lease_and_the_checks_still_run(tmp_path, ws_origin, monkeypatch, capsys):
    ws, origin = ws_origin
    race = _race_clone(tmp_path, origin)
    ran = tmp_path / "checks-ran"

    def hand_push():
        # Pushed by hand after prepare_branch fetched (HZ-446's f5daf4b).
        git(race, "checkout", "-q", "-b", "horizon/t-1")
        (race / "salvage.txt").write_text("saved by hand\n")
        git(race, "add", "-A")
        git(race, "commit", "-q", "-m", "hand-pushed salvage")
        git(race, "push", "-q", "origin", "horizon/t-1")

    monkeypatch.setattr(step_agent, "run_agent", _wrote(ws, "work.txt", hand_push=hand_push))
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {ran}")

    # The checks pass, but the finalize push leases against the same fetch
    # and is rejected too: the step fails on that push, nothing is forced.
    with pytest.raises(RuntimeError, match=r"git push --force-with-lease=refs/heads/horizon/t-1: .* failed"):
        step_agent.execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    hand_pushed = rev(race, "HEAD")
    assert ran.exists(), "the checks must run after a failed checkpoint push"
    assert "checkpoint: push failed" in capsys.readouterr().out
    assert _origin_rev(origin) == hand_pushed


@pytest.mark.parametrize(
    ("rebased", "note", "pushes"),
    [(False, "", False), (True, "", True), (False, "\n\nNOTE: the checkpoint was rebased onto current origin/main", False)],
    ids=["not-ancestor-skips", "rebased-pushes", "a-note-alone-skips"],
)
def test_only_a_rebase_lets_the_checkpoint_replace_commits_head_does_not_contain(tmp_path, rebased, note, pushes, capsys):
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "checkout", "-q", "-b", "horizon/t-1")
    (ws / "old.txt").write_text("the remote's checkpoint\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", "remote checkpoint")
    git(ws, "push", "-q", "origin", "horizon/t-1")
    remote = rev(ws, "HEAD")
    git(ws, "reset", "-q", "--hard", "origin/main")
    (ws / "new.txt").write_text("work that does not contain it\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", FARM_SUBJECT)
    head = rev(ws, "HEAD")
    item = make_task(11, IMPLEMENT, repo="acme/demo")["item"]
    prepared = step_agent.PreparedBranch("horizon/t-1", remote, note, rebased)

    got = step_agent._push_precheck_checkpoint(ws, item, "horizon/t-1", prepared, {"mode": "full"})

    if pushes:
        assert got == head and _origin_rev(origin) == head
    else:
        assert got == "" and _origin_rev(origin) == remote
        assert "checkpoint: skipped — origin/horizon/t-1 holds commits HEAD does not contain" in capsys.readouterr().out


def test_an_unreachable_remote_still_runs_the_checks_and_logs_no_credentials(tmp_path, ws_origin, monkeypatch, capsys):
    ws, origin = ws_origin
    secret = "ghp_" + "Q7" * 18
    monkeypatch.setenv("GITHUB_TOKEN", secret)
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    ran = tmp_path / "checks-ran"

    def unreachable():
        git(ws, "remote", "set-url", "--push", "origin", f"https://farm:{secret}@127.0.0.1:9/acme/demo.git")

    monkeypatch.setattr(step_agent, "run_agent", _wrote(ws, "work.txt", unreachable=unreachable))
    monkeypatch.setenv("FARM_CHECK_CMD", f"touch {ran}")

    with pytest.raises(RuntimeError):
        step_agent.execute(make_task(11, IMPLEMENT, repo="acme/demo"))

    out = capsys.readouterr().out
    assert ran.exists()
    assert "checkpoint: push failed" in out
    line = next(line for line in out.splitlines() if "checkpoint: push failed" in line)
    assert secret not in line
    assert _origin_rev(origin) == ""
