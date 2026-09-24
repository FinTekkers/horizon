"""HZ-50: per-item git worktree isolation.

The old workspace_path(repo) keyed the on-disk checkout on the repo alone —
every item in a repo shared one working tree, and prepare_branch()'s
`reset --hard` + `clean -fd` (needed to scrub a superseded attempt) would
just as happily wipe a *different* item's in-flight, uncommitted edit if two
runs against the same repo overlapped. These tests exercise the fix: each
item gets its own `git worktree` off a shared per-repo hub clone, so
concurrent runs on different items never share a tree to reset/clean/
checkout over each other.
"""

import subprocess
import threading
from pathlib import Path

import pytest

from farm import step_agent, workspaces


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


def make_repo_hub(tmp_path, repo_full="acme/demo"):
    """A local bare repo stands in for GitHub; the hub is a real clone of it
    at the exact path hub_path()/ensure_item_worktree() expect, so the real
    (non-monkeypatched) workspaces functions can be exercised against it."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(tmp_path, "init", "-b", "main", "seed")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "README.md").write_text("# demo\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    hub = workspaces.hub_path(repo_full)
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    git(hub, "config", "user.email", "farm@example.com")
    git(hub, "config", "user.name", "Horizon Farm")
    return hub, origin


@pytest.fixture
def isolated_workspaces_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    return tmp_path


# ---- basic worktree provisioning ----


def test_ensure_item_worktree_gives_each_item_its_own_directory(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)

    ws_a = workspaces.ensure_item_worktree("acme/demo", "T-1")
    ws_b = workspaces.ensure_item_worktree("acme/demo", "T-2")

    assert ws_a != ws_b
    assert ws_a.exists() and ws_b.exists()
    for ws in (ws_a, ws_b):
        assert subprocess.run(
            ["git", "-C", str(ws), "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True
        ).stdout.strip() == "true"


def test_ensure_item_worktree_is_idempotent_and_reuses_the_same_worktree(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)

    ws_first = workspaces.ensure_item_worktree("acme/demo", "T-1")
    (ws_first / "scratch.txt").write_text("in progress\n")
    ws_second = workspaces.ensure_item_worktree("acme/demo", "T-1")

    assert ws_first == ws_second
    assert (ws_second / "scratch.txt").exists()  # reused untouched, not recreated


def test_ensure_item_worktree_raises_when_the_hub_is_not_provisioned(isolated_workspaces_dir):
    with pytest.raises(RuntimeError, match="not provisioned"):
        workspaces.ensure_item_worktree("acme/never-started", "T-1")


# ---- the literal success-metric test: concurrent runs, no clobbering ----


def test_concurrent_implement_runs_on_different_items_do_not_clobber_each_other(isolated_workspaces_dir, monkeypatch):
    """Forces the exact race the old shared workspace_path(repo) was
    vulnerable to: item A leaves an uncommitted edit mid-run, then item B's
    prepare_branch (a fresh attempt's reset --hard + clean -fd) runs while
    A's edit is still uncommitted. Under the old code both runs shared one
    checkout, so B's scrub would delete A's file out from under it. Under
    per-item worktrees, B's scrub can only ever touch its own tree."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    a_uncommitted_written = threading.Event()
    b_prepare_branch_done = threading.Event()

    def fake_run_agent(prompt, **kwargs):
        cwd = Path(kwargs["cwd"])
        if "ITEM-A" in prompt:
            (cwd / "a_work.txt").write_text("item A in-progress edit\n")
            a_uncommitted_written.set()
            assert b_prepare_branch_done.wait(timeout=10), "item B never reached prepare_branch"
            return {"result": '{"summary": "a done"}'}
        # item B's own prepare_branch (its scrub of its own worktree) already
        # ran as part of execute() before run_agent was ever invoked.
        b_prepare_branch_done.set()
        (cwd / "b_work.txt").write_text("item B edit\n")
        return {"result": '{"summary": "b done"}'}

    monkeypatch.setattr(step_agent, "run_agent", fake_run_agent)

    def make_task(item_id):
        return {
            "run_id": item_id,
            "attempt": 1,
            "item": {
                "id": item_id,
                "title": "Test item",
                "desc": "Deliver the thing",
                "metric": "It works",
                "guardrails": "",
                "priority": "Medium",
                "repo": "acme/demo",
                "issue": 42,
            },
            "step": {"index": 11, "label": "Specialist agent implements", "agent": "Eng"},
            "artifacts": [],
            "feedback": [],
        }

    results, errors = {}, {}

    def run(key, task):
        try:
            results[key] = step_agent.execute(task)
        except Exception as exc:  # noqa: BLE001 - surfaced via the assertion below
            errors[key] = exc

    t_a = threading.Thread(target=run, args=("a", make_task("ITEM-A")))
    t_b = threading.Thread(target=run, args=("b", make_task("ITEM-B")))

    t_a.start()
    assert a_uncommitted_written.wait(timeout=10), "item A never reached run_agent"
    t_b.start()
    t_a.join(timeout=20)
    t_b.join(timeout=20)

    assert not errors, errors
    assert results["a"]["artifacts"]["branch"] == "horizon/item-a"
    assert results["b"]["artifacts"]["branch"] == "horizon/item-b"

    ws_a = workspaces.workspace_path("acme/demo", "ITEM-A")
    ws_b = workspaces.workspace_path("acme/demo", "ITEM-B")
    assert ws_a != ws_b

    def pushed_files(branch):
        shown = subprocess.run(
            ["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", branch],
            capture_output=True, text=True, check=True,
        ).stdout
        return set(shown.split())

    # Neither push carries the other item's file — A's uncommitted edit
    # survived B's scrub, and each item's commit landed only on its own branch.
    assert pushed_files("horizon/item-a") == {"README.md", "a_work.txt"}
    assert pushed_files("horizon/item-b") == {"README.md", "b_work.txt"}


# ---- bounded disk: pool eviction ----


def test_ensure_item_worktree_evicts_the_oldest_inactive_item_over_the_pool_bound(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)
    monkeypatch.setattr(workspaces, "WORKSPACE_ITEM_POOL_SIZE", 2)

    workspaces.ensure_item_worktree("acme/demo", "T-1")
    workspaces.ensure_item_worktree("acme/demo", "T-2")
    assert workspaces.existing_item_ids("acme/demo") == ["t-1", "t-2"]

    workspaces.ensure_item_worktree("acme/demo", "T-3")

    ids = workspaces.existing_item_ids("acme/demo")
    assert len(ids) == 2
    assert "t-1" not in ids  # least-recently-touched, evicted to make room
    assert "t-3" in ids


def test_pool_eviction_never_reaps_a_worktree_with_an_active_run(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)
    monkeypatch.setattr(workspaces, "WORKSPACE_ITEM_POOL_SIZE", 2)
    monkeypatch.setattr(workspaces, "_active_item_ids", lambda: {"t-1"})

    workspaces.ensure_item_worktree("acme/demo", "T-1")
    workspaces.ensure_item_worktree("acme/demo", "T-2")
    workspaces.ensure_item_worktree("acme/demo", "T-3")

    ids = workspaces.existing_item_ids("acme/demo")
    assert "t-1" in ids  # protected: an active run is sitting in it
    assert "t-2" not in ids  # evicted instead


# ---- crash / stale-metadata recovery ----


def test_reap_item_worktree_removes_directory_and_registration(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)
    ws = workspaces.ensure_item_worktree("acme/demo", "T-1")
    assert ws.exists()

    workspaces.reap_item_worktree("acme/demo", "T-1")

    assert not ws.exists()
    assert workspaces.existing_item_ids("acme/demo") == []


def test_prune_worktrees_drops_stale_metadata_left_by_a_killed_farmd(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    hub, _origin = make_repo_hub(tmp_path)
    ws = workspaces.ensure_item_worktree("acme/demo", "T-1")

    # Simulate a farmd killed mid-run: the worktree directory is gone but the
    # hub's registration for it is not.
    import shutil

    shutil.rmtree(ws)
    before = subprocess.run(
        ["git", "-C", str(hub), "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True
    ).stdout
    assert str(ws) in before

    workspaces.prune_worktrees("acme/demo")

    after = subprocess.run(
        ["git", "-C", str(hub), "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True
    ).stdout
    assert str(ws) not in after


def test_ensure_item_worktree_recovers_from_a_leftover_unregistered_directory(isolated_workspaces_dir):
    """A killed run mid-`worktree add`, or a pre-HZ-50 leftover directory,
    can leave a path that exists on disk but isn't a registered worktree —
    `git worktree add` refuses to reuse it. ensure_item_worktree must clear
    it and provision cleanly rather than failing every future attempt."""
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)
    stray = workspaces.workspace_path("acme/demo", "T-1")
    stray.mkdir(parents=True)
    (stray / "junk.txt").write_text("leftover from a killed run\n")

    ws = workspaces.ensure_item_worktree("acme/demo", "T-1")

    assert ws == stray
    assert not (ws / "junk.txt").exists()
    assert (ws / "README.md").exists()


# ---- hub_lock ----


def test_hub_lock_serializes_concurrent_callers(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)

    order = []
    barrier = threading.Barrier(2)

    def worker(label):
        barrier.wait(timeout=5)
        with workspaces.hub_lock("acme/demo"):
            order.append(f"{label}-start")
            import time

            time.sleep(0.05)
            order.append(f"{label}-end")

    threads = [threading.Thread(target=worker, args=(label,)) for label in ("x", "y")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    # Whichever acquired first must fully finish (start, end) before the
    # other starts — no interleaving of the two critical sections.
    assert order in (["x-start", "x-end", "y-start", "y-end"], ["y-start", "y-end", "x-start", "x-end"])
