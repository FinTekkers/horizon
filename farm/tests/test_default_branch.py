"""HZ-425: the farm uses each repo's real default branch, never an assumed
`main`. price-service-rust's default was `master`; with origin/HEAD unset
every farm `_default_branch()` copy fell back to `main`.

The fixture is a real bare origin whose HEAD is `master`, cloned, with
refs/remotes/origin/HEAD deleted — the state the old fallback got wrong."""

import re
import subprocess
from pathlib import Path

import pytest

from farm import check_slots, checks, conflict_resolver, step_agent, workspaces
from farm.checks import CheckFailure, run_checks

FARM_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv(checks.RERUN_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)


def git(cwd, *args):
    return subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def write(root: Path, files: dict[str, str]) -> None:
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)


def master_repo(tmp_path: Path, files: dict[str, str] | None = None) -> tuple[Path, Path]:
    """(seed, ws): seed pushes to a bare origin whose default is master; ws is
    a clone on an item branch with no refs/remotes/origin/HEAD."""
    seed = tmp_path / "seed"
    seed.mkdir(parents=True)
    git(seed, "init", "-q", "-b", "master")
    write(seed, {"README": "one\n", **(files or {})})
    git(seed, "add", "-A")
    git(seed, "commit", "-qm", "first")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    git(seed, "remote", "add", "origin", str(origin))
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(origin), str(ws)], check=True)
    git(ws, "remote", "set-head", "origin", "--delete")
    git(ws, "checkout", "-q", "-b", "horizon/psr-2")
    assert subprocess.run(["git", "-C", str(ws), "symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).returncode != 0
    return seed, ws


# ---- metric 5 ----


def test_every_farm_caller_reads_master_when_origin_head_is_unset(tmp_path):
    seed, ws = master_repo(tmp_path)
    assert workspaces.default_branch(ws) == "master"
    # set-head --auto recorded it, so the next read stays local.
    assert git(ws, "symbolic-ref", "refs/remotes/origin/HEAD").strip() == "refs/remotes/origin/master"
    git(ws, "remote", "set-head", "origin", "--delete")

    # conflict_resolver merges origin/<default_branch(ws)> when no base is given.
    assert conflict_resolver.default_branch is workspaces.default_branch
    assert conflict_resolver.default_branch(ws) == "master"

    # merge_default_branch merges master's new commit — `origin/main` does not exist.
    git(ws, "remote", "set-head", "origin", "--delete")
    write(seed, {"README": "two\n"})
    git(seed, "commit", "-qam", "second")
    git(seed, "push", "-q", "origin", "master")
    git(ws, "fetch", "-q", "origin")
    assert step_agent.merge_default_branch(ws) == []
    assert (ws / "README").read_text() == "two\n"


def test_a_repo_whose_default_is_main_still_reads_main(tmp_path):
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-q", "-b", "main")
    write(seed, {"README": "x\n"})
    git(seed, "add", "-A")
    git(seed, "commit", "-qm", "first")
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(seed), str(ws)], check=True)
    assert workspaces.default_branch(ws) == "main"
    git(ws, "remote", "set-head", "origin", "--delete")
    assert workspaces.default_branch(ws) == "main"


def test_no_farm_module_keeps_its_own_default_branch_copy():
    offenders = [
        str(path.relative_to(FARM_DIR))
        for path in FARM_DIR.rglob("*.py")
        if "tests" not in path.parts and re.search(r"^def _default_branch\b", path.read_text(encoding="utf-8"), re.M)
    ]
    assert offenders == []


# ---- metric 4: checks.py runs the branch copy against origin/<default> ----


def test_checks_on_a_master_repo_run_the_branch_copy_of_a_master_script(tmp_path):
    _seed, ws = master_repo(tmp_path, {"scripts/checks/test.sh": "exit 0\n"})
    write(ws, {"scripts/checks/test.sh": "echo broken; exit 1\n"})
    test_runs: list = []
    branch_notes: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(
            ws,
            log=lambda *_: None,
            configured={"test": "git show origin/master:scripts/checks/test.sh | sh"},
            test_runs=test_runs,
            branch_notes=branch_notes,
        )

    assert err.value.headline.startswith("branch test.sh failed (exit 1)")
    assert err.value.command == "sh -c cat scripts/checks/test.sh | sh"
    assert [r["label"] for r in test_runs] == ["main", "branch"]


def test_the_changed_scripts_are_diffed_against_the_merge_base_with_origin_master(tmp_path, monkeypatch):
    _seed, ws = master_repo(tmp_path, {"scripts/checks/test.sh": "exit 0\n"})
    write(ws, {"scripts/checks/test.sh": "exit 0 # changed\n"})
    seen: list[tuple[str, ...]] = []
    real = checks._git_lines

    def spy(path, *args):
        seen.append(args)
        return real(path, *args)

    monkeypatch.setattr(checks, "_git_lines", spy)
    assert checks.branch_script_changes(ws, lambda *_: None) == {"scripts/checks/test.sh"}
    assert seen[0] == ("merge-base", "origin/master", "HEAD")
