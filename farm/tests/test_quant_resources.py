"""HZ-972: a quant persona's run reads its project's registry and private store.

At the real dispatch sites — the PM-step call a golden-cases sub-step runs on,
and the implement call — a run whose persona the project's
quant_resources.json lists in `readers` gets the registry's folder and the
store as read-only add_dirs, and a prompt section naming them. Any other
project or persona dispatches exactly as before. The store is a temp stand-in
(HORIZON_QUANT_RESOURCES_DIR); the registry is the committed one.
"""

import json
from pathlib import Path

import pytest

from farm import quant_resources, step_agent
from farm.step_agent import IMPLEMENT_LABEL, execute
from farm.tests.test_step_agent import NO_CHECKS, make_git_workspace

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_DIR = str(REPO_ROOT / "farm" / "projects" / "fintekkers")
FINTEKKERS = {"id": 2, "name": "FinTekkers", "isolation": "internal", "definitionsEnabled": True}
HORIZON = {"id": 1, "name": "Horizon", "isolation": "internal", "definitionsEnabled": True}
GOLDEN_SUBSTEP = {"id": "quant-golden-cases", "label": "Quant golden cases", "output": "golden_cases", "persona": "quant"}


class Dispatched(Exception):
    """Raised by the stub once the provider call's kwargs are recorded."""


@pytest.fixture
def store(tmp_path, monkeypatch):
    path = tmp_path / "quant-resources"
    (path / "libs").mkdir(parents=True)
    monkeypatch.setenv(quant_resources.STORE_ENV, str(path))
    return path


@pytest.fixture
def calls(monkeypatch):
    seen = []

    def fake(prompt, **kwargs):
        seen.append({"prompt": prompt, **kwargs})
        raise Dispatched()

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return seen


def golden_task(project, substep=GOLDEN_SUBSTEP) -> dict:
    """The /steps/run body of a golden-cases sub-step run at its anchor."""
    body = {
        "run_id": 7,
        "attempt": 1,
        "item": {"id": "VS-164", "title": "Stub-aware engine", "desc": "Fix `src/calculators/ytm.rs`.", "metric": "", "guardrails": "", "priority": "High", "repo": "FinTekkers/valuation-service"},
        "step": {"index": 1, "label": "Define how we measure success", "agent": "PM"},
        "artifacts": [],
        "feedback": [],
        "project": project,
    }
    if substep:
        body["substep"] = substep
    return json.loads(json.dumps(body))


def implement_task(project, eng) -> dict:
    return json.loads(json.dumps({
        "run_id": 8,
        "attempt": 1,
        "item": {"id": "VS-165", "title": "Engine", "desc": "d", "metric": "m", "guardrails": "", "priority": "High", "repo": "FinTekkers/valuation-service", "personas": {"eng": eng}},
        "step": {"index": 11, "label": IMPLEMENT_LABEL, "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
        "checks_waiver": NO_CHECKS,
        "project": project,
    }))


def dispatch(task, calls) -> dict:
    with pytest.raises(Dispatched):
        execute(task)
    assert len(calls) == 1
    return calls[0]


# ---- the golden-cases sub-step: a PM-step call ----


def test_the_fintekkers_quant_sub_step_reads_the_registry_and_the_store(store, calls):
    call = dispatch(golden_task(FINTEKKERS), calls)
    assert call["add_dirs"] == [REGISTRY_DIR, str(store)]
    assert "## Quant resources (read-only)" in call["prompt"]
    assert f"`{REGISTRY_DIR}/quant_resources.json`" in call["prompt"]
    assert f"`{store}`" in call["prompt"]


def test_without_a_store_on_the_host_it_still_reads_the_registry(store, calls):
    (store / "libs").rmdir()
    store.rmdir()
    call = dispatch(golden_task(FINTEKKERS), calls)
    assert call["add_dirs"] == [REGISTRY_DIR]
    assert "Store:" not in call["prompt"]


def test_a_horizon_sub_step_and_a_plain_metric_step_dispatch_unchanged(store, calls):
    horizon = dispatch(golden_task(HORIZON, {**GOLDEN_SUBSTEP, "persona": "quant"}), calls)
    assert horizon["add_dirs"] is None
    assert "Quant resources" not in horizon["prompt"]
    calls.clear()
    plain = dispatch(golden_task(FINTEKKERS, substep=None), calls)
    assert plain["add_dirs"] is None
    assert "Quant resources" not in plain["prompt"]


def test_a_provider_that_cannot_read_add_dirs_gets_none(store, calls, monkeypatch):
    monkeypatch.setattr(step_agent, "reads_add_dirs", lambda override: False)
    call = dispatch(golden_task(FINTEKKERS), calls)
    assert call["add_dirs"] is None
    assert "Quant resources" not in call["prompt"]


# ---- the implement call ----


def test_a_rust_quant_implement_run_reads_the_store_and_a_fullstack_one_does_not(store, calls, tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    quant = dispatch(implement_task(FINTEKKERS, "rust_quant"), calls)
    assert quant["add_dirs"] == [REGISTRY_DIR, str(store)]
    assert "## Quant resources (read-only)" in quant["prompt"]
    calls.clear()
    fullstack = dispatch(implement_task(FINTEKKERS, "fullstack"), calls)
    assert fullstack["add_dirs"] is None
    assert "Quant resources" not in fullstack["prompt"]


def test_rust_quant_on_a_project_with_no_registry_gets_nothing(store, calls, tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    call = dispatch(implement_task(HORIZON, "rust_quant"), calls)
    assert call["add_dirs"] is None


# ---- the rule itself ----


def test_readers_come_from_the_committed_registry():
    assert quant_resources.readers(FINTEKKERS) == frozenset({"quant", "rust_quant"})
    assert quant_resources.readers(HORIZON) == frozenset()
    assert quant_resources.readers({"name": ""}) == frozenset()
    assert quant_resources.readers("FinTekkers") == frozenset()


def test_a_registry_that_does_not_parse_grants_nothing(tmp_path, store):
    (tmp_path / "fintekkers").mkdir()
    (tmp_path / "fintekkers" / "quant_resources.json").write_text("{ not json")
    assert quant_resources.step_dirs(FINTEKKERS, ["quant"], root=tmp_path) == []
    assert quant_resources.container_dirs(FINTEKKERS, root=tmp_path) == [str(store)], "the mount needs only the file"
