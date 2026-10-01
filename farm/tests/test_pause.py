"""HZ-194: pausing an item saves its running implement attempt as a WIP
checkpoint before the session is killed.

Three layers, each tested at its own seam and then across the process
boundary: step_agent's pause handling in-process (fake run_agent raising
PauseRequested), a real step_agent child process getting a real SIGTERM, and
farmd's /steps/cancel driving that child the way production does."""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import check_metrics, check_slots, checks, farmd, pause, step_agent, tmux_mgr
from farm import config as farm_config
from farm.config import QUEUE_DIR
from farm.tests.test_step_agent import (
    capture_run_agent,
    finished_run,
    git,
    make_checkpoint,
    make_git_workspace,
    make_task,
    origin_body,
    origin_log,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
IMPLEMENT = step_agent.IMPLEMENT_LABEL
client = TestClient(farmd.app)


def origin_sha(origin, ref="horizon/t-1"):
    res = subprocess.run(["git", "--git-dir", str(origin), "rev-parse", "--verify", "-q", ref], capture_output=True, text=True)
    return res.stdout.strip()


def origin_files(origin, ref="horizon/t-1"):
    return subprocess.run(
        ["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", ref], capture_output=True, text=True, check=True
    ).stdout.split()


def paused_run(ws, files=None):
    """A run_agent that edits files, then is paused mid-run."""

    def _fake(prompt, **kwargs):
        for name, text in (files if files is not None else {"paused_work.txt": "half done\n"}).items():
            (ws / name).parent.mkdir(parents=True, exist_ok=True)
            (ws / name).write_text(text)
        raise pause.PauseRequested()

    return _fake


@pytest.fixture
def ws_origin(tmp_path, monkeypatch, pause_state):
    """A workspace + local origin, the pause outcome redirected into
    tmp_path, and kill_descendants stubbed — in-process, the descendants
    would be pytest's own children."""
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    pause_state["outcome_path"] = tmp_path / "1.paused"
    monkeypatch.setattr(pause, "kill_descendants", lambda sig=signal.SIGKILL: 0)
    return ws, origin, tmp_path / "1.paused"


def forbid_pr_paths(monkeypatch):
    """Guardrail: a checkpoint never finalizes, publishes or opens a PR."""

    def boom(*a, **k):
        raise AssertionError("a pause checkpoint reached the finalize/PR path")

    monkeypatch.setattr(step_agent, "finalize_branch", boom)
    monkeypatch.setattr(step_agent, "publish_screenshots", boom)


# ---- step_agent, in-process ----


def test_pause_mid_implement_pushes_a_checkpoint_and_the_next_attempt_resumes_on_it(ws_origin, monkeypatch):
    ws, origin, outcome_path = ws_origin
    monkeypatch.setattr(step_agent, "run_agent", paused_run(ws))
    forbid_pr_paths(monkeypatch)
    monkeypatch.setattr(step_agent, "run_checks", lambda *a, **k: pytest.fail("checks ran after a pause"))

    with pytest.raises(pause.PauseRequested):
        execute_implement()

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    assert origin_log(origin).splitlines()[0] == f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"
    assert origin_body(origin).startswith("cause: paused")
    checkpoint = origin_sha(origin)

    # Attempt 2 starts on that checkpoint, with the paused resume note.
    monkeypatch.undo()
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    seen = {}

    def attempt_2(prompt, **kwargs):
        seen["head"] = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        seen["file"] = (ws / "paused_work.txt").read_text()
        return capture_run_agent(seen)(prompt, **kwargs)

    monkeypatch.setattr(step_agent, "run_agent", attempt_2)
    execute_implement()
    assert seen["head"] == checkpoint
    assert seen["file"] == "half done\n"
    assert "an operator paused the previous attempt mid-run" in seen["prompt"]
    assert "paused_work.txt" in seen["prompt"]


def execute_implement(scope=None):
    task = make_task(11, IMPLEMENT, repo="acme/demo")
    if scope:
        task["scope"] = scope
    return step_agent.execute(task)


def test_pause_with_a_clean_tree_makes_no_checkpoint(ws_origin, monkeypatch):
    ws, origin, outcome_path = ws_origin
    git(ws, "push", "origin", "HEAD:horizon/t-1")
    before = origin_sha(origin)
    monkeypatch.setattr(step_agent, "run_agent", paused_run(ws, files={}))

    with pytest.raises(pause.PauseRequested):
        execute_implement()

    assert pause.read_outcome(outcome_path)["outcome"] == "nothing"
    assert origin_sha(origin) == before


def test_pause_during_checks_checkpoints_the_code_and_is_not_a_check_failure(tmp_path, ws_origin, monkeypatch):
    """Through main(): no result is posted, the checkpoint's cause is
    `paused` (never checks-failed), and the real run_checks records the run
    as paused in the metrics."""
    ws, origin, _ = ws_origin
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farmhome"))
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    # Inside the farm's own check run this is set, and append_record skips.
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws, text="finished, unchecked\n"))

    def paused_mid_check(*a, **k):
        raise pause.PauseRequested()

    monkeypatch.setattr(checks, "_run_bounded", paused_mid_check)
    forbid_pr_paths(monkeypatch)
    task_file, posted = main_harness(tmp_path, monkeypatch)

    assert step_agent.main() == 0

    assert posted == []
    assert pause.read_outcome(task_file.with_suffix(".paused"))["outcome"] == "saved"
    body = origin_body(origin)
    assert body.startswith("cause: paused") and "checks-failed" not in body
    records, _ = check_metrics.read_records(check_metrics.metrics_path())
    assert records[-1]["outcome"] == "paused"


