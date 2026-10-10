"""Read-only enforcement for every provider (HZ-387).

A read-only step (the planning steps 4, 6, 7 and 8, and each of step 12's two
review passes) is meant to leave the item's worktree as it found it. Claude is
held to that by --allowedTools; Muse has no such flag, so the farm checks for
itself, after the call: guard() records the worktree before the body runs and
compares it afterwards. If anything changed, it puts the worktree back and
fails the step with ReadOnlyViolation, which step_agent.main() tags with the
non-retryable read-only reason, so the item pauses.

What a snapshot covers: HEAD and the branch it is on, the tracked index and
worktree content (as the trees `git stash create` writes — objects only, no
ref, never the shared stash stack), and every untracked file's content.
Gitignored files are not covered, and neither are other refs: a branch or
tag the agent made elsewhere stays. Both are documented gaps.

The rollback is local git only, in the item's own worktree, and keeps earlier
work: the branch goes back to the recorded HEAD (every earlier commit is an
ancestor of it), the earlier tracked edits come back from their recorded
trees, earlier untracked files are rewritten from their blobs, and only paths
that are new since the snapshot are deleted, one by one. No `git clean`, no
push, no branch delete, no `stash drop`.
"""

import os
import stat
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, NamedTuple

from . import pause
from .agent_runner import AgentError

# server/src/checkHeadline.js READ_ONLY_HEADLINE_PREFIX — keep the two in step
# (farm/tests/test_read_only_guard.py reads both and compares them).
HEADLINE_PREFIX = "read-only step changed the worktree"
# step_agent.ERROR_MAX_CHARS, the /fail route's `error` maxLength: the whole
# message, file list included, must fit or main() cuts it mid-line.
MESSAGE_MAX_CHARS = 2000
_WHY_MAX_CHARS = 300
GIT_TIMEOUT_S = 120


class ReadOnlyViolation(AgentError):
    """A read-only step changed the worktree. Line 1 is the headline (it
    names the provider); every changed path follows, one per line.
    `rolled_back` is False when the rollback itself failed."""

    def __init__(self, message: str, *, rolled_back: bool):
        super().__init__(message)
        self.rolled_back = rolled_back


class SnapshotFailed(AgentError):
    """The worktree could not be recorded before the step, so the step does
    not run at all: an unguarded read-only run is never allowed."""


class _Untracked(NamedTuple):
    kind: str  # "file" or "link"
    value: str  # blob sha for a file, the link target for a link
    mode: int


class Snapshot(NamedTuple):
    head: str
    branch: str | None  # refs/heads/<name>, or None on a detached HEAD
    worktree_tree: str  # tracked files as they are on disk
    index_tree: str
    untracked: dict[str, _Untracked]


class Watch:
    """What guard() yields: the caller sets `provider` to the provider that
    actually ran, from the reply's provenance, once the body returns."""

    def __init__(self, provider: str):
        self.provider = provider


def _git(ws: Path, *args: str, input: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(ws), "--no-optional-locks", *args],
        input=input,
        capture_output=True,
        timeout=GIT_TIMEOUT_S,
    )
    if result.returncode != 0:
        err = result.stderr.decode(errors="replace").strip()[:200]
        raise RuntimeError(f"git {' '.join(args)} failed: {err}")
    return result.stdout


def _status(ws: Path) -> list[tuple[str, str]]:
    """(XY, path) per porcelain entry. A rename's source path is dropped:
    the destination is what is on disk."""
    raw = _git(ws, "status", "--porcelain=v1", "-z", "--untracked-files=all").split(b"\0")
    entries, i = [], 0
    while i < len(raw):
        record = raw[i].decode(errors="surrogateescape")
        i += 1
        if not record:
            continue
        code, path = record[:2], record[3:]
        if code[0] in "RC":
            i += 1  # the next record is the rename's source
        entries.append((code, path))
    return entries


