"""HZ-570 metric 1: a server restart in the middle of a run's test-results
upload no longer costs the run its rows.

A throwaway Horizon instance, as in test_step_survives_restart.py: a real
`node server/src/server.js` on its own DB and port, and a real farmd in its
own FARM_HOME. An implement run reports its result, with 500 per-test rows,
through farmd's /internal/steps/result, exactly as the step agent does. The
server's test-only hold (HORIZON_TEST_RUNS_HOLD_DIR, testResults.js) stops
the test-runs post at a known point — before its insert, or after its commit
but before its reply — and the server is SIGKILLed there (a deploy's restart),
then booted again. farmd's retry must leave exactly 500 rows for the run.

The project is disabled, so the server dispatches no step: completing the run
is all it does. No agent runs, nothing calls systemctl, and the inherited
FARM_HOME is replaced."""

import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from domain.py import steps

pytestmark = pytest.mark.real_tmux

REPO_ROOT = Path(__file__).resolve().parents[2]
SECRET = "hz570-restart-test-secret"
REPO = "acme/demo"
ITEM = "TR-1"
ROWS = 500
IMPLEMENT = steps.by_kind_label("change", "Specialist agent implements")["index"]


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
        time.sleep(0.2)
    raise AssertionError(f"gave up waiting for {what} after {within_s}s")


class Instance:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.db_path = tmp / "horizon.db"
        self.farm_home = tmp / "farm-home"
        self.hold_dir = tmp / "hold"
        self.hold_dir.mkdir()
        self.server_port = _free_port()
        self.farm_port = _free_port()
        self.server_url = f"http://127.0.0.1:{self.server_port}"
        self.farm_url = f"http://127.0.0.1:{self.farm_port}"
        self.server: subprocess.Popen | None = None
        self.farmd: subprocess.Popen | None = None
        self.boots = {"server": 0, "farmd": 0}
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 1\n")
        (bin_dir / "systemctl").chmod(0o755)
        home = tmp / "home"
        home.mkdir()
        path = f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}"
        self.server_env = {
            "PATH": path,
            "HOME": str(home),
            "LANG": "C.UTF-8",
            "HORIZON_DB": str(self.db_path),
            "PORT": str(self.server_port),
            "FARM_URL": self.farm_url,
            "FARM_SHARED_SECRET": SECRET,
            "FARM_HOME": str(self.farm_home),
            "HORIZON_REPO": "",
            "GITHUB_TOKEN": "",
            "GITHUB_WEBHOOK_SECRET": "",
            "WA_NOTIFY_ENABLED": "0",
            "WA_BRIDGE_URL": "http://127.0.0.1:9",
            "HORIZON_TEST_RUNS_HOLD_DIR": str(self.hold_dir),
        }
        self.farmd_env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "TMUX")}
        self.farmd_env.update(
            PATH=path,
            FARM_HOME=str(self.farm_home),
            FARM_PORT=str(self.farm_port),
            HORIZON_URL=self.server_url,
            FARM_SHARED_SECRET=SECRET,
            FARM_RUNNER="subprocess",
            FARM_WA_ENABLED="0",
            PYTHONPATH=str(REPO_ROOT),
        )

    def sql(self, query: str, *args):
        conn = sqlite3.connect(self.db_path, timeout=10)
        try:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(query, args)]
            conn.commit()
            return rows
        finally:
            conn.close()

    def seed(self):
        script = """
const { db } = await import('./src/db.js')
const store = await import('./src/store.js')
store.purgeDemoItems()
db.prepare("INSERT INTO project (id, name, enabled) VALUES (1, 'Upload restart test', 0)").run()
db.prepare("INSERT INTO setting (key, value) VALUES ('active_project_id', '1'), ('farm_project_id', '1')").run()
"""
        out = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=str(REPO_ROOT / "server"),
            env=self.server_env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert out.returncode == 0, out.stderr[-2000:]
        self.sql(
            "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, repo, project_id)"
            " VALUES (?, 'upload restart', 'Medium', 'o', 'm', 'g', ?, ?, 1)",
            ITEM,
            IMPLEMENT,
            REPO,
        )

    def boot_server(self):
        self.boots["server"] += 1
        log = open(self.tmp / f"server-{self.boots['server']}.log", "w")
        self.server = subprocess.Popen(
            ["node", "src/server.js"], cwd=str(REPO_ROOT / "server"), env=self.server_env, stdout=log, stderr=subprocess.STDOUT
        )
        log.close()

        def up():
            if self.server.poll() is not None:
                raise AssertionError(f"server exited at boot: {self.log('server')[-2000:]}")
            try:
                return httpx.get(f"{self.server_url}/api/health", timeout=2).status_code == 200
            except httpx.HTTPError:
                return False

        _wait_for("the server to answer /api/health", up, 60)

    def boot_farmd(self):
        self.boots["farmd"] += 1
        log = open(self.tmp / f"farmd-{self.boots['farmd']}.log", "w")
        self.farmd = subprocess.Popen(
            [sys.executable, "-m", "farm.farmd"], cwd=str(REPO_ROOT), env=self.farmd_env, stdout=log, stderr=subprocess.STDOUT
        )
        log.close()

        def up():
            if self.farmd.poll() is not None:
                raise AssertionError(f"farmd exited at boot: {self.log('farmd')[-2000:]}")
            try:
                return httpx.get(f"{self.farm_url}/farm/status", timeout=2).status_code == 200
            except httpx.HTTPError:
                return False

        _wait_for("farmd to answer /farm/status", up, 60)

    def log(self, which: str) -> str:
        try:
            return (self.tmp / f"{which}-{self.boots[which]}.log").read_text()
        except OSError:
            return ""

    def kill_server(self):
        """KillMode=process: SIGKILL, no shutdown handler runs."""
        if self.server is not None and self.server.poll() is None:
            self.server.send_signal(signal.SIGKILL)
            self.server.wait(10)
        self.server = None

    def stop(self):
        self.kill_server()
        if self.farmd is not None and self.farmd.poll() is None:
            self.farmd.send_signal(signal.SIGKILL)
            self.farmd.wait(10)

    def stored(self, run_id: int) -> dict:
        return self.sql(
            "SELECT COUNT(*) AS n, COUNT(DISTINCT test) AS distinct_tests FROM test_result WHERE run_id = ? AND source = 'implement'",
            run_id,
        )[0]

    def ledger(self, run_id: int) -> dict:
        return self.sql("SELECT test_runs_expected, test_runs_stored, test_runs_stored_at FROM step_run WHERE id = ?", run_id)[0]

    def outbox(self) -> list[str]:
        return sorted(p.name for p in (self.farm_home / "state" / "test-runs-outbox").glob("*.json"))


