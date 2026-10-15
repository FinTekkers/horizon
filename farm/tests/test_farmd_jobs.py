"""HZ-378: farmd's job lane — dispatching a job, adopting it after a
restart, forwarding its finish with the Execute artifact, the kill switch,
and teardown."""

import json
import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from domain.py import reasons, run_plan, steps
from farm import container_runner, farmd, task_job, tmux_mgr
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

client = TestClient(farmd.app)

EXECUTE_INDEX = steps.by_kind_label("task", "Execute")["index"]
# HZ-416: the container path, run through conftest's fake_podman.
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
        for f in (QUEUE_DIR / "jobs" / "active").glob("913*.json*"):
            f.unlink(missing_ok=True)
        for run_id in ("9131", "9132", "9133"):
            farmd.JOB_SESSIONS.pop(run_id, None)


def job_payload(run_id, *, repo_dir="/tmp", cwd=".", commands=("echo hi",), runner=None):
    block = {"cwd": cwd, "commands": list(commands), "budget_minutes": 1}
    if runner is not None:
        block["runner"] = runner
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    return {
        "run_id": run_id,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": "HZ-13", "kind": "task", "repo": "acme/demo"},
        "step": {"index": EXECUTE_INDEX, "label": "Execute"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
        "repo_dir": repo_dir,
        "container_image": FAKE_IMAGE,
    }


def _write_finished(item_id, cwd, *, status="finished", summary=None, run_id=9131):
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
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
    name = farmd.launch_job(job_payload(9131, repo_dir=str(tmp_path)))
    assert name == "farm-job-hz-13"
    assert name in fake_tmux.sessions

    # The restart: fresh memory, same queue dir and tmux server.
    farmd.JOB_SESSIONS.clear()
    farmd._adopt_jobs()
    assert farmd.JOB_SESSIONS == {"9131": name}

    _write_finished("HZ-13", ".")
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


def test_reboot_reaps_orphaned_job_containers_and_spares_live_ones(monkeypatch, fake_tmux):
    """HZ-416, metric 3: a farm-job-* container whose runner's tmux session
    is gone (a killed runner, a reboot) is removed at boot; one whose runner
    still runs (HZ-408: only farmd restarted) keeps running."""
    podman = os.environ["FARM_PODMAN_BIN"]
    for name in ("farm-job-hz-live", "farm-job-hz-orphan"):
        started = subprocess.run([podman, "run", "-d", "--name", name, FAKE_IMAGE, "sleep", "infinity"], capture_output=True)
        assert started.returncode == 0, started.stderr
    fake_tmux.sessions.add("farm-job-hz-live")
    try:
        farmd._adopt_jobs()
        assert container_runner.list_job_containers() == ["farm-job-hz-live"]
    finally:
        for name in ("farm-job-hz-live", "farm-job-hz-orphan"):
            container_runner.stop_and_remove(name)
    assert container_runner.list_job_containers() == []


def test_a_budget_breach_forwards_the_non_retryable_reason(monkeypatch, fake_tmux, tmp_path):
    """The farm side of metric line 2: a breach reports through the same
    failure path as an agent step, tagged so the server pauses for a human
    instead of retrying."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, repo_dir=str(tmp_path)))
    _write_finished("HZ-13", ".", status="budget_exceeded", run_id=9133)
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


def test_an_undelivered_result_keeps_the_task_file_and_the_next_poll_forwards_it_once(monkeypatch, fake_tmux, tmp_path):
    """HZ-408: the server unreachable (it restarts in a deploy) must not lose
    a finished job's report — the task file stays for the next poll, which
    forwards it once and only then releases it."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9131, repo_dir=str(tmp_path)))
    _write_finished("HZ-13", ".")
    task_file = QUEUE_DIR / "jobs" / "active" / "9131.json"
    forwarded = []
    answers = iter([None, 200, 200])

    def forward(body):
        forwarded.append(body)
        return next(answers)

    monkeypatch.setattr(farmd, "_forward_result", forward)
    try:
        farmd._poll_jobs()
        assert len(forwarded) == 1
        assert task_file.exists(), "no answer: the task file is kept"
        farmd._poll_jobs()
        assert len(forwarded) == 2
        assert not task_file.exists(), "delivered: the task file is released"
        farmd._poll_jobs()
        assert len(forwarded) == 2, "a delivered result is never forwarded again"
    finally:
        task_file.unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9131.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-13.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9131", None)


def test_a_previous_runs_state_is_never_reported_for_a_new_run(monkeypatch, fake_tmux, tmp_path):
    """Between a Resume's dispatch and its runner's first write, the item's
    state file still holds the old run's result: it is not forwarded, and the
    new run's task file stays claimed."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9132, repo_dir=str(tmp_path)))
    _write_finished("HZ-13", ".")  # run_id 9131
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", forwarded.append)
    try:
        farmd._poll_jobs()
        assert forwarded == []
        assert (QUEUE_DIR / "jobs" / "active" / "9132.json").exists()
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9132.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9132.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-13.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9132", None)


def test_host_credentials_ride_for_redaction_only(monkeypatch, fake_tmux, tmp_path):
    """GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET go in the env file's redact set,
    never its env set, unless the plan's env block names them."""
    monkeypatch.setenv("GITHUB_TOKEN", "ghtoken-sentinel-1")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "whsec-sentinel-1")
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, repo_dir=str(tmp_path)))
    env_file = QUEUE_DIR / "jobs" / "active" / "9133.env.json"
    try:
        data = json.loads(env_file.read_text())
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9133.json").unlink(missing_ok=True)
        env_file.unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9133", None)
    assert data["env"] == {}
    assert data["redact"] == {"GITHUB_TOKEN": "ghtoken-sentinel-1", "GITHUB_WEBHOOK_SECRET": "whsec-sentinel-1"}