def main_harness(tmp_path, monkeypatch, task=None):
    active = tmp_path / "active"
    active.mkdir(exist_ok=True)
    task_file = active / "1.json"
    task_file.write_text(json.dumps(task or make_task(11, IMPLEMENT, repo="acme/demo")))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = []
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.append(json))
    return task_file, posted


def test_pause_whose_push_loses_the_lease_reports_failed_and_never_forces(tmp_path, ws_origin, monkeypatch):
    """The remote moved after this attempt fetched: the lease-protected push
    is rejected, the outcome is `failed`, main() still exits 0, and the
    remote is byte-identical to what the other writer pushed."""
    ws, origin, _ = ws_origin
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    race = tmp_path / "race"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(race)], check=True, capture_output=True)
    git(race, "config", "user.email", "race@example.com")
    git(race, "config", "user.name", "Racer")

    def _fake(prompt, **kwargs):
        (ws / "paused_work.txt").write_text("half done\n")
        git(race, "checkout", "horizon/t-1")
        (race / "race.txt").write_text("someone else's push\n")
        git(race, "add", "-A")
        git(race, "commit", "-m", "concurrent push")
        git(race, "push", "origin", "horizon/t-1")
        raise pause.PauseRequested()

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    task_file, posted = main_harness(tmp_path, monkeypatch)

    assert step_agent.main() == 0

    racer = subprocess.run(["git", "-C", str(race), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert origin_sha(origin) == racer
    outcome = pause.read_outcome(task_file.with_suffix(".paused"))
    assert outcome["outcome"] == "failed" and outcome["detail"]
    assert posted == []


def test_pause_in_fix_mode_skips_the_checkpoint_because_a_pr_is_open(ws_origin, monkeypatch):
    ws, origin, outcome_path = ws_origin
    git(ws, "push", "origin", "HEAD:horizon/t-1")
    before = origin_sha(origin)
    monkeypatch.setattr(step_agent, "run_agent", paused_run(ws))

    with pytest.raises(pause.PauseRequested):
        execute_implement(scope={"mode": "fix", "base_sha": before, "findings": []})

    outcome = pause.read_outcome(outcome_path)
    assert outcome["outcome"] == "skipped"
    assert "PR is open" in outcome["detail"]
    assert origin_sha(origin) == before


def test_a_pause_checkpoint_never_commits_secrets_or_ignored_files(ws_origin, monkeypatch):
    ws, origin, outcome_path = ws_origin
    files = {
        ".gitignore": "ignored.txt\n",
        "ignored.txt": "local only\n",
        "config/.env": "API_TOKEN=abc\n",
        "deploy/id_rsa": "-----BEGIN KEY-----\n",
        "certs/server.pem": "pem\n",
        "config/.env.example": "API_TOKEN=\n",
        "src/app.py": "print('work')\n",
    }
    monkeypatch.setattr(step_agent, "run_agent", paused_run(ws, files=files))

    with pytest.raises(pause.PauseRequested):
        execute_implement()

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    committed = origin_files(origin)
    assert "src/app.py" in committed and ".gitignore" in committed and "config/.env.example" in committed
    for secret in ("ignored.txt", "config/.env", "deploy/id_rsa", "certs/server.pem"):
        assert secret not in committed


@pytest.mark.parametrize(
    "cause, expected",
    [
        ("exhausted", "ran out of turns/time"),
        ("checks-failed", "the repo's checks failed on it"),
        (None, "ran out of turns/time"),  # pre-HZ-184: no body at all
        ("paused", "an operator paused the previous attempt mid-run"),
    ],
)
def test_resume_note_still_reads_every_checkpoint_cause(tmp_path, cause, expected):
    ws, origin = make_git_workspace(tmp_path)
    make_checkpoint(ws, origin, cause=cause)
    step_agent.prepare_branch(ws, {"id": "T-1", "repo": "acme/demo"})
    note = step_agent._checkpoint_resume_note(ws)
    assert expected in note and "wip.txt" in note


def test_salvage_returns_what_it_did(ws_origin):
    ws, origin, _ = ws_origin
    item = {"id": "T-1", "title": "t", "repo": "acme/demo"}
    git(ws, "checkout", "-B", "horizon/t-1")
    assert step_agent._salvage_checkpoint(ws, item, "horizon/t-1", cause=step_agent.CAUSE_PAUSED) == "nothing"
    (ws / "a.txt").write_text("a\n")
    assert step_agent._salvage_checkpoint(ws, item, "horizon/t-1", cause=step_agent.CAUSE_PAUSED) == "saved"
    (ws / "b.txt").write_text("b\n")
    stale = step_agent._salvage_checkpoint(ws, item, "horizon/t-1", cause=step_agent.CAUSE_PAUSED)
    assert stale.startswith("failed: ")  # the remote branch exists now; an empty lease is stale


def test_a_failed_pause_never_reports_the_remotes_token(ws_origin, monkeypatch):
    ws, _, outcome_path = ws_origin
    token = "ghs_" + "a1B2" * 9
    monkeypatch.setattr(
        step_agent,
        "_salvage_checkpoint",
        lambda *a, **k: f"failed: git push failed: error: failed to push some refs to 'https://x-access-token:{token}@github.com/acme/demo'",
    )
    monkeypatch.setattr(step_agent, "run_agent", paused_run(ws))

    with pytest.raises(pause.PauseRequested):
        execute_implement()

    outcome = pause.read_outcome(outcome_path)
    assert outcome["outcome"] == "failed"
    assert token not in outcome["detail"] and "x-access-token" not in outcome["detail"]
    assert "failed to push some refs" in outcome["detail"]


# ---- the SIGTERM handler ----


def test_an_idle_pause_reports_nothing_at_once_and_an_armed_one_raises_exactly_once(tmp_path):
    outcome_path = tmp_path / "5.paused"
    pause.install_sigterm_handler(outcome_path)
    os.kill(os.getpid(), signal.SIGTERM)  # idle: nothing of this attempt's to save
    assert pause.read_outcome(outcome_path)["outcome"] == "nothing"

    outcome_path.unlink()
    pause.install_sigterm_handler(outcome_path)
    with pytest.raises(pause.PauseRequested) as exc:
        with pause.interruptible():
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(5)
    assert exc.value.at_entry is False
    os.kill(os.getpid(), signal.SIGTERM)  # a second signal never interrupts the salvage
    assert not outcome_path.exists()
    with pytest.raises(pause.PauseRequested) as exc:
        with pause.interruptible():
            pytest.fail("entered an interruptible region after a pause")
    assert exc.value.at_entry is True


# ---- a real step_agent process ----

CHILD = r"""
import json, os, subprocess, sys, time
from pathlib import Path
cfg = json.loads(sys.argv[1])
from farm import step_agent

ws = Path(cfg["ws"])
step_agent.ensure_item_worktree = lambda repo, item_id: ws

def post(url, json=None, timeout=None):
    Path(cfg["posted"]).write_text(__import__("json").dumps(json))

step_agent.httpx.post = post

def run_agent(prompt, **kwargs):
    if cfg["step"] == "implement":
        (ws / "paused_work.txt").write_text("half done\n")
    if cfg["block"] == "agent":
        subprocess.Popen(["sleep", "60"])
        Path(cfg["ready"]).write_text("1")
        time.sleep(60)
    return {"result": '{"summary": "built it", "artifact_md": "# out"}'}

step_agent.run_agent = run_agent
sys.argv = ["step_agent", "--task", cfg["task"]]
sys.exit(step_agent.main())
"""


def _alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


def _wait_for(predicate, timeout=30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def _sleep_descendants(pid):
    found = []
    for child in pause.descendants(pid):
        try:
            if Path(f"/proc/{child}/comm").read_text().strip() == "sleep":
                found.append(child)
        except OSError:
            pass
    return found


class ChildAgent:
    """A real `step_agent.main()` in its own process: real pid file, real
    SIGTERM handler, real git. Never outlives the test."""

    def __init__(self, tmp_path, ws, *, run_id, step="implement", block="agent", env=None, task_dir=None):
        task_dir = task_dir or tmp_path / "active"
        task_dir.mkdir(parents=True, exist_ok=True)
        self.task = task_dir / f"{run_id}.json"
        label = IMPLEMENT if step == "implement" else "Plan options & trade-offs (pros / cons)"
        task = make_task(11 if step == "implement" else 4, label, repo="acme/demo")
        task["run_id"] = run_id
        self.task.write_text(json.dumps(task))
        self.posted = tmp_path / f"posted-{run_id}.json"
        self.ready = tmp_path / f"ready-{run_id}"
        cfg = {"ws": str(ws), "task": str(self.task), "posted": str(self.posted), "ready": str(self.ready), "step": step, "block": block}
        # FARM_IN_CHECKS is dropped: under the farm's own check run it would
        # make the child skip its check-metrics record.
        base_env = {k: v for k, v in os.environ.items() if k != check_slots.IN_CHECKS_ENV}
        child_env = {**base_env, "FARM_HOME": str(tmp_path / "farmhome"), "PYTHONPATH": str(REPO_ROOT), **(env or {})}
        self.proc = subprocess.Popen([sys.executable, "-c", CHILD, json.dumps(cfg)], cwd=str(REPO_ROOT), env=child_env)
        self.seen: set[int] = set()

    @property
    def pid_file(self):
        return self.task.with_suffix(".pid")

    @property
    def outcome(self):
        return pause.read_outcome(self.task.with_suffix(".paused"))

    def wait_until(self, predicate, what):
        assert _wait_for(lambda: predicate() or self.proc.poll() is not None), what
        assert self.proc.poll() is None, f"the child exited early ({self.proc.returncode}) waiting for {what}"
        self.seen.update(pause.descendants(self.proc.pid))

    def close(self):
        if self.proc.poll() is None:
            for pid in pause.descendants(self.proc.pid):
                with __import__("contextlib").suppress(OSError):
                    os.kill(pid, signal.SIGKILL)
            self.proc.kill()
        self.proc.wait(timeout=10)
        for pid in self.seen:
            if _alive(pid):
                with __import__("contextlib").suppress(OSError):
                    os.kill(pid, signal.SIGKILL)


@pytest.fixture
def child_agents():
    made = []
    yield made
    for child in made:
        child.close()


linux_only = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="walks /proc for descendants")


@linux_only
def test_a_real_sigterm_mid_agent_saves_a_checkpoint_and_exits_cleanly(tmp_path, child_agents):
    ws, origin = make_git_workspace(tmp_path)
    child = ChildAgent(tmp_path, ws, run_id=7)
    child_agents.append(child)
    child.wait_until(lambda: child.ready.exists() and child.pid_file.exists(), "the agent to start")

    os.kill(int(child.pid_file.read_text()), signal.SIGTERM)
    assert child.proc.wait(timeout=60) == 0

    assert child.outcome["outcome"] == "saved"
    assert not child.posted.exists(), "a paused run must not report a result"
    assert origin_log(origin).splitlines()[0] == f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"
    assert origin_body(origin).startswith("cause: paused")
    assert "paused_work.txt" in origin_files(origin)
    assert _wait_for(lambda: not any(_alive(pid) for pid in child.seen), 5), "the agent's children outlived the pause"


@linux_only
def test_a_real_sigterm_mid_checks_stops_every_check_process_and_is_not_a_failure(tmp_path, child_agents):
    ws, origin = make_git_workspace(tmp_path)
    child = ChildAgent(tmp_path, ws, run_id=8, block="checks", env={"FARM_CHECK_CMD": "sleep 60 & sleep 60; exit 1"})
    child_agents.append(child)
    child.wait_until(lambda: len(_sleep_descendants(child.proc.pid)) >= 2, "both check processes to start")
    grandchildren = _sleep_descendants(child.proc.pid)

    os.kill(int(child.pid_file.read_text()), signal.SIGTERM)
    assert child.proc.wait(timeout=60) == 0

    assert _wait_for(lambda: not any(_alive(pid) for pid in grandchildren), 5), "a check process outlived the pause"
    assert child.outcome["outcome"] == "saved"
    assert not child.posted.exists()
    body = origin_body(origin)
    assert body.startswith("cause: paused") and "checks-failed" not in body
    records, _ = check_metrics.read_records(tmp_path / "farmhome" / "logs" / "check-metrics.jsonl")
    assert records[-1]["outcome"] == "paused"


# ---- farmd's /steps/cancel ----


def _active(run_id, item_id="t-1", step_index=11):
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    task = {"run_id": run_id, "attempt": 1, "item": {"id": item_id}, "step": {"index": step_index, "label": "x"}}
    (active / f"{run_id}.json").write_text(json.dumps(task))
    return active, farmd._run_session_name(task)


@pytest.fixture
def cleanup_queue():
    run_ids = []
    yield run_ids
    for run_id in run_ids:
        for sub in ("pm", "runs", "runs/active"):
            for name in (f"{run_id}.json", f"{run_id}.pid", f"{run_id}.paused"):
                (QUEUE_DIR / sub / name).unlink(missing_ok=True)
        farmd.RUN_SESSIONS.pop(str(run_id), None)


HELPER = r"""
import json, os, signal, sys, time
outcome_path, outcome, delay, ignore = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4] == "1"
def on_term(*_):
    time.sleep(delay)
    tmp = outcome_path + ".tmp"
    open(tmp, "w").write(json.dumps({"outcome": outcome, "detail": "from the helper"}))
    os.replace(tmp, outcome_path)
signal.signal(signal.SIGTERM, signal.SIG_IGN if ignore else on_term)
print("ready", flush=True)
time.sleep(60)
"""


@pytest.fixture
def helper_agent():
    """A stand-in step agent: on SIGTERM it waits `delay`, then writes the
    given outcome (or, with ignore, never answers)."""
    procs = []

    def spawn(run_id, outcome="saved", delay=0.0, ignore=False):
        active = QUEUE_DIR / "runs" / "active"
        proc = subprocess.Popen(
            [sys.executable, "-c", HELPER, str(active / f"{run_id}.paused"), outcome, str(delay), "1" if ignore else "0"],
            stdout=subprocess.PIPE,
            text=True,
        )
        assert proc.stdout.readline().strip() == "ready"
        (active / f"{run_id}.pid").write_text(str(proc.pid))
        procs.append(proc)
        return proc

    yield spawn
    for proc in procs:
        proc.kill()
        proc.wait(timeout=10)


def test_farmd_kills_the_session_only_after_the_checkpoint_outcome_appears(fake_tmux, helper_agent, cleanup_queue, monkeypatch):
    cleanup_queue.append(9401)
    active, name = _active(9401)
    fake_tmux.sessions.add(name)
    helper_agent(9401, outcome="saved", delay=0.5)
    order = []
    real_kill = tmux_mgr.kill_session

    def recording_kill(session):
        order.append(("kill_session", (active / "9401.paused").exists()))
        return real_kill(session)

    monkeypatch.setattr(tmux_mgr, "kill_session", recording_kill)

    res = client.post("/steps/cancel", json={"run_id": 9401, "reason": "pause", "checkpoint_timeout_s": 10})

    assert res.status_code == 200
    body = res.json()
    assert body["checkpoint"] == {"outcome": "saved", "detail": "from the helper"}
    assert body["killed"] == name and body["removed"] is True
    assert order == [("kill_session", True)], "the session was killed before the checkpoint finished"
    assert not any((active / f"9401.{ext}").exists() for ext in ("json", "pid", "paused"))


@pytest.mark.parametrize("outcome", ["nothing", "failed"])
def test_farmd_relays_each_checkpoint_outcome_and_still_kills(fake_tmux, helper_agent, cleanup_queue, outcome):
    cleanup_queue.append(9402)
    _, name = _active(9402)
    fake_tmux.sessions.add(name)
    helper_agent(9402, outcome=outcome)

    res = client.post("/steps/cancel", json={"run_id": 9402, "reason": "pause"})

    assert res.status_code == 200 and res.json()["ok"] is True
    checkpoint = res.json()["checkpoint"]
    assert checkpoint["outcome"] == outcome and isinstance(checkpoint["detail"], str)
    assert name not in fake_tmux.sessions


@pytest.mark.parametrize("lane", ["runs", "pm"])
def test_pausing_a_queued_run_drops_it_without_a_signal(cleanup_queue, monkeypatch, lane):
    cleanup_queue.append(9403)
    (QUEUE_DIR / lane).mkdir(parents=True, exist_ok=True)
    task_path = QUEUE_DIR / lane / "9403.json"
    task_path.write_text(json.dumps({"run_id": 9403, "item": {"id": "t-1"}, "step": {"index": 11}}))
    signals = []
    monkeypatch.setattr(farmd.os, "kill", lambda *a: signals.append(a))
    started = time.monotonic()

    res = client.post("/steps/cancel", json={"run_id": 9403, "reason": "pause"})

    assert time.monotonic() - started < 1
    assert res.status_code == 200
    assert res.json()["removed"] is True
    assert res.json()["checkpoint"]["outcome"] == "not_running"
    assert signals == []
    assert not task_path.exists()


def test_a_pause_whose_agent_never_answers_times_out_and_still_kills(fake_tmux, helper_agent, cleanup_queue):
    cleanup_queue.append(9404)
    _, name = _active(9404)
    fake_tmux.sessions.add(name)
    helper_agent(9404, ignore=True)
    started = time.monotonic()

    res = client.post("/steps/cancel", json={"run_id": 9404, "reason": "pause", "checkpoint_timeout_s": 1})

    assert time.monotonic() - started < 3
    assert res.json()["checkpoint"]["outcome"] == "timed_out"
    assert name not in fake_tmux.sessions


def test_a_pause_with_no_pid_file_fails_at_once_and_kills(fake_tmux, cleanup_queue):
    cleanup_queue.append(9405)
    _, name = _active(9405)
    fake_tmux.sessions.add(name)
    started = time.monotonic()

    res = client.post("/steps/cancel", json={"run_id": 9405, "reason": "pause", "checkpoint_timeout_s": 30})

    assert time.monotonic() - started < 1
    assert res.json()["checkpoint"]["outcome"] == "failed"
    assert name not in fake_tmux.sessions


@pytest.mark.parametrize("body", [{}, {"reason": "reject"}, {"reason": "superseded"}])
def test_a_cancel_that_is_not_a_pause_is_unchanged(fake_tmux, cleanup_queue, monkeypatch, body):
    """HZ-185 relies on reject killing at once: no signal, no wait, no
    `checkpoint` key."""
    cleanup_queue.append(9406)
    active, name = _active(9406)
    fake_tmux.sessions.add(name)
    (active / "9406.pid").write_text(str(os.getpid()))
    signals = []
    monkeypatch.setattr(farmd.os, "kill", lambda *a: signals.append(a))

    res = client.post("/steps/cancel", json={"run_id": 9406, **body})

    assert res.json() == {"ok": True, "removed": True, "killed": name}
    assert signals == []


@pytest.mark.parametrize(
    "raw, expected",
    [(None, 30), ("abc", 30), (0, 30), (-5, 30), (True, 30), (9999, 300), (7, 7), ("12", 12), (0.5, 1)],
)
def test_the_pause_bound_is_clamped_and_a_bad_value_is_never_refused(fake_tmux, cleanup_queue, monkeypatch, raw, expected):
    monkeypatch.setattr(farm_config, "PAUSE_CHECKPOINT_TIMEOUT_S", 30)
    cleanup_queue.append(9407)
    _, name = _active(9407)
    fake_tmux.sessions.add(name)
    seen = []

    async def fake_pause(run_id, session, timeout_s):
        seen.append(timeout_s)
        return {"outcome": "nothing", "detail": ""}

    monkeypatch.setattr(farmd, "_pause_in_flight", fake_pause)
    body = {"run_id": 9407, "reason": "pause"}
    if raw is not None:
        body["checkpoint_timeout_s"] = raw

    res = client.post("/steps/cancel", json=body)

    assert res.status_code == 200
    assert seen == [expected]


def test_the_pause_bound_defaults_to_30_seconds():
    env = {k: v for k, v in os.environ.items() if k != "HZ_PAUSE_CHECKPOINT_TIMEOUT_S"}
    out = subprocess.run(
        [sys.executable, "-c", "from farm import config; print(config.PAUSE_CHECKPOINT_TIMEOUT_S)"],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert out == "30"


@linux_only
def test_farmd_pausing_a_real_implement_agent_saves_before_the_kill(tmp_path, fake_tmux, cleanup_queue, child_agents, monkeypatch):
    """The whole farm side across the process boundary: /steps/cancel →
    SIGTERM → the real step agent's checkpoint push → outcome → kill."""
    cleanup_queue.append(9408)
    ws, origin = make_git_workspace(tmp_path)
    _, name = _active(9408)
    fake_tmux.sessions.add(name)
    child = ChildAgent(tmp_path, ws, run_id=9408, task_dir=QUEUE_DIR / "runs" / "active")
    child_agents.append(child)
    child.wait_until(lambda: child.ready.exists() and child.pid_file.exists(), "the agent to start")
    pushed_at_kill = []
    real_kill = tmux_mgr.kill_session
    monkeypatch.setattr(tmux_mgr, "kill_session", lambda s: (pushed_at_kill.append(origin_sha(origin)), real_kill(s)))

    res = client.post("/steps/cancel", json={"run_id": 9408, "reason": "pause", "checkpoint_timeout_s": 60})

    assert res.json()["checkpoint"]["outcome"] == "saved"
    assert child.proc.wait(timeout=30) == 0
    assert pushed_at_kill and pushed_at_kill[0] == origin_sha(origin) != ""
    assert origin_body(origin).startswith("cause: paused")


@linux_only
def test_farmd_pausing_a_non_implement_step_returns_promptly_with_nothing(tmp_path, fake_tmux, cleanup_queue, child_agents):
    cleanup_queue.append(9409)
    ws, _ = make_git_workspace(tmp_path)
    _, name = _active(9409, step_index=4)
    fake_tmux.sessions.add(name)
    child = ChildAgent(tmp_path, ws, run_id=9409, step="plan", task_dir=QUEUE_DIR / "runs" / "active")
    child_agents.append(child)
    child.wait_until(lambda: child.ready.exists() and child.pid_file.exists(), "the agent to start")
    started = time.monotonic()

    res = client.post("/steps/cancel", json={"run_id": 9409, "reason": "pause", "checkpoint_timeout_s": 30})

    assert time.monotonic() - started < 3
    assert res.json()["checkpoint"]["outcome"] == "nothing"
    assert name not in fake_tmux.sessions


# ---- the control files never read as task files ----


def test_pid_and_outcome_files_are_ignored_by_every_task_glob_and_removed_by_teardown(tmp_path, cleanup_queue, monkeypatch):
    cleanup_queue.append(9410)
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / "9410.pid").write_text("123")
    pause.write_outcome(active / "9410.paused", "saved", "x")
    (active / "9410.paused.tmp").write_text("{")

    reconciled = []
    monkeypatch.setattr(farmd, "_reconcile_one_claimed_run", lambda p: reconciled.append(p.name))
    farmd._reconcile_claimed_runs()
    assert not any(n.startswith("9410.") for n in reconciled)
    assert farmd._session_for_run("9410") is None

    state_file = tmp_path / "farmd-state.json"
    state_file.write_text(json.dumps({"project": {"id": 1, "name": "P"}, "repos": []}))
    monkeypatch.setattr(farmd, "STATE_FILE", state_file)
    monkeypatch.setattr(farmd, "state", dict(farmd.state))
    monkeypatch.setattr(farmd, "RUN_SESSIONS", {})
    farmd._adopt_existing()
    assert "9410" not in farmd.RUN_SESSIONS

    farmd._teardown()
    assert not any(active.glob("9410.*"))
