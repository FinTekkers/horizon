"""Per-repo git checkouts under ~/.horizon-farm/workspaces/.

Phase 1 only provisions them (agents don't touch code yet); the Eng agent
starts working in these in phase 3. The PAT ends up in .git/config of the
clone — acceptable for a local prototype, revisit before any multi-user
deployment.
"""

import subprocess
from pathlib import Path

from .config import WORKSPACES_DIR


def workspace_path(repo_full: str) -> Path:
    return WORKSPACES_DIR / repo_full.replace("/", "__")


def _git(path: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, timeout=300)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def ensure(repo_full: str, token: str | None) -> Path:
    path = workspace_path(repo_full)
    auth = f"x-access-token:{token}@" if token else ""
    url = f"https://{auth}github.com/{repo_full}.git"
    if (path / ".git").exists():
        # Farm start = clean slate: fetch AND hard-sync the tree to the remote
        # default branch, discarding any leftovers from dead agent runs.
        # (Agents that need a work branch recreate it from origin refs.)
        _git(path, "fetch", "--all", "--prune")
        head = _git(path, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
        default = head.rsplit("/", 1)[-1] if head else "main"
        _git(path, "checkout", "-f", default)
        _git(path, "reset", "--hard", f"origin/{default}")
        _git(path, "clean", "-fd")
    else:
        result = subprocess.run(
            ["git", "clone", url, str(path)],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"clone of {repo_full} failed: {result.stderr.strip()[:200]}")
    return path
