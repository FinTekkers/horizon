"""HZ-569 test fakes: processes shaped like the ones the run reaper hunts.

Each fake is a real `node` process whose argv looks like the real thing —
`node <dir>/farm/capture/worker.mjs`, `node src/server.js <port>`,
`node <dir>/node_modules/vite/bin/vite.js preview --port <port>` — so
run_reaper.kind_of() sees exactly what it sees on the host. Every process a
test starts goes through Procs, which SIGKILLs and reaps them all in a
finally, whether the test passed or not.
"""

import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

from farm import procfs, run_reaper

SERVER_JS = """\
const http = require('node:http')
const fs = require('node:fs')
const flag = process.argv.indexOf('--port')
const port = Number(flag > 0 ? process.argv[flag + 1] : process.argv[2])
const out = process.env.FAKE_PID_FILE
http.createServer((req, res) => res.end('ok')).listen(port, '127.0.0.1', () => {
  if (out) fs.writeFileSync(out, JSON.stringify({ pid: process.pid, tag: process.env.HORIZON_RUN_ID || null }))
})
"""
IDLE_JS = "setInterval(() => {}, 1 << 30)\n"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def port_binds(port: int) -> bool:
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def gone(pid: int) -> bool:
    return not procfs.alive(pid)


def wait_until(what: str, check, within_s: float = 10.0, poll_s: float = 0.05):
    """A polling deadline, never a fixed sleep."""
    deadline = time.monotonic() + within_s
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"gave up after {within_s}s waiting for {what}")
        time.sleep(poll_s)


def make_app(root: Path) -> Path:
    """A directory holding the fake scripts, CommonJS like a repo's server."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text('{"type": "commonjs"}\n')
    (root / "src").mkdir(exist_ok=True)
    (root / "src" / "server.js").write_text(SERVER_JS)
    vite = root / "node_modules" / "vite" / "bin"
    vite.mkdir(parents=True, exist_ok=True)
    (vite / "vite.js").write_text(SERVER_JS)
    worker = root / "farm" / "capture"
    worker.mkdir(parents=True, exist_ok=True)
    (worker / "worker.mjs").write_text(IDLE_JS)
    return root


def tag_env(run_id: str | None, **extra) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k != run_reaper.RUN_ENV}
    if run_id is not None:
        env[run_reaper.RUN_ENV] = run_id
    env.update(extra)
    return env


def write_lease(runs_dir: Path, run_id: str, owner_pid: int, *, item_id="HZ-569", worktree="/work/hz-569", start=None):
    st = procfs.stat(owner_pid)
    lease = {
        "run_id": run_id,
        "owner_pid": owner_pid,
        "owner_start": start if start is not None else st.start,
        "item_id": item_id,
        "caller": "test",
        "worktree": worktree,
        "started_at": "2026-10-24T13:00:00+00:00",
    }
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / f"{run_id}.json").write_text(json.dumps(lease))
    return lease


class Procs:
    """Starts processes for one test and kills every one of them after it."""

    def __init__(self, app: Path):
        self.app = app
        self.started: list[subprocess.Popen] = []
        self.extra_pids: set[int] = set()

    def spawn(self, argv, *, run_id=None, cwd=None, env=None, **kwargs) -> subprocess.Popen:
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd or self.app),
            env=env if env is not None else tag_env(run_id),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            **kwargs,
        )
        self.started.append(proc)
        return proc

    def worker(self, run_id=None) -> subprocess.Popen:
        return self.spawn(["node", str(self.app / "farm" / "capture" / "worker.mjs")], run_id=run_id)

    def server(self, port: int, run_id=None, pid_file=None) -> subprocess.Popen:
        extra = {"FAKE_PID_FILE": str(pid_file)} if pid_file else {}
        return self.spawn(["node", "src/server.js", str(port)], env=tag_env(run_id, **extra))

    def vite(self, port: int, run_id=None) -> subprocess.Popen:
        return self.spawn(["node", str(self.app / "node_modules" / "vite" / "bin" / "vite.js"), "preview", "--port", str(port)], run_id=run_id)

    def owner(self) -> subprocess.Popen:
        """A live process standing for a run's owner (a step agent in tmux)."""
        return self.spawn(["sleep", "600"])

    def dead_owner(self) -> tuple[int, int]:
        """(pid, start) of an owner that has exited and been reaped."""
        proc = self.owner()
        start = procfs.stat(proc.pid).start
        proc.kill()
        proc.wait(5)
        return proc.pid, start

    def track(self, pid: int) -> None:
        """A pid the test learned of but did not start (a browser, a server
        Playwright started): killed afterwards too."""
        self.extra_pids.add(pid)

    def kill_all(self) -> None:
        for pid in self.extra_pids:
            if procfs.alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        for proc in self.started:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    proc.kill()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                pass