def test_job_dispatch_reports_started_so_no_agent_timer_bounds_it(running_farm, monkeypatch, fake_tmux, tmp_path):
    """Metric 2 (queue half): dispatching a job reports it started, flipping
    the server's watchdog off the queue timer — markFarmRunStarted arms no
    execution timer for the job lane, so nothing agent-side can kill the job."""
    notified = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: notified.append(run_id) or True)
    try:
        res = running_farm.post("/steps/run", json=job_payload(9134, repo_dir=str(tmp_path)))
        assert res.status_code == 200
        assert res.json() == {"ok": True, "queued": "job", "session": "farm-job-hz-13"}
        assert notified == [9134]
        assert "farm-job-hz-13" in fake_tmux.sessions
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9134.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9134.env.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9134", None)


def test_a_stale_job_dispatch_launches_nothing(running_farm, monkeypatch, fake_tmux, tmp_path):
    """A run the server already gave up on is not launched — the same rule
    _claim_and_launch applies to agent runs."""
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: False)
    res = running_farm.post("/steps/run", json=job_payload(9135, repo_dir=str(tmp_path)))
    assert res.status_code == 200
    assert res.json() == {"ok": True, "queued": "job", "stale": True}
    assert "farm-job-hz-13" not in fake_tmux.sessions
    assert not (QUEUE_DIR / "jobs" / "active" / "9135.json").exists()


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
    # HZ-434: with the command list it is this attempt's evidence, reports
    # ahead of the log so a head-first digest keeps them.
    md = farmd.job_artifact_md(
        "1 command(s) run, 1 passed, 0 failed",
        "$ echo hi\nhi\n",
        commands=["- exit 0 — `echo hi`"],
        reports_md="## Reports\n\n### Report: r.json\n\nmissing: no such file\n",
        full_log="Full log: `x.log`",
    )
    assert md == (
        "## Commands\n1 command(s) run, 1 passed, 0 failed\n- exit 0 — `echo hi`\n\nFull log: `x.log`\n\n"
        "## Reports\n\n### Report: r.json\n\nmissing: no such file\n\n"
        "## Log (this attempt)\n$ echo hi\nhi\n\n"
    )
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


# ---- HZ-407: the live Execute card's farm side ----

loopback = TestClient(farmd.app, client=("127.0.0.1", 50000))


