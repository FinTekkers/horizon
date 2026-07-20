"""farmd contract tests: session-name derivation, /steps/cancel, and the
rules stamp on /steps/run (HZ-9's payload-visibility metric)."""

import json

import pytest
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


@pytest.fixture
def running_farm():
    """Flip farmd to running for one test; tasks go to the pm queue (step 9),
    which no background dispatcher consumes in tests."""
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield
    finally:
        farmd.state.update(saved)
        for f in (QUEUE_DIR / "pm").glob("*.json"):
            f.unlink(missing_ok=True)


def test_steps_run_stamps_the_repos_rules_into_the_task_payload(running_farm):
    task = make_task(101, item_id="HZ-9", step_index=9)
    task["item"]["repo"] = "FinTekkers/ui-service"
    res = client.post("/steps/run", json=task)
    assert res.status_code == 200

    queued = json.loads((QUEUE_DIR / "pm" / "101.json").read_text())
    # The success metric's payload check: the migrated ui-service rules are in
    # the queued task verbatim, alongside the project-level FinTekkers rules.
    assert "FinTekkers/ui-service — repo rules" in queued["rules"]
    assert "npm install --ignore-scripts" in queued["rules"]
    assert "FinTekkers — project rules" in queued["rules"]


def test_steps_run_without_matching_rules_stamps_an_empty_string(running_farm):
    farmd.state["project"] = {"id": 2, "name": "NoSuchProject"}
    task = make_task(102, item_id="X-1", step_index=9)
    task["item"]["repo"] = "acme/unmapped"
    res = client.post("/steps/run", json=task)
    assert res.status_code == 200
    assert json.loads((QUEUE_DIR / "pm" / "102.json").read_text())["rules"] == ""


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
