"""HZ-670: farm/workspace_sweep.py — leftover processes in finished items'
workspaces, and the zombie count.

Every process here is a fake /proc entry (a stat line, cwd and exe links and
a cmdline) under a temp procfs.PROC, so nothing real is ever signalled:
`signal_fn` and `sleep` are injected and record what the sweep would do.

Metric 1: an old process in finished hz-1's workspace is killed; a young one,
one in an item a run or lease holds, one outside the workspaces and one in
hz-10 are not. Metric 2: SIGTERM, then SIGKILL only while the pid still names
the same process, by pid only. Metric 3: the log has pid, item and age, never
the cmdline. Metric 4: state-Z entries counted by parent pid."""

import json
import os
import re
import signal
from pathlib import Path

import pytest

from farm import procfs, run_reaper, workspace_sweep, workspaces

UPTIME = 1_000_000.0
TICK = os.sysconf("SC_CLK_TCK")
SENTINEL = "SENTINEL-670"
HOUR = 3600


class FakeProc:
    """A temp /proc: one dir per pid with stat, cwd, exe and cmdline."""

    def __init__(self, root: Path, workspaces_dir: Path):
        self.root = root
        self.ws = workspaces_dir
        root.mkdir()
        (root / "uptime").write_text(f"{UPTIME} 123.0\n")

    def item_dir(self, item, repo="acme__demo", suffix="__items"):
        return self.ws / f"{repo}{suffix}" / item

    def add(self, pid, *, age_s=2 * HOUR, cwd=None, exe="/usr/bin/python3", state="S", ppid=1, session=0, tty=0, start=None):
        d = self.root / str(pid)
        d.mkdir()
        start = start if start is not None else int((UPTIME - age_s) * TICK)
        self.write_stat(pid, state=state, ppid=ppid, session=session, tty=tty, start=start)
        if cwd is not None:
            os.symlink(str(cwd), d / "cwd")
        if exe is not None:
            os.symlink(str(exe), d / "exe")
        (d / "cmdline").write_bytes(f"python3\0serve_app.py\0--token={SENTINEL}\0".encode())
        return start

    def write_stat(self, pid, *, state="S", ppid=1, session=0, tty=0, start=0):
        rest = " ".join(["0"] * 14)
        line = f"{pid} (serve_app {SENTINEL}) {state} {ppid} {pid} {session} {tty} {rest} {start} 0 0\n"
        (self.root / str(pid) / "stat").write_text(line)

    def move(self, pid, cwd):
        link = self.root / str(pid) / "cwd"
        link.unlink()
        os.symlink(str(cwd), link)

    def remove(self, pid):
        d = self.root / str(pid)
        for child in d.iterdir():
            child.unlink()
        d.rmdir()


@pytest.fixture
def proc(tmp_path, monkeypatch):
    ws = tmp_path / "workspaces"
    ws.mkdir()
    fake = FakeProc(tmp_path / "proc", ws)
    monkeypatch.setattr(procfs, "PROC", fake.root)
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", ws)
    monkeypatch.setattr(workspaces, "QUEUE_DIR", tmp_path / "queue")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", tmp_path / "runs")
    return fake


class Signals:
    def __init__(self, on_term=None):
        self.calls = []
        self.on_term = on_term

    def __call__(self, pid, sig):
        assert type(pid) is int, "only ever a pid"
        self.calls.append((pid, sig))
        if sig == signal.SIGTERM and self.on_term:
            self.on_term(pid)


def sweep(finished=("hz-1",), *, signals=None, sleep=None, min_age_s=workspace_sweep.MIN_AGE_S):
    signals = signals or Signals()
    lines = []
    orphans = workspace_sweep.scan(min_age_s=min_age_s)
    kills = workspace_sweep.kill(
        orphans, set(finished), grace_s=0.3, signal_fn=signals, sleep=sleep or (lambda _: None), log=lines.append
    )
    return orphans, kills, signals, lines


def termed(signals):
    return sorted(pid for pid, sig in signals.calls if sig == signal.SIGTERM)


def write_task(proc, item_id):
    active = workspaces.QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / f"{item_id}.json").write_text(json.dumps({"item": {"id": item_id.upper()}}))


def write_live_lease(proc, name, **fields):
    owner = 900 + len(list(proc.root.iterdir()))
    start = proc.add(owner, age_s=60)
    runs = run_reaper.config.RUNS_DIR
    runs.mkdir(exist_ok=True)
    (runs / f"{name}.json").write_text(json.dumps({"run_id": name, "owner_pid": owner, "owner_start": start, **fields}))


# ---- metric line 1 ----


