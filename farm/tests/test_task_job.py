"""HZ-378: the Execute job runner — only the approved plan's commands, in
order, with the plan's cwd; the hash gate; the budget kill; the redacted log;
the summary.

Real subprocesses throughout (echo/sleep/exit): what is proven here is what
the shell actually did, not what a stub recorded.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import farmd, task_job, tmux_mgr
from farm.checks import redact
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

COMMANDS = ["echo one >> order.txt", "echo two >> order.txt"]


def plan_artifact(cwd, commands, budget_minutes=5, env=None):
    block = {"cwd": str(cwd), "commands": list(commands), "budget_minutes": budget_minutes}
    if env is not None:
        block["env"] = env
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def run_in(tmp_path, artifact, approved_hash=None, env_values=None):
    state_path = tmp_path / "job.json"
    log_path = tmp_path / "job.log"
    summary = task_job.run_job(
        run_id=7,
        item_id="HZ-1",
        plan_artifact=artifact,
        approved_hash=approved_hash if approved_hash is not None else task_job.plan_hash_of(artifact),
        state_path=state_path,
        log_path=log_path,
        env_values=env_values or {},
    )
    return summary, json.loads(state_path.read_text()), log_path.read_text()


def test_hash_mismatch_spawns_zero_subprocesses(tmp_path, monkeypatch):
    """R1: a plan edited after approval runs nothing — every command stays
    pending and no subprocess ever starts."""

    def _boom(*args, **kwargs):
        raise AssertionError("run_job must not spawn when the hash mismatches")

    monkeypatch.setattr(task_job.subprocess, "Popen", _boom)
    summary, state, log = run_in(tmp_path, plan_artifact(tmp_path, COMMANDS), approved_hash="0" * 64)
    assert summary == {"run": 0, "passed": 0, "failed": 0, "failing": []}
    assert state["status"] == "hash_mismatch"
    assert [c["status"] for c in state["commands"]] == ["pending", "pending"]
    assert "zero commands run" in log


def test_only_the_blocks_commands_run_in_order_with_plan_cwd(tmp_path):
    """R2: shell lines in the prose are never executed — only the block's
    commands run, in order, with cwd set to the plan's cwd."""
    cwd = tmp_path / "repo"
    cwd.mkdir()
    artifact = (
        "## Commands\nRun `touch prose-inline.txt` first.\n\n"
        "```sh\necho PROSE > prose-fence.txt\n```\n\n"
        "## Run plan block\n"
        + run_plan.render({"cwd": str(cwd), "commands": COMMANDS, "budget_minutes": 5})
        + "\n"
    )
    summary, state, _log = run_in(tmp_path, artifact)
    assert summary == {"run": 2, "passed": 2, "failed": 0, "failing": []}
    assert (cwd / "order.txt").read_text().splitlines() == ["one", "two"]
    assert not (cwd / "prose-inline.txt").exists()
    assert not (cwd / "prose-fence.txt").exists()
    assert [c["command"] for c in state["commands"]] == COMMANDS
    assert {c["cwd"] for c in state["commands"]} == {str(cwd)}


def test_the_first_failure_stops_the_job_with_exact_counts(tmp_path):
    """R16: stop-on-first-failure — later commands stay pending so Resume
    retries them, and the summary names the failing command."""
    summary, state, _log = run_in(
        tmp_path, plan_artifact(tmp_path, ["echo ran1 >> markers.txt", "exit 3", "echo ran3 >> markers.txt"])
    )
    assert summary == {"run": 2, "passed": 1, "failed": 1, "failing": ["exit 3"]}
    assert [(c["status"], c["exit_code"]) for c in state["commands"]] == [("done", 0), ("done", 3), ("pending", None)]
    assert (tmp_path / "markers.txt").read_text().splitlines() == ["ran1"]


