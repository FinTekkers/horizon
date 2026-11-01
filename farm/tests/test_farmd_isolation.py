"""HZ-662: farmd refuses a tenant project's task unless it names both a $NAME
credential reference and a run user, and refuses any unknown isolation — on
/steps/run (agent and job lane alike) and again when a queued file is claimed.
An internal task enqueues and launches exactly as before. The log names the
reference only, never its value, and nothing here resolves the reference or
switches user (that is HZ-663)."""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from domain.py import steps
from farm import farmd
from farm.config import QUEUE_DIR

client = TestClient(farmd.app)

CASES = json.loads((Path(__file__).resolve().parents[2] / "domain" / "fixtures" / "isolation-cases.json").read_text())
REFUSED = [case for case in CASES["shared"] if case["refusal"] and case["project"] is not None]
IMPLEMENT = 10  # runs lane
EXECUTE_INDEX = steps.by_kind_label("task", "Execute")["index"]
REF = "$ACME_GITHUB_TOKEN"
SECRET = "s3cret-value-never-logged"
TENANT_COMPLETE = {"isolation": "tenant", "githubTokenRef": REF, "runUser": "acme"}


def make_task(run_id, isolation_fields=None, *, step_index=IMPLEMENT, item_id="AC-1"):
    project = {"id": 7, "name": "Acme"}
    if isolation_fields is not None:
        project.update(isolation_fields)
    return {
        "run_id": run_id,
        "attempt": 1,
        "project": project,
        "item": {"id": item_id, "title": "t", "repo": "acme/site"},
        "step": {"index": step_index, "label": "Implement"},
    }


@pytest.fixture
def farm(monkeypatch):
    """A running farm; the background tick is a no-op and no hub is cloned."""
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: True)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "Horizon"})
    dirs = [QUEUE_DIR / "pm", QUEUE_DIR / "runs", QUEUE_DIR / "runs" / "active", QUEUE_DIR / "jobs" / "active"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    try:
        yield
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        for d in dirs:
            for f in d.glob("66*.json*"):
                f.unlink(missing_ok=True)


def queued_files():
    return sorted(p.name for d in ("pm", "runs", "runs/active", "jobs/active") for p in (QUEUE_DIR / d).glob("66*.json*"))


# ---- the shared rule: the same table as server/src/projectIsolation.js ----


@pytest.mark.parametrize("case", CASES["shared"], ids=[c["id"] for c in CASES["shared"]])
def test_isolation_refusal_matches_the_shared_table(case):
    assert farmd._isolation_refusal(case["project"]) == case["refusal"]


# ---- guardrail 3: the one named exception, pinned ----


@pytest.mark.parametrize("case", CASES["farmPayloadOnly"], ids=[c["id"] for c in CASES["farmPayloadOnly"]])
def test_a_task_with_no_isolation_key_reads_as_internal(case):
    assert farmd._isolation_refusal(case["project"]) == case["refusal"] is None


@pytest.mark.parametrize("value", [None, "", "TENANT"])
def test_a_present_but_unknown_isolation_is_refused(value):
    assert farmd._isolation_refusal({"id": 7, "name": "Acme", "isolation": value}) is not None


# ---- metric 2: a refused tenant task is never enqueued or launched ----


@pytest.mark.parametrize("case", REFUSED, ids=[c["id"] for c in REFUSED])
def test_steps_run_refuses_an_incomplete_tenant_or_unknown_isolation_and_queues_nothing(farm, fake_tmux, case):
    res = client.post("/steps/run", json=make_task(6601, case["project"]))
    assert res.status_code == 400
    assert res.json() == {"error": "isolation_refused", "reason": case["refusal"]}
    assert queued_files() == []
    assert [c for c in fake_tmux.calls if c[0] == "new-session"] == []


def test_a_tenant_job_missing_run_user_is_refused_before_anything_launches(farm, fake_tmux, monkeypatch):
    monkeypatch.setattr(farmd, "_jobs_enabled", lambda: True)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: pytest.fail("a refused job must never report started"))
    monkeypatch.setattr(farmd, "launch_job", lambda task: pytest.fail("a refused job must never launch"))
    job = make_task(6602, {"isolation": "tenant", "githubTokenRef": REF, "runUser": None}, step_index=EXECUTE_INDEX, item_id="AC-2")
    job["item"]["kind"] = "task"
    job["step"]["label"] = "Execute"
    job.update(plan_artifact="plan", approved_hash="h", runner="host", repo_dir="/tmp")

    res = client.post("/steps/run", json=job)
    assert res.status_code == 400
    assert res.json() == {"error": "isolation_refused", "reason": "tenant project needs run_user before the farm runs it"}
    assert queued_files() == []


