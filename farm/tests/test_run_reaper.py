"""HZ-569: farm/run_reaper.py — tags, leases, the reap and farmd's sweep.

Every process here is a real `node` process shaped like a capture worker, a
browser's parent or an e2e server (run_reaper_fakes.py), so kind_of() and the
/proc reads run for real. Each test sweeps a RUNS_DIR of its own: never the
suite's FARM_HOME, never the host's.

Metric line 4: one sweep kills a stray worker no active run owns and spares
the one an active run owns, and logs the stray with its worktree. Metric line
2's race: a lease owner the server has SIGKILLed but not yet reaped (a
zombie) counts as dead. Guardrails 1–3: a process is only ever killed for a
tag plus a dead lease in this RUNS_DIR, of a target kind; a service's own
untagged `node src/server.js` is never touched; cleanup never changes a
check's result.

HZ-963: orphaned check processes — untagged, or with no lease — in an idle
item or pre-merge workspace are stopped by workspace_sweep's orphan pass, and
the tests only ever see and signal what they started themselves:
`process_list` narrows procfs.own_pids/all_pids to Procs.mine() plus a
StaleBox of simulated leftovers (the 22 Nov 2026 box), and `kill_guard` fails
any test that signals a process it did not start."""

import dataclasses
import json
import os
import subprocess

import pytest

from farm import checks, procfs, run_reaper, workspace_sweep, workspaces
from farm.tests.run_reaper_fakes import (
    Procs,
    StaleBox,
    free_port,
    gone,
    make_app,
    make_workspace,
    pgrp,
    tag_env,
    wait_until,
    write_lease,
)


@pytest.fixture
def procs(tmp_path):
    p = Procs(make_app(tmp_path / "app"))
    try:
        yield p
    finally:
        p.kill_all()
        # Guardrail 4's other half: nothing the test started outlives it.
        wait_until("every process the test started to be gone", lambda: not p.leaked(), 5)


@pytest.fixture
def runs(tmp_path):
    return tmp_path / "runs"


@pytest.fixture
def stale():
    return StaleBox()


@pytest.fixture(autouse=True)
def process_list(procs, stale, monkeypatch):
    """The only processes any test here sees: its own and the StaleBox's."""
    stale.add_box_of_22_nov()
    stale.install(monkeypatch)
    monkeypatch.setattr(procfs, "own_pids", lambda: procs.mine() + stale.own())
    monkeypatch.setattr(procfs, "all_pids", lambda: procs.mine() + list(stale.entries))
    return stale


class KillGuard:
    def __init__(self, procs, stale):
        self.procs = procs
        self.stale = stale
        self.sent: list[tuple[int, int]] = []
        self.violations: list[str] = []

    def allowed(self, pid: int) -> bool:
        return pid > 1 and pid not in self.stale.entries and pid in self.procs.mine()

    def refuse(self, what: str):
        self.violations.append(what)
        raise AssertionError(f"a test signalled a process it did not start: {what}")


@pytest.fixture(autouse=True)
def kill_guard(procs, stale, monkeypatch):
    """Guardrail 4: every os.kill/os.killpg goes to a process this test
    started, or the test fails — also when the code under test swallowed the
    AssertionError."""
    guard = KillGuard(procs, stale)
    real_kill, real_killpg = os.kill, os.killpg

    def kill(pid, sig):
        if not guard.allowed(pid):
            guard.refuse(f"kill({pid}, {sig})")
        guard.sent.append((pid, sig))
        return real_kill(pid, sig)

    def killpg(pgid, sig):
        members = [pid for pid in procfs.all_pids() if pgrp(pid) == pgid]
        if pgid <= 1 or pgid in stale.entries or not all(guard.allowed(pid) for pid in members):
            guard.refuse(f"killpg({pgid}, {sig})")
        guard.sent.append((pgid, sig))
        return real_killpg(pgid, sig)

    monkeypatch.setattr(os, "kill", kill)
    monkeypatch.setattr(os, "killpg", killpg)
    yield guard
    assert guard.violations == []


@pytest.fixture
def ws(tmp_path, runs, monkeypatch):
    """A workspaces dir, task queue and RUNS_DIR of the test's own."""
    root = tmp_path / "workspaces"
    root.mkdir()
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(workspaces, "QUEUE_DIR", tmp_path / "queue")
    monkeypatch.setattr(run_reaper.config, "WORKSPACES_DIR", root)
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    return root


def wait_started(proc, kind):
    wait_until(f"pid {proc.pid} to be a {kind}", lambda: run_reaper.kind_of(proc.pid) == kind, 5)


# ---- metric line 4 ----


