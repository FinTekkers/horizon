"""HZ-371 metric 2: farmd launches farm.step_agent for every step, PM steps
included, and the PM lane still runs one PM step at a time.

Lanes are read off domain/steps.json (runsIn), never typed here. The last
test runs a PM step the way farmd's command line does, as a real subprocess.
"""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from domain.py import steps
from farm import farmd
from farm.config import QUEUE_DIR

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TESTS_DIR = Path(__file__).resolve().parent

PM_STEPS = [step for step in steps.STEPS if step["runsIn"] == "pm"]
FARM_STEP = next(step for step in steps.STEPS if step["runsIn"] == "farm")


def _task(run_id: int, step: dict, item_id: str) -> dict:
    return {
        "run_id": run_id,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": item_id, "title": "One runner", "desc": "", "metric": "", "guardrails": ""},
        "step": {"index": step["index"], "label": step["label"]},
        "artifacts": [],
        "feedback": [],
        "rules": [],
    }


def _write(path: Path, task: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(task))
    return path


def _launches(fake_tmux) -> dict[str, str]:
    return {call[call.index("-s") + 1]: call[-1] for call in fake_tmux.calls if call[0] == "new-session"}


@pytest.fixture
def farm(monkeypatch):
    """A running farm with clean queues; the background dispatcher's tick is
    a no-op so the test drives each tick itself."""
    real_tick = farmd._dispatch_tick
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    dirs = [QUEUE_DIR / "pm", QUEUE_DIR / "runs", QUEUE_DIR / "runs" / "active"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    try:
        yield real_tick
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        for d in dirs:
            for f in d.glob("*.json*"):
                f.unlink(missing_ok=True)


def test_the_table_has_pm_and_farm_steps():
    assert len(PM_STEPS) == 4
    assert FARM_STEP["runsIn"] == "farm"


@pytest.mark.parametrize("step", [*PM_STEPS, FARM_STEP], ids=lambda step: step["label"])
def test_every_step_launches_farm_step_agent(farm, fake_tmux, step):
    queued = _write(QUEUE_DIR / "pm" / "901.json", _task(901, step, "hz-one"))

    name = farmd._claim_and_launch(queued, QUEUE_DIR / "runs", REPO_ROOT)

    claimed = QUEUE_DIR / "runs" / "active" / "901.json"
    assert _launches(fake_tmux)[name].endswith(f" -m farm.step_agent --task {claimed}")


def test_two_queued_pm_steps_run_one_at_a_time(farm, fake_tmux):
    first = _write(QUEUE_DIR / "pm" / "911.json", _task(911, PM_STEPS[0], "hz-a"))
    os.utime(first, (first.stat().st_mtime - 5,) * 2)  # oldest first
    _write(QUEUE_DIR / "pm" / "912.json", _task(912, PM_STEPS[-1], "hz-b"))

    farm()  # tick 1: the PM lane has one slot
    launched = _launches(fake_tmux)
    assert list(launched) == [f"farm-run-hz-a-s{PM_STEPS[0]['index']}-a1"]

    farm()  # tick 2: the first PM step is still live
    assert _launches(fake_tmux) == launched
    assert (QUEUE_DIR / "pm" / "912.json").exists()

    fake_tmux.sessions.clear()  # the first PM step finished
    farm()  # tick 3: the second one launches
    second = f"farm-run-hz-b-s{PM_STEPS[-1]['index']}-a1"
    assert set(_launches(fake_tmux)) == {*launched, second}
    claimed = QUEUE_DIR / "runs" / "active" / "912.json"
    assert _launches(fake_tmux)[second].endswith(f" -m farm.step_agent --task {claimed}")


class _ResultHandler(BaseHTTPRequestHandler):
    posts: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        self.posts.append({"path": self.path, "body": body})
        payload = json.dumps({"ok": True, "forwarded": 200}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def test_a_pm_step_runs_as_a_step_agent_subprocess(tmp_path):
    """What farmd's command line runs, end to end: the real module under -m,
    the real run_agent over the fake claude binary, and a stub farmd taking
    the result."""
    handler = type("Handler", (_ResultHandler,), {"posts": []})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    task_file = _write(tmp_path / "921.json", _task(921, PM_STEPS[0], "hz-sub"))
    env = {k: v for k, v in os.environ.items() if k != "FARM_PROVIDER"}
    env.update(
        FARM_PORT=str(server.server_port),
        FARM_CLAUDE_BIN=str(TESTS_DIR / "fake_claude"),
        FARM_RUNNER="subprocess",
    )
    try:
        result = subprocess.run(
            [sys.executable, "-m", "farm.step_agent", "--task", str(task_file)],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert result.returncode == 0, result.stdout + result.stderr
    assert [post["path"] for post in handler.posts] == ["/internal/steps/result"]
    body = handler.posts[0]["body"]
    assert body["run_id"] == 921 and body["ok"] is True
    assert body["summary"] == f"[fake-claude] completed {PM_STEPS[0]['label'].lower()}"
    assert isinstance(body["patch"], dict)
    assert not task_file.exists()
    assert not task_file.with_suffix(".pid").exists()
