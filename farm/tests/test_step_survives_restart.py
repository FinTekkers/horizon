"""HZ-469 metric 1: which running agent steps survive a Horizon restart.

A throwaway Horizon instance: a real `node server/src/server.js` on its own
DB and port, and a real farmd in its own FARM_HOME, on the private tmux
server the real_tmux fixture gives every such test. Agents are
farm/tests/fake_claude behind a wrapper that holds until a file exists.

One step of each runsIn kind is running: a `farm` step and a `pm` step the
server dispatched itself, a `job` (Execute) dispatched to farmd directly,
and a `server` step's active row (a server step runs synchronously, so a
restart can only ever find it mid-call). The restart follows a deploy:
SIGKILL the server (systemd's KillMode=process), release the hold while it
is down, boot it again, then SIGKILL and boot farmd. A kind survives when
its original step_run ends `done`, no second run of that step exists, and
the item moves on. The observed result for every kind must equal
RESTART_SURVIVAL in server/src/deployDrain.js — the table the deploy drain
reads.

Guardrail 2: nothing here calls systemctl (a stub on PATH records any call
and the test asserts none), the inherited FARM_HOME is replaced, and no
session is ever created on the host's tmux server."""

import json
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from domain.py import run_plan, steps
from farm import task_job, tmux_mgr
from farm.tests.leak_guard import host_farm_sessions

pytestmark = pytest.mark.real_tmux

REPO_ROOT = Path(__file__).resolve().parents[2]
SECRET = "hz469-restart-test-secret"
REPO = "acme/demo"
FAKE_CLAUDE = Path(__file__).resolve().parent / "fake_claude"
# Every item id starts with this, so its sessions are easy to look for on
# the host's tmux server (they must never be there).
PREFIX = "RS"
# The authored table, every row: domain.py's views leave server rows out.
ALL_STEPS = json.loads((REPO_ROOT / "domain" / "steps.json").read_text())["steps"]


def _index(kind: str, runs_in: str) -> int:
    return next(
        i
        for i, s in enumerate(ALL_STEPS)
        if s["kind"] == "agent" and s.get("runsIn") == runs_in and (s.get("itemKind") or "change") == kind
    )


# kind -> (item id, item kind, step index). Planning rows only: they need no
# real repo checkout.
CASES = {
    "farm": (f"{PREFIX}-1", "change", steps.by_kind_label("change", "Architecture review")["index"]),
    "pm": (f"{PREFIX}-2", "change", _index("change", "pm")),
    "job": (f"{PREFIX}-3", "task", _index("task", "job")),
    "server": (f"{PREFIX}-4", "plan", _index("plan", "server")),
}


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


def _node(script: str, env: dict) -> str:
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=str(REPO_ROOT / "server"),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout


class Instance:
    """The test instance: one DB, one FARM_HOME, fixed ports for its life so
    a rebooted farmd and server find each other where they left off."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.db_path = tmp / "horizon.db"
        self.farm_home = tmp / "farm-home"
        self.hold = tmp / "release-the-hold"
        self.systemctl_log = tmp / "systemctl.log"
        self.server_port = _free_port()
        self.farm_port = _free_port()
        self.server_url = f"http://127.0.0.1:{self.server_port}"
        self.farm_url = f"http://127.0.0.1:{self.farm_port}"
        self.server: subprocess.Popen | None = None
        self.farmd: subprocess.Popen | None = None
        self.boots = {"server": 0, "farmd": 0}

        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        # Any systemctl call is recorded and refused: this test never restarts a service.
        (bin_dir / "systemctl").write_text(f'#!/bin/sh\necho "$*" >> {self.systemctl_log}\nexit 1\n')
        claude = bin_dir / "hold-claude"
        # Bounded, so an agent orphaned by a killed test run still ends.
        claude.write_text(
            "#!/bin/sh\n"
            f'i=0; while [ ! -e "{self.hold}" ] && [ $i -lt 1800 ]; do sleep 0.1; i=$((i+1)); done\n'
            f'exec "{FAKE_CLAUDE}" "$@"\n'
        )
        for f in (bin_dir / "systemctl", claude):
            f.chmod(0o755)
        (self.farm_home / "workspaces" / REPO.replace("/", "__") / ".git").mkdir(parents=True)
        home = tmp / "home"
        home.mkdir()

        path = f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}"
        # Allow-listed, never a copy of this process's env: the server must not
        # see a real token, DB, farm or WhatsApp bridge.
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
            "FARM_QUEUE_TIMEOUT_MS": "600000",
            "FARM_STEP_TIMEOUT_MS": "600000",
            "FARM_RECOVERY_POLL_MS": "1000",
        }
        # farmd gets this process's env (the suite's hermetic one, with the
        # private TMUX_TMPDIR) minus the inherited FARM_HOME, which is replaced.
        self.farmd_env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "TMUX")}
        self.farmd_env.update(
            PATH=path,
            FARM_HOME=str(self.farm_home),
            FARM_PORT=str(self.farm_port),
            HORIZON_URL=self.server_url,
            FARM_SHARED_SECRET=SECRET,
            FARM_CLAUDE_BIN=str(claude),
            FARM_RUNNER="subprocess",
            FARM_WA_ENABLED="0",
            PYTHONPATH=str(REPO_ROOT),
        )

    # ---- the database, read and written beside the server ----

    def sql(self, query: str, *args):
        conn = sqlite3.connect(self.db_path, timeout=10)
        try:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(query, args)]
            conn.commit()
            return rows
        finally:
            conn.close()

    def runs(self, item_id: str, index: int):
        return self.sql("SELECT * FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id", item_id, index)

    def cursor(self, item_id: str) -> int:
        return self.sql("SELECT cursor FROM work_item WHERE id = ?", item_id)[0]["cursor"]

    def add_item(self, item_id: str, kind: str, cursor: int):
        self.sql(
            "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, repo, project_id, kind)"
            " VALUES (?, ?, 'Medium', 'outcome', 'metric', 'guardrails', ?, ?, 1, ?)",
            item_id,
            f"restart survival {item_id}",
            cursor,
            REPO,
            kind,
        )

    def seed(self) -> dict:
        """Builds the schema, empties the demo seed, adds the project and the
        farm/pm items, and returns RESTART_SURVIVAL as the server reads it."""
        script = """