def test_one_sweep_kills_only_the_stray_worker_and_logs_its_worktree(procs, runs):
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-hz-546-stray", dead_pid, start=dead_start, item_id="HZ-546", worktree="/tmp/hz546-main-wt")
    owner = procs.owner()
    write_lease(runs, "chk-hz-549-live", owner.pid, item_id="HZ-549")
    stray = procs.worker("chk-hz-546-stray")
    owned = procs.worker("chk-hz-549-live")
    wait_started(stray, "capture_worker")
    wait_started(owned, "capture_worker")

    lines = []
    kills = run_reaper.sweep(runs_dir=runs, log=lines.append)

    assert [kill["pid"] for kill in kills] == [stray.pid]
    assert gone(stray.pid)
    assert procfs.alive(owned.pid), "a worker an active run owns is never swept"
    assert lines == [
        f"run_reaper: killed capture_worker pid={stray.pid} run=chk-hz-546-stray item=HZ-546 worktree=/tmp/hz546-main-wt"
    ]
    # The live run keeps its lease; the next sweep removes the stray's.
    assert (runs / "chk-hz-549-live.json").exists()
    run_reaper.sweep(runs_dir=runs, log=lines.append)
    assert not (runs / "chk-hz-546-stray.json").exists()


# ---- metric line 2: the owner the cap just killed is a zombie ----


@pytest.mark.parametrize("path", ["sweep", "reaper_cli"])
def test_a_zombie_lease_owner_counts_as_dead(procs, runs, monkeypatch, path):
    owner = procs.owner()
    lease = write_lease(runs, "premerge-hz-549-capped", owner.pid)
    worker = procs.worker("premerge-hz-549-capped")
    wait_started(worker, "capture_worker")
    owner.kill()  # what the cap does — and nobody has wait()ed for it yet
    wait_until("the owner to be a zombie", lambda: (procfs.stat(owner.pid) or procfs.Stat("", "Z", 0, 0)).state == "Z", 5)
    assert procfs.stat(owner.pid).start == lease["owner_start"], "same pid, same start time: only its state says dead"

    assert run_reaper.lease_active(lease) is False
    if path == "sweep":
        assert [kill["pid"] for kill in run_reaper.sweep(runs_dir=runs, log=lambda _: None)] == [worker.pid]
    else:
        monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
        assert run_reaper.main(["--run", "premerge-hz-549-capped"]) == 0
        assert not (runs / "premerge-hz-549-capped.json").exists()
    assert gone(worker.pid)


def test_the_reaper_cli_kills_nothing_while_the_owner_runs(procs, runs, monkeypatch, capsys):
    owner = procs.owner()
    write_lease(runs, "premerge-hz-549-live", owner.pid)
    worker = procs.worker("premerge-hz-549-live")
    wait_started(worker, "capture_worker")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    assert run_reaper.main(["--run", "premerge-hz-549-live"]) == 0
    assert '"killed": 0' in capsys.readouterr().out
    assert procfs.alive(worker.pid)


# ---- guardrail 1: never a process an active run owns, never by name alone ----


@pytest.mark.parametrize("case", ["untagged_worker", "tagged_sleep_dead_lease", "tagged_worker_no_lease", "lease_in_foreign_runs_dir"])
def test_the_sweep_spares_whatever_it_cannot_prove_is_an_orphan(procs, runs, tmp_path, case):
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-dead", dead_pid, start=dead_start)
    if case == "untagged_worker":
        proc = procs.worker(None)
    elif case == "tagged_sleep_dead_lease":
        proc = procs.spawn(["sleep", "600"], run_id="chk-dead")
    elif case == "tagged_worker_no_lease":
        proc = procs.worker("chk-no-lease-here")
    else:
        # Another FARM_HOME's run — a test's, another worktree's pytest's.
        write_lease(tmp_path / "other-farm-home" / "runs", "chk-foreign", dead_pid, start=dead_start)
        proc = procs.worker("chk-foreign")
    wait_until("the process to start", lambda: procfs.cmdline(proc.pid), 5)

    assert run_reaper.sweep(runs_dir=runs, log=lambda _: None) == []
    assert procfs.alive(proc.pid)


def test_the_suite_itself_carries_no_run_tag():
    assert run_reaper.RUN_ENV not in os.environ


