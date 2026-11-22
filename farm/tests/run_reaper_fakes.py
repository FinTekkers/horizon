"""HZ-569 test fakes: processes shaped like the ones the run reaper hunts.

Each fake is a real `node` process whose argv looks like the real thing —
`node <dir>/farm/capture/worker.mjs`, `node src/server.js <port>`,
`node <dir>/node_modules/vite/bin/vite.js preview --port <port>`,
`node <dir>/node_modules/playwright/cli.js test -c pw.config.cjs` and a
`headless_shell` — so run_reaper.kind_of() sees exactly what it sees on the
host. Every process a test starts goes through Procs, which records it by
(pid, start time), SIGKILLs every one of them by pid in a finally, whether the
test passed or not, and reports any that outlived that.

HZ-963: Procs.mine() is the process list a test may see and signal: what it
started, their descendants, and what this pytest process started since the
test began. StaleBox simulates other processes on the box (pids above
pid_max, which no real process can have) through the procfs reads.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from farm import procfs, run_reaper

TICK = os.sysconf("SC_CLK_TCK")
# The real readers, before any test patches procfs.
REAL_STAT = procfs.stat
REAL_CMDLINE = procfs.cmdline
REAL_ENVIRON_VALUE = procfs.environ_value
REAL_LINK = procfs.link
REAL_ALL_PIDS = procfs.all_pids

SERVER_JS = """\
const http = require('node:http')
const fs = require('node:fs')
const flag = process.argv.indexOf('--port')
const port = Number(flag > 0 ? process.argv[flag + 1] : process.argv[2])
const out = process.env.FAKE_PID_FILE
http.createServer((req, res) => res.end('ok')).listen(port, '127.0.0.1', () => {
  if (out) fs.writeFileSync(out, JSON.stringify({ pid: process.pid, tag: process.env.HORIZON_RUN_ID || null }))
  if (process.env.FAKE_READY_DIR) fs.writeFileSync(`${process.env.FAKE_READY_DIR}/${process.pid}`, '')
})
"""
IDLE_JS = """\
const fs = require('node:fs')
if (process.env.FAKE_READY_DIR) fs.writeFileSync(`${process.env.FAKE_READY_DIR}/${process.pid}`, '')
setInterval(() => {}, 1 << 30)
"""
# A capture worker that, given FAKE_CHILD, starts it from / (Chrome's helpers
# chdir away from the workspace) and writes its pid to FAKE_CHILD_PID_FILE.
WORKER_MJS = """\
import { spawn } from 'node:child_process'
import fs from 'node:fs'
if (process.env.FAKE_CHILD) {
  const child = spawn(process.env.FAKE_CHILD, [], { cwd: '/', stdio: 'ignore' })
  fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid))
}
if (process.env.FAKE_READY_DIR) fs.writeFileSync(`${process.env.FAKE_READY_DIR}/${process.pid}`, '')
setInterval(() => {}, 1 << 30)
"""
# comm comes from the script's file name; prctl makes sure of it.
BROWSER_PY = f"""\
#!{sys.executable}
import ctypes, os, time
ctypes.CDLL(None).prctl(15, b"headless_shell", 0, 0, 0)
if os.environ.get("FAKE_READY_DIR"):
    open(os.path.join(os.environ["FAKE_READY_DIR"], str(os.getpid())), "w").close()
while True:
    time.sleep(60)
