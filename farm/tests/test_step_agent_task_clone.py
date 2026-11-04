"""HZ-738: Assess, Run plan and Impact review fast-forward the task clone
before they read it, as Execute does — and Assess and Impact review move the
item worktree they actually read to the same sha.

Every step runs through step_agent.execute() with run_agent stubbed; the stub
records what the clone and the worktree hold at the moment it is spawned.
The git repos are real: a local bare origin stands in for GitHub, with the
task clone, the farm's hub and the item worktree all made one commit behind.
"""

import json
import subprocess
import sys
from types import SimpleNamespace

import pytest

from farm import step_agent, task_clone, workspaces
from farm.agent_runner import AgentError
from farm.tests.test_task_job import _git, _wait_for
from farm.tests.test_task_steps import make_task, reply_for

REPO = "acme/tasks"
LABELS = [step_agent.ASSESS_LABEL, step_agent.RUN_PLAN_LABEL, step_agent.IMPACT_REVIEW_LABEL]
WORKTREE_LABELS = [step_agent.ASSESS_LABEL, step_agent.IMPACT_REVIEW_LABEL]
NEW_PATH = "scripts/tenant-sites"
PLAN = {"cwd": ".", "commands": ["true"], "budget_minutes": 5}


def _commit(upstream, rel, text):
    path = upstream / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    _git(upstream, "add", rel)
    _git(upstream, "commit", "-q", "-m", rel)
    _git(upstream, "push", "-q", "origin", "main")
    return _git(upstream, "rev-parse", "HEAD")


@pytest.fixture
def repos(tmp_path, monkeypatch):
    """The task clone, the hub and the item worktree, all at `old`; origin's
    main at `new`, which alone has scripts/tenant-sites/."""
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    upstream = tmp_path / "upstream"
    _git(tmp_path, "init", "-q", "-b", "main", str(upstream))
    _git(upstream, "remote", "add", "origin", str(origin))
    old = _commit(upstream, "one.txt", "one\n")
    clone = tmp_path / "horizon-tasks"
    _git(tmp_path, "clone", "-q", str(origin), str(clone))
    hub = workspaces.hub_path(REPO)
    hub.parent.mkdir(parents=True, exist_ok=True)
    _git(tmp_path, "clone", "-q", str(origin), str(hub))
    ws = workspaces.ensure_item_worktree(REPO, "T-383")
    new = _commit(upstream, f"{NEW_PATH}/README", "tenant sites\n")
    assert _git(clone, "rev-parse", "HEAD") == _git(ws, "rev-parse", "HEAD") == old != new
    return SimpleNamespace(upstream=upstream, clone=clone, ws=ws, old=old, new=new)


def clone_task(label, repos, **extra):
    """The task dict farmd hands step_agent, with the keys the server's
    jobEnvFields sends (server/test/task-clone-dispatch.test.mjs)."""
    task = make_task(label, repo=REPO)
    task.update(
        repo_dir=str(repos.clone), venv_dir=None, task_clone=True, container_image=None, cpu_limit=None, memory_limit=None
    )
    if label == step_agent.RUN_PLAN_LABEL:
        task["runner"] = "host"
    task.update(extra)
    return task


def recording_agent(monkeypatch, repos, label, run_plan=None):
    """run_agent stub: records the clone's and the worktree's HEAD at spawn."""
    seen = []
    body = reply_for(label, run_plan=run_plan or dict(PLAN)) if label == step_agent.RUN_PLAN_LABEL else reply_for(label)

    def fake(prompt, **kwargs):
        seen.append({"clone": _git(repos.clone, "rev-parse", "HEAD"), "ws": _git(repos.ws, "rev-parse", "HEAD")})
        return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return seen


def _log_lines(capsys):
    return capsys.readouterr().out.splitlines()


# ---- metric 1: each step reads origin/main's HEAD and logs it ----