def test_a_nested_scope_neither_reaps_the_outer_run_nor_removes_its_lease(procs, runs):
    env = {}
    with run_reaper.run_scope(env, item_id="HZ-569", caller="test", runs_dir=runs, log=lambda _: None) as outer:
        worker = procs.worker(outer)
        wait_started(worker, "capture_worker")
        inner_env = dict(env)
        with run_reaper.run_scope(inner_env, caller="nested", runs_dir=runs, log=lambda _: None) as inner:
            assert inner == outer
        assert procfs.alive(worker.pid), "the nested run's end left the outer run's worker alone"
        assert (runs / f"{outer}.json").exists()
        assert run_reaper.lease_active(run_reaper.read_lease(outer, runs))
    assert gone(worker.pid), "the outer run's own end reaps it"
    assert not (runs / f"{outer}.json").exists()


# ---- guardrail 3: services are never touched ----


def test_an_untagged_server_and_vite_preview_survive_every_sweep_and_reap(procs, runs):
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-dead", dead_pid, start=dead_start)
    server = procs.server(free_port(), None)  # what horizon-server runs
    vite = procs.vite(free_port(), None)
    wait_started(server, "e2e_server")
    wait_started(vite, "e2e_server")

    assert run_reaper.sweep(runs_dir=runs, log=lambda _: None) == []
    assert run_reaper.reap_run("chk-dead", log=lambda _: None) == 0
    assert run_reaper.reap_run("any-run-id", log=lambda _: None) == 0
    assert procfs.alive(server.pid) and procfs.alive(vite.pid)


def test_the_orphan_pass_spares_an_untagged_server_outside_every_workspace(procs, runs, ws):
    # The procs app dir is next to the workspaces dir, not in it: horizon-server.
    server = procs.server(free_port(), None, orphan=True)
    wait_started(server, "e2e_server")
    lines = []
    assert workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, log=lines.append) == []
    assert procfs.alive(server.pid)
    assert lines == []


# ---- guardrail 2: cleanup never changes a check's result ----


