"""HZ-183: the pre-merge check — a test-merge of the PR head into the base tip,
in a scratch worktree, judged by farm/checks.py's own checks.

The headline case replays the HZ-154 x HZ-156 crossing with a fixture repo:
main gains a test banning direct extract_json() calls, a PR branched before
that adds one. Each side is green alone; the merge is red, and the result
names the failing check and the failing test.
"""

import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

import pytest

from farm import checks, premerge, workspaces
from farm.tests.test_workspaces import git, make_repo_hub

REPO = "acme/demo"


@pytest.fixture
def ws_dir(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    return tmp_path


def sha(cwd, ref="HEAD"):
    return subprocess.run(
        ["git", "-C", str(cwd), "rev-parse", ref], check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(seed, files, message):
    for rel, body in files.items():
        path = seed / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    git(seed, "add", "-A")
    git(seed, "commit", "-m", message)
    return sha(seed)


BAN_TEST = '''\
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_no_module_calls_extract_json_directly():
    offenders = [
        str(p.relative_to(ROOT))
        for p in (ROOT / "pkg").glob("*.py")
        if p.name != "parser.py" and "extract_json(" in p.read_text()
    ]
    assert offenders == [], f"call the shared reply parser instead: {offenders}"
'''


def crossing_fixture(tmp_path):
    """origin/main: fork point -> HZ-156's ban test. PR branch (off the fork
    point): HZ-154's direct extract_json() call. Returns (hub, shas)."""
    hub, origin = make_repo_hub(tmp_path)
    seed = tmp_path / "seed"
    fork = commit(
        seed,
        {
            "pkg/__init__.py": "",
            "pkg/parser.py": "def extract_json(text):\n    return text\n",
            "tests/test_parser.py": "from pkg.parser import extract_json\n\n\ndef test_parse():\n    assert extract_json('x') == 'x'\n",
        },
        "parser",
    )
    git(seed, "checkout", "-b", "horizon/hz-154")
    pr_head = commit(
        seed,
        {"pkg/conflict_resolver.py": "from pkg.parser import extract_json\n\n\ndef resolve(r):\n    return extract_json(r)\n"},
        "HZ-154: resolver parses replies itself",
    )
    git(seed, "checkout", "main")
    main_tip = commit(seed, {"tests/test_ban_extract_json.py": BAN_TEST}, "HZ-156: one shared reply parser")
    git(seed, "push", "--quiet", str(origin), "main", "horizon/hz-154")
    return hub, {"fork": fork, "pr_head": pr_head, "main": main_tip}


# HZ-304: run_checks no longer auto-detects the fixture's pytest suite; this is
# the command auto-detection used to run, configured explicitly as in Admin.
PYTEST_CHECKS = {"test": f"{shlex.quote(sys.executable)} -m pytest -q"}


def run(hub_shas, head, base, **kw):
    return premerge.premerge_check(REPO, "HZ-154", head, base, timeout_s=kw.pop("timeout_s", 600), log=lambda *_: None, **kw)


# ---- success metric: the HZ-154 x HZ-156 replay blocks the merge ----


def test_replay_of_the_hz154_hz156_crossing_is_red_though_each_side_is_green_alone(ws_dir):
    hub, s = crossing_fixture(ws_dir)

    main_alone = run(hub, s["main"], s["main"], configured=PYTEST_CHECKS)
    pr_alone = run(hub, s["pr_head"], s["fork"], configured=PYTEST_CHECKS)
    assert main_alone["ok"] is True, main_alone
    assert pr_alone["ok"] is True, pr_alone

    crossed = run(hub, s["pr_head"], s["main"], configured=PYTEST_CHECKS)
    assert crossed["ok"] is False
    assert crossed["reason"] == "checks_failed"
    assert "pytest" in crossed["failing_check"]
    assert "test_no_module_calls_extract_json_directly" in crossed["tail"]
    assert crossed["head_sha"] == s["pr_head"] and crossed["base_sha"] == s["main"]


def test_the_green_result_reports_the_tested_commits_and_the_merge(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    result = run(hub, s["pr_head"], s["fork"], configured=PYTEST_CHECKS)
    assert result["ok"] is True
    assert result["head_sha"] == s["pr_head"]
    assert result["base_sha"] == s["fork"]
    merge_parents = subprocess.run(
        ["git", "-C", str(hub), "log", "-1", "--format=%P", result["merge_sha"]], capture_output=True, text=True
    )
    # The worktree is reaped, but the merge commit stays in the hub's objects.
    assert merge_parents.stdout.split() == [s["fork"], s["pr_head"]]


def test_the_scratch_worktree_is_reaped_after_every_run(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    run(hub, s["pr_head"], s["main"], configured=PYTEST_CHECKS)  # red
    run(hub, s["pr_head"], s["fork"], configured=PYTEST_CHECKS)  # green
    ws = premerge.premerge_path(REPO, "HZ-154")
    assert not ws.exists()
    assert str(ws) not in subprocess.run(
        ["git", "-C", str(hub), "worktree", "list"], capture_output=True, text=True
    ).stdout


# ---- fail closed ----


def test_no_hub_fails_closed(ws_dir):
    result = run(None, "a" * 40, "b" * 40)
    assert result["ok"] is False and result["reason"] == "no_hub"
    assert "start the farm" in result["detail"]


def test_a_merge_conflict_fails_closed(ws_dir):
    hub, origin = make_repo_hub(ws_dir)
    seed = ws_dir / "seed"
    git(seed, "checkout", "-b", "side")
    side = commit(seed, {"README.md": "side\n"}, "side")
    git(seed, "checkout", "main")
    main_tip = commit(seed, {"README.md": "main\n"}, "main")
    git(seed, "push", "--quiet", str(origin), "main", "side")
    result = run(hub, side, main_tip)
    assert result["ok"] is False and result["reason"] == "merge_conflict"


def test_a_repo_with_no_checks_fails_closed_and_says_so(ws_dir):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")
    result = run(hub, tip, tip)
    assert result["ok"] is False and result["reason"] == "no_checks_detected"


def test_an_unknown_commit_fails_closed(ws_dir):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")
    result = run(hub, "0" * 40, tip)
    assert result["ok"] is False and result["reason"] == "crash"


@pytest.mark.parametrize("head", ["main", "abc123", "", "$(touch x)"])
def test_anything_but_a_full_sha_is_refused_before_git_runs(ws_dir, head):
    result = run(None, head, "b" * 40)
    assert result["ok"] is False and result["reason"] == "bad_input"


def test_a_second_run_for_the_same_item_is_refused_while_one_holds_the_lock(ws_dir):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")
    with premerge._item_lock(REPO, "HZ-154") as held:
        assert held
        result = run(hub, tip, tip)
    assert result["ok"] is False and result["reason"] == "busy"


def test_the_whole_run_shares_one_budget_and_reports_a_structured_timeout(ws_dir, monkeypatch):
    """FARM_CHECK_TIMEOUT_S bounds each command alone; the deadline bounds the
    run. Two 3s commands under a 2s budget must stop at the first with a
    structured "timed_out" — not run on until the server's kill loses the JSON."""
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")
    monkeypatch.setattr(premerge, "RESERVE_S", 0)
    monkeypatch.setenv("FARM_CHECK_CMD", "sleep 3 && sleep 3")
    started = time.monotonic()
    result = run(hub, tip, tip, timeout_s=2)
    assert time.monotonic() - started < 6
    assert result["ok"] is False and result["reason"] == "timed_out"


# ---- success metric: never in /opt/horizon or a deployed checkout ----


def test_the_scratch_path_is_under_the_workspaces_dir(ws_dir):
    ws = premerge.premerge_path(REPO, "HZ-183")
    assert ws == ws_dir / "workspaces" / "acme__demo__premerge" / "hz-183"
    premerge.assert_scratch_path(ws)  # does not raise


@pytest.mark.parametrize(
    "path",
    ["/opt/horizon", "/opt/horizon/server", "/opt/horizon/../horizon/farm", "/tmp/elsewhere/acme__demo__premerge/x"],
)
def test_deployed_or_foreign_paths_are_refused(ws_dir, path):
    with pytest.raises(premerge.PremergeRefused):
        premerge.assert_scratch_path(Path(path))


def test_the_running_checkout_is_refused(ws_dir):
    with pytest.raises(premerge.PremergeRefused):
        premerge.assert_scratch_path(premerge.RUNNING_CHECKOUT)


def test_a_symlink_under_the_workspaces_dir_cannot_point_at_opt_horizon(ws_dir, monkeypatch):
    target = ws_dir / "deployed"
    target.mkdir()
    monkeypatch.setattr(premerge, "DEPLOYED_ROOTS", (target,))
    link = ws_dir / "workspaces" / "acme__demo__premerge" / "hz-1"
    link.parent.mkdir(parents=True)
    link.symlink_to(target)
    with pytest.raises(premerge.PremergeRefused):
        premerge.assert_scratch_path(link)


def test_a_refused_path_never_reaches_git(ws_dir, monkeypatch):
    monkeypatch.setattr(premerge, "premerge_path", lambda repo, item: Path("/opt/horizon"))
    result = run(None, "a" * 40, "b" * 40)
    assert result["ok"] is False and result["reason"] == "bad_workspace"


# ---- guardrail: one definition of which checks run ----


def test_premerge_names_no_check_of_its_own():
    """The only source of commands is checks.detect_check_commands (via
    run_checks); a literal check here would be a second definition."""
    source = Path(premerge.__file__).read_text()
    for literal in ('"npm', "'npm", '"pytest', "'pytest", '"lint', "'lint", "test:e2e"):
        assert literal not in source, literal
    assert "run_checks(" in source


# ---- CLI contract ----


def test_cli_stdout_is_exactly_one_json_line_even_when_checks_print(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    env = {
        **os.environ,
        "FARM_HOME": str(ws_dir),  # WORKSPACES_DIR = FARM_HOME/workspaces in the child
        "FARM_CHECK_CMD": "echo noisy-stdout; echo noisy-stderr >&2; exit 1",
    }
    proc = subprocess.run(
        [sys.executable, "-m", "farm.premerge", REPO, "HZ-154", s["pr_head"], "--base", s["fork"], "--json"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(premerge.RUNNING_CHECKOUT),
    )
    lines = proc.stdout.strip().splitlines()
    assert len(lines) == 1, proc.stdout
    result = json.loads(lines[0])
    assert proc.returncode == 1
    assert result["ok"] is False and result["reason"] == "checks_failed"
    assert "noisy-stdout" in result["tail"] and "noisy-stderr" in result["tail"]


def test_cli_exits_zero_only_on_green(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    env = {**os.environ, "FARM_HOME": str(ws_dir), "FARM_CHECK_CMD": "true"}
    proc = subprocess.run(
        [sys.executable, "-m", "farm.premerge", REPO, "HZ-154", s["pr_head"], "--base", s["main"]],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(premerge.RUNNING_CHECKOUT),
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["ok"] is True


def test_cli_checks_run_under_a_throwaway_farm_home_never_the_farms(ws_dir, tmp_path):
    """The checks run the PR's code; a PR test that inherited (or defaulted)
    FARM_HOME would read and write the live farm's queue and workspaces. They
    get a fresh directory instead, which is gone once the run ends."""
    hub, s = crossing_fixture(ws_dir)
    seen = tmp_path / "seen-farm-home"
    env = {**os.environ, "FARM_HOME": str(ws_dir), "FARM_CHECK_CMD": f'printf %s "$FARM_HOME" > {seen}'}
    proc = subprocess.run(
        [sys.executable, "-m", "farm.premerge", REPO, "HZ-154", s["pr_head"], "--base", s["main"]],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(premerge.RUNNING_CHECKOUT),
    )
    assert json.loads(proc.stdout)["ok"] is True, proc.stdout + proc.stderr
    checks_home = Path(seen.read_text())
    assert checks_home.name.startswith("horizon-premerge-farm-home-")
    assert checks_home != ws_dir and ws_dir not in checks_home.parents
    assert not checks_home.exists()


# ---- isolation: nothing outside the test's FARM_HOME, nothing outside __premerge ----


def item_worktree(hub, item_id):
    """A real item worktree on the hub, where farmd would put one."""
    path = workspaces.workspace_path(REPO, item_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    git(hub, "worktree", "add", "--quiet", "--detach", str(path), "origin/main")
    return path


def test_premerge_and_its_cleanup_touch_no_path_outside_the_tests_farm_home(ws_dir, monkeypatch):
    """Every path the pre-merge code hands git or rmtree must sit inside this
    test's own FARM_HOME. The farm's real ~/.horizon-farm (or anything else)
    showing up here is the attempt-3 isolation bug."""
    scratch_tmp = ws_dir / "tmp"
    scratch_tmp.mkdir()
    monkeypatch.setattr(premerge.tempfile, "tempdir", str(scratch_tmp))
    touched = []
    real_git, real_rmtree = premerge._git, premerge.shutil.rmtree

    def spy_git(path, *args, **kw):
        touched.append(Path(path))
        touched.extend(Path(a) for a in args if a.startswith("/"))
        return real_git(path, *args, **kw)

    def spy_rmtree(path, *args, **kw):
        touched.append(Path(path))
        return real_rmtree(path, *args, **kw)

    monkeypatch.setattr(premerge, "_git", spy_git)
    monkeypatch.setattr(premerge.shutil, "rmtree", spy_rmtree)
    hub, s = crossing_fixture(ws_dir)
    monkeypatch.setenv("FARM_CHECK_CMD", f'test "$FARM_HOME" != "{ws_dir}" && {sys.executable} -m pytest -q')

    assert run(hub, s["pr_head"], s["fork"])["ok"] is True
    assert run(hub, s["pr_head"], s["main"])["reason"] == "checks_failed"

    assert touched, "the spies saw nothing — the test is not observing premerge"
    root = ws_dir.resolve()
    outside = [p for p in touched if p.resolve() != root and root not in p.resolve().parents]
    assert outside == []


def test_runs_leave_every_item_worktree_on_the_hub_alone(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    items = [item_worktree(hub, "hz-1"), item_worktree(hub, "hz-2")]
    run(hub, s["pr_head"], s["main"], configured=PYTEST_CHECKS)  # red
    run(hub, s["pr_head"], s["fork"], configured=PYTEST_CHECKS)  # green
    listed = subprocess.run(["git", "-C", str(hub), "worktree", "list"], capture_output=True, text=True).stdout
    for path in items:
        assert path.is_dir() and (path / ".git").exists()
        assert str(path) in listed


@pytest.mark.parametrize(
    "victim",
    ["item", "items_root", "hub", "premerge_root", "workspaces_dir"],
)
def test_cleanup_can_only_remove_a_premerge_scratch_path(ws_dir, victim):
    """_remove_scratch is the one deleting call in farm/premerge.py; fed any
    path but <WORKSPACES_DIR>/<repo>__premerge/<item> it refuses, and the
    target survives — whether or not git knows it as a worktree."""
    hub, _origin = make_repo_hub(ws_dir)
    item = item_worktree(hub, "hz-1")
    premerge_root = premerge.premerge_path(REPO, "hz-1").parent
    premerge_root.mkdir(parents=True)
    path = {
        "item": item,
        "items_root": item.parent,
        "hub": hub,
        "premerge_root": premerge_root,
        "workspaces_dir": ws_dir / "workspaces",
    }[victim]
    with pytest.raises(premerge.PremergeRefused):
        premerge._reap(REPO, hub, path)
    assert path.is_dir()
    assert item.is_dir() and str(item) in subprocess.run(
        ["git", "-C", str(hub), "worktree", "list"], capture_output=True, text=True
    ).stdout


# ---- HZ-245: the repo's configured check commands ----


def test_cli_check_commands_run_exactly_the_configured_slots(ws_dir, monkeypatch, capsys):
    """A partial config (install + test) is exactly what the test-merge runs —
    the crossed merge's pytest suite, which auto-detection would run and
    fail on, is not run at all."""
    hub, s = crossing_fixture(ws_dir)
    ran = []
    monkeypatch.setattr(
        checks,
        "_run_bounded",
        lambda cmd, ws, timeout_s, env: ran.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""),
    )
    configured = {"install": "npm install --ignore-scripts", "test": "npm test", "lint": None, "e2e": None}

    code = premerge.main(
        [REPO, "HZ-154", s["pr_head"], "--base", s["main"], "--json", "--check-commands", json.dumps(configured)]
    )

    result = json.loads(capsys.readouterr().out)
    assert code == 0 and result["ok"] is True, result
    assert ran == [["sh", "-c", "npm install --ignore-scripts"], ["sh", "-c", "npm test"]]


@pytest.mark.parametrize("bad", ["{not json", "[]", '"npm test"', "null"])
def test_unreadable_check_commands_fail_closed_never_auto_detect(ws_dir, monkeypatch, capsys, bad):
    hub, s = crossing_fixture(ws_dir)
    ran = []
    monkeypatch.setattr(checks, "_run_bounded", lambda cmd, *a: ran.append(cmd))

    code = premerge.main([REPO, "HZ-154", s["pr_head"], "--base", s["fork"], "--check-commands", bad])

    result = json.loads(capsys.readouterr().out)
    assert code == 1
    assert result["ok"] is False and result["reason"] == "crash"
    assert ran == []


# ---- HZ-249: the dependency cache is keyed by the PR's repo ----


def test_premerge_passes_its_repo_to_run_checks_for_the_dependency_cache(ws_dir, monkeypatch):
    hub, s = crossing_fixture(ws_dir)
    seen = []
    real = premerge.run_checks
    monkeypatch.setattr(premerge, "run_checks", lambda ws, **kw: seen.append(kw.get("repo")) or real(ws, **kw))

    assert run(hub, s["pr_head"], s["fork"], configured=PYTEST_CHECKS)["ok"] is True
    assert seen == [REPO]


# ---- HZ-304: no commands, a waiver, and missing runners ----


def test_a_waived_repo_merges_with_the_waiver_named_and_runs_nothing(ws_dir, monkeypatch):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")

    def no_slot(*_a, **_k):
        raise AssertionError("a waived run must not take a check slot")

    monkeypatch.setattr(checks.check_slots, "check_slot", no_slot)
    result = run(hub, tip, tip, checks_waiver="predates_enforcement")
    assert result["ok"] is True
    assert result["note"] == "checks waived for acme/demo: item predates readiness enforcement"


def test_a_repo_with_no_commands_names_the_repo_in_its_failure(ws_dir):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")
    result = run(hub, tip, tip)
    assert result["reason"] == "no_checks_detected"
    assert result["detail"] == "no check commands configured for acme/demo"


def test_configured_commands_whose_runner_is_missing_block_the_merge(ws_dir, monkeypatch):
    hub, _origin = make_repo_hub(ws_dir)
    tip = sha(ws_dir / "seed")

    def missing(cmd, *_a, **_k):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(checks, "_run_bounded", missing)
    result = run(hub, tip, tip, configured={"test": "npm test"}, checks_waiver="no_checks")
    assert result["ok"] is False
    assert result["reason"] == "no_checks_detected"
    assert "every check runner is missing on this host" in result["detail"]


def test_cli_rejects_an_unknown_waiver(ws_dir, capsys):
    with pytest.raises(SystemExit):
        premerge.main(["acme/demo", "HZ-154", "a" * 40, "--base", "b" * 40, "--checks-waiver", "everything"])
    assert "invalid choice" in capsys.readouterr().err