@pytest.mark.parametrize("label", LABELS)
def test_each_step_reads_the_clone_at_origin_main_and_logs_its_sha(monkeypatch, capsys, repos, label):
    seen = recording_agent(monkeypatch, repos, label)
    step_agent.execute(clone_task(label, repos))
    assert seen and seen[0]["clone"] == repos.new
    lines = _log_lines(capsys)
    assert [line for line in lines if "task clone HEAD:" in line] == [
        line for line in lines if line.endswith(f"] task clone HEAD: {repos.new}")
    ]
    assert any(line.endswith(f"] task clone HEAD: {repos.new}") for line in lines)


@pytest.mark.parametrize("label", WORKTREE_LABELS)
def test_assess_and_impact_review_read_their_worktree_at_the_same_sha(monkeypatch, capsys, repos, label):
    """The HZ-699/HZ-736 failure: the worktree they read was days old."""
    seen = recording_agent(monkeypatch, repos, label)
    result = step_agent.execute(clone_task(label, repos))
    assert seen[0]["ws"] == repos.new
    assert any(line.endswith(f"checked out at {repos.new[:12]} (origin/main, same as the task clone)") for line in _log_lines(capsys))
    assert result["summary"].startswith(f"did {label}"), "the checkout is never read as a read-only violation"


def test_run_plan_reads_the_clone_and_leaves_its_worktree(monkeypatch, repos):
    seen = recording_agent(monkeypatch, repos, step_agent.RUN_PLAN_LABEL)
    step_agent.execute(clone_task(step_agent.RUN_PLAN_LABEL, repos))
    assert seen[0] == {"clone": repos.new, "ws": repos.old}


def test_a_worktree_that_cannot_reach_the_clone_sha_fails_in_one_line(monkeypatch, repos):
    def unreachable(*args):
        raise RuntimeError("git checkout --detach failed: reference is not a tree")

    monkeypatch.setattr(step_agent, "checkout_detached", unreachable)
    seen = recording_agent(monkeypatch, repos, step_agent.ASSESS_LABEL)
    with pytest.raises(AgentError) as err:
        step_agent.execute(clone_task(step_agent.ASSESS_LABEL, repos))
    assert str(err.value) == f"workspace cannot reach task clone HEAD {repos.new[:12]}"
    assert seen == []


def test_a_checkout_sha_step_keeps_its_deployed_checkout(monkeypatch, repos):
    seen = recording_agent(monkeypatch, repos, step_agent.ASSESS_LABEL)
    step_agent.execute(clone_task(step_agent.ASSESS_LABEL, repos, checkout_sha=repos.old))
    assert seen[0] == {"clone": repos.new, "ws": repos.old}


# ---- metric 2: Run plan's `requires` check sees the newer main ----


def test_run_plan_requires_finds_a_path_only_the_newer_main_has(monkeypatch, repos):
    seen = recording_agent(monkeypatch, repos, step_agent.RUN_PLAN_LABEL, run_plan={**PLAN, "requires": [{"path": NEW_PATH}]})
    result = step_agent.execute(clone_task(step_agent.RUN_PLAN_LABEL, repos))
    assert len(seen) == 1, "no gap, so no reprompt"
    assert result["summary"].startswith(f"did {step_agent.RUN_PLAN_LABEL}")


def test_run_plan_requires_still_stops_on_a_path_neither_main_has(monkeypatch, repos):
    recording_agent(monkeypatch, repos, step_agent.RUN_PLAN_LABEL, run_plan={**PLAN, "requires": [{"path": "scripts/nowhere"}]})
    with pytest.raises(AgentError) as err:
        step_agent.execute(clone_task(step_agent.RUN_PLAN_LABEL, repos))
    assert str(err.value).startswith(step_agent.REQUIRES_GAP_PREFIX)
    assert "path `scripts/nowhere` does not exist in the checkout" in str(err.value)


# ---- metric 3: a clone that cannot fast-forward fails the step ----


def _local_commit(repos):
    _commit_local(repos.clone, "local.txt")
    return "task clone cannot fast-forward"