def test_only_the_old_process_in_the_finished_items_workspace_is_killed(proc):
    proc.add(101, cwd=proc.item_dir("hz-1") / "server")  # old, finished: killed
    proc.add(102, cwd=proc.item_dir("hz-1"), age_s=30 * 60)  # young
    proc.add(103, cwd=proc.item_dir("hz-2"))  # active task file
    proc.add(104, cwd=proc.item_dir("hz-3"))  # active lease
    proc.add(105, cwd="/home/ubuntu/horizon/server")  # outside the workspaces
    proc.add(106, cwd=proc.item_dir("hz-10"))  # hz-10, only hz-1 finished
    write_task(proc, "hz-2")
    write_live_lease(proc, "chk-hz-3-1", item_id="HZ-3")

    orphans, kills, signals, _ = sweep(finished=("hz-1", "hz-2", "hz-3"))

    assert sorted(o.pid for o in orphans) == [101, 103, 104, 106]
    assert termed(signals) == [101]
    assert [k["pid"] for k in kills] == [101]


def test_a_process_whose_workspace_was_already_deleted_is_killed(proc):
    proc.add(101, cwd=f"{proc.item_dir('hz-1')} (deleted)", exe=None)
    assert not proc.item_dir("hz-1").exists()

    _, kills, signals, _ = sweep()

    assert termed(signals) == [101]
    assert kills[0]["item_id"] == "hz-1"


def test_a_process_whose_exe_is_in_the_workspace_is_killed(proc):
    proc.add(101, cwd="/", exe=proc.item_dir("hz-1") / "node_modules" / ".bin" / "esbuild")
    _, _, signals, _ = sweep()
    assert termed(signals) == [101]


# ---- metric line 2 ----


