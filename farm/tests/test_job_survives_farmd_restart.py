"""HZ-408: an Execute job outlives its farmd. Each test runs a real farmd
subprocess against real tmux (a private socket, never the host's server), in
its own FARM_HOME, reporting to a stub server that records every POST. The
restart is SIGKILL to farmd's pid alone — what systemd's KillMode=process
does — and a fresh farmd on the same FARM_HOME.

Metric line 3: the job keeps running and the server gets exactly one final
report, including when the job ends while farmd is down. Metric line 4: Stop
still ends the job after a restart, and a job past its budget is still ended
with the budget reason. Guardrail 2: a restart never starts a second copy."""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from domain.py import reasons, run_plan, steps
from farm import task_job, tmux_mgr

pytestmark = pytest.mark.real_tmux

REPO_ROOT = Path(__file__).resolve().parents[2]
EXECUTE_INDEX = steps.by_kind_label("task", "Execute")["index"]
PROJECT = {"id": 1, "name": "FinTekkers"}
ITEM_ID = "HZ-408"
SESSION = f"{tmux_mgr.JOB_SESSION_PREFIX}{ITEM_ID.lower()}"


class StubServer:
    """The Horizon server farmd reports to: answers every POST 200 (a run
    that is still active) and records (path, body)."""

    def __init__(self):
        self.posts: list[tuple[str, dict]] = []
        posts = self.posts

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    body = {}
                posts.append((self.path, body))
                out = json.dumps({"ok": True, "active": True}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def do_GET(self):
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def reports(self, run_id, kind):
        return [body for path, body in list(self.posts) if path == f"/api/farm/steps/{run_id}/{kind}"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(what, check, within_s):
    deadline = time.monotonic() + within_s
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.25)
    raise AssertionError(f"gave up waiting for {what} after {within_s}s")


class Farm:
    """Boots, kills and talks to farmd subprocesses sharing one FARM_HOME."""

    def __init__(self, home: Path, stub: StubServer, log_dir: Path):
        self.home = home
        self.stub = stub
        self.log_dir = log_dir
        self.proc: subprocess.Popen | None = None
        self.url = ""
        self.boots = 0
        # The inherited FARM_HOME is stripped and replaced: this farmd must
        # never see the suite's (or the host's) farm.
        self.env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
        self.env.update(FARM_HOME=str(home), HORIZON_URL=stub.url, PYTHONPATH=str(REPO_ROOT))

    @property
    def task_file(self) -> Path:
        return self.home / "queue" / "jobs" / "active"

    def job_state(self) -> dict | None:
        try:
            return json.loads((self.home / "state" / "jobs" / f"{ITEM_ID}.json").read_text())
        except (OSError, json.JSONDecodeError):
            return None

    def boot(self):
        self.boots += 1
        port = _free_port()
        self.url = f"http://127.0.0.1:{port}"
        log = open(self.log_dir / f"farmd-{self.boots}.log", "w")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "farm.farmd"],
            cwd=str(REPO_ROOT),
            env={**self.env, "FARM_PORT": str(port)},
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        log.close()

        def up():
            if self.proc.poll() is not None:
                raise AssertionError(f"farmd exited at boot: {(self.log_dir / f'farmd-{self.boots}.log').read_text()[-2000:]}")
            try:
                return httpx.get(f"{self.url}/farm/status", timeout=2).json().get("status") == "running"
            except httpx.HTTPError:
                return False

        _wait_for("farmd to come up running", up, 30)

    def kill(self):
        """KillMode=process: SIGKILL farmd's pid alone; tmux and the job's
        runner are separate processes and keep running."""
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(10)
        self.proc = None

    def restart(self):
        self.kill()
        self.boot()

    def post(self, path, body):
        return httpx.post(f"{self.url}{path}", json=body, timeout=20)

    def dispatch(self, run_id, commands, budget_minutes=1):
        block = {"cwd": ".", "commands": list(commands), "budget_minutes": budget_minutes}
        artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
        res = self.post(
            "/steps/run",
            {
                "run_id": run_id,
                "project": PROJECT,
                "item": {"id": ITEM_ID, "kind": "task", "repo": "acme/demo"},
                "step": {"index": EXECUTE_INDEX, "label": "Execute"},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
                "repo_dir": str(self.home),
            },
        )
        assert res.status_code == 200, res.text
        assert res.json().get("session") == SESSION
        _wait_for("the job's runner to start", lambda: (self.job_state() or {}).get("run_id") == run_id, 20)

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(10)


