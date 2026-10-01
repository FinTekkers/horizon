"""HZ-140: the live-session half of "no agent session holds a gate-approving
credential".

test_tmux_env.py proves tmux_mgr.agent_env() excludes the credentials. That is
a statement about a function. This file drives the real tool over a real tmux
session, which is the only thing that would catch a session launched with the
old policy — tmux sessions keep the environment they were started with.

The tool ships tested rather than as a thing a human remembers to run.
"""

import os
import shutil
import subprocess

import pytest

from farm import tmux_mgr
from farm.tools import check_session_env as cse

tmux_available = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
proc_available = pytest.mark.skipif(
    not os.path.isdir("/proc/self"), reason="/proc is Linux-only; the live check is a Linux deploy check"
)

SECRET_VALUE = "super-secret-approval-value"


# ---- parsing, over fixture blobs ----


def test_names_in_environ_returns_names_only():
    blob = b"FARM_SHARED_SECRET=hunter2\0WA_APPROVAL_SECRET=hunter3\0FARM_HOME=/tmp\0"
    names = cse.names_in_environ(blob)
    assert names == {"FARM_SHARED_SECRET", "WA_APPROVAL_SECRET", "FARM_HOME"}
    # Values are never carried out of the parser.
    assert not any("hunter" in n for n in names)


def test_names_in_environ_tolerates_a_ragged_blob():
    assert cse.names_in_environ(b"") == set()
    assert cse.names_in_environ(b"\0\0") == set()
    assert cse.names_in_environ(b"NOEQUALS\0A=1\0") == {"A"}


def test_a_clean_environ_reports_no_leak(tmp_path, monkeypatch):
    monkeypatch.setattr(cse, "env_names", lambda pid: {"FARM_HOME", "HORIZON_URL"})
    assert cse.leaked_names(1234, frozenset(tmux_mgr.NEVER_FORWARD)) == []


def test_a_dirty_environ_reports_the_names_it_found(monkeypatch):
    monkeypatch.setattr(cse, "env_names", lambda pid: {"FARM_SHARED_SECRET", "FARM_HOME"})
    assert cse.leaked_names(1234, frozenset(tmux_mgr.NEVER_FORWARD)) == ["FARM_SHARED_SECRET"]


def test_a_vanished_or_unreadable_proc_entry_is_skipped_not_crashed_on():
    # pid 0 has no /proc entry; a real scan races process exit constantly.
    assert cse.env_names(0) == set()
    assert cse.leaked_names(0, frozenset(tmux_mgr.NEVER_FORWARD)) == []


def test_the_concierge_grant_is_subtracted_from_what_counts_as_a_leak():
    assert cse.forbidden_names("farm-run-x") == frozenset(tmux_mgr.NEVER_FORWARD)
    assert cse.forbidden_names("farm-concierge-horizon") == frozenset({"FARM_SHARED_SECRET"})


# ---- reporting: names out, values never ----


def test_the_report_prints_names_and_never_a_value(monkeypatch, capsys):
    monkeypatch.setattr(cse, "scan", lambda: {"farm-run-x": {4242: ["FARM_SHARED_SECRET"]}})
    monkeypatch.setattr(cse, "grants_held", lambda: {})
    assert cse.main() == 1
    out = capsys.readouterr().out
    assert "FARM_SHARED_SECRET" in out and "farm-run-x" in out
    assert SECRET_VALUE not in out
    assert "hunter" not in out


def test_a_clean_scan_exits_zero(monkeypatch, capsys):
    monkeypatch.setattr(cse, "scan", lambda: {})
    monkeypatch.setattr(cse, "grants_held", lambda: {})
    assert cse.main() == 0
    assert "clean" in capsys.readouterr().out


