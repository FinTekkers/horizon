"""HZ-378: farmd's job lane — dispatching a job, adopting it after a
restart, forwarding its finish with the Execute artifact, the kill switch,
and teardown."""

import json

import pytest
from fastapi.testclient import TestClient

from domain.py import reasons, run_plan, steps
from farm import farmd, task_job, tmux_mgr
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

client = TestClient(farmd.app)

EXECUTE_INDEX = steps.by_kind_label("task", "Execute")["index"]


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
        for f in (QUEUE_DIR / "jobs" / "active").glob("913*.json*"):
            f.unlink(missing_ok=True)
        for run_id in ("9131", "9132", "9133"):
            farmd.JOB_SESSIONS.pop(run_id, None)


def job_payload(run_id, *, cwd="/tmp", commands=("echo hi",)):
    block = {"cwd": cwd, "commands": list(commands), "budget_minutes": 1}
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    return {
        "run_id": run_id,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": "HZ-13", "kind": "task", "repo": "acme/demo"},
        "step": {"index": EXECUTE_INDEX, "label": "Execute"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
    }


def _write_finished(item_id, cwd, *, status="finished", summary=None):
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").write_text(
        json.dumps(
            {
                "run_id": 9131,
                "item_id": item_id,
                "status": status,
                "commands": [{"command": "echo hi", "cwd": cwd, "status": "done", "exit_code": 0}],
                "summary": summary or {"run": 1, "passed": 1, "failed": 0, "failing": []},
            }
        )
    )


def test_reboot_adopts_the_job_and_reports_it_finished(monkeypatch, fake_tmux, tmp_path):
    """R13: a farmd restarted mid-job re-adopts its farm-job-* session from
    the claimed task file; when the runner finishes, the stub server gets the
    completion once, with the summary and the redacted log."""
    farmd.JOB_SESSIONS.clear()
    name = farmd.launch_job(job_payload(9131, cwd=str(tmp_path)))
    assert name == "farm-job-hz-13"
    assert name in fake_tmux.sessions

    # The restart: fresh memory, same queue dir and tmux server.
    farmd.JOB_SESSIONS.clear()
    farmd._adopt_jobs()
    assert farmd.JOB_SESSIONS == {"9131": name}

    _write_finished("HZ-13", str(tmp_path))
    (LOGS_DIR / "farm-job-hz-13.log").write_text("$ echo hi\nhi\nexit 0\n")
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", forwarded.append)
    try:
        farmd._poll_jobs()
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9131.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9131.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-13.json").unlink(missing_ok=True)
        (LOGS_DIR / "farm-job-hz-13.log").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9131", None)
    assert len(forwarded) == 1
    body = forwarded[0]
    assert body["run_id"] == 9131 and body["ok"] is True
    assert body["summary"] == "1 command(s) run, 1 passed, 0 failed"
    artifact = body["artifacts"]["artifact_md"]
    assert "1 command(s) run, 1 passed, 0 failed" in artifact
    assert "hi\nexit 0" in artifact


def test_a_budget_breach_forwards_the_non_retryable_reason(monkeypatch, fake_tmux, tmp_path):
    """The farm side of metric line 2: a breach reports through the same
    failure path as an agent step, tagged so the server pauses for a human
    instead of retrying."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, cwd=str(tmp_path)))
    _write_finished("HZ-13", str(tmp_path), status="budget_exceeded")
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", forwarded.append)
    try:
        farmd._poll_jobs()
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9133.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9133.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-13.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9133", None)
    assert len(forwarded) == 1
    assert forwarded[0]["ok"] is False
    assert forwarded[0]["reason"] == reasons.REASON["JOB_BUDGET_EXCEEDED"]


def test_jobs_disabled_refuses_new_dispatches_without_running_anything(running_farm, monkeypatch, fake_tmux):
    """R22 (optional): with the kill switch off, the farm refuses the job —
    nothing is queued and no session starts."""
    monkeypatch.setenv("FARM_JOBS_ENABLED", "0")
    res = running_farm.post("/steps/run", json=job_payload(9132))
    assert res.status_code == 409
    assert res.json() == {"error": "jobs_disabled"}
    assert not (QUEUE_DIR / "jobs" / "active" / "9132.json").exists()
    assert "farm-job-hz-13" not in fake_tmux.sessions


def test_the_execute_artifact_carries_the_summary_and_the_capped_log():
    md = farmd.job_artifact_md("1 command(s) run, 1 passed, 0 failed", "$ echo hi\nhi\n")
    assert "1 command(s) run, 1 passed, 0 failed" in md
    assert "$ echo hi\nhi" in md
    big = "x" * (farmd.JOB_LOG_MAX_CHARS + 100)
    capped = farmd.job_artifact_md("s", big)
    assert capped.endswith(farmd.JOB_LOG_TRUNCATED_MARKER)
    assert len(capped) == farmd.JOB_LOG_MAX_CHARS + len(farmd.JOB_LOG_TRUNCATED_MARKER)
    # Pinned mirror of server/src/orchestrator.js: the two sides cap the same
    # text at the same length with the same marker.
    assert farmd.JOB_LOG_MAX_CHARS == 512 * 1024
    assert farmd.JOB_LOG_TRUNCATED_MARKER == "\n\n[...truncated: job log exceeded 512 KB; showing the first 512 KB]"


def test_teardown_covers_job_sessions(fake_tmux):
    assert tmux_mgr.JOB_SESSION_PREFIX in tmux_mgr.AGENT_SESSION_PREFIXES
    fake_tmux.sessions.add("farm-job-hz-9")
    assert "farm-job-hz-9" in tmux_mgr.kill_all_farm_sessions()
    assert "farm-job-hz-9" not in fake_tmux.sessions