def _cleanup_job(run_id, item_id):
    (QUEUE_DIR / "jobs" / "active" / f"{run_id}.json").unlink(missing_ok=True)
    (QUEUE_DIR / "jobs" / "active" / f"{run_id}.env.json").unlink(missing_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").unlink(missing_ok=True)
    (LOGS_DIR / f"farm-job-{item_id.lower()}.log").unlink(missing_ok=True)
    farmd.JOB_SESSIONS.pop(str(run_id), None)


def test_a_seeded_secret_never_reaches_the_forwarded_view_or_the_log_fallback(monkeypatch, fake_tmux, tmp_path):
    """Guardrail 3: a .env value written into a command's text and printed to
    the log is absent from the view farmd forwards to the server, and from
    the log farmd still serves after Stop released the job."""
    secret = "seeded-env-secret-4071"
    run_id, item_id = 9471, "HZ-471"
    cwd = tmp_path / "repo"
    cwd.mkdir()
    (cwd / ".env").write_text(f"API_KEY={secret}\n")
    block = {"cwd": ".", "commands": [f"echo key={secret}"], "budget_minutes": 1}
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    task = {
        "run_id": run_id,
        "item": {"id": item_id, "repo": "acme/demo"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
        "repo_dir": str(cwd),
        "container_image": FAKE_IMAGE,
    }
    forwarded = []
    monkeypatch.setattr(farmd, "_in_background", lambda fn, *args: fn(*args))
    monkeypatch.setattr(farmd, "_forward_progress", lambda rid, view: forwarded.append(view))
    monkeypatch.setattr(task_job, "_notify_progress", lambda rid: None)
    try:
        farmd.launch_job(task)
        assert task_job.main(["--task", str(QUEUE_DIR / "jobs" / "active" / f"{run_id}.json")]) == 0
        res = loopback.post(f"/jobs/{run_id}/progress")
        assert res.status_code == 200
        assert len(forwarded) == 1
        view = forwarded[0]
        assert view["commands"][0]["command"] == "echo key=[redacted]"
        assert any("[redacted]" in line for line in view["logTail"])
        assert secret not in json.dumps(view)
        assert set(view["commands"][0]) == {"command", "status", "exit_code", "started_at", "ended_at"}

        # Stop released the task file: the log is still served, by item id.
        (QUEUE_DIR / "jobs" / "active" / f"{run_id}.json").unlink()
        assert loopback.get(f"/jobs/{run_id}/log").status_code == 404
        res = loopback.get(f"/jobs/{run_id}/log", params={"item_id": item_id})
        assert res.status_code == 200
        assert "[redacted]" in res.json()["content"]
        assert secret not in res.text
        assert loopback.get(f"/jobs/{run_id}/log", params={"item_id": "../../etc"}).status_code == 404
    finally:
        _cleanup_job(run_id, item_id)


def test_stop_records_the_running_command_stopped_and_returns_the_view(fake_tmux, tmp_path):
    """Metric 2 / guardrail 2: Stop never leaves the running command half
    reported — the state file and the view it returns both say `stopped`."""
    run_id, item_id = 9472, "HZ-13"
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(run_id, repo_dir=str(tmp_path), commands=("echo a", "echo b", "echo c")))
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item_id": item_id,
                "status": "running",
                "budget_s": 60,
                "commands": [
                    {"command": "echo a", "status": "done", "exit_code": 0},
                    {"command": "echo b", "status": "running", "exit_code": None},
                    {"command": "echo c", "status": "pending", "exit_code": None},
                ],
            }
        )
    )
    try:
        res = loopback.post("/jobs/stop", json={"run_id": run_id})
        assert res.status_code == 200
        body = res.json()
        assert body["commandsDone"] == 1
        assert [c["status"] for c in body["view"]["commands"]] == ["done", "stopped", "pending"]
        assert body["view"]["status"] == "stopped"
        state = json.loads((STATE_DIR / "jobs" / f"{item_id}.json").read_text())
        assert [c["status"] for c in state["commands"]] == ["done", "stopped", "pending"]
        assert "farm-job-hz-13" not in fake_tmux.sessions
    finally:
        _cleanup_job(run_id, item_id)


