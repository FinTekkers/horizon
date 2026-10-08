"""HZ-248: the 'Validate project' check run on `main` — a fresh scratch
worktree outside every deployed checkout, always reaped, under the
check-slot limiter."""

import contextlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from farm import check_slots, checks, premerge, validate, workspaces
from farm.checks import CheckFailure
from farm.tests.test_workspaces import git, make_repo_hub

REPO = "acme/demo"


@pytest.fixture
def ws_dir(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root)
    monkeypatch.setattr(validate, "WORKSPACES_DIR", root)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    return tmp_path


@pytest.fixture
def hub(ws_dir):
    hub, _origin = make_repo_hub(ws_dir)
    return hub


def head(cwd):
    return subprocess.run(["git", "-C", str(cwd), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()


def worktrees(hub):
    return subprocess.run(["git", "-C", str(hub), "worktree", "list"], check=True, capture_output=True, text=True).stdout


def checks_homes(run_id):
    return list(Path(validate.tempfile.gettempdir()).glob(f"{validate.CHECKS_HOME_PREFIX}{run_id}-*"))


# ---- the path guard ----


def test_run_dir_is_outside_every_protected_root(ws_dir):
    forbid = [ws_dir / "deployed" / "horizon", ws_dir / "deployed" / "ui-service"]
    ws = validate.validate_path(REPO, "v3-1700000000000")
    validate.assert_validate_path(ws, forbid)
    for root in (*forbid, *premerge.DEPLOYED_ROOTS, validate.HORIZON_STATE_ROOT, premerge.RUNNING_CHECKOUT):
        assert not premerge._within(ws.resolve(), Path(root).resolve())
    assert ws.parent.name == "acme__demo__validate"


def test_path_guard_refuses_protected_and_off_pattern_paths(ws_dir, monkeypatch):
    root = validate.WORKSPACES_DIR
    refused = {
        "deployed root": premerge.DEPLOYED_ROOTS[0] / "acme__demo__validate" / "v1-1",
        "running checkout": premerge.RUNNING_CHECKOUT / "acme__demo__validate" / "v1-1",
        "horizon state": validate.HORIZON_STATE_ROOT / "horizon" / "v1-1",
        "items pool": root / "acme__demo__items" / "v1-1",
        "bad run id": root / "acme__demo__validate" / "Not_A_Run",
        "too deep": root / "acme__demo__validate" / "v1-1" / "sub",
    }
    for label, path in refused.items():
        with pytest.raises(validate.ValidateRefused):
            validate.assert_validate_path(path)
        assert label  # named for the failure message only
    # A --forbid root that contains the workspace refuses it.
    with pytest.raises(validate.ValidateRefused, match="protected"):
        validate.assert_validate_path(root / "acme__demo__validate" / "v1-1", [root])
    # ~/.horizon is refused even when the caller forgets to pass it.
    monkeypatch.setattr(validate, "HORIZON_STATE_ROOT", root)
    with pytest.raises(validate.ValidateRefused, match="protected"):
        validate.assert_validate_path(root / "acme__demo__validate" / "v1-1")


# ---- cleanup on every outcome ----


def _stub_run_checks(outcome, seen):
    def fake(ws, **kwargs):
        seen.update(kwargs)
        seen["ws"] = ws
        seen["existed"] = Path(ws).is_dir()
        if outcome == "passed":
            return "2 repo check(s) passed"
        if outcome == "failed":
            raise CheckFailure("repo checks failed (npm test)", command="npm test", tail="1 failing")
        if outcome == "errored":
            raise RuntimeError("boom")
        raise CheckFailure("repo checks ran out of time before: npm test", command="npm test", reason="timed_out")

    return fake


@pytest.mark.parametrize(
    "outcome,reason",
    [("passed", None), ("failed", "checks_failed"), ("errored", "crash"), ("ran_out", "timed_out")],
)
def test_workspace_and_farm_home_are_reaped_on_every_outcome(hub, monkeypatch, outcome, reason):
    seen = {}
    monkeypatch.setattr(validate, "run_checks", _stub_run_checks(outcome, seen))
    forbid = [str(hub.parent / "deployed")]
    result = validate.validate_checks(REPO, "v1-100", head(hub), timeout_s=600, forbidden=forbid, log=lambda *_: None)

    assert result["ok"] is (outcome == "passed")
    assert result.get("reason") == reason
    assert result.get("detail")
    assert seen["existed"] is True
    assert seen["caller"] == "validate"  # the check-slot limiter path
    ws = Path(seen["ws"])
    assert ws == validate.validate_path(REPO, "v1-100")
    assert not ws.exists()
    assert str(ws) not in worktrees(hub)
    farm_home = Path(seen["child_env"]["FARM_HOME"])
    assert farm_home.name.startswith(validate.CHECKS_HOME_PREFIX)
    assert not farm_home.exists()
    assert not (validate._validate_root(REPO) / ".v1-100.lock").exists()


def test_reap_only_cleans_up_after_a_killed_run(hub, ws_dir):
    run_id = "v2-200"
    ws = validate.validate_path(REPO, run_id)
    ws.parent.mkdir(parents=True, exist_ok=True)
    git(hub, "worktree", "add", "--detach", str(ws), "HEAD")
    home = Path(validate.tempfile.mkdtemp(prefix=f"{validate.CHECKS_HOME_PREFIX}{run_id}-"))
    assert str(ws) in worktrees(hub)

    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    env["FARM_HOME"] = str(ws_dir)  # WORKSPACES_DIR = FARM_HOME/workspaces in the child
    proc = subprocess.run(
        [sys.executable, "-m", "farm.validate", REPO, run_id, "--reap-only", "--forbid", str(ws_dir / "deployed")],
        cwd=premerge.RUNNING_CHECKOUT,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert json.loads(proc.stdout) == {"ok": True, "workspace": str(ws)}, proc.stderr
    assert not ws.exists()
    assert str(ws) not in worktrees(hub)
    assert not home.exists()


# ---- concurrency: the sweep and the hub lock ----


def test_sweep_spares_a_run_whose_lock_is_held(hub):
    live = validate.validate_path(REPO, "v1-1")
    dead = validate.validate_path(REPO, "v1-2")
    live.parent.mkdir(parents=True, exist_ok=True)
    git(hub, "worktree", "add", "--detach", str(live), "HEAD")
    git(hub, "worktree", "add", "--detach", str(dead), "HEAD")

    with validate._run_lock(REPO, "v1-1") as held:
        assert held
        reaped = validate.reap_leftovers(REPO, hub, [], log=lambda *_: None)
        assert reaped == ["v1-2"]
        assert live.is_dir()
        assert not dead.exists()
    git(hub, "worktree", "remove", "--force", str(live))


def test_hub_lock_wraps_fetch_worktree_add_and_removal(hub, ws_dir, monkeypatch):
    # A main commit the hub has not fetched yet forces the fetch path.
    seed = ws_dir / "seed"
    (seed / "new.txt").write_text("x\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "new main")
    git(seed, "push", str(ws_dir / "origin.git"), "main")
    main_sha = head(seed)

    depth = {"n": 0}
    real_lock = workspaces.hub_lock

    @contextlib.contextmanager
    def spy_lock(repo_full):
        with real_lock(repo_full):
            depth["n"] += 1
            try:
                yield
            finally:
                depth["n"] -= 1

    calls = []

    def spy_git(real):
        def wrapped(path, *args, **kwargs):
            calls.append((args[0], args[1] if len(args) > 1 else None, depth["n"]))
            return real(path, *args, **kwargs)

        return wrapped

    monkeypatch.setattr(workspaces, "hub_lock", spy_lock)
    monkeypatch.setattr(validate, "_git", spy_git(premerge._git))
    monkeypatch.setattr(premerge, "_git", spy_git(premerge._git))
    monkeypatch.setattr(validate, "run_checks", lambda ws, **kw: "ok")

    result = validate.validate_checks(REPO, "v1-300", main_sha, timeout_s=600, log=lambda *_: None)
    assert result["ok"] is True, result
    mutations = [c for c in calls if c[0] == "fetch" or (c[0] == "worktree" and c[1] in ("add", "remove", "prune"))]
    assert {c[0] for c in mutations} == {"fetch", "worktree"}
    assert any(c[1] == "add" for c in mutations) and any(c[1] == "remove" for c in mutations)
    assert all(depth_at_call >= 1 for *_, depth_at_call in mutations), mutations


# ---- the limiter: a hung check run gives its slot back ----


def test_hung_checks_end_timed_out_and_release_the_check_slot(hub, tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "slot-home"))
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "5")
    monkeypatch.setenv("FARM_CHECK_CMD", "sleep 30")

    started = time.monotonic()
    result = validate.validate_checks(REPO, "v1-400", head(hub), timeout_s=validate.RESERVE_S + 1, log=lambda *_: None)
    assert result["reason"] == "timed_out", result
    assert time.monotonic() - started < 20

    deadline = time.monotonic() + 5
    while True:
        with check_slots.check_slot(poll_s=0.05) as hold:
            if hold.mode == "held":
                break
        assert time.monotonic() < deadline, "the check slot was not released"


# ---- HZ-304: a marked repo runs nothing; an unmarked one fails by name ----


def test_with_no_commands_and_no_waiver_the_run_fails_by_name(hub):
    result = validate.validate_checks(REPO, "v1-304", head(hub), timeout_s=600, log=lambda *_: None)
    assert result["ok"] is False
    assert result["reason"] == "no_checks_detected"
    assert result["detail"] == "no check commands configured for this repo"


def test_cli_no_checks_waiver_runs_nothing_and_reports_the_waiver(hub, monkeypatch, capsys):
    def no_slot(*_a, **_k):
        raise AssertionError("a waived run must not take a check slot")

    monkeypatch.setattr(checks.check_slots, "check_slot", no_slot)
    code = validate.main([REPO, "v1-305", head(hub), "--checks-waiver", "no_checks"])
    result = json.loads(capsys.readouterr().out.strip())
    assert code == 0
    assert result["ok"] is True
    assert result["detail"] == "checks waived for this repo: marked 'no checks' in Admin"


def test_configured_commands_whose_runner_is_missing_fail_none_ran(hub, monkeypatch):
    def missing(cmd, *_a, **_k):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(checks, "_run_bounded", missing)
    result = validate.validate_checks(
        REPO, "v1-306", head(hub), timeout_s=600, configured={"test": "npm test"}, checks_waiver="no_checks", log=lambda *_: None
    )
    assert result["ok"] is False
    assert result["reason"] == "no_checks_detected"
    assert "every check runner is missing on this host" in result["detail"]


# ---- HZ-349: validate never records a branch run ----


def test_validate_never_runs_or_records_a_branch_run(hub, monkeypatch):
    """Even when scripts/checks/ looks changed, validate passes no test_runs,
    so the branch pass is never reached."""
    monkeypatch.setattr(checks, "branch_script_changes", lambda ws, log: {"scripts/checks/test.sh"})
    monkeypatch.setattr(checks, "_run_branch_pass", lambda *a, **k: pytest.fail("validate ran a branch run"))
    result = validate.validate_checks(
        REPO, "v1-349", head(hub), timeout_s=600, configured={"test": "true"}, log=lambda *_: None
    )
    assert result["ok"] is True, result
    assert "test_runs" not in result and "branch_notes" not in result
