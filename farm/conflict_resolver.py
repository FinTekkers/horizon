"""HZ-92: deterministic, LLM-free merge-conflict resolution.

A PR that only needs a mechanical merge conflict resolved (renames,
deletions, non-overlapping edits) today has exactly one lever: send the item
back to the full "Specialist agent implements" step — a fresh agent, fresh
context, 15-40 minutes, for maybe ten minutes of mechanical work.

This module is the fast path: plain `git merge` of the PR's target branch
into the item's existing branch, in its existing worktree, gated on the
repo's own test suite actually passing — no agent, no judgment call. It
NEVER uses `--ours`/`--theirs` (that would silently discard one side's
changes) and never force-pushes: a clean merge is a fast-forward from the
branch's previous tip by construction, so a plain `git push` is always
sufficient and safe.

Escalation (falling back to the full implement cycle) happens whenever this
script cannot be certain the result is correct:
  - real, overlapping conflicts git itself could not resolve
  - the merge resolves cleanly but the repo's own tests then fail

Conflict detection reads git's own index state (`git status --porcelain`),
never a text search for `<<<<<<<` — a file that legitimately contains that
string (a diff fixture, a markdown doc about git) must never be misread as a
live conflict marker.
"""

import subprocess
from pathlib import Path

from .checks import CheckFailure, run_checks
from .workspaces import ensure_item_worktree, hub_lock

# Bounded like every other git subprocess in this codebase (step_agent.py,
# workspaces.py) — a hung git process must not hang the resolution forever.
GIT_TIMEOUT_S = 300

# Index status codes from `git status --porcelain=v1` that mean "still
# unmerged" — any code with a 'U' in either column, plus the two "both sides
# touched it the same way" pairs that porcelain reports without a 'U'.
_UNMERGED_CODES = {"AA", "DD"}


def git(ws: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=GIT_TIMEOUT_S
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def _default_branch(ws: Path) -> str:
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    return head.rsplit("/", 1)[-1] if head else "main"


def _unmerged_paths(ws: Path) -> list[str]:
    """Conflict detection via git's own index state, not marker text — see
    module docstring. Returns the list of still-conflicted paths (empty if
    the working tree is clean)."""
    status = git(ws, "status", "--porcelain=v1", check=False).stdout
    paths = []
    for line in status.splitlines():
        if len(line) < 3:
            continue
        code = line[:2]
        if "U" in code or code in _UNMERGED_CODES:
            paths.append(line[3:].strip())
    return paths


def resolve(repo_full: str, item_id: str, branch: str | None = None, base_branch: str | None = None, log=print) -> dict:
    """Attempt a mechanical merge-conflict resolution for one item's PR
    branch, in that item's existing worktree.

    Returns one of:
      {"resolved": True,  "files": "<diffstat>", "summary": "..."}
      {"resolved": False, "reason": "merge_conflict"|"tests_failed"|
                                     "branch_missing"|"push_rejected",
       "detail": "..."}

    Never raises for an ordinary escalation — only for something the caller
    (the farmd route) should treat as an infrastructure failure (worktree not
    provisioned, a git command failing outside the merge itself).
    """
    branch = branch or f"horizon/{item_id.lower()}"
    ws = ensure_item_worktree(repo_full, item_id)

    # Scrub before touching anything — mirrors step_agent.prepare_branch:
    # a superseded/killed prior attempt may have left uncommitted edits.
    git(ws, "reset", "--hard")
    git(ws, "clean", "-fd")
    with hub_lock(repo_full):
        git(ws, "fetch", "origin", "--prune")

    remote_branch = git(ws, "rev-parse", "--verify", f"origin/{branch}", check=False)
    if remote_branch.returncode != 0:
        return {"resolved": False, "reason": "branch_missing", "detail": f"origin/{branch} not found"}
    git(ws, "checkout", "-B", branch, f"origin/{branch}")
    pre_merge_sha = git(ws, "rev-parse", "HEAD").stdout.strip()

    default = base_branch or _default_branch(ws)
    log(f"conflict_resolver: merging origin/{default} into {branch}")
    git(ws, "merge", "--no-edit", f"origin/{default}", check=False)

    unmerged = _unmerged_paths(ws)
    if unmerged:
        log(f"conflict_resolver: {len(unmerged)} unmerged path(s) — escalating, aborting merge")
        git(ws, "merge", "--abort", check=False)
        # Belt and braces: merge --abort should already leave a clean tree,
        # but a script that gates on "clean or escalate" must never hand the
        # next attempt (a full implement cycle) a dirty worktree.
        git(ws, "reset", "--hard", pre_merge_sha)
        git(ws, "clean", "-fd")
        return {
            "resolved": False,
            "reason": "merge_conflict",
            "detail": f"conflicts in: {', '.join(sorted(unmerged))}",
        }

    diffstat = git(ws, "diff", "--stat", f"{pre_merge_sha}..HEAD", check=False).stdout.strip()

    try:
        check_note = run_checks(ws, log)
    except CheckFailure as exc:
        log(f"conflict_resolver: post-merge checks failed — escalating, discarding the merge ({exc})")
        git(ws, "reset", "--hard", pre_merge_sha)
        git(ws, "clean", "-fd")
        return {"resolved": False, "reason": "tests_failed", "detail": str(exc)[:400]}

    # A clean merge is a fast-forward of the branch's own previous tip (its
    # first parent is exactly pre_merge_sha) — a plain push is always
    # sufficient and never discards a commit this run did not itself create.
    try:
        with hub_lock(repo_full):
            git(ws, "push", "origin", branch)
    except RuntimeError as exc:
        # Someone else pushed to this branch while we were merging/testing —
        # refuse rather than force over it.
        log(f"conflict_resolver: push rejected — escalating ({exc})")
        return {"resolved": False, "reason": "push_rejected", "detail": str(exc)[:400]}

    log(f"conflict_resolver: merged origin/{default} into {branch} and pushed — {check_note}")
    return {"resolved": True, "files": diffstat, "summary": f"merged origin/{default} into {branch}; {check_note}"}
