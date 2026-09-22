"""farmd contract tests: session names, /steps/cancel, /runs/{id}/log, the
HZ-5 subscription guardrail, and the rules stamp on /steps/run (HZ-9's
payload-visibility metric)."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import farmd
from farm.config import LOGS_DIR, QUEUE_DIR

client = TestClient(farmd.app)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


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


# ---- /internal/steps/result forwarding (HZ-29) ----
# farmd is a dumb relay here: it must forward the agent's reported artifacts
# to the Node server byte-for-byte, with no re-slicing of its own — any cap
# on artifact size belongs to the agent (write side) and the server
# (dispatch-time budget), not this hop.


def test_steps_result_forwards_a_large_artifact_verbatim(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"], captured["json"] = url, json
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    big = "z" * 50000
    res = client.post(
        "/internal/steps/result",
        json={"run_id": 55, "ok": True, "summary": "done", "artifacts": {"artifact_md": big}},
    )
    assert res.status_code == 200
    assert captured["json"]["artifacts"]["artifact_md"] == big


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


# ---- HZ-5 cost guardrail ----


def test_farm_start_refuses_with_api_key_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    res = client.post("/farm/start", json={"project": {"id": 1, "name": "P"}, "repos": []})
    assert res.status_code == 500
    assert "ANTHROPIC_API_KEY" in res.json()["error"]


def test_farmd_refuses_to_boot_with_api_key_set():
    """Module init runs the guardrail, so the adopt path (which never goes
    through /farm/start) can't bring up a farm on API billing either."""
    env = {**os.environ, "ANTHROPIC_API_KEY": "sk-ant-test"}
    proc = subprocess.run(
        [sys.executable, "-c", "import farm.farmd"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
        timeout=60,
    )
    assert proc.returncode != 0
    assert "ANTHROPIC_API_KEY" in proc.stderr


# ---- /runs/{run_id}/log (HZ-5 live activity tail) ----


def _seed_run_log(run_id, text, item_id="hz-5", step_index=11, attempt=1):
    task = make_task(run_id, item_id=item_id, step_index=step_index, attempt=attempt)
    name = farmd._run_session_name(task)
    farmd.RUN_SESSIONS[str(run_id)] = name
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / f"{name}.log").write_text(text)
    return name


def test_run_log_pages_by_offset(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    _seed_run_log(101, "hello\nworld\n")

    res = client.get("/runs/101/log")
    assert res.status_code == 200
    body = res.json()
    assert body == {"content": "hello\nworld\n", "next_offset": 12, "active": True}

    res = client.get("/runs/101/log", params={"offset": body["next_offset"]})
    assert res.json() == {"content": "", "next_offset": 12, "active": True}


def test_run_log_offset_past_eof_returns_empty_with_unchanged_offset(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    _seed_run_log(102, "short")
    res = client.get("/runs/102/log", params={"offset": 9999})
    assert res.json() == {"content": "", "next_offset": 9999, "active": False}


def test_run_log_caps_each_read_at_64k(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    _seed_run_log(103, "x" * (70 * 1024))
    res = client.get("/runs/103/log")
    body = res.json()
    assert len(body["content"]) == 64 * 1024
    assert body["next_offset"] == 64 * 1024
    # The remainder arrives on the next page.
    res = client.get("/runs/103/log", params={"offset": body["next_offset"]})
    assert len(res.json()["content"]) == 6 * 1024


def test_run_log_active_flips_false_when_the_session_dies(monkeypatch):
    _seed_run_log(104, "output\n")
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    res = client.get("/runs/104/log")
    assert res.json()["active"] is False


def test_run_log_resolves_a_claimed_task_file_after_restart(monkeypatch):
    """A farmd restart empties RUN_SESSIONS; the active task file rescan
    must still resolve the run (same seam _adopt_existing uses)."""
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    task = make_task(105, item_id="hz-5", step_index=11, attempt=1)
    name = farmd._run_session_name(task)
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / "105.json").write_text(json.dumps(task))
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / f"{name}.log").write_text("resumed\n")
    farmd.RUN_SESSIONS.pop("105", None)

    res = client.get("/runs/105/log")
    assert res.status_code == 200
    assert res.json()["content"] == "resumed\n"
    (active / "105.json").unlink()


def test_run_log_unknown_run_is_404():
    """Covers PM-queue runs too (steps 0/1/2/9 share the PM session's log and
    never enter RUN_SESSIONS): the endpoint 404s and the UI panel stays away."""
    (QUEUE_DIR / "pm").mkdir(parents=True, exist_ok=True)
    (QUEUE_DIR / "pm" / "106.json").write_text(json.dumps(make_task(106, step_index=1)))
    res = client.get("/runs/106/log")
    assert res.status_code == 404
    assert res.json() == {"error": "unknown run"}


def test_run_log_404s_after_the_run_leaves_run_sessions():
    _seed_run_log(107, "gone\n")
    farmd.RUN_SESSIONS.pop("107")
    res = client.get("/runs/107/log")
    assert res.status_code == 404


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
