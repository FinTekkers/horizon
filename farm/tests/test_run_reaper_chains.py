"""HZ-569 metric line 1: a check that starts a capture worker, its
headless_shell browser and an e2e server leaves nothing running once it ends
— by its time limit, and by Stop.

These run the real chains, not stand-ins: the real farm/capture/worker.mjs
launches the real Chromium (missing ones fail the test, never skip it — run
`cd farm/capture && npm ci && npx playwright install chromium`), and a real
Playwright test run starts `node src/server.js` and `vite preview` as its
webServers. Each test asserts the run's tag reached every one of those
processes while it ran, then that within 10 s of the run ending none is left
and the ports bind again."""

import json
import os
import signal
import sys
import threading
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import checks, procfs, run_reaper, screenshot_runner, task_job
from farm.checks import CheckFailure
from farm.tests.run_reaper_fakes import Procs, free_port, gone, make_app, port_binds, wait_until

FIXTURES = Path(__file__).parent / "fixtures" / "run_reaper"
LEAKY_CHECK = FIXTURES / "leaky_check.py"
WORKER = screenshot_runner.CAPTURE_DIR / "worker.mjs"
PLAYWRIGHT = screenshot_runner.CAPTURE_DIR / "node_modules" / "playwright"
REPO_ROOT = Path(__file__).resolve().parents[2]
WITHIN_S = 10


@pytest.fixture
def procs(tmp_path):
    p = Procs(make_app(tmp_path / "app"))
    try:
        yield p
    finally:
        p.kill_all()


@pytest.fixture
def check_env(tmp_path, monkeypatch):
    """A check run of the test's own: its RUNS_DIR, its TMPDIR (Chromium's
    and Playwright's temp files stay in tmp_path), no outer run's tag."""
    runs = tmp_path / "runs"
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    tmp = tmp_path / "tmp"
    tmp.mkdir()
    monkeypatch.setenv("TMPDIR", str(tmp))
    monkeypatch.delenv(checks.check_slots.IN_CHECKS_ENV, raising=False)
    return runs


def require_real_worker():
    if not screenshot_runner.worker_installed() or not checks._playwright_chromium_installed():
        pytest.fail(f"the real capture worker or Chromium is missing on this host — run `{screenshot_runner.INSTALL_HINT}`")


def tagged_with(run_id: str) -> list[int]:
    return [pid for pid in procfs.own_pids() if procfs.alive(pid) and procfs.environ_value(pid, run_reaper.RUN_ENV) == run_id]


def test_a_check_past_its_time_limit_leaves_no_worker_browser_or_server(procs, check_env, tmp_path, monkeypatch):
    require_real_worker()
    port = free_port()
    out = tmp_path / "leak.json"
    monkeypatch.setenv("FARM_CHECK_CMD", f"{sys.executable} {LEAKY_CHECK} {out} {procs.app} {port} {WORKER}")
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "25")

    with pytest.raises(CheckFailure) as failure:
        checks.run_checks(procs.app, log=lambda _: None)
    assert failure.value.reason == "timed_out"

    # Written by the check command before its time ran out.
    assert out.exists(), "the worker's Chromium never came up inside the check's time limit"
    leak = json.loads(out.read_text())
    for proc in leak["procs"]:
        procs.track(proc["pid"])
    assert leak["ready"] == {"ready": True}
    by_pid = {p["pid"]: p for p in leak["procs"]}
    worker, server = leak["procs"][0], leak["procs"][-1]
    browsers = [p for p in leak["procs"] if p["comm"] == "headless_shell" and p["ppid"] == worker["pid"]]
    assert browsers, f"no headless_shell under the worker: {leak['procs']}"
    helpers = [p for p in leak["procs"] if p["comm"] == "headless_shell" and p["ppid"] != worker["pid"]]
    assert helpers and all(h["ppid"] in by_pid for h in helpers), "Chromium's zygote and helpers descend from the browser"
    run_id = leak["own_tag"]
    assert run_id and run_id.startswith("chk-")
    for proc in (worker, server, *browsers):
        assert proc["tag"] == run_id, f"{proc['comm']} pid {proc['pid']} does not carry the run's tag"

    wait_until("every process of the run to be gone", lambda: all(gone(p["pid"]) for p in leak["procs"]), WITHIN_S)
    assert tagged_with(run_id) == []
    wait_until(f"port {port} to bind again", lambda: port_binds(port), WITHIN_S)
    assert not (check_env / f"{run_id}.json").exists(), "a fully reaped run leaves no lease"


PW_CONFIG = """\
module.exports = {{
  testDir: '.',
  testMatch: /hang\\.spec\\.cjs$/,
  outputDir: './test-results',
  timeout: 0,
  reporter: 'line',
  webServer: [
    {{ command: 'node src/server.js {a}', port: {a}, reuseExistingServer: false, env: {{ FAKE_PID_FILE: {a_out} }} }},
    {{ command: 'node node_modules/vite/bin/vite.js preview --port {b}', port: {b}, reuseExistingServer: false, env: {{ FAKE_PID_FILE: {b_out} }} }},
  ],
}}
"""
HANG_SPEC = """\
const {{ test }} = require({test_module})
test('holds the webServers up until the check is stopped', async () => {{
  await new Promise(() => {{}})
}})
"""