def _proc_gone(pid):
    """True once SIGKILL has landed: reaped, or a zombie awaiting its reaper."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return True
    return stat.rsplit(")", 1)[1].split()[0] in ("X", "x", "Z")


def test_budget_breach_kills_the_whole_process_group_fast(tmp_path, monkeypatch):
    """R5: past the budget the runner kills the command's whole process group
    — children and grandchildren — and returns promptly instead of waiting
    out the sleeps. budget_minutes floors at 1, so a fake clock moves the
    breach to half a second in; the kill path is the real one."""
    pids_file = tmp_path / "pids.txt"
    command = f"echo $$ > {pids_file}; sleep 30 & echo $! >> {pids_file}; sleep 30 & echo $! >> {pids_file}; wait"

    # The first two reads are the runner's own clock (job start, then the
    # budget check before command 1); every later read is real time, so the
    # communicate() timeout below runs on a live clock however subprocess
    # looks it up.
    real_monotonic = time.monotonic
    calls = []

    def _fake_monotonic():
        calls.append(1)
        if len(calls) == 1:
            return 0.0
        if len(calls) == 2:
            return 59.5
        return real_monotonic()

    monkeypatch.setattr(time, "monotonic", _fake_monotonic)
    started = time.time()
    summary, state, _log = run_in(tmp_path, plan_artifact(tmp_path, [command], budget_minutes=1))
    elapsed = time.time() - started
    assert summary == {"run": 0, "passed": 0, "failed": 0, "failing": []}
    assert state["status"] == "budget_exceeded"
    # HZ-407: cut off mid-command is `stopped`, never `done` or `pending`.
    assert state["commands"][0]["status"] == "stopped"
    assert state["commands"][0]["exit_code"] is None
    assert elapsed < 5, f"the breach took {elapsed:.1f}s to stop 30s sleeps"

    pids = [int(line) for line in pids_file.read_text().splitlines()]
    assert len(pids) == 3
    deadline = time.time() + 5
    while time.time() < deadline and not all(_proc_gone(pid) for pid in pids):
        time.sleep(0.05)
    assert all(_proc_gone(pid) for pid in pids), pids


def test_a_reapproved_plan_reruns_commands_a_prior_run_finished(tmp_path):
    """Done entries are reused only for the same approved hash: after a
    re-approval, a command the old plan finished runs again."""
    cwd = tmp_path / "repo"
    cwd.mkdir()
    old = plan_artifact(cwd, ["echo one >> order.txt"])
    run_in(tmp_path, old)
    new = plan_artifact(cwd, ["echo one >> order.txt"], budget_minutes=6)
    summary, _state, _log = run_in(tmp_path, new)
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    assert (cwd / "order.txt").read_text().splitlines() == ["one", "one"]


def test_host_credentials_are_redacted_but_not_exported(tmp_path):
    """redact_values mask the log only: a command the plan did not hand
    GITHUB_TOKEN to cannot read it."""
    token = "host-token-value-123"
    _summary, _state, log = run_in_with_redact(
        tmp_path,
        plan_artifact(tmp_path, ["echo tok=${GITHUB_TOKEN:-unset}", f"echo {token}"]),
        redact_values={"GITHUB_TOKEN": token},
    )
    assert "tok=unset" in log
    assert token not in log
    assert "[redacted]" in log


def run_in_with_redact(tmp_path, artifact, redact_values):
    state_path = tmp_path / "job.json"
    log_path = tmp_path / "job.log"
    summary = task_job.run_job(
        run_id=7,
        item_id="HZ-1",
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        state_path=state_path,
        log_path=log_path,
        env_values={},
        redact_values=redact_values,
    )
    return summary, json.loads(state_path.read_text()), log_path.read_text()


DB_URL = "postgres://u:pw@h/db"


def test_env_values_and_token_shapes_never_reach_the_job_log(tmp_path):
    """R18 (farm leg): every env value is a secret whatever its name —
    DATABASE_URL included — and token shapes are masked wherever they appear,
    including the `$ command` echo lines the runner writes itself."""
    literal = "sk-ant-" + "y" * 12
    _summary, _state, log = run_in(
        tmp_path,
        plan_artifact(tmp_path, ["echo db=$DATABASE_URL", f"echo {literal}"]),
        env_values={"DATABASE_URL": DB_URL},
    )
    assert DB_URL not in log
    assert literal not in log
    assert log.count("[redacted]") >= 3


def test_redaction_masks_every_value_of_four_or_more_chars():
    """The floor: values under 4 chars would redact ordinary words out of
    every log line, so they are left alone."""
    assert redact("x abcd y", {"K": "abcd"}) == "x [redacted] y"
    assert redact("x abc y", {"K": "abc"}) == "x abc y"


def _job_task(tmp_path, *, run_id=421, item_id="HZ-19", commands=("echo hi",), env=None):
    cwd = tmp_path / "repo"
    cwd.mkdir(exist_ok=True)
    block = {"cwd": str(cwd), "commands": list(commands), "budget_minutes": 1}
    if env is not None:
        block["env"] = env
    artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
    return {
        "run_id": run_id,
        "item": {"id": item_id, "repo": "acme/demo"},
        "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact),
    }, cwd


def test_secrets_ride_only_in_the_0600_env_file(tmp_path, monkeypatch, fake_tmux):
    """R19: the tmux command line and the queue task file carry no secret
    values; only the 0600 env file does, and the runner unlinks it at start —
    while the log it writes stays redacted."""
    secret = "supersecret-db-password-1"
    task, cwd = _job_task(tmp_path, commands=("echo db=$DATABASE_URL",), env={"DB": "$DATABASE_URL"})
    (cwd / ".env").write_text(f"DATABASE_URL={secret}\n")
    captured = {}
    real_new_session = tmux_mgr.new_session

    def _spy(name, command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return real_new_session(name, command, **kwargs)

    monkeypatch.setattr(tmux_mgr, "new_session", _spy)
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
    try:
        assert farmd.launch_job(task) == "farm-job-hz-19"
        assert secret not in captured["command"]
        assert captured["kwargs"].get("log_file") is None
        task_file = QUEUE_DIR / "jobs" / "active" / "421.json"
        env_file = QUEUE_DIR / "jobs" / "active" / "421.env.json"
        assert secret not in task_file.read_text()
        assert secret in env_file.read_text()
        assert oct(env_file.stat().st_mode & 0o777) == "0o600"
        assert task_job.main(["--task", str(task_file)]) == 0
        assert not env_file.exists()
        log = (LOGS_DIR / "farm-job-hz-19.log").read_text()
        assert secret not in log
        assert "[redacted]" in log
    finally:
        (QUEUE_DIR / "jobs" / "active" / "421.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "421.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-19.json").unlink(missing_ok=True)
        (LOGS_DIR / "farm-job-hz-19.log").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("421", None)


def test_a_dotenv_value_the_plan_never_names_is_still_redacted(tmp_path, fake_tmux, monkeypatch):
    """Guardrail 4: every <cwd>/.env value is masked, named by the plan's env
    block or not — a command run in cwd can print .env itself."""
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
    unnamed = "unnamed-api-key-value-9"
    task, cwd = _job_task(tmp_path, run_id=423, item_id="HZ-21", commands=("cat .env", f"echo key={unnamed}"))
    (cwd / ".env").write_text(f"OTHER_API_KEY={unnamed}\n")
    try:
        farmd.launch_job(task)
        task_file = QUEUE_DIR / "jobs" / "active" / "423.json"
        assert task_job.main(["--task", str(task_file)]) == 0
        log = (LOGS_DIR / "farm-job-hz-21.log").read_text()
        assert unnamed not in log
        assert log.count("[redacted]") >= 2
    finally:
        (QUEUE_DIR / "jobs" / "active" / "423.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "423.env.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / "HZ-21.json").unlink(missing_ok=True)
        (LOGS_DIR / "farm-job-hz-21.log").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("423", None)


def test_job_sessions_never_use_pipe_pane(tmp_path, fake_tmux):
    """R20: pipe-pane would write raw pane output past redact(), so job
    sessions refuse it — and launch_job never asks for one."""
    with pytest.raises(RuntimeError, match="pipe-pane"):
        tmux_mgr.new_session("farm-job-hz-20", "true", cwd=str(tmp_path), log_file=str(tmp_path / "x.log"))
    assert "farm-job-hz-20" not in fake_tmux.sessions
    task, _cwd = _job_task(tmp_path, run_id=422, item_id="HZ-20")
    try:
        farmd.launch_job(task)
        assert [c for c in fake_tmux.calls if c[0] == "pipe-pane"] == []
    finally:
        (QUEUE_DIR / "jobs" / "active" / "422.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / "422.env.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("422", None)


# ---- HZ-407: the live Execute card's runner side ----


def _wait_for(predicate, what, limit_s=10.0):
    deadline = time.time() + limit_s
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"gave up waiting for {what}")


def _state_of(path):
    return task_job.load_state(path) or {}


def test_output_is_logged_and_nudged_while_the_command_still_runs(tmp_path):
    """Metric 1 (farm leg): a line a command prints reaches the log, and a
    nudge goes out, while that command is still running — not when it ends."""
    state_path = tmp_path / "job.json"
    log_path = tmp_path / "job.log"
    release = tmp_path / "release"
    artifact = plan_artifact(tmp_path, [f"echo first; while [ ! -f {release} ]; do sleep 0.05; done"])
    nudges = []

    def notify():
        state = _state_of(state_path)
        running = bool(state.get("commands")) and state["commands"][0]["status"] == "running"
        nudges.append((running, log_path.read_text() if log_path.exists() else ""))

    runner = threading.Thread(
        target=task_job.run_job,
        kwargs=dict(
            run_id=7,
            item_id="HZ-1",
            plan_artifact=artifact,
            approved_hash=task_job.plan_hash_of(artifact),
            state_path=state_path,
            log_path=log_path,
            notify=notify,
        ),
        daemon=True,
    )
    runner.start()
    try:
        _wait_for(lambda: log_path.exists() and "first" in log_path.read_text(), "the first line in the log")
        assert _state_of(state_path)["commands"][0]["status"] == "running"
        _wait_for(lambda: any(running and "first" in log for running, log in nudges), "a nudge carrying the line")
    finally:
        release.touch()
        runner.join(10)
    assert _state_of(state_path)["commands"][0]["status"] == "done"


def _task_file(tmp_path, run_id, item_id, artifact):
    path = tmp_path / f"{run_id}.task.json"
    path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item": {"id": item_id},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
            }
        )
    )
    return path


def test_stop_during_command_two_then_resume_runs_each_command_once(tmp_path, monkeypatch):
    """Metric 2: a real runner is stopped during command 2 (its process dies
    as tmux kill-session kills it, then farmd's Stop marks the state). Command
    2 shows `stopped`, not `done`. Resume runs 2 and 3 and never re-runs 1:
    each command completes exactly once and all three end `done`."""
    from farm import farmd

    cwd = tmp_path / "repo"
    cwd.mkdir()
    release = tmp_path / "release"
    commands = [
        "echo one >> runs.txt",
        f"while [ ! -f {release} ]; do sleep 0.05; done; echo two >> runs.txt",
        "echo three >> runs.txt",
    ]
    artifact = plan_artifact(cwd, commands)
    run_id, item_id = 9407, "HZ-9407"
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    task = _task_file(tmp_path, run_id, item_id, artifact)
    repo_root = Path(__file__).resolve().parents[2]
    # FARM_PORT 9 (discard): the runner's nudges never reach a real farmd.
    env = {**os.environ, "FARM_PORT": "9", "PYTHONPATH": str(repo_root)}
    runner = subprocess.Popen([sys.executable, "-m", "farm.task_job", "--task", str(task)], cwd=str(repo_root), env=env)
    try:
        _wait_for(
            lambda: [c["status"] for c in _state_of(state_path).get("commands", [])] == ["done", "running", "pending"]
            and "pgid" in _state_of(state_path)["commands"][1],
            "command 2 running",
        )
        pgid = _state_of(state_path)["commands"][1]["pgid"]
        os.kill(runner.pid, signal.SIGKILL)  # what tmux kill-session does to the runner
        runner.wait(5)
        farmd._mark_job_stopped(run_id, item_id)

        stopped = _state_of(state_path)
        assert [c["status"] for c in stopped["commands"]] == ["done", "stopped", "pending"]
        assert stopped["commands"][1]["exit_code"] is None
        assert "pgid" not in stopped["commands"][1]
        assert stopped["status"] == "stopped"
        assert "stopped by the owner" in log_path.read_text()
        _wait_for(lambda: _pgid_gone(pgid), "command 2's process group to die")

        # Resume: the same approved plan, run again by a fresh runner.
        release.touch()
        monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
        assert task_job.main(["--task", str(task)]) == 0
        final = _state_of(state_path)
        assert [c["status"] for c in final["commands"]] == ["done", "done", "done"]
        assert [c["exit_code"] for c in final["commands"]] == [0, 0, 0]
        time.sleep(0.3)  # an orphaned command 2 would have written by now
        assert (cwd / "runs.txt").read_text().splitlines() == ["one", "two", "three"]
    finally:
        if runner.poll() is None:
            runner.kill()
        release.touch()
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)


def _pgid_gone(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    # Only zombies left (awaiting their reaper) counts as gone.
    return all(_proc_gone(int(p)) for p in _pids_in_group(pgid))


def _pids_in_group(pgid):
    pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        if int(stat.rsplit(")", 1)[1].split()[2]) == pgid:
            pids.append(entry.name)
    return pids


def test_past_the_budget_the_running_command_stops_and_no_later_one_starts(tmp_path, monkeypatch):
    """Metric 3: a fake clock jumps past the budget while command 2 runs. The
    job stops: command 2 is `stopped`, command 3 stays pending and never runs
    (its marker file is never written), and the job is budget_exceeded."""
    cwd = tmp_path / "repo"
    cwd.mkdir()
    commands = ["echo one >> c1.txt", "sleep 30", "echo three >> c3.txt"]
    artifact = plan_artifact(cwd, commands, budget_minutes=1)
    state_path = tmp_path / "job.json"
    real_monotonic = time.monotonic
    jump = {"s": 0.0}
    monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() + jump["s"])

    def advance_once_command_two_runs():
        _wait_for(
            lambda: [c["status"] for c in _state_of(state_path).get("commands", [])][1:2] == ["running"]
            and "pgid" in _state_of(state_path)["commands"][1],
            "command 2 running",
        )
        time.sleep(0.3)  # its deadline is set right after the pgid is saved
        jump["s"] = 61.0

    clock = threading.Thread(target=advance_once_command_two_runs, daemon=True)
    clock.start()
    started = time.time()
    summary = task_job.run_job(
        run_id=8,
        item_id="HZ-2",
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        state_path=state_path,
        log_path=tmp_path / "job.log",
    )
    clock.join(5)
    assert time.time() - started < 10
    state = _state_of(state_path)
    assert state["status"] == "budget_exceeded"
    assert [c["status"] for c in state["commands"]] == ["done", "stopped", "pending"]
    assert state["commands"][2]["started_at"] is None
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    assert (cwd / "c1.txt").exists()
    assert not (cwd / "c3.txt").exists()
