"""Shared real-git fixtures for HZ-92 conflict-resolution tests.

A local bare repo stands in for GitHub (same pattern as test_workspaces.py):
no network, no mocked git plumbing — `conflict_resolver.resolve()` and the
farmd `/conflicts/resolve` route both run against real merge mechanics.
Factored out of test_conflict_resolver.py so test_farmd.py's end-to-end HTTP
test can set up the exact same kind of repo without duplicating the git
plumbing.
"""

import subprocess
from pathlib import Path

from farm import workspaces


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


def make_repo_hub(tmp_path: Path, repo_full: str = "acme/demo"):
    seed = tmp_path / "seed"
    seed.mkdir()
    git(tmp_path, "init", "-b", "main", "seed")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "shared.txt").write_text("line1\nline2\nline3\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    hub = workspaces.hub_path(repo_full)
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    git(hub, "config", "user.email", "farm@example.com")
    git(hub, "config", "user.name", "Horizon Farm")
    return hub, origin


def push_new_branch(tmp_path: Path, origin: Path, branch: str, mutate, label: str) -> str:
    """Stands in for the implement step already having pushed the item's PR
    branch, or main having moved independently — a throwaway clone, never the
    hub or item worktree conflict_resolver itself manages."""
    work = tmp_path / f"push-{label}"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "test@example.com")
    git(work, "config", "user.name", "Test")
    git(work, "checkout", "-b", branch, "main") if branch != "main" else git(work, "checkout", "main")
    mutate(work)
    git(work, "add", "-A")
    git(work, "commit", "-m", f"{label} commit")
    git(work, "push", "origin", f"HEAD:refs/heads/{branch}")
    return git(work, "rev-parse", "HEAD").stdout.strip()


def origin_branch_sha(origin: Path, branch: str) -> str:
    return git(origin, "rev-parse", branch).stdout.strip()


def clone_and_read(tmp_path: Path, origin: Path, branch: str, filename: str, label: str) -> str:
    work = tmp_path / f"read-{label}"
    subprocess.run(["git", "clone", "--quiet", "-b", branch, str(origin), str(work)], check=True, capture_output=True)
    return (work / filename).read_text()


# HZ-157's real conflict, reduced to its shape: both sides added one line at
# the same spot in farm/tests/conftest.py — a single conflicted hunk.
HZ157_CONFTEST = "farm/tests/conftest.py"
HZ157_CONFTEST_BASE = (
    "import os\n"
    'os.environ.setdefault("FARM_CLAUDE_BIN", "fake_claude")\n'
    'os.environ.setdefault("FARM_HOME", "/tmp/horizon-farm-test")\n'
)
HZ157_CONFTEST_BRANCH_LINE = 'os.environ.setdefault("FARM_RUNNER", "subprocess")\n'
HZ157_CONFTEST_MAIN_LINE = 'os.environ.setdefault("WA_APPROVAL_SECRET", "wa-approval-secret-for-tests")\n'


def seed_hz157_conftest_conflict(tmp_path: Path, origin: Path, branch: str) -> None:
    """Pushes the common base to main, the PR branch's edit, then main's
    competing edit — leaving `branch` with a 1-hunk conflict against main."""

    def write(work: Path, extra: str = "") -> None:
        path = work / HZ157_CONFTEST
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = HZ157_CONFTEST_BASE.splitlines(keepends=True)
        path.write_text("".join(lines[:2]) + extra + "".join(lines[2:]))

    push_new_branch(tmp_path, origin, "main", write, "hz157-base")
    push_new_branch(tmp_path, origin, branch, lambda w: write(w, HZ157_CONFTEST_BRANCH_LINE), "hz157-branch")
    push_new_branch(tmp_path, origin, "main", lambda w: write(w, HZ157_CONFTEST_MAIN_LINE), "hz157-main")