def test_playwright_web_servers_carry_the_tag_and_free_their_ports(procs, check_env, tmp_path, monkeypatch):
    require_real_worker()
    a, b = free_port(), free_port()
    a_out, b_out = tmp_path / "server.json", tmp_path / "vite.json"
    app = procs.app
    (app / "pw.config.cjs").write_text(PW_CONFIG.format(a=a, b=b, a_out=json.dumps(str(a_out)), b_out=json.dumps(str(b_out))))
    (app / "hang.spec.cjs").write_text(HANG_SPEC.format(test_module=json.dumps(str(PLAYWRIGHT / "test"))))
    monkeypatch.setenv("FARM_CHECK_CMD", f"node {PLAYWRIGHT / 'cli.js'} test -c pw.config.cjs")
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "20")

    seen: dict[str, dict] = {}

    def watch():
        # While the check runs: what /proc says about each webServer.
        try:
            wait_until("both webServers to listen", lambda: a_out.exists() and b_out.exists(), 18, 0.1)
        except AssertionError:
            return
        leases = sorted(p.stem for p in check_env.glob("*.json"))
        for name, path in (("server", a_out), ("vite", b_out)):
            pid = json.loads(path.read_text())["pid"]
            procs.track(pid)
            seen[name] = {"pid": pid, "kind": run_reaper.kind_of(pid), "tag": procfs.environ_value(pid, run_reaper.RUN_ENV), "leases": leases}

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    with pytest.raises(CheckFailure) as failure:
        checks.run_checks(app, log=lambda _: None)
    watcher.join(5)
    assert failure.value.reason == "timed_out"

    assert set(seen) == {"server", "vite"}, "Playwright never brought both webServers up"
    run_ids = seen["server"]["leases"]
    assert len(run_ids) == 1 and run_ids[0].startswith("chk-")
    for name in ("server", "vite"):
        assert seen[name]["kind"] == "e2e_server"
        assert seen[name]["tag"] == run_ids[0], f"Playwright's {name} webServer did not inherit the run's tag"

    wait_until("both webServers to be gone", lambda: all(gone(seen[n]["pid"]) for n in seen), WITHIN_S)
    assert tagged_with(run_ids[0]) == []
    wait_until("both ports to bind again", lambda: port_binds(a) and port_binds(b), WITHIN_S)


# ---- Stop: the runner is killed, farmd's Stop and its sweep loop finish ----


def _plan(commands) -> str:
    block = {"cwd": ".", "commands": list(commands), "budget_minutes": 5, "runner": "host"}
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def test_a_stopped_job_leaves_no_worker_or_server_once_the_sweep_ticks(procs, tmp_path, monkeypatch):
    from farm import farmd
    from farm.config import LOGS_DIR, RUNS_DIR, STATE_DIR

    port = free_port()
    app = procs.app
    worker = app / "farm" / "capture" / "worker.mjs"
    command = f"setsid node src/server.js {port} & setsid node {worker} & sleep 600"
    artifact = _plan([command])
    run_id, item_id = 95690, "HZ-95690"
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    task = tmp_path / "task.json"
    task.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item": {"id": item_id},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
                "runner": "host",
                "repo_dir": str(app),
            }
        )
    )
    # FARM_PORT 9 (discard): the runner's nudges never reach a real farmd.
    env = {**os.environ, "FARM_PORT": "9", "PYTHONPATH": str(REPO_ROOT)}
    runner = procs.spawn([sys.executable, "-m", "farm.task_job", "--task", str(task)], cwd=REPO_ROOT, env=env)
    stop = threading.Event()
    try:
        lease = wait_until("the job's lease", lambda: sorted(RUNS_DIR.glob("job-hz-95690-*.json")), WITHIN_S)[0]
        job_run = lease.stem
        kinds = lambda: sorted(filter(None, (run_reaper.kind_of(pid) for pid in tagged_with(job_run))))  # noqa: E731
        wait_until("the job's worker and server", lambda: kinds() == ["capture_worker", "e2e_server"], WITHIN_S)
        pids = tagged_with(job_run)
        for pid in pids:
            procs.track(pid)

        os.kill(runner.pid, signal.SIGKILL)  # what tmux kill-session does to the runner
        runner.wait(5)
        farmd._mark_job_stopped(run_id, item_id)  # kills the command's group; setsid'd children escape it
        assert any(procfs.alive(pid) for pid in pids), "the escaped processes outlived Stop's group kill"

        monkeypatch.setattr(farmd.farm_config, "RUN_SWEEP_INTERVAL_S", 1)
        threading.Thread(target=farmd._run_sweep_loop, args=(stop,), daemon=True).start()
        wait_until("every process of the stopped job to be gone", lambda: all(gone(pid) for pid in pids), WITHIN_S)
        assert tagged_with(job_run) == []
        wait_until(f"port {port} to bind again", lambda: port_binds(port), WITHIN_S)
    finally:
        stop.set()
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)
