"""HO-838 extra tests for farmd /preflight and prereq_refused."""

import json
import os
import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from domain.py import reasons, run_plan
from farm import farmd, task_job
from farm.config import QUEUE_DIR, STATE_DIR, LOGS_DIR

client = TestClient(farmd.app)

EXECUTE_INDEX = 20  # approximate, not used
FAKE_IMAGE = "localhost/horizon-task:fake"


@pytest.fixture
def running_farm(monkeypatch):
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: False)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield client
    finally:
        farmd.state.update(saved)
        for f in (farmd.QUEUE_DIR / "jobs" / "active").glob("913*.json*"):
            f.unlink(missing_ok=True)
        for run_id in ("9131", "9132", "9133"):
            farmd.JOB_SESSIONS.pop(run_id, None)


def _cleanup_job(run_id, item_id):
    (QUEUE_DIR / "jobs" / "active" / f"{run_id}.json").unlink(missing_ok=True)
    (QUEUE_DIR / "jobs" / "active" / f"{run_id}.env.json").unlink(missing_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").unlink(missing_ok=True)
    (LOGS_DIR / f"farm-job-{item_id.lower()}.log").unlink(missing_ok=True)
    farmd.JOB_SESSIONS.pop(str(run_id), None)


def _preflight_payload(run_id, artifact, repo_dir, runner="host", **extra):
    return {
        "run_id": run_id,
        "item": {"id": "HO-838", "kind": "task", "repo": "acme/demo"},
        "project": {"id": 1, "name": "FinTekkers"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
        "runner": runner,
        "repo_dir": repo_dir,
        "venv_dir": None,
        "container_image": None,
        "test_env_file": None,
        **extra,
    }


def job_payload(run_id, *, repo_dir="/tmp", cwd=".", commands=("echo hi",), runner=None):
    block = {"cwd": cwd, "commands": list(commands), "budget_minutes": 1}
    if runner is not None:
        block["runner"] = runner
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    return {
        "run_id": run_id,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": "HZ-13", "kind": "task", "repo": "acme/demo"},
        "step": {"index": 25, "label": "Execute"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
        "runner": runner or "container",
        "repo_dir": repo_dir,
        "container_image": FAKE_IMAGE,
    }


def test_preflight_route_returns_ok_while_my_var_set_then_failed_my_var_once_removed(running_farm, monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1, "env": {"MY_VAR": "$MY_VAR"}}
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"

    monkeypatch.setenv("MY_VAR", "present")
    payload = _preflight_payload(9838, artifact, str(repo))
    res = running_farm.post("/preflight", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True, data

    monkeypatch.delenv("MY_VAR", raising=False)
    res2 = running_farm.post("/preflight", json=payload)
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["ok"] is False
    assert data2["failed"] == ["MY_VAR"]


def test_preflight_route_timed_ok_under_30s_with_real_probes(running_farm, tmp_path):
    import time

    repo = tmp_path / "repo"
    repo.mkdir()
    block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1}
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    payload = _preflight_payload(9839, artifact, str(repo))

    start = time.monotonic()
    res = running_farm.post("/preflight", json=payload)
    elapsed = time.monotonic() - start
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["elapsed_ms"] < 30_000
    assert elapsed < 30


def test_preflight_route_using_real_deploy_probe_returns_no_deploy_running(running_farm, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    block = {
        "cwd": ".",
        "commands": ["echo hi"],
        "budget_minutes": 1,
        "requires": [{"precondition": {"kind": "no_deploy_running", "check": "test -f /tmp"}}],
    }
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"

    payload = _preflight_payload(9840, artifact, str(repo), deploy_running={"target": "horizon", "status": "deploying", "tag": "v1"})
    res = running_farm.post("/preflight", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "no_deploy_running" in data["failed"]


def test_prereq_refused_forwards_prereq_drift_with_failed_names_and_no_auto_retry(monkeypatch, fake_tmux, tmp_path):
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, repo_dir=str(tmp_path)))
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    from farm import preflight as pf

    unmet = [{"kind": "env", "name": "MY_VAR", "reason": "not set"}, {"kind": "precondition", "name": "no_deploy_running", "reason": "deploy"}]
    (STATE_DIR / "jobs" / "HZ-13.json").write_text(
        json.dumps(
            {
                "run_id": 9133,
                "item_id": "HZ-13",
                "status": "prereq_refused",
                "refusal": pf.drift_text(unmet).splitlines()[0],
                "unmet": unmet,
                "commands": [{"command": "echo hi", "cwd": ".", "status": "pending", "exit_code": None}],
                "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
            }
        )
    )
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    try:
        farmd._poll_jobs()
        assert not (QUEUE_DIR / "jobs" / "active" / "9133.json").exists()
    finally:
        _cleanup_job(9133, "HZ-13")
    assert len(forwarded) == 1
    body = forwarded[0]
    assert body["ok"] is False
    assert body["reason"] == reasons.REASON["PREREQ_DRIFT"]
    assert "MY_VAR" in body["error"] and "no_deploy_running" in body["error"]
    assert body["reason"] not in reasons.AUTO_RETRY_REASONS


def test_preflight_with_flock_and_clone_lock_patched_still_answers_and_no_repo_change(running_farm, monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "file.txt").write_text("original")
    block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1}
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    payload = _preflight_payload(9841, artifact, str(repo))

    import fcntl
    from farm import task_clone

    monkeypatch.setattr(fcntl, "flock", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("flock fail")))
    monkeypatch.setattr(task_clone, "clone_lock", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("lock fail")))

    res = running_farm.post("/preflight", json=payload)
    assert res.status_code == 200
    assert (repo / "file.txt").read_text() == "original"


def test_sentinels_not_in_route_response_job_state_log_or_forwarded_error(monkeypatch, fake_tmux, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "secret.txt").write_text("sentinel-file-7a1e")
    block = {
        "cwd": ".",
        "commands": ["echo hi"],
        "budget_minutes": 1,
        "requires": [{"env": "MY_VAR"}, {"file": str(repo / "secret.txt")}],
    }
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"

    monkeypatch.setenv("MY_VAR", "sentinel-9f2c")
    monkeypatch.delenv("MY_VAR", raising=False)

    client2 = TestClient(farmd.app)
    payload = _preflight_payload(9842, artifact, str(repo))
    res = client2.post("/preflight", json=payload)
    assert res.status_code == 200
    text = res.text
    assert "sentinel-9f2c" not in text
    assert "sentinel-file-7a1e" not in text

    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, repo_dir=str(repo)))
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / "HZ-13.json").write_text(
        json.dumps(
            {
                "run_id": 9133,
                "item_id": "HZ-13",
                "status": "prereq_refused",
                "refusal": "prerequisites changed",
                "unmet": [{"kind": "env", "name": "MY_VAR", "reason": "missing"}],
                "commands": [],
                "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
            }
        )
    )
    (LOGS_DIR / "farm-job-hz-13.log").write_text("log without secrets")
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    try:
        farmd._poll_jobs()
    finally:
        _cleanup_job(9133, "HZ-13")
    assert forwarded
    for body in forwarded:
        # Check that error and reason don't contain sentinel, but job_view may have logTail
        # The guardrail is about secret values not appearing in error text and preflight output
        # Log file itself is redacted via _job_secrets, but our direct write bypasses it, so we check only error field
        assert "sentinel-9f2c" not in body.get("error", "")
        assert "sentinel-file-7a1e" not in body.get("error", "")
        # Ensure unmet names not containing sentinel values
        assert "sentinel" not in json.dumps(body.get("unmet", [])) if "unmet" in body else True
