"""HZ-379: the farm half of "a Task that needs code waits for it".

- Assess's `code_needed` rides through to the server untouched, because
  domain/steps.json names it as Assess's `spawnsOn` field. Any other step's
  copy, or a non-object, is dropped.
- A step dispatched with `checkout_sha` (Run plan, once its spawned code is
  live) runs on that commit. The checkout happens before the read-only guard
  takes its baseline, so it is never read as the agent changing the
  worktree, and it keeps the lock order: item_lock outside, hub_lock only
  inside it, never item_lock while hub_lock is held.

run_agent is stubbed; the git repos are real (a local bare repo stands in
for GitHub).
"""

import contextlib
import json
import subprocess

import pytest

from domain.py import steps
from farm import read_only_guard, step_agent, workspaces

REPO = "acme/demo"
CODE_NEEDED = {
    "title": "Add a --since flag",
    "outcome": "The backfill script takes --since.",
    "metric": "1. --since filters rows.",
    "guardrails": "1. The default run is unchanged.",
}
VALID_PLAN = {"cwd": ".", "commands": ["./backfill.sh"], "budget_minutes": 5}


def git(cwd, *args) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def make_task(label: str, *, repo=None, checkout_sha=None) -> dict:
    task = {
        "run_id": 379,
        "attempt": 1,
        "item": {"id": "T-379", "title": "Backfill", "desc": "Run it", "priority": "High", "repo": repo, "kind": "task"},
        "step": {"index": steps.by_kind_label("task", label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }
    if checkout_sha:
        task["checkout_sha"] = checkout_sha
    return task


def stub_agent(monkeypatch, reply: dict, on_call=None):
    def fake(prompt, **kwargs):
        if on_call:
            on_call(kwargs)
        return {"result": json.dumps(reply), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)


# ---- the pass-through ----


def test_assess_passes_code_needed_through_untouched(monkeypatch):
    stub_agent(monkeypatch, {"summary": "code needed", "artifact_md": "## Code needed\nA flag.", "code_needed": CODE_NEEDED})
    result = step_agent.execute(make_task(step_agent.ASSESS_LABEL))
    assert result["artifacts"]["code_needed"] == CODE_NEEDED


@pytest.mark.parametrize("value", [None, "a flag", ["a flag"]])
def test_assess_drops_a_code_needed_that_is_not_an_object(monkeypatch, value):
    stub_agent(monkeypatch, {"summary": "assessed", "artifact_md": "## Code needed\n**none**", "code_needed": value})
    result = step_agent.execute(make_task(step_agent.ASSESS_LABEL))
    assert "code_needed" not in result["artifacts"]


def test_a_step_with_no_spawn_field_drops_code_needed(monkeypatch):
    assert step_agent._spawn_field("task", step_agent.RUN_PLAN_LABEL) is None
    stub_agent(
        monkeypatch,
        {"summary": "planned", "artifact_md": "## Commands\n1. run", "run_plan": VALID_PLAN, "code_needed": CODE_NEEDED},
    )
    result = step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert "code_needed" not in result["artifacts"]


def test_the_spawn_field_comes_from_the_step_table():
    assert step_agent._spawn_field("task", step_agent.ASSESS_LABEL) == "code_needed"
    assert all(step_agent._spawn_field("change", row["label"]) is None for row in steps.steps_for("change"))


def test_a_literal_secret_in_code_needed_is_rejected(monkeypatch):
    token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
    stub_agent(
        monkeypatch,
        {"summary": "code needed", "artifact_md": "## Code needed\nA flag.", "code_needed": {**CODE_NEEDED, "outcome": f"use {token}"}},
    )
    with pytest.raises(Exception, match="literal secret"):
        step_agent.execute(make_task(step_agent.ASSESS_LABEL))


# ---- the checkout ----


@pytest.fixture
def repo_with_new_commit(tmp_path, monkeypatch):
    """A hub clone and an item worktree at the first commit, and a second
    commit pushed to origin AFTER the hub cloned — so only a fetch finds it.
    Returns (worktree, old sha, new sha)."""
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    seed = tmp_path / "seed"
    subprocess.run(["git", "init", "-q", "-b", "main", str(seed)], check=True)
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "backfill.sh").write_text("echo old\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    hub = workspaces.hub_path(REPO)
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(hub)], check=True)
    ws = workspaces.ensure_item_worktree(REPO, "T-379")
    old = git(ws, "rev-parse", "HEAD")

    git(seed, "remote", "add", "origin", str(origin))
    (seed / "backfill.sh").write_text("echo new --since\n")
    git(seed, "commit", "-q", "-am", "the shipped change")
    git(seed, "push", "-q", "origin", "main")
    return ws, old, git(seed, "rev-parse", "HEAD")