def test_the_final_view_rides_on_the_result_and_on_the_budget_failure(monkeypatch, fake_tmux, tmp_path):
    """Guardrail 2: the job's last view goes with its result or failure, so
    the server stores it in the same write that closes the run — a nudge that
    loses the race can't leave a command `running` on the card."""
    payloads = []

    class Res:
        status_code = 200
        text = ""

    monkeypatch.setattr(farmd.httpx, "post", lambda url, json=None, **kw: payloads.append((url, json)) or Res())
    for status, commands, path in (
        ("finished", [{"command": "echo hi", "status": "done", "exit_code": 0}], "complete"),
        ("budget_exceeded", [{"command": "echo hi", "status": "stopped", "exit_code": None}], "fail"),
    ):
        farmd.JOB_SESSIONS.clear()
        farmd.launch_job(job_payload(9131, repo_dir=str(tmp_path)))
        (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
        (STATE_DIR / "jobs" / "HZ-13.json").write_text(
            json.dumps({"run_id": 9131, "item_id": "HZ-13", "status": status, "commands": commands, "summary": {"run": 1, "passed": 1}})
        )
        try:
            farmd._poll_jobs()
        finally:
            _cleanup_job(9131, "HZ-13")
        url, body = payloads[-1]
        assert url.endswith(f"/api/farm/steps/9131/{path}")
        assert body["job_view"]["commands"][0]["status"] == commands[0]["status"]


# ---- HZ-415: the plan's cwd resolves inside the Task repo's checkout ----


@pytest.mark.parametrize("case", ["no repo_dir", "symlink out", "absolute cwd", "venv outside"])
def test_a_cwd_outside_the_repo_is_refused_with_no_session_and_no_env_file(running_farm, monkeypatch, fake_tmux, tmp_path, case):
    """Metric 2 (farmd leg): the refusal comes before any .env read, env file
    or tmux session — a 400 the server records as the run's error."""
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    if case == "no repo_dir":
        payload = job_payload(9136, repo_dir=None)
        expected = "cwd refused: this repo has no deploy target directory"
    elif case == "symlink out":
        (tmp_path / "link").symlink_to("/")
        payload = job_payload(9136, repo_dir=str(tmp_path), cwd="link")
        expected = "cwd refused: cwd resolves outside the repo directory"
    elif case == "venv outside":
        # HZ-431: the checkout's .venv resolves outside it.
        repo = tmp_path / "repo"
        repo.mkdir()
        (tmp_path / "elsewhere" / "bin").mkdir(parents=True)
        (repo / ".venv").symlink_to(tmp_path / "elsewhere")
        # HZ-416: only a host run uses (and so checks) the venv.
        payload = job_payload(9136, repo_dir=str(repo), runner="host")
        expected = "cwd refused: venv resolves outside the repo directory"
    else:
        payload = job_payload(9136, repo_dir=str(tmp_path))
        block = {"cwd": "/tmp", "commands": ["echo hi"], "budget_minutes": 1}
        payload["plan_artifact"] = "## Run plan block\n```json run-plan\n" + json.dumps(block) + "\n```\n"
        payload["approved_hash"] = task_job.plan_hash_of(payload["plan_artifact"])
        expected = "invalid run plan: run_plan 'cwd' must be relative to the repo root, not an absolute path"
    try:
        res = running_farm.post("/steps/run", json=payload)
        assert res.status_code == 400
        assert res.json() == {"error": expected}
        assert "farm-job-hz-13" not in fake_tmux.sessions
        assert not (QUEUE_DIR / "jobs" / "active" / "9136.json").exists()
        assert not (QUEUE_DIR / "jobs" / "active" / "9136.env.json").exists()
        assert list((QUEUE_DIR / "jobs" / "active").glob("9136.env.*")) == []
    finally:
        (QUEUE_DIR / "jobs" / "active" / "9136.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "9136.env.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("9136", None)


def test_a_refused_cwd_forwards_a_failure_with_its_reason(monkeypatch, fake_tmux, tmp_path):
    """R3: a runner that refused its cwd (on a Resume, say) reports a failure
    with the refusal line and a reason from the domain vocabulary."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9133, repo_dir=str(tmp_path)))
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / "HZ-13.json").write_text(
        json.dumps(
            {
                "run_id": 9133,
                "item_id": "HZ-13",
                "status": "cwd_refused",
                "refusal": "cwd resolves outside the repo directory",
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
    assert body["error"] == "Execute refused: cwd resolves outside the repo directory"
    assert body["reason"] == reasons.REASON["JOB_CWD_REFUSED"]
    assert body["job_view"]["commands"][0]["status"] == "pending"


def test_the_job_env_comes_from_the_repo_never_from_horizons_own_dotenv(monkeypatch, fake_tmux, tmp_path):
    """Guardrail 3 and the .env leak: launch_job and _job_secrets read only
    <repo_dir>/.env; a cwd that does not resolve gets host credentials only
    and no .env is read at all."""
    monkeypatch.setenv("GITHUB_TOKEN", "ghtoken-sentinel-2")
    (tmp_path / ".env").write_text("REPO_KEY=repo-dotenv-value-1\n")
    read = []
    real_read = farmd._read_dotenv
    monkeypatch.setattr(farmd, "_read_dotenv", lambda path: read.append(Path(path)) or real_read(path))
    horizon_env = task_job.HORIZON_ROOT / ".env"
    farmd.JOB_SESSIONS.clear()
    task = job_payload(9132, repo_dir=str(tmp_path))
    try:
        farmd.launch_job(task)
        data = json.loads((QUEUE_DIR / "jobs" / "active" / "9132.env.json").read_text())
        assert data["redact"]["dotenv:REPO_KEY"] == "repo-dotenv-value-1"
        assert farmd._job_secrets(task)["dotenv:REPO_KEY"] == "repo-dotenv-value-1"
    finally:
        _cleanup_job(9132, "HZ-13")
    assert read and set(read) == {tmp_path.resolve() / ".env"}
    assert horizon_env not in read

    read.clear()
    assert farmd._job_secrets(job_payload(9132, repo_dir=None)) == {"GITHUB_TOKEN": "ghtoken-sentinel-2"}
    assert farmd._job_secrets(job_payload(9132, repo_dir=str(task_job.HORIZON_ROOT))) == {"GITHUB_TOKEN": "ghtoken-sentinel-2"}
    assert read == []


# ---- HZ-434: Verify judges this attempt's log and the plan's report files ----

LOAD_SH = """if [ -f fixed ]; then
  echo "loaded 21 securities, 3551 prices, 0 errors"
else
  echo "café — ünïcode before the offset"
  echo "UNKNOWN_OPERATOR: price feed"
  exit 1
fi
"""


def _attempt(task):
    """One Execute attempt through the real runner, on farmd's own state and
    log paths, the way task_job.main runs it."""
    item_id = task["item"]["id"]
    return task_job.run_job(
        run_id=task["run_id"],
        item_id=item_id,
        plan_artifact=task["plan_artifact"],
        approved_hash=task["approved_hash"],
        state_path=STATE_DIR / "jobs" / f"{item_id}.json",
        log_path=LOGS_DIR / f"farm-job-{item_id.lower()}.log",
        repo_dir=task["repo_dir"],
        container_image=FAKE_IMAGE,
    )


def _forwarded_artifact(monkeypatch, task):
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", forwarded.append)
    farmd._poll_jobs()
    assert len(forwarded) == 1
    return forwarded[0]["artifacts"]["artifact_md"]


@pytest.fixture
def two_attempts(monkeypatch, fake_tmux, tmp_path):
    """Attempt 1 fails with UNKNOWN_OPERATOR; attempt 2 (a Resume of the same
    approved plan, its input fixed) passes. Yields the artifact farmd
    forwards after attempt 2, and the on-disk log."""
    run_id, item_id = 9434, "HZ-434"
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "load.sh").write_text(LOAD_SH)
    task = job_payload(run_id, repo_dir=str(repo), commands=("echo prepared", "sh load.sh"))
    task["item"]["id"] = item_id
    farmd.JOB_SESSIONS.clear()
    try:
        farmd.launch_job(task)
        assert _attempt(task)["failed"] == 1
        (repo / "fixed").write_text("")
        assert _attempt(task) == {"run": 2, "passed": 2, "failed": 0, "failing": []}
        artifact = _forwarded_artifact(monkeypatch, task)
        log = (LOGS_DIR / f"farm-job-{item_id.lower()}.log").read_text(encoding="utf-8")
        yield artifact, log
    finally:
        _cleanup_job(run_id, item_id)


def test_the_forwarded_artifact_holds_only_this_attempts_output(two_attempts):
    """Metric 1 (R1): attempt 2's commands and output reach Verify; none of
    attempt 1's output does. Guardrail 4: the log on disk keeps both."""
    artifact, log = two_attempts
    assert "$ sh load.sh" in artifact
    assert "loaded 21 securities, 3551 prices, 0 errors" in artifact
    assert "- exit 0 — `echo prepared` (passed in an earlier attempt)" in artifact
    assert "- exit 0 — `sh load.sh`" in artifact
    assert "UNKNOWN_OPERATOR" not in artifact
    assert "UNKNOWN_OPERATOR" in log, "the stored log stays whole on disk"
    assert "/api/items/HZ-434/job/log?format=text" in artifact


def test_the_attempt_slice_starts_at_its_own_first_line_after_multibyte_text(two_attempts):
    """R11: log_offset counts bytes, so multi-byte text before it never
    shifts the slice: it starts exactly at attempt 2's first line."""
    artifact, log = two_attempts
    assert "café — ünïcode" in log
    attempt_log = artifact.split("## Log (this attempt)\n", 1)[1]
    assert attempt_log.startswith(f"env: system\ncontainer: {FAKE_IMAGE}\n$ sh load.sh")
    assert "\ufffd" not in artifact
    assert "café" not in artifact


@pytest.mark.parametrize("size", ["under", "over"])
def test_a_report_named_by_the_plan_reaches_the_forwarded_artifact(monkeypatch, fake_tmux, tmp_path, size):
    """Metric 2 (R2): under the cap the report rides byte-for-byte; over it,
    a key/count summary with no raw slice of the file."""
    from farm import job_reports

    run_id, item_id = 9435, "HZ-435"
    repo = tmp_path / "repo"
    repo.mkdir()
    report = tmp_path / "mdi-51-run1.json"
    if size == "under":
        content = json.dumps({"securities": 21, "prices": 3551, "errors": []}, indent=2)
    else:
        content = json.dumps({"securities": 21, "prices": [{"price_id": i} for i in range(3000)], "errors": []})
        assert len(content.encode()) > job_reports.REPORT_INLINE_MAX_BYTES
    (tmp_path / "src.json").write_text(content)
    (repo / "write.sh").write_text(f'cp {tmp_path / "src.json"} "$2"\necho wrote "$2"\n')
    # HZ-434's host semantics: the report is under the host's /tmp, which a
    # container run sees as its own throwaway dir instead (fake_podman runs
    # commands on the host, so see test_container_runner.py for that case).
    task = job_payload(run_id, repo_dir=str(repo), commands=(f"sh write.sh --report {report}",), runner="host")
    task["item"]["id"] = item_id
    farmd.JOB_SESSIONS.clear()
    try:
        farmd.launch_job(task)
        assert _attempt(task)["passed"] == 1
        artifact = _forwarded_artifact(monkeypatch, task)
    finally:
        _cleanup_job(run_id, item_id)
    assert f"### Report: {report}" in artifact
    assert artifact.index("## Reports") < artifact.index("## Log (this attempt)")
    if size == "under":
        assert f"inlined, {len(content.encode()):,} bytes" in artifact
        assert content in artifact
    else:
        assert "summarised" in artifact
        assert "securities: 21\nprices: list (3000 items)\nerrors: list (0 items)" in artifact
        assert '"price_id"' not in artifact


def test_a_state_from_before_the_offset_forwards_todays_artifact(monkeypatch, fake_tmux, tmp_path):
    """R10: a runner from before HZ-434 wrote no log_offset and no reports;
    farmd forwards the whole log in today's shape, with no exception."""
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(job_payload(9131, repo_dir=str(tmp_path)))
    _write_finished("HZ-13", ".")
    (LOGS_DIR / "farm-job-hz-13.log").write_text("$ echo hi\nhi\nexit 0\n")
    try:
        artifact = _forwarded_artifact(monkeypatch, None)
    finally:
        _cleanup_job(9131, "HZ-13")
    assert artifact == "## Commands\n1 command(s) run, 1 passed, 0 failed\n\n## Log\n$ echo hi\nhi\nexit 0\n\n"
