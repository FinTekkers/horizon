"""HO-838 extra tests for task_job prereq recheck."""

import os
import json
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import task_job, workspaces
from farm.tests.test_task_job import plan_artifact, STATE_DIR, LOGS_DIR, _task_file, _main_task_file, _origin_and_clone, PROBE, FAKE_IMAGE, server_runner
from farm.config import QUEUE_DIR


def _state_of(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def test_run_job_with_real_probes_and_no_drift_is_not_prereq_refused_and_first_command_runs(tmp_path, monkeypatch):
    """Metric 3: task_job.main with real probes and no drift is not
    prereq_refused and its first command runs. The plan requires a path only
    the fast-forward brings (the clone is one commit behind origin), so the
    re-check must run after the fast-forward, not before it."""
    _upstream, clone = _origin_and_clone(tmp_path)
    assert not (clone / "two.txt").exists(), "two.txt is only on origin until the fast-forward"
    item_id = "HO-838-CLEAN"
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
    artifact = "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(
        {"cwd": ".", "commands": ["cat two.txt"], "budget_minutes": 1, "runner": "host", "requires": [{"path": "two.txt"}]}
    ) + "\n"
    task = _main_task_file(tmp_path, item_id, artifact, clone, task_clone=True)

    try:
        started = time.monotonic()
        result = task_job.main(["--task", str(task)])
        assert result == 0
        state = _state_of(state_path)
        assert state.get("status") == "finished", state
        assert state["commands"][0]["status"] == "done"
        assert time.monotonic() - started < 30
    finally:
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)


def test_unavailable_raised_inside_run_job_saves_prereq_refused_and_zero_commands(tmp_path, monkeypatch):
    """Guardrail 2: Unavailable raised inside _run_job saves prereq_refused and runs zero commands."""
    _upstream, clone = _origin_and_clone(tmp_path)
    item_id = "HO-838-UNAVAIL"
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)

    # Patch preflight.run to raise Unavailable
    from farm import preflight, run_plan_requires

    def boom(*a, **k):
        raise run_plan_requires.Unavailable("probe cannot run")

    monkeypatch.setattr(preflight, "run", boom)

    task = _main_task_file(tmp_path, item_id, plan_artifact(".", ["echo hi"]), clone, task_clone=True)
    try:
        task_job.main(["--task", str(task)])
        state = _state_of(state_path)
        assert state.get("status") == "prereq_refused"
        # Zero commands run
        assert state["summary"]["run"] == 0
        assert all(c["status"] == "pending" for c in state["commands"])
    finally:
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)


def test_spy_on_preflight_shows_both_preflight_and_run_job_call_it(tmp_path, monkeypatch):
    """Guardrail 3: spy on HO-837's preflight shows both /preflight and _run_job call it."""
    calls = []

    from farm import preflight

    orig_run = preflight.run

    def spy_run(*args, **kwargs):
        calls.append("called")
        return orig_run(*args, **kwargs)

    monkeypatch.setattr(preflight, "run", spy_run)

    # Call via farmd route
    from fastapi.testclient import TestClient
    from farm import farmd

    client = TestClient(farmd.app)
    # Need running_farm state
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "test"})
    try:
        repo = tmp_path / "repo"
        repo.mkdir()
        block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1}
        artifact = "## Commands\nplan\n\n## Run plan block\n" + __import__("domain.py.run_plan", fromlist=["render"]).render(block) + "\n"
        payload = {
            "run_id": 9999,
            "item": {"id": "HO-838", "kind": "task", "repo": "acme/demo"},
            "project": {"id": 1, "name": "test"},
            "plan_artifact": artifact,
            "approved_hash": task_job.plan_hash_of(artifact),
            "runner": "host",
            "repo_dir": str(repo),
        }
        res = client.post("/preflight", json=payload)
        assert res.status_code == 200
    finally:
        farmd.state.update(saved)

    assert len(calls) >= 1

    # Now call via _run_job
    calls.clear()
    _upstream, clone = _origin_and_clone(tmp_path)
    item_id = "HO-838-SPY"
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
    task = _main_task_file(tmp_path, item_id, plan_artifact(".", ["echo hi"]), clone, task_clone=True)
    try:
        task_job.main(["--task", str(task)])
    finally:
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)

    assert len(calls) >= 1