def test_run_plan_runs_on_checkout_sha_taken_before_the_guard_baseline(monkeypatch, repo_with_new_commit):
    ws, old, new = repo_with_new_commit
    seen = {}
    real_snapshot = read_only_guard.snapshot

    def recording_snapshot(path, **kwargs):
        seen.setdefault("baseline_head", git(path, "rev-parse", "HEAD"))
        return real_snapshot(path, **kwargs)

    monkeypatch.setattr(read_only_guard, "snapshot", recording_snapshot)
    stub_agent(
        monkeypatch,
        {"summary": "planned", "artifact_md": "## Commands\n1. run", "run_plan": VALID_PLAN},
        on_call=lambda kwargs: seen.setdefault("agent_saw", (ws / "backfill.sh").read_text()),
    )

    result = step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL, repo=REPO, checkout_sha=new))

    assert old != new
    assert seen["baseline_head"] == new, "the guard's baseline is taken after the checkout"
    assert seen["agent_saw"] == "echo new --since\n", "the agent reads the shipped code"
    assert git(ws, "rev-parse", "HEAD") == new
    assert result["summary"].startswith("planned"), "the checkout is never read as a read-only violation"


def test_without_checkout_sha_the_worktree_is_left_where_it_is(monkeypatch, repo_with_new_commit):
    ws, old, _new = repo_with_new_commit
    stub_agent(monkeypatch, {"summary": "planned", "artifact_md": "## Commands\n1. run", "run_plan": VALID_PLAN})
    step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL, repo=REPO))
    assert git(ws, "rev-parse", "HEAD") == old


def test_the_checkout_keeps_the_lock_order(monkeypatch, repo_with_new_commit):
    _ws, _old, new = repo_with_new_commit
    events = []
    held = {"item": 0, "hub": 0}
    real_item_lock, real_hub_lock = step_agent.item_lock, workspaces.hub_lock

    @contextlib.contextmanager
    def item_lock(*args, **kwargs):
        assert held["hub"] == 0, "item_lock taken while hub_lock is held"
        with real_item_lock(*args, **kwargs):
            held["item"] += 1
            events.append("item_lock")
            try:
                yield
            finally:
                held["item"] -= 1

    @contextlib.contextmanager
    def hub_lock(*args, **kwargs):
        with real_hub_lock(*args, **kwargs):
            held["hub"] += 1
            events.append(f"hub_lock(item_lock held={held['item'] > 0})")
            try:
                yield
            finally:
                held["hub"] -= 1

    real_checkout = workspaces.checkout_detached

    def checkout(*args):
        events.append("checkout")
        real_checkout(*args)

    monkeypatch.setattr(step_agent, "item_lock", item_lock)
    monkeypatch.setattr(workspaces, "hub_lock", hub_lock)
    monkeypatch.setattr(step_agent, "checkout_detached", checkout)
    stub_agent(monkeypatch, {"summary": "planned", "artifact_md": "## Commands\n1. run", "run_plan": VALID_PLAN})

    step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL, repo=REPO, checkout_sha=new))

    assert events[0] == "item_lock", events
    after_checkout = events[events.index("checkout") + 1 :]
    assert after_checkout == ["hub_lock(item_lock held=True)"], events
    assert all(e != "hub_lock(item_lock held=False)" for e in events), events