def _untracked_entries(ws: Path, paths: list[str], store: bool) -> dict[str, _Untracked]:
    """Each untracked path's content and mode. Hashed raw (--no-filters), so
    restore() writes back exactly the bytes that were there; one git call
    for all of them (a path holding a newline is hashed on its own)."""
    entries: dict[str, _Untracked] = {}
    files: list[tuple[str, int]] = []
    for rel in paths:
        info = os.lstat(ws / rel)
        if stat.S_ISLNK(info.st_mode):
            entries[rel] = _Untracked("link", os.readlink(ws / rel), 0)
        else:
            files.append((rel, info.st_mode & 0o777))
    hash_args = ["hash-object", "--no-filters", *(["-w"] if store else [])]
    batch = [rel for rel, _ in files if "\n" not in rel]
    shas: dict[str, str] = {}
    if batch:
        listed = "\n".join(batch).encode(errors="surrogateescape")
        shas = dict(zip(batch, _git(ws, *hash_args, "--stdin-paths", input=listed).decode().split()))
    for rel, mode in files:
        sha = shas[rel] if rel in shas else _git(ws, *hash_args, "--", rel).decode().strip()
        entries[rel] = _Untracked("file", sha, mode)
    return entries


def snapshot(ws: Path, *, store: bool = True) -> Snapshot:
    """Records the worktree. `store` writes each untracked file's blob into
    the object store so restore() can bring it back; a snapshot taken only to
    compare against skips that."""
    head = _git(ws, "rev-parse", "--verify", "HEAD").decode().strip()
    ref = subprocess.run(
        ["git", "-C", str(ws), "symbolic-ref", "-q", "HEAD"], capture_output=True, text=True, timeout=GIT_TIMEOUT_S
    )
    branch = ref.stdout.strip() if ref.returncode == 0 else None
    head_tree = _git(ws, "rev-parse", f"{head}^{{tree}}").decode().strip()
    entries = _status(ws)
    stash = _git(ws, "stash", "create").decode().strip() if any(code != "??" for code, _ in entries) else ""
    if stash:
        worktree_tree = _git(ws, "rev-parse", f"{stash}^{{tree}}").decode().strip()
        index_tree = _git(ws, "rev-parse", f"{stash}^2^{{tree}}").decode().strip()
    else:
        worktree_tree = index_tree = head_tree
    untracked = _untracked_entries(ws, [path for code, path in entries if code == "??"], store)
    return Snapshot(head, branch, worktree_tree, index_tree, untracked)


def changed_paths(ws: Path, before: Snapshot, after: Snapshot) -> list[str]:
    """One line per change, for the violation's details: commits first, then
    every path whose tracked or untracked content differs."""
    lines: list[str] = []
    if before.branch != after.branch:
        lines.append(f"branch switched: {_short_ref(before.branch)} -> {_short_ref(after.branch)}")
    if before.head != after.head:
        made = _git(ws, "rev-list", "--reverse", f"{before.head}..{after.head}").decode().split()
        lines += [f"commit {sha[:9]} (discarded)" for sha in made]
        if not made:
            lines.append(f"HEAD moved {before.head[:9]} -> {after.head[:9]}")
    paths: set[str] = set()
    for old, new in ((before.worktree_tree, after.worktree_tree), (before.index_tree, after.index_tree)):
        if old != new:
            paths.update(_git(ws, "diff", "--name-only", "-z", "--no-renames", old, new).decode().split("\0"))
    for path in before.untracked.keys() | after.untracked.keys():
        if before.untracked.get(path) != after.untracked.get(path):
            paths.add(path)
    paths.discard("")
    return lines + sorted(paths)


def _short_ref(ref: str | None) -> str:
    return ref.removeprefix("refs/heads/") if ref else "(detached)"