def test_the_concierge_grant_is_reported_rather_than_passed_over(monkeypatch, capsys):
    """The tool judges by the launch policy, so the concierge holding
    WA_APPROVAL_SECRET is not a leak. Reporting it anyway is the difference
    between "clean" meaning "nothing unexpected" and being read as "nothing
    running here can approve a gate" — which would be false."""
    monkeypatch.setattr(cse, "scan", lambda: {})
    monkeypatch.setattr(
        cse, "grants_held", lambda: {"farm-concierge-horizon": {99: ["WA_APPROVAL_SECRET"]}}
    )
    assert cse.main() == 0
    out = capsys.readouterr().out
    assert "GRANT farm-concierge-horizon pid 99: WA_APPROVAL_SECRET" in out
    assert "LEAK" not in out
    # The residual is named where someone reading the output will see it.
    assert "/proc" in out
    assert SECRET_VALUE not in out


def test_a_grant_and_a_leak_are_reported_separately(monkeypatch, capsys):
    monkeypatch.setattr(cse, "scan", lambda: {"farm-run-x": {42: ["WA_APPROVAL_SECRET"]}})
    monkeypatch.setattr(
        cse, "grants_held", lambda: {"farm-concierge-horizon": {99: ["WA_APPROVAL_SECRET"]}}
    )
    assert cse.main() == 1
    out = capsys.readouterr().out
    assert "GRANT farm-concierge-horizon" in out
    assert "LEAK farm-run-x pid 42: WA_APPROVAL_SECRET" in out
    # Only the leak sets the exit status; "clean" must not appear alongside it.
    assert "clean" not in out


def test_grants_held_asks_for_the_granted_names_not_the_forbidden_ones(monkeypatch):
    monkeypatch.setattr(cse, "session_pids", lambda session: [7])
    monkeypatch.setattr(cse, "env_names", lambda pid: {"WA_APPROVAL_SECRET", "FARM_HOME"})
    assert cse.grants_held(["farm-concierge-horizon"]) == {"farm-concierge-horizon": {7: ["WA_APPROVAL_SECRET"]}}
    # A step session is granted nothing, so it can never appear on a GRANT line
    # — the same holding is a leak there, and scan() is what reports it.
    assert cse.grants_held(["farm-run-x"]) == {}
    assert cse.scan(["farm-run-x"]) == {"farm-run-x": {7: ["WA_APPROVAL_SECRET"]}}


# ---- the live check, over real tmux ----


@tmux_available
@proc_available
@pytest.mark.real_tmux
def test_a_real_step_session_holds_neither_credential(monkeypatch):
    """The end of the forgery path, measured rather than argued: launch a step
    session through the same code farmd uses, then read the pane process's own
    /proc environ."""
    env = dict(os.environ)
    env["FARM_SHARED_SECRET"] = SECRET_VALUE
    env["WA_APPROVAL_SECRET"] = SECRET_VALUE
    env["FARM_HOME"] = env.get("FARM_HOME", "/tmp")
    monkeypatch.setattr(tmux_mgr.os, "environ", env)

    name = "farm-run-hz140-envcheck-s11-a1"
    tmux_mgr.new_session(name, "sleep 30", cwd="/tmp")
    try:
        assert tmux_mgr.session_exists(name)
        pids = cse.session_pids(name)
        assert pids, "the session reported no pane process — the check would pass vacuously"
        assert cse.scan([name]) == {}
        # And the positive control: the session really did get its other vars,
        # so an empty leak report is not just an unreadable /proc.
        assert any("FARM_HOME" in cse.env_names(pid) for pid in pids)
    finally:
        tmux_mgr.kill_session(name)


@tmux_available
@proc_available
@pytest.mark.real_tmux
def test_the_live_check_would_catch_a_session_launched_the_old_way(monkeypatch):
    """A pre-upgrade session still holds the credential. If this didn't fail,
    the live check couldn't tell a clean host from a stale one."""
    name = "farm-run-hz140-legacy-s11-a1"
    # Exactly what _farm_env_prefix() used to build: every var, no denylist.
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", name, "-c", "/tmp", f"env FARM_SHARED_SECRET={SECRET_VALUE} sleep 30"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    try:
        assert tmux_mgr.session_exists(name)
        report = cse.scan([name])
        assert name in report
        assert any("FARM_SHARED_SECRET" in names for names in report[name].values())
    finally:
        tmux_mgr.kill_session(name)
