"""HZ-183: the pre-merge check — a test-merge of the PR head into the base tip,
in a scratch worktree, judged by farm/checks.py's own checks.

The headline case replays the HZ-154 x HZ-156 crossing with a fixture repo:
main gains a test banning direct extract_json() calls, a PR branched before
that adds one. Each side is green alone; the merge is red, and the result
names the failing check and the failing test.
"""

import json
import os
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


def run(hub_shas, head, base, **kw):
    return premerge.premerge_check(REPO, "HZ-154", head, base, timeout_s=kw.pop("timeout_s", 600), log=lambda *_: None, **kw)


# ---- success metric: the HZ-154 x HZ-156 replay blocks the merge ----


def test_replay_of_the_hz154_hz156_crossing_is_red_though_each_side_is_green_alone(ws_dir):
    hub, s = crossing_fixture(ws_dir)

    main_alone = run(hub, s["main"], s["main"])
    pr_alone = run(hub, s["pr_head"], s["fork"])
    assert main_alone["ok"] is True, main_alone
    assert pr_alone["ok"] is True, pr_alone

    crossed = run(hub, s["pr_head"], s["main"])
    assert crossed["ok"] is False
    assert crossed["reason"] == "checks_failed"
    assert "pytest" in crossed["failing_check"]
    assert "test_no_module_calls_extract_json_directly" in crossed["tail"]
    assert crossed["head_sha"] == s["pr_head"] and crossed["base_sha"] == s["main"]


def test_the_green_result_reports_the_tested_commits_and_the_merge(ws_dir):
    hub, s = crossing_fixture(ws_dir)
    result = run(hub, s["pr_head"], s["fork"])
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
    run(hub, s["pr_head"], s["main"])  # red
    run(hub, s["pr_head"], s["fork"])  # green
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


def test_cli_checks_never_inherit_the_real_farm_home(ws_dir):
    """The checks run the PR's code; the farm's own conftest only setdefaults
    FARM_HOME, so an inherited value would point the PR's tests at the real
    farm's queue."""
    hub, s = crossing_fixture(ws_dir)
    env = {**os.environ, "FARM_HOME": str(ws_dir), "FARM_CHECK_CMD": 'test -z "$FARM_HOME"'}
    proc = subprocess.run(
        [sys.executable, "-m", "farm.premerge", REPO, "HZ-154", s["pr_head"], "--base", s["main"]],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(premerge.RUNNING_CHECKOUT),
    )
    assert json.loads(proc.stdout)["ok"] is True, proc.stdout + proc.stderr