const { db } = await import('./src/db.js')
const store = await import('./src/store.js')
const { RESTART_SURVIVAL } = await import('./src/deployDrain.js')
store.purgeDemoItems()
db.prepare("INSERT INTO project (id, name, enabled) VALUES (1, 'Restart test', 1)").run()
db.prepare("INSERT INTO setting (key, value) VALUES ('active_project_id', '1'), ('farm_project_id', '1')").run()
console.log(JSON.stringify(RESTART_SURVIVAL))
"""
        table = json.loads(_node(script, self.server_env).strip().splitlines()[-1])
        for kind in ("farm", "pm"):
            item_id, item_kind, index = CASES[kind]
            self.add_item(item_id, item_kind, index)
        return table

    # ---- processes ----

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

    @staticmethod
    def _kill(proc):
        """KillMode=process: SIGKILL that pid alone. tmux and every agent and
        job under it are separate processes and keep running."""
        if proc is not None and proc.poll() is None:
            proc.send_signal(signal.SIGKILL)
            proc.wait(10)

    def kill_server(self):
        self._kill(self.server)
        self.server = None

    def kill_farmd(self):
        self._kill(self.farmd)
        self.farmd = None

    def stop(self):
        self.kill_server()
        self.kill_farmd()

    # ---- the job, dispatched to farmd as the server would ----

    def dispatch_job(self, run_id: int):
        item_id, _, index = CASES["job"]
        wait = f'i=0; while [ ! -e "{self.hold}" ] && [ $i -lt 1800 ]; do sleep 0.1; i=$((i+1)); done; echo ok'
        block = {"cwd": ".", "commands": [wait], "budget_minutes": 10}
        artifact = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"
        res = httpx.post(
            f"{self.farm_url}/steps/run",
            json={
                "run_id": run_id,
                "project": {"id": 1, "name": "Restart test"},
                "item": {"id": item_id, "kind": CASES["job"][1], "repo": REPO},
                "step": {"index": index, "label": ALL_STEPS[index]["label"]},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
                "repo_dir": str(self.farm_home),
            },
            timeout=20,
        )
        assert res.status_code == 200, res.text

    def job_status(self) -> str | None:
        try:
            state = json.loads((self.farm_home / "state" / "jobs" / f"{CASES['job'][0]}.json").read_text())
        except (OSError, json.JSONDecodeError):
            return None
        return state.get("status")

    def drain_steps(self):
        res = httpx.get(f"{self.server_url}/api/farm/deploy-drain", headers={"x-farm-secret": SECRET}, timeout=10)
        assert res.status_code == 200, res.text
        return res.json()["steps"]


def _our_sessions(names) -> set[str]:
    prefixes = (f"farm-run-{PREFIX.lower()}-", f"{tmux_mgr.JOB_SESSION_PREFIX}{PREFIX.lower()}-")
    return {n for n in names if n.startswith(prefixes)}


@pytest.fixture
def instance(tmp_path):
    if not (REPO_ROOT / "server" / "node_modules").is_dir():
        pytest.fail("server/node_modules is missing: run `npm --prefix server install` (the root `npm test` does)")
    inst = Instance(tmp_path)
    try:
        yield inst
    finally:
        inst.stop()
        # Lets any agent or job still waiting end on its own; the real_tmux
        # fixture then kills what is left on the private tmux server.
        inst.hold.touch()
        shutil.rmtree(inst.farm_home, ignore_errors=True)


def test_each_step_kind_survives_a_restart_exactly_as_the_drain_table_says(instance, host_tmux_env):
    host_before = host_farm_sessions(host_tmux_env)
    table = instance.seed()
    assert set(table) == {s["runsIn"] for s in ALL_STEPS if s["kind"] == "agent"}

    # 1. Boot. The server starts the farm and dispatches the farm and pm steps;
    # each agent is held at its first model call.
    instance.boot_farmd()
    instance.boot_server()
    first = {}
    for kind in ("farm", "pm"):
        item_id, _, index = CASES[kind]
        run = _wait_for(
            f"the {kind} step's agent to start",
            lambda: next((r for r in instance.runs(item_id, index) if r["status"] == "active" and r["agent_started_at"]), None),
            90,
        )
        first[kind] = run["id"]
    _wait_for(
        "both agent sessions on the private tmux server",
        lambda: len(_our_sessions(tmux_mgr.list_farm_sessions())) >= 2,
        30,
    )

    # The job and the server step: rows written beside the running server,
    # which kicks neither (only events and boots do).
    item_id, kind_of_item, index = CASES["job"]
    instance.add_item(item_id, kind_of_item, index)
    first["job"] = instance.sql(
        "INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'DevOps', 'active') RETURNING id",
        item_id,
        index,
    )[0]["id"]
    instance.dispatch_job(first["job"])
    _wait_for("the job to run", lambda: instance.job_status() == "running", 30)
    item_id, kind_of_item, index = CASES["server"]
    instance.add_item(item_id, kind_of_item, index)
    first["server"] = instance.sql(
        "INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Horizon', 'active') RETURNING id",
        item_id,
        index,
    )[0]["id"]

    # Every step is running, and the drain lists all but the job (HZ-378),
    # each tagged from the table.
    listed = {s["runId"]: s for s in instance.drain_steps()}
    for kind, run_id in first.items():
        if kind == "job":
            assert run_id not in listed
            continue
        assert run_id in listed, f"the {kind} step is not listed as running: {listed}"
        assert listed[run_id]["kind"] == kind
        assert listed[run_id]["survives"] is (table[kind] == "survives")
    for kind in ("farm", "pm", "job"):
        assert instance.runs(CASES[kind][0], CASES[kind][2])[-1]["status"] == "active"

    # 2. The restart. The server goes down first; every held step finishes
    # while it is down, then it boots again; then farmd restarts.
    instance.kill_server()
    instance.hold.touch()
    _wait_for("the held agents to finish", lambda: not _our_sessions(tmux_mgr.list_farm_sessions()), 90)
    _wait_for("the job to finish", lambda: instance.job_status() == "finished", 30)
    instance.boot_server()
    instance.kill_farmd()
    instance.boot_farmd()

    # 3. What became of each original run.
    observed = {}
    for kind, run_id in first.items():
        item_id, _, index = CASES[kind]
        original = _wait_for(
            f"the original {kind} run to end",
            lambda: next((r for r in instance.runs(item_id, index) if r["id"] == run_id and r["status"] != "active"), None),
            90,
        )
        later = [r for r in instance.runs(item_id, index) if r["id"] != run_id]
        survived = original["status"] == "done" and not later
        if survived:
            _wait_for(f"the {kind} item to move past its step", lambda: instance.cursor(item_id) > index, 60)
        observed[kind] = "survives" if survived else "lost"

    assert observed == dict(table), (
        f"RESTART_SURVIVAL in server/src/deployDrain.js says {dict(table)}, the restart showed {observed}"
    )
    assert not instance.systemctl_log.exists(), "the restart test must never call systemctl"
    host_after = host_farm_sessions(host_tmux_env)
    if host_before is not None and host_after is not None:
        assert not _our_sessions(host_after), "a session of this test reached the host's tmux server"
