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
check's result."""

import os
import subprocess

import pytest

from farm import checks, procfs, run_reaper
from farm.tests.run_reaper_fakes import Procs, free_port, gone, make_app, tag_env, wait_until, write_lease


@pytest.fixture
def procs(tmp_path):
    p = Procs(make_app(tmp_path / "app"))
    try:
        yield p
    finally:
        p.kill_all()


@pytest.fixture
def runs(tmp_path):
    return tmp_path / "runs"


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


def test_the_report_counts_a_worker_older_than_every_active_run(procs, runs, monkeypatch, capsys):
    dead_pid, dead_start = procs.dead_owner()
    write_lease(runs, "chk-dead", dead_pid, start=dead_start)
    worker = procs.worker("chk-dead")
    wait_started(worker, "capture_worker")
    monkeypatch.setattr(run_reaper.config, "RUNS_DIR", runs)
    out = run_reaper.report()
    mine = [p for p in out["processes"] if p["pid"] == worker.pid]
    assert mine and mine[0]["older_than_runs"] is True
    assert out["ok"] is False
    assert run_reaper.main(["--report"]) == 1
    assert f'"pid": {worker.pid}' in capsys.readouterr().out
