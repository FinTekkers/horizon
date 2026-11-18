"""HO-874: a step request's optional `backend`.

POST /steps/run with no `backend` runs the farm as today, through
farm/vcs/git.py; an unknown one is refused before anything is provisioned,
queued or spawned. The two request tests send the same body, differing only
in `backend`, and the repo has no hub, so the no-backend request really does
reach the hub clone: that is what makes the refusal's zero spawns mean
something.

The `..._argv_unchanged` test names no farm.vcs module (the registry test
imports it locally), so it also passes on the tree before the move.

HO-909: the registry test checks farm/vcs/ against the owner-approved set of
backends, so HO-876 can add farm/vcs/sl.py (and register it) without editing
this file. Exact `{git, sl}` equality is proven on a temp copy of farm/vcs/,
since this item may not add sl.py itself.
"""

import json
import re
import shutil
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType

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

# Owner ruling (HO-909): approved VCS backends are exactly `git` and `sl`.
APPROVED_BACKENDS = frozenset({"git", "sl"})


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
    from farm import vcs

    before = _queued()
    tripwire = SpawnTripwire(monkeypatch)
    provisioned = []
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: provisioned.append(repo))

    res = client.post("/steps/run", json=request_body(backend="hg"))

    assert res.status_code == 400
    # HO-909 (owner-approved): `known` is the live registry, which the
    # registry test holds to an approved subset that includes git.
    assert res.json() == {"error": "unknown_vcs_backend", "backend": "hg", "known": sorted(vcs.BACKENDS)}
    assert "git" in res.json()["known"]
    assert set(res.json()["known"]) <= APPROVED_BACKENDS
    assert tripwire.calls == []
    assert provisioned == []
    assert _queued() == before
    assert f"{RUN_ID}.json" not in sum(before.values(), [])
    assert not (farm_up / ".git").exists()


def _backend_modules(vcs_dir: Path) -> set[str]:
    """The backend module names in `vcs_dir`: its `*.py` stems, minus `__init__`."""
    return {p.stem for p in vcs_dir.glob("*.py")} - {"__init__"}


def _assert_approved(vcs_dir: Path, registry: Mapping[str, ModuleType]) -> None:
    """Every backend module on disk and every registered backend is approved,
    git is among them, and nothing is registered without a module on disk."""
    modules = _backend_modules(vcs_dir)
    extras = modules - APPROVED_BACKENDS
    assert not extras, f"unapproved backend modules: {sorted(extras)}"
    assert "git" in modules, f"git backend module missing: {sorted(modules)}"
    unapproved = set(registry) - APPROVED_BACKENDS
    assert not unapproved, f"unapproved registered backends: {sorted(unapproved)}"
    missing = set(registry) - modules
    assert not missing, f"registered backends with no module: {sorted(missing)}"


@pytest.fixture
def vcs_copy(tmp_path) -> Path:
    """A copy of farm/vcs/ with a stub sl.py, the tree HO-876 will create."""
    copy = tmp_path / "vcs"
    shutil.copytree(FARM_DIR / "vcs", copy, ignore=shutil.ignore_patterns("__pycache__"))
    (copy / "sl.py").write_text('"""Stub sl backend (HO-909 test)."""\n')
    return copy


def test_only_approved_backends_are_present():
    from farm import vcs

    assert vcs.BACKENDS["git"] is vcs.git
    _assert_approved(FARM_DIR / "vcs", vcs.BACKENDS)


def test_sl_stub_makes_backend_set_equal_git_and_sl(vcs_copy):
    from farm import vcs

    assert _backend_modules(vcs_copy) == {"git", "sl"}
    _assert_approved(vcs_copy, vcs.BACKENDS)

    registry = {"git": vcs.git, "sl": ModuleType("sl")}
    assert set(registry) == {"git", "sl"}
    _assert_approved(vcs_copy, registry)


def test_unapproved_backend_module_is_rejected(vcs_copy):
    from farm import vcs

    (vcs_copy / "hg.py").write_text('"""Unapproved backend (HO-909 test)."""\n')

    with pytest.raises(AssertionError, match=re.escape("unapproved backend modules: ['hg']")):
        _assert_approved(vcs_copy, vcs.BACKENDS)
