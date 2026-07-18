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


def ensure(repo_full: str, token: str | None) -> Path:
    path = workspace_path(repo_full)
    auth = f"x-access-token:{token}@" if token else ""
    url = f"https://{auth}github.com/{repo_full}.git"
    if (path / ".git").exists():
        subprocess.run(
            ["git", "-C", str(path), "fetch", "--all", "--prune"],
            capture_output=True, text=True, timeout=300, check=True,
        )
    else:
        result = subprocess.run(
            ["git", "clone", url, str(path)],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"clone of {repo_full} failed: {result.stderr.strip()[:200]}")
    return path