def _broken_reaper(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("reaper exploded")

    monkeypatch.setattr(run_reaper, "reap_run", boom)
    monkeypatch.setattr(run_reaper, "_reap", boom)


def test_a_failing_reap_still_raises_the_commands_timeout(tmp_path, monkeypatch):
    _broken_reaper(monkeypatch)
    env = tag_env(None)
    with run_reaper.run_scope(env, runs_dir=tmp_path / "runs", log=lambda _: None):
        with pytest.raises(subprocess.TimeoutExpired):
            checks._run_bounded(["sleep", "30"], tmp_path, 0.3, env)


@pytest.mark.parametrize("command", ["true", "echo boom; exit 3", "sleep 30"])
def test_a_failing_reap_leaves_run_checks_result_unchanged(tmp_path, monkeypatch, command):
    monkeypatch.setenv("FARM_CHECK_CMD", command)
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", tmp_path / "runs")
    ws = tmp_path / "ws"
    ws.mkdir()

    def outcome():
        try:
            return ("note", checks.run_checks(ws, log=lambda _: None))
        except checks.CheckFailure as exc:
            return ("failure", str(exc), exc.reason, exc.command, exc.headline)

    expected = outcome()
    _broken_reaper(monkeypatch)
    assert outcome() == expected


def test_a_lease_whose_pid_was_reused_is_dead(procs):
    owner = procs.owner()
    lease = {"owner_pid": owner.pid, "owner_start": procfs.stat(owner.pid).start - 1}
    assert run_reaper.lease_active(lease) is False


def _row(out, pid):
    rows = [p for p in out["processes"] if p["pid"] == pid]
    assert len(rows) == 1, f"pid {pid} is listed once"
    return rows[0]


def test_the_report_counts_a_worker_older_than_every_active_run(procs, runs, monkeypatch, capsys):
    """Metric line 3: only the test's own worker is asserted on, though the
    StaleBox's 26-day servers and 46-hour browsers are in the list too."""
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-dead", dead_pid, start=dead_start)
    worker = procs.worker("chk-dead")
    wait_started(worker, "capture_worker")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    assert _row(run_reaper.report(), worker.pid)["older_than_runs"] is True
    run_reaper.main(["--report"])
    assert f'"pid": {worker.pid}' in capsys.readouterr().out


def test_the_report_does_not_count_a_worker_an_active_run_owns(procs, runs, monkeypatch):
    owner = procs.owner()
    write_lease(runs, "chk-live", owner.pid)
    # Ages are reported to 0.1 s: the run must be measurably older than its worker.
    wait_until("the owner to be 0.5 s old", lambda: procfs.age_s(procfs.stat(owner.pid).start) > 0.5, 5)
    worker = procs.worker("chk-live")
    wait_started(worker, "capture_worker")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    assert _row(run_reaper.report(), worker.pid)["older_than_runs"] is False


def test_the_report_counts_an_untagged_server_only_inside_a_workspace(procs, runs, ws):
    app = make_workspace(ws, "hz-963")
    inside = procs.server(free_port(), None, app=app)
    outside = procs.server(free_port(), None)
    wait_started(inside, "e2e_server")
    wait_started(outside, "e2e_server")
    out = run_reaper.report(runs_dir=runs)
    assert {k: _row(out, inside.pid)[k] for k in ("item_id", "older_than_runs")} == {"item_id": "hz-963", "older_than_runs": True}
    assert {k: _row(out, outside.pid)[k] for k in ("item_id", "older_than_runs")} == {"item_id": None, "older_than_runs": False}


# ---- HZ-963 metric line 3: the tests see only what they started ----


def test_the_process_list_holds_only_the_tests_own_pids_and_the_stale_box(procs, stale):
    worker = procs.worker(None)
    wait_started(worker, "capture_worker")
    expected = set(procs.mine()) | set(stale.entries)
    assert worker.pid in procs.mine()
    assert set(procfs.own_pids()) <= expected and set(procfs.all_pids()) <= expected
    assert set(stale.own()) <= set(procfs.own_pids())
    assert os.getpid() not in procfs.own_pids()
    # A real pid passes through every patched read.
    raw = (procfs.PROC / str(worker.pid) / "stat").read_text()
    assert procfs.stat(worker.pid).start == int(raw[raw.rfind(")") + 2 :].split()[19])
    assert procfs.cmdline(worker.pid) == (procfs.PROC / str(worker.pid) / "cmdline").read_bytes().decode().split("\0")[:-1]
    assert procfs.link(worker.pid, "cwd") == os.readlink(procfs.PROC / str(worker.pid) / "cwd")


def test_a_stale_reap_target_gets_no_signal(procs, runs, stale, kill_guard):
    """Guardrail 4: a leftover shaped like a sweep target — a tagged worker
    whose lease in this RUNS_DIR is dead — but another user's, is never
    signalled; nor is any other StaleBox entry, by either pass."""
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-stale-dead", dead_pid, start=dead_start)
    target = stale.add(["node", "/srv/x/farm/capture/worker.mjs"], age_s=3600, cwd="/srv/x", tag="chk-stale-dead", own=False)
    assert run_reaper.kind_of(target) == "capture_worker"

    run_reaper.sweep(runs_dir=runs, log=lambda _: None)
    workspace_sweep.sweep_check_orphans(workspaces_dir=runs.parent, runs_dir=runs, min_age_s=0, log=lambda _: None)

    assert not [pid for pid, _sig in kill_guard.sent if pid in stale.entries]


# ---- HZ-963 metric line 1: one sweep stops every orphan kind ----

KINDS = ("e2e_server", "capture_worker", "playwright_runner", "browser")


def start_orphans(procs, app) -> dict[str, int]:
    """One double-forked stand-in of each kind, from `app`, with no tag."""
    port = free_port()
    started = {
        "e2e_server": procs.server(port, None, app=app, orphan=True),
        "capture_worker": procs.worker(None, app=app, orphan=True),
        "playwright_runner": procs.playwright(None, app=app, orphan=True),
        "browser": procs.browser(None, app=app, orphan=True),
    }
    for kind, proc in started.items():
        wait_started(proc, kind)
        procs.wait_ready(proc.pid)
    return {kind: proc.pid for kind, proc in started.items()}


@pytest.mark.parametrize("where", ["items", "premerge", "deleted"])
def test_one_sweep_stops_every_orphan_kind_in_an_idle_workspace(procs, runs, ws, where):
    app = make_workspace(ws, "hz-923", "__premerge" if where == "premerge" else "__items")
    pids = start_orphans(procs, app)
    if where == "deleted":
        # The 26-day servers' item worktrees were long reaped.
        subprocess.run(["rm", "-rf", str(app)], check=True, timeout=10)
        assert os.readlink(procfs.PROC / str(pids["e2e_server"]) / "cwd").endswith(" (deleted)")

    lines = []
    kills = workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, log=lines.append)

    for kind in KINDS:
        pid = pids[kind]
        wait_until(f"the {kind} to be gone", lambda: gone(pid), 5)
        assert f"workspace sweep: killed {kind} pid={pid} item=hz-923 reason=orphan" in lines
    assert sorted(kill["pid"] for kill in kills) == sorted(pids.values())


def test_a_workers_browser_goes_with_it(procs, runs, ws):
    app = make_workspace(ws, "hz-923")
    worker = procs.worker(None, app=app, orphan=True, child=True)
    browser = procs.worker_child()
    procs.wait_ready(worker.pid)
    procs.wait_ready(browser)
    assert run_reaper.kind_of(browser) == "browser"
    assert procfs.link(browser, "cwd") == "/", "only its parent is in the workspace"

    lines = []
    workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, log=lines.append)

    for kind, pid in (("capture_worker", worker.pid), ("browser", browser)):
        wait_until(f"the {kind} to be gone", lambda: gone(pid), 5)
        assert f"workspace sweep: killed {kind} pid={pid} item=hz-923 reason=orphan" in lines