def test_tenant_dispatch_recheck_defers_the_clone_checks_to_the_job(tmp_path, monkeypatch):
    """Guardrail 2,3: a tenant task's dispatch re-check never judges the farm
    user's tree. Its cwd, login env and requires are `deferred` to the
    tenant job's own re-check (clean pass and removed var: test_tenant_job.py),
    while the same payload as an internal task does get a cwd verdict."""
    from farm import farmd
    from fastapi.testclient import TestClient

    client = TestClient(farmd.app)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "test"})
    try:
        block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1}
        artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
        payload = {
            "run_id": 9999,
            "item": {"id": "HO-838", "kind": "task", "repo": "acme/demo"},
            "project": {"id": 2, "name": "tenant", "isolation": "tenant", "githubTokenRef": "$TOKEN", "runUser": "testuser"},
            "plan_artifact": artifact,
            "approved_hash": task_job.plan_hash_of(artifact),
            "runner": "host",
            "repo_dir": str(tmp_path / "missing"),  # the farm user's path, never the tenant's
        }
        tenant = client.post("/preflight", json=payload)
        assert tenant.status_code == 200
        data = tenant.json()
        assert data["deferred"] == farmd.PREREQ_TENANT_DEFERRED == ["cwd", "login_env", "requires"]
        assert not [u for u in data["unmet"] if u["kind"] in data["deferred"]], data["unmet"]

        internal = client.post("/preflight", json={**payload, "project": {"id": 1, "name": "test"}}).json()
        assert internal["deferred"] == []
        assert internal["ok"] is False
        assert [u["kind"] for u in internal["unmet"]] == ["cwd"]
    finally:
        farmd.state.update(saved)


def test_resume_into_a_prereq_refusal_keeps_the_passed_commands_done(tmp_path, monkeypatch):
    """Plan: commands already done stay recorded through a prereq_refused
    Resume, as in the cwd_refused path, so a later Resume still skips them.
    Run 1 passes command 1 and fails command 2; the host then drifts."""
    from farm import preflight

    marks = tmp_path / "marks.txt"
    artifact = plan_artifact(".", [f"echo one >> {marks}", f"echo two >> {marks}; exit 1", "echo three"], runner="host")
    kwargs = dict(
        run_id=7,
        item_id="HZ-1",
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        runner=server_runner(artifact),
        state_path=tmp_path / "job.json",
        log_path=tmp_path / "job.log",
        repo_dir=str(tmp_path),
        container_image=FAKE_IMAGE,
        env_values={},
    )
    task_job.run_job(**kwargs)
    first = json.loads((tmp_path / "job.json").read_text())
    assert [c["exit_code"] for c in first["commands"]] == [0, 1, None]

    drift = {"passed": False, "unmet": [{"kind": "env", "name": "MY_VAR", "reason": "not set"}]}
    monkeypatch.setattr(preflight, "run", lambda *a, **k: drift)
    summary = task_job.run_job(**kwargs, prereq_task={})
    refused = json.loads((tmp_path / "job.json").read_text())
    assert summary == {"run": 0, "passed": 0, "failed": 0, "failing": []}
    assert refused["status"] == "prereq_refused"
    assert (refused["commands"][0]["status"], refused["commands"][0]["exit_code"]) == ("done", 0)
    assert [c["status"] for c in refused["commands"][1:]] == ["pending", "pending"]
    assert marks.read_text().splitlines() == ["one", "two"]


@pytest.mark.parametrize(
    "result",
    [
        {"passed": False, "unmet": ["x"]},
        {"passed": False, "unmet": []},
        {"passed": None, "unmet": []},
        {"passed": True, "unmet": "x"},
        {},
        None,
    ],
)
def test_prereq_recheck_fails_closed_unless_the_engine_says_passed(monkeypatch, result):
    """Guardrail 2: a malformed or unconfirmed engine result is an unmet
    `probe`, never a pass."""
    from farm import preflight

    monkeypatch.setattr(preflight, "run", lambda *a, **k: result)
    unmet = task_job._prereq_recheck({}, "0" * 64)
    assert unmet and all(u["kind"] == "probe" for u in unmet), unmet


def test_prereq_recheck_passes_a_clean_result_and_leaves_plan_gaps_to_the_hash_gate(monkeypatch):
    from farm import preflight

    results = iter([
        {"passed": True, "unmet": []},
        {"passed": False, "unmet": [{"kind": "plan", "name": "plan", "reason": "changed"}]},
    ])
    monkeypatch.setattr(preflight, "run", lambda *a, **k: next(results))
    assert task_job._prereq_recheck({}, "0" * 64) == []
    assert task_job._prereq_recheck({}, "0" * 64) == []


def test_a_recheck_timeout_names_the_recheck_cap_not_the_preflight_step_cap(monkeypatch):
    """A re-check runs under PREREQ_RECHECK_S, so its timeout says so."""
    from farm import preflight

    monkeypatch.setattr(preflight, "_checks", lambda *a, **k: time.sleep(5))
    result = preflight.run({}, deadline=time.monotonic() + 0.2, cap_s=task_job.PREREQ_RECHECK_S)
    assert result["passed"] is False
    assert [u["reason"] for u in result["unmet"]] == [f"timed out: preflight has {task_job.PREREQ_RECHECK_S}s"]