def test_a_hand_written_tenant_queue_file_is_refused_before_the_claim_and_the_server_is_told_why(tmp_path, monkeypatch, fake_tmux):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: pytest.fail("_notify_started must never be called"))
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = runs_dir / "6603.json"
    task_path.write_text(json.dumps(make_task(6603, {"isolation": "tenant", "githubTokenRef": None, "runUser": "acme"})))

    assert farmd._claim_and_launch(task_path, runs_dir, tmp_path) is None
    assert [c for c in fake_tmux.calls if c[0] == "new-session"] == []
    assert not (runs_dir / "active" / "6603.json").exists(), "never renamed into active"
    assert forwarded == [
        {
            "run_id": 6603,
            "ok": False,
            "error": "the farm refused this tenant item: tenant project needs github_token_ref before the farm runs it",
        }
    ]
    assert not task_path.exists(), "released once the server took the report"


def test_a_refused_queue_file_stays_for_the_next_tick_when_the_server_cannot_be_reached(tmp_path, monkeypatch, fake_tmux):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: pytest.fail("_notify_started must never be called"))
    monkeypatch.setattr(farmd, "_forward_result", lambda body: None)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = runs_dir / "6604.json"
    task_path.write_text(json.dumps(make_task(6604, {"isolation": "shared"})))

    assert farmd._claim_and_launch(task_path, runs_dir, tmp_path) is None
    assert task_path.exists()
    assert [c for c in fake_tmux.calls if c[0] == "new-session"] == []


# ---- metric 1: an internal task enqueues and launches as today ----


def test_an_internal_task_is_enqueued_like_a_pre_hz662_task_and_launched(farm, fake_tmux, monkeypatch):
    started = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: started.append(run_id) or True)
    monkeypatch.setattr(farmd, "_refresh_rules", lambda task: False)
    internal = {"isolation": "internal", "githubTokenRef": None, "runUser": None}
    assert client.post("/steps/run", json=make_task(6605, internal)).json() == {"ok": True, "queued": "runs"}
    assert client.post("/steps/run", json=make_task(6606, item_id="AC-6")).json() == {"ok": True, "queued": "runs"}

    new = json.loads((QUEUE_DIR / "runs" / "6605.json").read_text())
    old = json.loads((QUEUE_DIR / "runs" / "6606.json").read_text())
    for key in internal:
        assert new["project"].pop(key) == internal[key]
    new.pop("run_id"), old.pop("run_id")
    new["item"].pop("id"), old["item"].pop("id")
    assert new == old, "an internal task is today's task plus the three fields"

    name = farmd._claim_and_launch(QUEUE_DIR / "runs" / "6605.json", QUEUE_DIR / "runs", Path.cwd())
    assert name is not None
    assert started == [6605]
    assert [c for c in fake_tmux.calls if c[0] == "new-session"]


# ---- metric 3 / guardrail 2: the log names the reference, never the value ----


def test_the_refusal_log_and_400_name_the_reference_never_its_value(farm, monkeypatch, capsys):
    monkeypatch.setenv("ACME_GITHUB_TOKEN", SECRET)
    res = client.post("/steps/run", json=make_task(6607, {"isolation": "tenant", "githubTokenRef": REF, "runUser": None}))
    assert res.status_code == 400
    assert SECRET not in res.text

    out = capsys.readouterr()
    log = out.out + out.err
    assert f"farmd: refused run 6607: tenant project needs run_user before the farm runs it (token ref {REF})" in log
    assert SECRET not in log


def test_a_ref_that_is_not_a_reference_is_never_logged(farm, capsys):
    res = client.post("/steps/run", json=make_task(6608, {"isolation": "tenant", "githubTokenRef": "ghp_abc123", "runUser": "acme"}))
    assert res.status_code == 400
    out = capsys.readouterr()
    assert "ghp_abc123" not in out.out + out.err + res.text
    assert "(token ref invalid)" in out.out


# ---- guardrail 4: no token injected, no switch to run_user (HZ-663) ----


def test_a_complete_tenant_task_launches_as_the_farm_user_with_no_resolved_token(farm, fake_tmux, monkeypatch, tmp_path):
    """HZ-663 part 1 replaced HZ-662's interim launch: a complete tenant task
    is refused until part 2, and never launches as the farm user."""
    monkeypatch.setenv("ACME_GITHUB_TOKEN", SECRET)
    monkeypatch.setattr(farmd.farm_config, "TENANT_ENV_ROOT", tmp_path / "tenants")
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: pytest.fail("a refused tenant task must never report started"))
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda *args, **kwargs: pytest.fail("a tenant task must never launch as the farm user"))
    task = make_task(6609, TENANT_COMPLETE)
    task["test_env_file"] = str(tmp_path / "tenants" / "7" / "e2e.env")

    res = client.post("/steps/run", json=task)
    assert res.status_code == 400
    assert res.json() == {"error": "tenant_launch_refused", "reason": farmd.TENANT_WORKSPACE_GATE}
    assert queued_files() == []
    assert SECRET not in res.text
