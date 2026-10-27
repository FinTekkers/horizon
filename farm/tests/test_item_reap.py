"""HZ-604: farmd's clean-up tick reaps closed and abandoned items' worktrees.

Nothing removed an item's worktrees once it was done, and on 27 Oct 2026 that
was 35 GB. farmd._reap_finished_items() asks the server which of the ids it
holds worktrees for are finished, then removes each one's <repo>__items/<id>
and <repo>__premerge/<id> — unless a live run or a held lock says it is in
use. The server is stubbed at the httpx layer, answering ids in upper case
as the real one does, so the case join to the lowercased dirs is exercised.
"""

import os
import subprocess
import threading
from pathlib import Path

import httpx
import pytest

from farm import config as farm_config
from farm import farmd, premerge, workspaces


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


def make_hub(tmp_path, repo_full):
    """A real clone of a local bare repo at hub_path(repo_full)."""
    base = tmp_path / "origins" / repo_full.replace("/", "__")
    seed = base / "seed"
    seed.mkdir(parents=True)
    git(seed, "init", "-b", "main")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "README.md").write_text("# demo\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = base / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    hub = workspaces.hub_path(repo_full)
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    return hub


def add_worktrees(repo_full, item_id):
    """The item worktree the farm makes, plus a pre-merge one at its real path."""
    item_ws = workspaces.ensure_item_worktree(repo_full, item_id)
    pm_ws = premerge.premerge_path(repo_full, item_id)
    pm_ws.parent.mkdir(parents=True, exist_ok=True)
    git(workspaces.hub_path(repo_full), "worktree", "add", "--detach", str(pm_ws), "HEAD")
    return item_ws, pm_ws


def listed_worktrees(repo_full):
    porcelain = git(workspaces.hub_path(repo_full), "worktree", "list", "--porcelain")
    return {Path(line[len("worktree "):]).resolve() for line in porcelain.splitlines() if line.startswith("worktree ")}


@pytest.fixture
def farm(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root)
    monkeypatch.setattr(workspaces, "_active_item_ids", lambda: set())
    return tmp_path


class FakeServer:
    """Stands in for httpx.post to POST /api/farm/items/finished."""

    def __init__(self, finished=None, status=200, error=None):
        self.finished = finished or {}
        self.status = status
        self.error = error
        self.calls = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self.error is not None:
            raise self.error
        request = httpx.Request("POST", url)
        if self.status != 200:
            return httpx.Response(self.status, json={"message": "Not Found"}, request=request)
        items = [
            {"id": item_id, "state": state}
            for item_id, state in self.finished.items()
            if item_id.lower() in {i.lower() for i in json["ids"]}
        ]
        return httpx.Response(200, json={"items": items}, request=request)


def serve(monkeypatch, **kwargs):
    server = FakeServer(**kwargs)
    monkeypatch.setattr(farmd.httpx, "post", server)
    return server


@pytest.mark.parametrize("state", ["closed", "abandoned"])
def test_a_finished_item_loses_both_worktrees(farm, monkeypatch, state):
    make_hub(farm, "acme/demo")
    item_ws, pm_ws = add_worktrees("acme/demo", "T-1")
    server = serve(monkeypatch, finished={"T-1": state})

    farmd._reap_finished_items()

    assert not item_ws.exists() and not pm_ws.exists()
    listed = listed_worktrees("acme/demo")
    assert item_ws.resolve() not in listed and pm_ws.resolve() not in listed
    assert server.calls[0]["url"].endswith("/api/farm/items/finished")
    assert server.calls[0]["json"] == {"ids": ["t-1"]}
    assert server.calls[0]["headers"] == {"x-farm-secret": farm_config.SHARED_SECRET}


def test_a_worktree_in_a_live_run_is_kept(farm, monkeypatch, capsys):
    make_hub(farm, "acme/demo")
    item_ws, pm_ws = add_worktrees("acme/demo", "T-1")
    monkeypatch.setattr(workspaces, "_active_item_ids", lambda: {"t-1"})
    serve(monkeypatch, finished={"T-1": "closed"})

    farmd._reap_finished_items()

    assert item_ws.exists() and pm_ws.exists()
    assert {item_ws.resolve(), pm_ws.resolve()} <= listed_worktrees("acme/demo")
    out = capsys.readouterr().out
    assert "reap acme/demo t-1 item active_run" in out
    assert "reap acme/demo t-1 premerge active_run" in out


def test_a_worktree_whose_item_lock_is_held_is_kept(farm, monkeypatch, capsys):
    make_hub(farm, "acme/demo")
    item_ws, pm_ws = add_worktrees("acme/demo", "T-1")
    serve(monkeypatch, finished={"T-1": "closed"})

    with workspaces.item_lock("acme/demo", "T-1", wait_s=0):
        farmd._reap_finished_items()

    assert item_ws.exists() and pm_ws.exists()
    assert {item_ws.resolve(), pm_ws.resolve()} <= listed_worktrees("acme/demo")
    out = capsys.readouterr().out
    assert "reap acme/demo t-1 item item_lock" in out
    assert "reap acme/demo t-1 premerge item_lock" in out


def test_a_held_premerge_lock_keeps_the_premerge_worktree(farm, monkeypatch, capsys):
    make_hub(farm, "acme/demo")
    item_ws, pm_ws = add_worktrees("acme/demo", "T-1")
    serve(monkeypatch, finished={"T-1": "closed"})

    with premerge._item_lock("acme/demo", "t-1") as held:
        assert held
        farmd._reap_finished_items()

    assert pm_ws.exists() and pm_ws.resolve() in listed_worktrees("acme/demo")
    assert not item_ws.exists()
    assert "reap acme/demo t-1 premerge premerge_lock" in capsys.readouterr().out


def test_an_open_item_the_hub_and_branches_are_untouched(farm, monkeypatch):
    hub = make_hub(farm, "acme/demo")
    add_worktrees("acme/demo", "T-1")
    open_item, open_pm = add_worktrees("acme/demo", "T-2")
    git(hub, "branch", "horizon/t-1")
    hub_entries = sorted(p.name for p in hub.iterdir())
    refs = git(hub, "for-each-ref")
    serve(monkeypatch, finished={"T-1": "closed"})

    farmd._reap_finished_items()

    assert open_item.exists() and open_pm.exists()
    assert {open_item.resolve(), open_pm.resolve()} <= listed_worktrees("acme/demo")
    assert sorted(p.name for p in hub.iterdir()) == hub_entries
    assert git(hub, "for-each-ref") == refs
    assert hub.resolve() in listed_worktrees("acme/demo")


def test_repo_names_with_underscores_map_to_their_own_hubs(farm, monkeypatch):
    make_hub(farm, "acme/my_repo")
    make_hub(farm, "acme/my")
    closed_item, closed_pm = add_worktrees("acme/my_repo", "T-1")
    open_item, open_pm = add_worktrees("acme/my", "T-2")
    assert workspaces.repos_with_worktrees() == {"acme/my_repo": {"t-1"}, "acme/my": {"t-2"}}
    serve(monkeypatch, finished={"T-1": "closed"})

    farmd._reap_finished_items()

    assert not closed_item.exists() and not closed_pm.exists()
    assert open_item.exists() and open_pm.exists()
    assert {open_item.resolve(), open_pm.resolve()} <= listed_worktrees("acme/my")


@pytest.mark.parametrize(
    "server",
    [
        {"status": 404},
        {"status": 500},
        {"error": httpx.ConnectError("refused")},
        {"finished": {}},
    ],
    ids=["not-found", "server-error", "connection-refused", "id-left-out"],
)
def test_no_answer_reaps_nothing_but_the_tmp_sweep_still_runs(farm, monkeypatch, server):
    make_hub(farm, "acme/demo")
    item_ws, pm_ws = add_worktrees("acme/demo", "T-1")
    serve(monkeypatch, **server)
    tmp_root = farm / "tmproot"
    stale = tmp_root / "tmp.stale"
    stale.mkdir(parents=True)
    os.utime(stale, (0, 0))
    real_sweep = farmd.tmp_sweep.sweep
    sweeps = []

    def sweep(**kwargs):
        sweeps.append(kwargs)
        return real_sweep(tmp_root, uid=os.getuid(), **kwargs)

    monkeypatch.setattr(farmd.tmp_sweep, "sweep", sweep)

    farmd._cleanup_tick()

    assert item_ws.exists() and pm_ws.exists()
    assert len(sweeps) == 1
    assert not stale.exists()


def test_cleanup_is_off_in_the_suite_so_importing_farmd_starts_no_loop(monkeypatch):
    assert farm_config.CLEANUP_INTERVAL_S == 0
    assert not [t for t in threading.enumerate() if t.name == "farmd-cleanup"]
    monkeypatch.setattr(farmd, "_cleanup_tick", lambda: pytest.fail("ticked while switched off"))

    farmd._cleanup_loop()


def test_cleanup_loop_ticks_once_at_start_then_stops(monkeypatch):
    monkeypatch.setattr(farm_config, "CLEANUP_INTERVAL_S", 3600.0)
    ticks = []
    monkeypatch.setattr(farmd, "_cleanup_tick", lambda: ticks.append(1))
    stop = threading.Event()
    stop.set()

    farmd._cleanup_loop(stop)

    assert ticks == [1]