def _off_main(repos):
    _git(repos.clone, "checkout", "-q", "-b", "elsewhere")
    return "task clone is not on main"


def _commit_local(clone, rel):
    (clone / rel).write_text("local\n")
    _git(clone, "add", rel)
    _git(clone, "commit", "-q", "-m", rel)


@pytest.mark.parametrize("label", LABELS)
@pytest.mark.parametrize("spoil", [_local_commit, _off_main], ids=["local-commit", "off-main"])
def test_a_clone_that_cannot_fast_forward_fails_the_step_and_moves_nothing(monkeypatch, repos, label, spoil):
    refusal = spoil(repos)
    head = _git(repos.clone, "rev-parse", "HEAD")
    branch = _git(repos.clone, "symbolic-ref", "--short", "HEAD")
    seen = recording_agent(monkeypatch, repos, label)
    with pytest.raises(AgentError) as err:
        step_agent.execute(clone_task(label, repos))
    assert str(err.value) == refusal
    assert seen == [], "the agent never ran"
    assert _git(repos.clone, "rev-parse", "HEAD") == head
    assert _git(repos.clone, "symbolic-ref", "--short", "HEAD") == branch
    assert _git(repos.ws, "rev-parse", "HEAD") == repos.old


# ---- guardrail 1: fast-forward only, never reset or clean ----


def test_the_refresh_keeps_untracked_and_edited_files(monkeypatch, repos):
    (repos.clone / "one.txt").write_text("edited\n")
    (repos.clone / "untracked.txt").write_text("keep me\n")
    before = _git(repos.clone, "status", "--porcelain")
    recording_agent(monkeypatch, repos, step_agent.ASSESS_LABEL)
    step_agent.execute(clone_task(step_agent.ASSESS_LABEL, repos))
    assert _git(repos.clone, "rev-parse", "HEAD") == repos.new
    assert _git(repos.clone, "status", "--porcelain") == before
    assert (repos.clone / "one.txt").read_text() == "edited\n"
    assert (repos.clone / "untracked.txt").read_text() == "keep me\n"


# ---- guardrail 2: a checkout without task_clone is never touched ----


@pytest.mark.parametrize("label", LABELS)
def test_a_repo_dir_without_task_clone_is_left_behind(monkeypatch, capsys, repos, label):
    seen = recording_agent(monkeypatch, repos, label)
    task = clone_task(label, repos)
    del task["task_clone"]
    step_agent.execute(task)
    assert seen[0] == {"clone": repos.old, "ws": repos.old}
    assert not any("task clone HEAD" in line for line in _log_lines(capsys))


# ---- guardrail 4: never under a live Execute ----

HOLDER = """
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_SH)
open(sys.argv[2], "w").close()
deadline = time.monotonic() + 60
while not os.path.exists(sys.argv[3]) and time.monotonic() < deadline:
    time.sleep(0.05)
"""


@pytest.mark.parametrize("label", LABELS)
def test_a_step_fails_busy_while_an_execute_holds_the_clone(monkeypatch, tmp_path, repos, label):
    monkeypatch.setattr(step_agent, "TASK_CLONE_WAIT_S", 0.2)
    ready, release = tmp_path / "ready", tmp_path / "release"
    holder = subprocess.Popen(
        [sys.executable, "-c", HOLDER, str(repos.clone / ".git" / task_clone.LOCK_NAME), str(ready), str(release)]
    )
    try:
        _wait_for(ready.exists, "the Execute stand-in to hold the lock")
        seen = recording_agent(monkeypatch, repos, label)
        with pytest.raises(AgentError) as err:
            step_agent.execute(clone_task(label, repos))
        assert str(err.value) == "task clone busy: an Execute job is running in it"
        assert seen == []
        assert _git(repos.clone, "rev-parse", "HEAD") == repos.old
    finally:
        release.touch()
        holder.wait(timeout=30)