def restore(ws: Path, before: Snapshot) -> None:
    """Puts the worktree back to `before`, then re-checks it. Raises if any
    git call fails or the worktree still differs."""
    if before.branch:
        _git(ws, "checkout", "-f", "-B", before.branch.removeprefix("refs/heads/"), before.head)
    else:
        _git(ws, "checkout", "-f", "--detach", before.head)
    # New untracked paths go, by name. Earlier untracked files are rewritten
    # below; a path that was untracked before is never deleted here.
    for code, rel in _status(ws):
        if code == "??" and rel not in before.untracked:
            os.unlink(ws / rel)
    # Earlier tracked edits: the worktree content, then the index on top of
    # it without touching the files, so staged and unstaged edits both return.
    if before.worktree_tree != _git(ws, "rev-parse", f"{before.head}^{{tree}}").decode().strip():
        _git(ws, "read-tree", "--reset", "-u", before.worktree_tree)
    if before.index_tree != before.worktree_tree:
        _git(ws, "read-tree", before.index_tree)
    for rel, entry in before.untracked.items():
        path = ws / rel
        if path.is_symlink() or path.exists():
            if _untracked_entries(ws, [rel], store=False)[rel] == entry:
                continue
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        if entry.kind == "link":
            os.symlink(entry.value, path)
        else:
            path.write_bytes(_git(ws, "cat-file", "blob", entry.value))
            os.chmod(path, entry.mode)
    after = snapshot(ws, store=False)
    if after != before:
        left = changed_paths(ws, before, after)
        raise RuntimeError(f"the worktree still differs after the rollback: {', '.join(left[:10])}")


def violation_message(provider: str, changes: list[str], failure: str | None = None) -> str:
    """The error main() reports. Line 1 is the headline; each change follows
    on its own line, and only a list past MESSAGE_MAX_CHARS ends `+N more`."""
    if failure is None:
        headline = f"{HEADLINE_PREFIX} (provider: {provider}) — rolled back"
    else:
        why = " ".join(failure.split())[:_WHY_MAX_CHARS]
        headline = f"{HEADLINE_PREFIX} (provider: {provider}) — rollback FAILED: {why}"
    lines = [headline]
    for i, change in enumerate(changes):
        rest = len(changes) - i - 1
        tail = f"\n+{rest} more" if rest else ""
        if len("\n".join([*lines, change])) + len(tail) > MESSAGE_MAX_CHARS:
            lines.append(f"+{len(changes) - i} more")
            break
        lines.append(change)
    return "\n".join(lines)


def _check(ws: Path, before: Snapshot, watch: Watch, cause: BaseException | None) -> None:
    """Raises ReadOnlyViolation if the worktree changed, after restoring it.
    Returns quietly (and runs no restore command) when nothing changed."""
    provider = watch.provider
    if cause is not None and getattr(cause, "provider", None):
        provider = cause.provider
    try:
        after = snapshot(ws, store=False)
    except Exception as exc:
        changes = [f"the worktree could not be read after the step: {' '.join(str(exc).split())[:200]}"]
    else:
        if after == before:
            return
        try:
            changes = changed_paths(ws, before, after)
        except Exception as exc:
            changes = [f"(could not list the changes: {' '.join(str(exc).split())[:200]})"]
    try:
        restore(ws, before)
    except Exception as exc:
        message = violation_message(provider, changes, f"{type(exc).__name__}: {exc}")
        raise ReadOnlyViolation(message, rolled_back=False) from (cause or exc)
    raise ReadOnlyViolation(violation_message(provider, changes), rolled_back=True) from cause


@contextmanager
def guard(ws: Path | None, provider: str) -> Iterator[Watch]:
    """Runs the body as a read-only step in `ws`. `provider` names the
    provider in the headline unless the body sets Watch.provider (or raised
    an error carrying one). A `ws` of None (no workspace) guards nothing.

    The body runs inside pause.interruptible(), so an operator's pause
    raises here and the worktree is put back before the pause propagates. A
    pause whose rollback failed is reported as the violation instead: the
    item must never resume on an unrestored worktree."""
    watch = Watch(provider)
    if ws is None:
        yield watch
        return
    try:
        before = snapshot(ws)
    except Exception as exc:
        raise SnapshotFailed(
            f"could not record the worktree before a read-only step, so it did not run: {exc}"
        ) from exc
    try:
        with pause.interruptible():
            yield watch
    except pause.PauseRequested as exc:
        # Stop the agent before restoring, or it keeps writing behind us.
        pause.kill_descendants()
        try:
            _check(ws, before, watch, exc)
        except ReadOnlyViolation as violation:
            if not violation.rolled_back:
                raise
        raise
    except BaseException as exc:
        _check(ws, before, watch, exc)
        raise
    _check(ws, before, watch, None)
