"""HO-874: a step request's optional `backend`.

POST /steps/run with no `backend` runs the farm as today, through
farm/vcs/git.py; an unknown one is refused before anything is provisioned,
queued or spawned. The two request tests send the same body, differing only
in `backend`, and the repo has no hub, so the no-backend request really does
reach the hub clone: that is what makes the refusal's zero spawns mean
something.

The `..._argv_unchanged` test names no farm.vcs module (the registry test
imports it locally), so it also passes on the tree before the move.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import farmd, workspaces
from farm.config import QUEUE_DIR
from farm.tests.vcs_spy import GitRecorder, SpawnTripwire

client = TestClient(farmd.app)

REPO = "acme/ho874-vcs"
RUN_ID = 87401
FARM_DIR = Path(__file__).resolve().parent.parent
QUEUE_DIRS = ("pm", "runs", "runs/active", "jobs/active")


def request_body(**extra):
    return {
        "run_id": RUN_ID,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": "HO-874", "repo": REPO},
        "step": {"index": 9, "label": "x"},
        **extra,
    }


def _queued() -> dict[str, list[str]]:
    return {d: sorted(p.name for p in (QUEUE_DIR / d).glob("*.json")) for d in QUEUE_DIRS}


@pytest.fixture
def farm_up(monkeypatch):
    """farmd running, its dispatcher paused (the test reads its own queue
    file), and no hub token. Unlike test_farmd's running_farm, the hub clone
    is NOT stubbed out: _provision_hub runs _clone_hub inline, so the spawn
    it makes lands in the request."""
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_hub_token", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: farmd._clone_hub(repo) or True)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    hub = workspaces.hub_path(REPO)
    assert not (hub / ".git").exists(), "precondition: the repo has no hub, so a request would clone it"
    try:
        yield hub
    finally:
        farmd.state.update(saved)
        (QUEUE_DIR / "pm" / f"{RUN_ID}.json").unlink(missing_ok=True)


def _post_without_backend(monkeypatch):
    # Stubbed: the clone would otherwise reach github.com.
    recorder = GitRecorder(monkeypatch, stub=True)
    res = client.post("/steps/run", json=request_body())
    assert res.status_code == 200, res.text
    assert res.json() == {"ok": True, "queued": "pm"}
    assert (QUEUE_DIR / "pm" / f"{RUN_ID}.json").exists()
    return recorder


def test_no_backend_clone_argv_unchanged(farm_up, monkeypatch):
    recorder = _post_without_backend(monkeypatch)
    assert [(s.argv, s.kwargs) for s in recorder.spawns] == [
        (
            ["git", "clone", f"https://github.com/{REPO}.git", str(farm_up)],
            dict(capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600),
        )
    ]


def test_no_backend_runs_through_vcs_git(farm_up, monkeypatch):
    recorder = _post_without_backend(monkeypatch)
    assert [(s.argv, s.module) for s in recorder.spawns] == [
        (["git", "clone", f"https://github.com/{REPO}.git", str(farm_up)], "farm.vcs.git")
    ]
    queued = json.loads((QUEUE_DIR / "pm" / f"{RUN_ID}.json").read_text())
    assert "backend" not in queued


def test_unknown_backend_is_refused_with_zero_spawns(farm_up, monkeypatch):
    before = _queued()
    tripwire = SpawnTripwire(monkeypatch)
    provisioned = []
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: provisioned.append(repo))

    res = client.post("/steps/run", json=request_body(backend="hg"))

    assert res.status_code == 400
    assert res.json() == {"error": "unknown_vcs_backend", "backend": "hg", "known": ["git"]}
    assert tripwire.calls == []
    assert provisioned == []
    assert _queued() == before
    assert f"{RUN_ID}.json" not in sum(before.values(), [])
    assert not (farm_up / ".git").exists()


def test_only_git_is_registered():
    # HO-876 (owner ruling): exactly git and sl. Another backend amends this.
    from farm import vcs

    assert vcs.BACKENDS == {"git": vcs.git, "sl": vcs.sl}
    assert sorted(p.name for p in (FARM_DIR / "vcs").glob("*.py")) == ["__init__.py", "git.py", "sl.py"]
