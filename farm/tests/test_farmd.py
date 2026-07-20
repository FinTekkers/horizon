"""farmd contract tests: session-name derivation and /steps/cancel."""

import json

from fastapi.testclient import TestClient

from farm import farmd
from farm.config import QUEUE_DIR

client = TestClient(farmd.app)


def make_task(run_id, item_id="hz-3", step_index=10, attempt=2):
    return {
        "run_id": run_id,
        "attempt": attempt,
        "item": {"id": item_id},
        "step": {"index": step_index, "label": "x"},
    }


def test_run_session_name_matches_dispatcher_format():
    name = farmd._run_session_name(make_task(9, item_id="HZ-3", step_index=10, attempt=2))
    assert name == "farm-run-hz-3-s10-a2"


def test_cancel_removes_a_queued_task():
    runs = QUEUE_DIR / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    task_path = runs / "41.json"
    task_path.write_text(json.dumps(make_task(41)))

    res = client.post("/steps/cancel", json={"run_id": 41})
    assert res.status_code == 200
    body = res.json()
    assert body["removed"] is True
    assert not task_path.exists()


def test_cancel_of_unknown_run_is_a_noop():
    res = client.post("/steps/cancel", json={"run_id": 999999})
    assert res.status_code == 200
    assert res.json()["removed"] is False


def test_concierge_does_not_launch_when_the_flag_is_off(monkeypatch):
    launched = []
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", False)
    monkeypatch.setitem(farmd.state, "project", {"id": 1, "name": "My Proj"})
    assert farmd._maybe_launch_concierge() is False
    assert launched == []


def test_concierge_launches_when_the_flag_is_on(monkeypatch):
    launched = []
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", True)
    monkeypatch.setitem(farmd.state, "project", {"id": 1, "name": "My Proj"})
    assert farmd._maybe_launch_concierge() is True
    assert launched == ["farm-concierge-my-proj"]


def test_cancel_of_active_run_removes_task_and_reports_kill_state():
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    task_path = active / "42.json"
    task_path.write_text(json.dumps(make_task(42)))

    res = client.post("/steps/cancel", json={"run_id": 42})
    assert res.status_code == 200
    body = res.json()
    assert body["removed"] is True
    assert not task_path.exists()
    # No such tmux session exists in tests; the endpoint reports killed=None
    # rather than failing — the kill is best-effort by design.
    assert body["killed"] is None
