"""Per-repo git checkouts under ~/.horizon-farm/workspaces/.

Each repo gets one shared "hub" clone (the fetch target, kept on the default
branch — same directory and behavior as the old single shared checkout). Each
work item gets its own `git worktree` off that hub, at
`<hub>__items/<item-id>/` — every workspace-touching step (4/6/7/8/11/12)
reads and writes there, never the hub directly. That is the HZ-50 isolation
fix: two items in the same repo can no longer reset/clean/checkout over each
other's uncommitted work, because they no longer share a working tree.

Worktrees still share the hub's object database and refs, so any git command
that mutates that shared state (fetch, push, worktree add/remove/prune) is
serialized through hub_lock() — otherwise concurrent ref updates from
different item worktrees can race (`cannot lock ref ...`). Per-worktree state
(HEAD, index, working tree) needs no locking — that's the whole point of
`git worktree`.

The PAT ends up in .git/config of the hub clone — acceptable for a local
prototype, revisit before any multi-user deployment.
"""

import contextlib
import fcntl
import json
import os
import shutil
import subprocess
from pathlib import Path

from .config import QUEUE_DIR, WORKSPACES_DIR

# Bounded pool of live item worktrees per repo. Without a bound, every item
# ever dispatched would keep its own node_modules-sized checkout on disk
# forever — on this host that risks filling the disk and taking down every
# other service (HZ-50 guardrail). Env-overridable like FARM_MAX_EPHEMERAL:
# the right number depends on disk headroom, not a constant.
WORKSPACE_ITEM_POOL_SIZE = int(os.environ.get("FARM_WORKSPACE_POOL_SIZE", "8"))


def hub_path(repo_full: str) -> Path:
    return WORKSPACES_DIR / repo_full.replace("/", "__")


def _items_root(repo_full: str) -> Path:
    return WORKSPACES_DIR / f"{repo_full.replace('/', '__')}__items"


def workspace_path(repo_full: str, item_id: str) -> Path:
    """The item's isolated worktree path. Pure — no git calls, no creation;
    use ensure_item_worktree() to actually provision it."""
    return _items_root(repo_full) / item_id.lower()


@contextlib.contextmanager
def hub_lock(repo_full: str):
    """A real flock, not a Python threading.Lock: each step agent runs in
    its own tmux session / OS process, so only a filesystem lock actually
    serializes them."""
    hub = hub_path(repo_full)
    lock_path = hub / ".git" / "horizon-hub.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _git(path: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, timeout=300)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def _default_branch(hub: Path) -> str:
    head = _git(hub, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    return head.rsplit("/", 1)[-1] if head else "main"


def ensure(repo_full: str, token: str | None) -> Path:
    path = hub_path(repo_full)
    auth = f"x-access-token:{token}@" if token else ""
    url = f"https://{auth}github.com/{repo_full}.git"
    if (path / ".git").exists():
        with hub_lock(repo_full):
            # Farm start = clean slate: fetch AND hard-sync the hub tree to
            # the remote default branch, discarding any leftovers from dead
            # agent runs. (Agents work in per-item worktrees, not the hub, so
            # this reset only ever touches the hub's own tree.)
            _git(path, "fetch", "--all", "--prune")
            default = _default_branch(path)
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


def _active_item_ids() -> set[str]:
    """Item ids with a claimed (in-flight) task file — read straight off the
    same directory farmd's dispatcher and /runs/{id}/log resolution use, so
    the eviction pool never reaps a worktree a live run is sitting in."""
    active_dir = QUEUE_DIR / "runs" / "active"
    ids: set[str] = set()
    if not active_dir.exists():
        return ids
    for task_path in active_dir.glob("*.json"):
        try:
            task = json.loads(task_path.read_text())
            item_id = task.get("item", {}).get("id")
        except (json.JSONDecodeError, AttributeError):
            continue
        if item_id:
            ids.add(item_id.lower())
    return ids


def existing_item_ids(repo_full: str) -> list[str]:
    root = _items_root(repo_full)
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir())


def _evict_lru_if_over_pool(repo_full: str, keep_item_id: str) -> None:
    """Runs before adding a brand-new worktree: if the repo's item pool is
    already at the bound, reap the least-recently-touched worktree that
    isn't part of a live run to make room. If every worktree in the pool is
    currently active, the pool is briefly over-bound rather than reaping
    live work — it settles back down as those runs finish."""
    root = _items_root(repo_full)
    ids = existing_item_ids(repo_full)
    if len(ids) < WORKSPACE_ITEM_POOL_SIZE:
        return
    protected = _active_item_ids() | {keep_item_id.lower()}
    candidates = [root / i for i in ids if i not in protected]
    if not candidates:
        return
    oldest = min(candidates, key=lambda p: p.stat().st_mtime)
    reap_item_worktree(repo_full, oldest.name)


def ensure_item_worktree(repo_full: str, item_id: str) -> Path:
    """Idempotent: the first dispatch for an item creates its worktree off
    the hub's default branch; later attempts (and step 12 re-visiting the
    same item) reuse it untouched — prepare_branch() does the per-attempt
    scrub, not this function."""
    hub = hub_path(repo_full)
    if not (hub / ".git").exists():
        raise RuntimeError(f"hub workspace not provisioned for {repo_full} — restart the farm")
    item_path = workspace_path(repo_full, item_id)

    with hub_lock(repo_full):
        _git(hub, "worktree", "prune")
        registered = str(item_path) in _git(hub, "worktree", "list", "--porcelain").stdout
    if registered:
        return item_path

    # Eviction takes its own hub_lock — must run outside ours (flock isn't
    # reentrant across separate fds/opens within the same process).
    _evict_lru_if_over_pool(repo_full, item_id)

    with hub_lock(repo_full):
        if item_path.exists():
            # A leftover directory that never registered as a worktree (e.g.
            # a killed run mid-`worktree add`, or pre-HZ-50 state) — git
            # worktree add refuses to reuse a non-empty, unregistered path.
            shutil.rmtree(item_path)
        _git(hub, "fetch", "origin", "--prune")
        default = _default_branch(hub)
        item_path.parent.mkdir(parents=True, exist_ok=True)
        _git(hub, "worktree", "add", "--detach", str(item_path), f"origin/{default}")
    return item_path


def reap_item_worktree(repo_full: str, item_id: str) -> None:
    """Removes one item's worktree — called by the bounded-pool eviction and
    available for external cleanup (an item closing out) — so per-repo disk
    stays bounded to live items, not every item ever dispatched."""
    hub = hub_path(repo_full)
    item_path = workspace_path(repo_full, item_id)
    with hub_lock(repo_full):
        _git(hub, "worktree", "remove", "--force", str(item_path), check=False)
        if item_path.exists():
            shutil.rmtree(item_path, ignore_errors=True)
        _git(hub, "worktree", "prune")


def prune_worktrees(repo_full: str) -> None:
    """Drops stale worktree metadata left by a killed farmd (registered
    worktrees whose directory is gone) — run at boot, mirrors
    _adopt_existing()'s tmux-session recovery."""
    hub = hub_path(repo_full)
    if not (hub / ".git").exists():
        return
    with hub_lock(repo_full):
        _git(hub, "worktree", "prune")