@pytest.fixture
def instance(tmp_path):
    if not (REPO_ROOT / "server" / "node_modules").is_dir():
        pytest.fail("server/node_modules is missing: run `npm --prefix server install` (the root `npm test` does)")
    inst = Instance(tmp_path)
    try:
        yield inst
    finally:
        inst.stop()


def _result_body(run_id: int) -> dict:
    tests = [
        {"suite": "Suite", "file": None, "test": f"test {i}", "status": "pass", "duration_ms": 1, "command": "npm test", "attempt": 1}
        for i in range(ROWS)
    ]
    return {
        "run_id": run_id,
        "ok": True,
        "summary": "implemented; checks passed",
        "patch": {},
        "test_runs": [
            {
                "check_run": f"cr-{run_id}",
                "label": "main",
                "commit_sha": "c" * 40,
                "tree_sha": "e" * 40,
                "tests": tests,
                "commands": [{"command": "npm test", "attempt": 1, "exit_code": 0}],
            }
        ],
    }


@pytest.mark.parametrize("stage", ["before", "after"], ids=["killed-before-insert", "killed-after-commit-before-reply"])
def test_a_restart_mid_upload_still_stores_exactly_500_rows(instance, stage):
    instance.seed()
    instance.boot_farmd()
    instance.boot_server()
    run_id = instance.sql(
        "INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'active') RETURNING id",
        ITEM,
        IMPLEMENT,
    )[0]["id"]
    gate = instance.hold_dir / f"{stage}-{run_id}"
    gate.touch()

    # The step agent's report: farmd forwards /complete, then the rows.
    res = httpx.post(f"{instance.farm_url}/internal/steps/result", json=_result_body(run_id), timeout=30)
    assert res.status_code == 200, res.text
    assert instance.ledger(run_id)["test_runs_expected"] == ROWS
    _wait_for("the upload to reach the hold", lambda: (instance.hold_dir / f"{stage}-{run_id}.reached").exists(), 30)
    assert instance.outbox() == [f"{run_id}.json"], "farmd keeps the rows until the server confirms them"
    if stage == "after":
        assert instance.stored(run_id)["n"] == ROWS, "committed before the kill"
    else:
        assert instance.stored(run_id)["n"] == 0

    # The deploy's restart: the server dies holding the request, then boots.
    instance.kill_server()
    gate.unlink()
    instance.boot_server()

    _wait_for("farmd's retry to be stored", lambda: instance.ledger(run_id)["test_runs_stored_at"], 90)
    assert instance.stored(run_id) == {"n": ROWS, "distinct_tests": ROWS}
    assert instance.ledger(run_id)["test_runs_stored"] == ROWS
    _wait_for("farmd to drop its spool", lambda: instance.outbox() == [], 30)
    assert "abandoned" not in instance.log("farmd")