@pytest.fixture
def farm(tmp_path):
    home = tmp_path / "farm-home"
    (home / "state").mkdir(parents=True)
    # A farm already started for this project: farmd adopts it at boot.
    (home / "state" / "farmd-state.json").write_text(json.dumps({"project": PROJECT, "repos": []}))
    # The item's hub exists, so dispatch never tries to clone it.
    (home / "workspaces" / "acme__demo" / ".git").mkdir(parents=True)
    stub = StubServer()
    f = Farm(home, stub, tmp_path)
    try:
        f.boot()
        yield f
    finally:
        f.stop()
        stub.close()


def _job_sessions():
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith(tmux_mgr.JOB_SESSION_PREFIX)]


def _restart_and_readopt(farm):
    farm.restart()
    # The server's next /farm/start for the same project changes nothing:
    # no teardown, so the job's session is never killed.
    res = farm.post("/farm/start", {"project": PROJECT, "repos": []})
    assert res.json() == {"ok": True, "already": True}


def test_a_job_survives_a_farmd_restart_and_reports_once(farm):
    run_id = 40801
    farm.dispatch(run_id, ["sleep 4 && echo ok"])
    assert tmux_mgr.session_exists(SESSION)

    _restart_and_readopt(farm)
    assert _job_sessions() == [SESSION], "a restart never starts a second copy"
    assert farm.job_state()["status"] == "running", "the job kept running through the restart"

    _wait_for("the job's completion report", lambda: farm.stub.reports(run_id, "complete"), 60)
    _wait_for("the task file to be released", lambda: not (farm.task_file / f"{run_id}.json").exists(), 20)
    assert len(farm.stub.reports(run_id, "complete")) == 1
    assert farm.stub.reports(run_id, "fail") == []
    report = farm.stub.reports(run_id, "complete")[0]
    assert report["summary"] == "1 command(s) run, 1 passed, 0 failed"


def test_a_job_that_ends_while_farmd_is_down_is_reported_once_by_the_next_farmd(farm):
    run_id = 40802
    farm.dispatch(run_id, ["sleep 1 && echo ok"])
    farm.kill()

    _wait_for("the job to finish with farmd down", lambda: (farm.job_state() or {}).get("status") == "finished", 30)
    assert farm.stub.reports(run_id, "complete") == []

    farm.boot()
    _wait_for("the job's completion report", lambda: farm.stub.reports(run_id, "complete"), 60)
    _wait_for("the task file to be released", lambda: not (farm.task_file / f"{run_id}.json").exists(), 20)
    assert len(farm.stub.reports(run_id, "complete")) == 1
    assert farm.stub.reports(run_id, "fail") == []


def test_stop_still_ends_the_job_after_a_farmd_restart(farm):
    run_id = 40803
    farm.dispatch(run_id, ["sleep 600"])

    _restart_and_readopt(farm)
    assert _job_sessions() == [SESSION]

    res = farm.post("/jobs/stop", {"run_id": run_id})
    assert res.status_code == 200, res.text
    assert res.json()["killed"] is True
    assert not tmux_mgr.session_exists(SESSION)
    assert not (farm.task_file / f"{run_id}.json").exists()
    assert farm.stub.reports(run_id, "complete") == []
    assert farm.stub.reports(run_id, "fail") == []


def test_a_job_past_its_budget_is_still_ended_after_a_farmd_restart(farm):
    """The runner enforces the budget itself, so a restarted farmd only has
    to relay it: one /fail with the budget reason, never a completion. The
    shortest budget a plan allows is one minute, so this takes about that."""
    run_id = 40804
    farm.dispatch(run_id, ["sleep 600"], budget_minutes=1)

    _restart_and_readopt(farm)
    assert _job_sessions() == [SESSION]

    _wait_for("the budget failure report", lambda: farm.stub.reports(run_id, "fail"), 120)
    _wait_for("the task file to be released", lambda: not (farm.task_file / f"{run_id}.json").exists(), 20)
    fails = farm.stub.reports(run_id, "fail")
    assert len(fails) == 1
    assert fails[0]["reason"] == reasons.REASON["JOB_BUDGET_EXCEEDED"]
    assert farm.stub.reports(run_id, "complete") == []
    assert not tmux_mgr.session_exists(SESSION)