def test_sigterm_then_sigkill_while_the_pid_still_names_the_process(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    _, _, signals, _ = sweep()
    assert signals.calls == [(101, signal.SIGTERM), (101, signal.SIGKILL)]


def test_no_sigkill_once_the_process_is_gone_after_sigterm(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    sleeps = []
    _, kills, signals, _ = sweep(signals=Signals(on_term=proc.remove), sleep=sleeps.append)
    assert signals.calls == [(101, signal.SIGTERM)]
    assert sleeps == [], "nothing left to wait for"
    assert [k["pid"] for k in kills] == [101]


def test_two_orphans_share_one_grace_wait(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    proc.add(102, cwd=proc.item_dir("hz-1"))
    sleeps = []
    _, _, signals, _ = sweep(sleep=sleeps.append)
    assert sum(sleeps) == pytest.approx(0.3)
    assert signals.calls == [(101, signal.SIGTERM), (102, signal.SIGTERM), (101, signal.SIGKILL), (102, signal.SIGKILL)]


def test_the_sweep_kills_by_pid_only_never_by_name_or_pattern():
    source = Path(workspace_sweep.__file__).read_text()
    for banned in ("pkill", "killall", "killpg", "subprocess"):
        assert banned not in source, banned
    assert "cmdline" not in source and "environ" not in source


# ---- guardrail 2: a reused pid ----


def test_a_pid_reused_before_sigterm_gets_no_signal(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    orphans = workspace_sweep.scan()
    proc.write_stat(101, start=orphans[0].start + 1)
    signals = Signals()
    workspace_sweep.kill(orphans, {"hz-1"}, grace_s=0.3, signal_fn=signals, sleep=lambda _: None, log=lambda _: None)
    assert signals.calls == []


@pytest.mark.parametrize("change", ["new-start", "cwd-moved-out"])
def test_a_pid_reused_during_the_grace_gets_no_sigkill(proc, change):
    start = proc.add(101, cwd=proc.item_dir("hz-1"))

    def on_term(pid):
        if change == "new-start":
            proc.write_stat(pid, start=start + 7)
        else:
            proc.move(pid, "/home/ubuntu")

    _, _, signals, _ = sweep(signals=Signals(on_term=on_term))
    assert signals.calls == [(101, signal.SIGTERM)]


# ---- metric line 3 ----


def test_the_log_has_pid_item_and_age_and_never_the_cmdline(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"), age_s=26 * HOUR)
    proc.add(102, cwd=proc.item_dir("hz-1"), tty=34816, session=103)
    proc.add(103, cwd="/home/ubuntu", tty=34816, session=103)
    _, _, _, lines = sweep()
    assert lines == [
        "workspace sweep: spared pid=102 item=hz-1 (tty)",
        "workspace sweep: killed pid=101 item=hz-1 age=93600s",
    ]

    write_task(proc, "hz-9")
    (workspaces.QUEUE_DIR / "runs" / "active" / "hz-9.json").write_text("{not json")
    _, _, _, skipped = sweep()
    assert skipped == ["workspace sweep: skipped, run state unreadable"]
    for line in lines + skipped:
        assert SENTINEL not in line and "serve_app" not in line


# ---- metric line 4 ----


def test_zombies_are_counted_by_the_parent_that_holds_them(proc):
    proc.add(201, state="Z", ppid=1234)
    proc.add(202, state="Z", ppid=1234)
    proc.add(203, state="Z", ppid=88)
    proc.add(204, state="S", ppid=1234)

    zombies = workspace_sweep.count_zombies()

    assert zombies["count"] == 3
    assert zombies["parents"] == [{"ppid": 1234, "count": 2}, {"ppid": 88, "count": 1}]
    assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$", zombies["at"])
    assert SENTINEL not in json.dumps(zombies)


def test_the_zombie_parents_are_capped(proc):
    for i in range(25):
        proc.add(300 + i, state="Z", ppid=5000 + i)
    zombies = workspace_sweep.count_zombies()
    assert zombies["count"] == 25
    assert [p["ppid"] for p in zombies["parents"]] == list(range(5000, 5020))


# ---- guardrail 1: never anything outside the item workspaces ----


@pytest.mark.parametrize("case", ["farmd-ancestor", "tty-live-leader", "premerge", "sibling-dir", "items-root"])
def test_spared_processes(proc, case):
    if case == "farmd-ancestor":
        proc.add(os.getpid(), cwd="/", ppid=101)
        proc.add(101, cwd=proc.item_dir("hz-1"))
    elif case == "tty-live-leader":
        proc.add(101, cwd=proc.item_dir("hz-1"), tty=34816, session=102)
        proc.add(102, cwd="/home/ubuntu", tty=34816, session=102)
    elif case == "premerge":
        proc.add(101, cwd=proc.item_dir("hz-1", suffix="__premerge"))
    elif case == "sibling-dir":
        proc.add(101, cwd=proc.ws.parent / "workspaces-old" / "acme__demo__items" / "hz-1")
    else:
        proc.add(101, cwd=proc.ws / "acme__demo__items")

    _, kills, signals, _ = sweep()

    assert signals.calls == [] and kills == []


def test_a_tty_whose_session_leader_is_dead_is_killed(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"), tty=34816, session=102)
    _, _, signals, _ = sweep()
    assert termed(signals) == [101]


def test_a_parent_with_a_live_unlisted_child_is_spared_and_its_listed_child_killed(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))  # a tmux server or shell
    proc.add(102, cwd=proc.item_dir("hz-1"), ppid=101)  # its leftover: killed
    proc.add(103, cwd="/home/ubuntu", ppid=101)  # work outside the workspace

    _, _, signals, lines = sweep()

    assert termed(signals) == [102]
    assert "workspace sweep: spared pid=101 item=hz-1 (child)" in lines


# ---- guardrail 3: fails closed ----


def _garbled_task(proc):
    write_task(proc, "hz-9")
    (workspaces.QUEUE_DIR / "runs" / "active" / "hz-9.json").write_text("{not json")


def _garbled_lease(proc):
    runs = run_reaper.config.RUNS_DIR
    runs.mkdir()
    (runs / "chk-x.json").write_text("{not json")


def _runs_dir_a_file(proc):
    run_reaper.config.RUNS_DIR.write_text("")


def _lease_with_no_item(proc):
    write_live_lease(proc, "capture-x", item_id=None, worktree="/tmp/somewhere")


def _lock_probe_raises(proc, monkeypatch):
    def boom(repo_full, item_id):
        raise OSError("no /proc/locks")

    monkeypatch.setattr(workspaces, "item_lock_held", boom)


def _uptime_unreadable(proc):
    (proc.root / "uptime").unlink()


def _cwd_unreadable(proc):
    (proc.root / "101" / "cwd").unlink()
    (proc.root / "101" / "exe").unlink()


@pytest.mark.parametrize(
    "breakage",
    [_garbled_task, _garbled_lease, _runs_dir_a_file, _lease_with_no_item, _lock_probe_raises, _uptime_unreadable, _cwd_unreadable],
    ids=lambda f: f.__name__.strip("_"),
)
def test_anything_unreadable_kills_nothing(proc, monkeypatch, breakage):
    proc.add(101, cwd=proc.item_dir("hz-1"), exe=proc.item_dir("hz-1") / "bin")
    if breakage is _lock_probe_raises:
        breakage(proc, monkeypatch)
    else:
        breakage(proc)

    _, kills, signals, _ = sweep()

    assert signals.calls == [] and kills == []


def test_a_lease_with_only_a_worktree_protects_that_item(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    proc.add(102, cwd=proc.item_dir("hz-2"))
    write_live_lease(proc, "capture-hz-1", item_id=None, worktree=str(proc.item_dir("hz-1")))

    _, _, signals, _ = sweep(finished=("hz-1", "hz-2"))

    assert termed(signals) == [102]


def test_an_ended_lease_protects_nothing(proc):
    proc.add(101, cwd=proc.item_dir("hz-1"))
    write_live_lease(proc, "chk-hz-1", item_id="hz-1", ended_at="2026-10-30T00:00:00+00:00")
    _, _, signals, _ = sweep()
    assert termed(signals) == [101]