# ---- HZ-963 metric line 2: an active run's look-alikes survive ----


@pytest.mark.parametrize("owner", ["lease", "task_file", "item_lock"])
def test_an_orphan_shaped_process_an_active_run_owns_survives(procs, runs, ws, owner):
    app = make_workspace(ws, "hz-923")
    pids = start_orphans(procs, app)
    lines = []

    def sweep():
        workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, log=lines.append)

    if owner == "lease":
        write_lease(runs, "chk-hz-923-live", procs.owner().pid, item_id="HZ-923", worktree=str(app))
        sweep()
    elif owner == "task_file":
        active = workspaces.QUEUE_DIR / "runs" / "active"
        active.mkdir(parents=True)
        (active / "hz-923.json").write_text(json.dumps({"item": {"id": "HZ-923"}}))
        sweep()
    else:
        with workspaces.item_lock("FinTekkers/horizon", "hz-923", wait_s=0):
            sweep()

    assert all(procfs.alive(pid) for pid in pids.values())
    assert lines == []


# ---- HZ-963 guardrail 2: a reused pid is never signalled ----


def test_the_orphan_pass_skips_a_pid_whose_start_changed(procs, runs, ws, monkeypatch):
    app = make_workspace(ws, "hz-923")
    server = procs.server(free_port(), None, app=app, orphan=True)
    wait_started(server, "e2e_server")
    real_scan = workspace_sweep.scan
    # As if the server had exited and its pid been reused between the scan and the signal.
    monkeypatch.setattr(workspace_sweep, "scan", lambda **kw: [dataclasses.replace(o, start=o.start - 1) for o in real_scan(**kw)])
    sent, lines = [], []

    workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, signal_fn=lambda *a: sent.append(a), log=lines.append)

    assert sent == [] and lines == []
    assert procfs.alive(server.pid)


def test_the_tag_pass_skips_a_pid_whose_start_changed(procs, runs, monkeypatch, kill_guard):
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-dead", dead_pid, start=dead_start)
    worker = procs.worker("chk-dead")
    wait_started(worker, "capture_worker")
    real_tagged = run_reaper._tagged
    monkeypatch.setattr(run_reaper, "_tagged", lambda *a: [(pid, run, start - 1) for pid, run, start in real_tagged(*a)])

    assert run_reaper.sweep(runs_dir=runs, log=lambda _: None) == []
    assert procfs.alive(worker.pid)
    assert worker.pid not in [pid for pid, _sig in kill_guard.sent]


# ---- HZ-963 guardrail 3: unclear ownership kills nothing ----


def test_an_unreadable_task_file_skips_the_orphan_pass(procs, runs, ws):
    app = make_workspace(ws, "hz-923")
    pids = start_orphans(procs, app)
    active = workspaces.QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True)
    (active / "hz-9.json").write_text("{not json")
    lines = []

    assert workspace_sweep.sweep_check_orphans(runs_dir=runs, min_age_s=0, log=lines.append) == []

    assert all(procfs.alive(pid) for pid in pids.values())
    assert lines == ["workspace sweep: orphan pass skipped, run state unreadable"]


def test_a_young_orphan_is_spared(procs, runs, ws):
    app = make_workspace(ws, "hz-923")
    server = procs.server(free_port(), None, app=app, orphan=True)
    wait_started(server, "e2e_server")
    lines = []
    assert workspace_sweep.sweep_check_orphans(runs_dir=runs, log=lines.append) == []
    assert procfs.alive(server.pid) and lines == []


# ---- HZ-963 metric line 4's proxy: farmd runs both passes ----


@pytest.mark.parametrize("broken", [None, "sweep", "orphans"])
def test_farmds_run_sweep_runs_both_passes(monkeypatch, capsys, broken):
    from farm import farmd

    calls = []

    def fake(name):
        def run(**kwargs):
            calls.append(name)
            if name == broken:
                raise RuntimeError("boom")
            return []

        return run

    monkeypatch.setattr(run_reaper, "sweep", fake("sweep"))
    monkeypatch.setattr(workspace_sweep, "sweep_check_orphans", fake("orphans"))
    farmd._sweep_runs()
    assert calls == ["sweep", "orphans"]
    if broken:
        assert "error: RuntimeError: boom" in capsys.readouterr().out