"""


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
    (worker / "worker.mjs").write_text(WORKER_MJS)
    playwright = worker / "node_modules" / "playwright"
    playwright.mkdir(parents=True, exist_ok=True)
    (playwright / "cli.js").write_text(IDLE_JS)
    (root / "bin").mkdir(exist_ok=True)
    browser = root / "bin" / "headless_shell"
    browser.write_text(BROWSER_PY)
    browser.chmod(0o755)
    return root


def make_workspace(workspaces_dir: Path, item: str, suffix: str = "__items") -> Path:
    """<workspaces_dir>/FinTekkers__horizon<suffix>/<item>/, holding the fake app."""
    return make_app(workspaces_dir / f"FinTekkers__horizon{suffix}" / item)


def now_ticks() -> int:
    return int((procfs.uptime_s() or 0.0) * TICK)


def pgrp(pid: int) -> int | None:
    """Field 5 of /proc/<pid>/stat: the process group."""
    try:
        raw = (procfs.PROC / str(pid) / "stat").read_text()
        return int(raw[raw.rfind(")") + 2 :].split()[2])
    except (OSError, IndexError, ValueError):
        return None


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


class Orphaned:
    """A process started by a double fork: its parent is gone, so it is
    reparented to init (or a subreaper), like the 22 Nov 2026 leftovers."""

    def __init__(self, pid: int):
        self.pid = pid


class Procs:
    """Starts processes for one test and kills every one of them after it."""

    def __init__(self, app: Path):
        self.app = app
        self.started: list[subprocess.Popen] = []
        # pid -> start ticks of every process this test started or learned of.
        self.registry: dict[int, int] = {}
        self.t0 = now_ticks()
        self.ready_dir = app.parent / f"{app.name}-ready"
        self.ready_dir.mkdir(exist_ok=True)

    def _register(self, pid: int) -> None:
        st = REAL_STAT(pid)
        if st is not None:
            self.registry[pid] = st.start

    def spawn(self, argv, *, run_id=None, cwd=None, env=None, orphan=False, **kwargs):
        env = dict(env if env is not None else tag_env(run_id))
        env["FAKE_READY_DIR"] = str(self.ready_dir)
        if orphan:
            # sh starts the command in the background and exits at once.
            out = subprocess.run(
                ["sh", "-c", '"$@" </dev/null >/dev/null 2>&1 & echo $!', "sh", *argv],
                cwd=str(cwd or self.app),
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                start_new_session=True,
                check=True,
            )
            proc = Orphaned(int(out.stdout.strip()))
            self._register(proc.pid)
            return proc
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd or self.app),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            **kwargs,
        )
        self.started.append(proc)
        self._register(proc.pid)
        return proc

    def wait_ready(self, pid: int, within_s: float = 10.0) -> None:
        """The fake script has loaded (and a server listens)."""
        wait_until(f"pid {pid} to be ready", lambda: (self.ready_dir / str(pid)).exists(), within_s)

    def worker(self, run_id=None, *, app=None, orphan=False, child=False):
        app = app or self.app
        env = tag_env(run_id)
        if child:
            env.update(FAKE_CHILD=str(app / "bin" / "headless_shell"), FAKE_CHILD_PID_FILE=str(self.ready_dir / "child-pid"))
        return self.spawn(["node", str(app / "farm" / "capture" / "worker.mjs")], cwd=app, env=env, orphan=orphan)

    def worker_child(self) -> int:
        """The pid of the browser the last worker(child=True) started, tracked."""
        path = self.ready_dir / "child-pid"
        pid = int(wait_until("the worker's browser to start", lambda: path.exists() and path.read_text().strip(), 10))
        self.track(pid)
        return pid

    def server(self, port: int, run_id=None, pid_file=None, *, app=None, orphan=False):
        extra = {"FAKE_PID_FILE": str(pid_file)} if pid_file else {}
        return self.spawn(["node", "src/server.js", str(port)], cwd=app or self.app, env=tag_env(run_id, **extra), orphan=orphan)

    def playwright(self, run_id=None, *, app=None, orphan=False):
        app = app or self.app
        cli = app / "farm" / "capture" / "node_modules" / "playwright" / "cli.js"
        return self.spawn(["node", str(cli), "test", "-c", "pw.config.cjs"], cwd=app, run_id=run_id, orphan=orphan)

    def browser(self, run_id=None, *, app=None, orphan=False):
        app = app or self.app
        return self.spawn([str(app / "bin" / "headless_shell"), "--headless"], cwd=app, run_id=run_id, orphan=orphan)

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
        self._register(pid)

    def same(self, pid: int) -> bool:
        """`pid` is alive and still the process the registry recorded."""
        st = REAL_STAT(pid)
        return st is not None and st.state not in procfs.DEAD_STATES and self.registry.get(pid) == st.start

    def mine(self) -> list[int]:
        """Every live process this test started: the registry, their
        descendants, and what this pytest process started since the test
        began (a check's command, a run_scope's children). Nothing older."""
        me = os.getpid()
        live: dict[int, procfs.Stat] = {}
        for pid in REAL_ALL_PIDS():
            st = REAL_STAT(pid)
            if st is not None and st.state not in procfs.DEAD_STATES:
                live[pid] = st
        anchors = {pid for pid in self.registry if self.same(pid)}
        out = []
        for pid, st in live.items():
            if st.start < self.t0 or pid == me:
                continue
            seen, cur = set(), pid
            while cur > 1 and cur not in seen and cur in live:
                if cur in anchors or cur == me:
                    out.append(pid)
                    break
                seen.add(cur)
                cur = live[cur].ppid
        return sorted(out)

    def leaked(self) -> list[int]:
        """Registered processes still alive as the same process."""
        return sorted(pid for pid in self.registry if self.same(pid))

    def kill_all(self) -> None:
        for pid in list(self.registry):
            if self.same(pid):
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


class StaleBox:
    """Simulated processes left running on the box by other runs: pids above
    /proc/sys/kernel/pid_max, answered by patched procfs reads. A real pid
    passes straight through to the real reader."""

    def __init__(self):
        self.base = int(Path("/proc/sys/kernel/pid_max").read_text()) + 1000
        self.entries: dict[int, dict] = {}

    def add(self, argv, *, comm="node", age_s, cwd, tag=None, ppid=1, own=True) -> int:
        pid = self.base + len(self.entries)
        start = max(1, int(((procfs.uptime_s() or 0.0) - age_s) * TICK))
        stat = procfs.Stat(comm, "S", ppid, start, 0, 0)
        self.entries[pid] = {"stat": stat, "argv": list(argv), "cwd": cwd, "tag": tag, "own": own}
        return pid

    def add_box_of_22_nov(self, root="/srv/stale-box/workspaces") -> list[int]:
        """The 22 Nov 2026 leftovers, in a farm workspace outside the test's."""
        day, hour = 86400, 3600
        hz923 = f"{root}/FinTekkers__horizon__items/hz-923"
        hz930 = f"{root}/FinTekkers__horizon__premerge/hz-930"
        pids = [self.add(["node", "src/server.js", port], age_s=26 * day, cwd=f"{root}/FinTekkers__horizon__items/hz-9/server") for port in ("36533", "40613", "55319")]
        pids.append(self.add(["node", f"{hz923}/farm/capture/worker.mjs"], age_s=46 * hour, cwd=hz923))
        pids += [self.add(["headless_shell", "--headless"], comm="headless_shell", age_s=46 * hour, cwd="/", ppid=pids[3]) for _ in range(5)]
        pids.append(self.add(["node", f"{hz930}/farm/capture/node_modules/playwright/cli.js", "test", "-c", "pw.config.cjs"], age_s=24 * hour, cwd=hz930))
        return pids

    def own(self) -> list[int]:
        return [pid for pid, entry in self.entries.items() if entry["own"]]

    def install(self, monkeypatch) -> None:
        entries = self.entries

        def stat(pid):
            return entries[pid]["stat"] if pid in entries else REAL_STAT(pid)

        def cmdline(pid):
            return list(entries[pid]["argv"]) if pid in entries else REAL_CMDLINE(pid)

        def environ_value(pid, name):
            if pid in entries:
                return entries[pid]["tag"] if name == run_reaper.RUN_ENV else None
            return REAL_ENVIRON_VALUE(pid, name)

        def link(pid, name):
            if pid in entries:
                return entries[pid]["cwd"] if name == "cwd" else None
            return REAL_LINK(pid, name)

        monkeypatch.setattr(procfs, "stat", stat)
        monkeypatch.setattr(procfs, "cmdline", cmdline)
        monkeypatch.setattr(procfs, "environ_value", environ_value)
        monkeypatch.setattr(procfs, "link", link)
