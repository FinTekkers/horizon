"""HZ-447: the read-only copy a Plan's Inventory and Design steps read.

build() exports each repo in the Plan's scope from its hub, at the default
branch, with `git archive` into <BUNDLE_ROOT>/<item>/<owner__name>/: files
only, no .git, so nothing in the bundle can commit or push. Beside them,
_refs/<owner__name> lists the repo's branches and tags and its latest check
(the server's plan_scope). Then the whole bundle is made read-only. A repo
outside the scope is never exported.

The farm enforces this itself, not the prompt:
- tool_rules() allows reads of this item's bundle only and denies every
  tool that writes, runs or fetches;
- guard() compares a manifest of the bundle and a snapshot of each hub —
  HEAD, branches, tags, `git status` and origin's refs (`git ls-remote`) —
  before and after the step, and any change fails it;
- leaked_paths() fails a reply that names a hub, another item's bundle or an
  out-of-scope repo;
- scrub() and scrubbed_stdout() mask secrets and out-of-scope repo names in
  what is stored and in the run log (stdout only; stderr is not wrapped).
"""

import contextlib
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator, NamedTuple

from . import workspaces
from .agent_runner import AgentError
from .checks import scrub as scrub_secrets
from .read_only_guard import ReadOnlyViolation, SnapshotFailed, Watch, violation_message

BUNDLE_ROOT = Path("/tmp/horizon-plan")
BUNDLE_MAX_AGE_S = 24 * 60 * 60
GIT_TIMEOUT_S = 300
REFS_DIR = "_refs"
OUT_OF_SCOPE_MASK = "[out-of-scope repo]"
# Every tool that edits, runs, fetches or delegates, plus reads of the farm's
# home. Read rules cover Glob and Grep too.
DENIED_TOOLS = "Read(~/**),Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,Task,Agent"
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_ITEM = re.compile(r"^[A-Za-z0-9_-]+$")
_BRANCH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$")
# Origin refs other writers move while a step runs: pull-request refs,
# screenshot branches, and the farm's own item branches (other items push,
# merge and delete them). The default branch may only fast-forward (a merge).
_CONCURRENT_REMOTE_PREFIXES = ("refs/pull/", "refs/heads/e2e-artifacts/", "refs/heads/horizon/")


class Bundle(NamedTuple):
    root: Path
    branches: dict[str, str]  # in-scope repo -> the default branch exported
    out_of_scope: tuple[str, ...]
    manifest: dict[str, tuple[int, int, int]]


class _HubState(NamedTuple):
    head: str
    refs: dict[str, str]  # refs/heads/* and refs/tags/*
    status: str
    remote: dict[str, str]  # git ls-remote origin
    other_worktrees: frozenset[str]  # branches checked out by other items' worktrees


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "--no-optional-locks", *args],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=GIT_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed in {path.name}: {result.stderr.strip()[:200]}")
    return result.stdout


def _dirname(repo: str) -> str:
    return repo.replace("/", "__")


def parse_scope(plan_scope) -> tuple[list[dict], list[str]]:
    """(in-scope repo entries, out-of-scope repo names) from the server's
    plan_scope. Fails closed: with no valid scope nothing is read."""
    repos = plan_scope.get("repos") if isinstance(plan_scope, dict) else None
    if not isinstance(repos, list) or not repos or not all(
        isinstance(entry, dict) and isinstance(entry.get("repo"), str) and _REPO.match(entry["repo"]) for entry in repos
    ):
        raise AgentError("this Plan step needs the Plan's repo scope (plan_scope) and the task has none — nothing was read")
    outside = plan_scope.get("out_of_scope") or []
    if not isinstance(outside, list) or not all(isinstance(repo, str) and _REPO.match(repo) for repo in outside):
        raise AgentError("plan_scope.out_of_scope must list owner/name repos — nothing was read")
    return repos, outside


def build(item_id: str, plan_scope) -> Bundle:
    """Exports every in-scope repo into a fresh, read-only bundle for this
    item. Raises AgentError naming a repo this farm has no hub for."""
    entries, outside = parse_scope(plan_scope)
    if not _ITEM.match(item_id):
        raise AgentError(f"item id {item_id!r} cannot name a bundle directory")
    _sweep()
    root = BUNDLE_ROOT / item_id.lower()
    _remove_tree(root)
    (root / REFS_DIR).mkdir(parents=True)
    try:
        branches = {entry["repo"]: _export(entry, root) for entry in entries}
        _make_read_only(root)
    except BaseException:
        _remove_tree(root)
        raise
    return Bundle(root, branches, tuple(outside), _manifest(root))


def _export(entry: dict, root: Path) -> str:
    repo = entry["repo"]
    hub = workspaces.hub_path(repo)
    if not (hub / ".git").exists():
        raise AgentError(f"{repo} has no workspace on this farm, so it cannot be read — restart the farm with it connected")
    with workspaces.hub_lock(repo):
        fetch = subprocess.run(["git", "-C", str(hub), "fetch", "--quiet", "origin", "--prune"], capture_output=True, timeout=GIT_TIMEOUT_S)
    branch = entry.get("default_branch")
    if not isinstance(branch, str) or not _BRANCH.match(branch):
        branch = workspaces.default_branch(hub)
    sha = _git(hub, "rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}").strip()
    dest = root / _dirname(repo)
    dest.mkdir()
    archive = subprocess.Popen(["git", "-C", str(hub), "archive", "--format=tar", sha], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    untar = subprocess.run(["tar", "-x", "--no-same-owner", "-C", str(dest)], stdin=archive.stdout, capture_output=True, timeout=GIT_TIMEOUT_S)
    archive.stdout.close()
    if archive.wait(timeout=GIT_TIMEOUT_S) != 0 or untar.returncode != 0:
        raise AgentError(f"{repo}: could not export {branch} for reading")
    _drop_escaping_links(dest)
    refs = _git(hub, "for-each-ref", "--format=%(objectname) %(refname:short)", "refs/remotes/origin", "refs/tags")
    stale = "" if fetch.returncode == 0 else " (the fetch failed: as of the hub's last fetch)"
    lines = [f"repo: {repo}", f"exported: origin/{branch} at {sha}{stale}", _check_line(entry.get("last_check")), "", "refs (sha name):", refs.rstrip()]
    (root / REFS_DIR / _dirname(repo)).write_text("\n".join(lines) + "\n")
    return branch


def _check_line(last_check) -> str:
    if isinstance(last_check, dict) and last_check.get("status") == "pass":
        fields = (str(last_check.get(key)).replace("\n", " ") for key in ("sha", "finished_at", "source"))
        return "last_check: pass {} finished {} (source: {})".format(*fields)
    return (
        "last_check: none — no passing check run is recorded for this repo. Passes are pruned after 7 days, "
        "so this does not mean no checks ever ran."
    )


def _drop_escaping_links(dest: Path) -> None:
    """A committed symlink that points outside its repo's export could read
    past the bundle, so it is removed."""
    real_dest = os.path.realpath(dest)
    for dirpath, dirnames, filenames in os.walk(dest):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            if os.path.islink(path) and os.path.commonpath([os.path.realpath(path), real_dest]) != real_dest:
                os.unlink(path)


def _make_read_only(root: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames + dirnames:
            path = os.path.join(dirpath, name)
            if not os.path.islink(path):
                os.chmod(path, os.lstat(path).st_mode & ~0o222)
    os.chmod(root, os.lstat(root).st_mode & ~0o222)


def _manifest(root: Path) -> dict[str, tuple[int, int, int]]:
    """Every path in the bundle, with its mode, size and mtime."""
    entries = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            info = os.lstat(path)
            entries[os.path.relpath(path, root)] = (info.st_mode, info.st_size, info.st_mtime_ns)
    return entries


def _remove_tree(path: Path) -> None:
    """rmtree, after giving every directory its write bit back: removing a
    file needs write permission on the directory holding it."""
    if not os.path.lexists(path):
        return
    for dirpath, _dirnames, _filenames in os.walk(path):
        os.chmod(dirpath, 0o700)
    shutil.rmtree(path)


def _sweep() -> None:
    """Removes bundles a crashed run left behind, once they are a day old."""
    if not BUNDLE_ROOT.is_dir():
        return
    cutoff = time.time() - BUNDLE_MAX_AGE_S
    for child in BUNDLE_ROOT.iterdir():
        with contextlib.suppress(OSError):
            if child.lstat().st_mtime < cutoff:
                _remove_tree(child)


def remove(bundle: Bundle) -> None:
    try:
        _remove_tree(bundle.root)
    except OSError as exc:
        print(f"plan bundle {bundle.root.name} not removed ({exc.strerror}); the next sweep removes it", flush=True)


def tool_rules(bundle: Bundle) -> tuple[str, str]:
    """(allowed, disallowed) for run_agent. Reads are allowed under this
    item's bundle only. Glob and Grep are deliberately not allowed bare:
    Claude holds them to the Read rules, and a bare `Grep` allow would let
    them search another item's bundle (farm/tests/test_plan_bundle_live.py).
    The hubs are denied outright, on top of the `~` deny."""
    return f"Read(/{bundle.root}/**)", f"Read(/{workspaces.WORKSPACES_DIR}/**),{DENIED_TOOLS}"


def _names_pattern(names) -> re.Pattern | None:
    variants = sorted({form for name in names for form in (name, _dirname(name))}, key=len, reverse=True)
    if not variants:
        return None
    return re.compile(r"(?<![\w.-])(?:" + "|".join(map(re.escape, variants)) + r")(?![\w-])", re.IGNORECASE)


def leaked_paths(text: str, bundle: Bundle) -> list[str]:
    """What kinds of out-of-scope location `text` names — never the matched
    text itself, so the failure can be reported without repeating it."""
    found = []
    if str(workspaces.WORKSPACES_DIR) in text or ".horizon-farm/workspaces" in text:
        found.append("a farm workspace path")
    others = re.findall(re.escape(str(BUNDLE_ROOT)) + r"/([A-Za-z0-9_-]+)", text)
    if any(name != bundle.root.name for name in others):
        found.append("another item's bundle")
    pattern = _names_pattern(bundle.out_of_scope)
    if pattern and pattern.search(text):
        found.append("a repo outside the Plan's scope")
    return found


def scrub(text: str, out_of_scope) -> str:
    """Secrets (checks.scrub) and out-of-scope repo names masked."""
    pattern = _names_pattern(out_of_scope)
    text = scrub_secrets(text)
    return pattern.sub(OUT_OF_SCOPE_MASK, text) if pattern else text


class _ScrubbedStream:
    """Writes whole lines through scrub(), so a token is never split across
    two writes. A partial line waits for its newline, or for close()."""

    def __init__(self, stream, out_of_scope):
        self._stream, self._out_of_scope, self._pending = stream, out_of_scope, ""

    def write(self, text: str) -> int:
        self._pending += text
        *lines, self._pending = self._pending.split("\n")
        if lines:
            self._stream.write("".join(scrub(line, self._out_of_scope) + "\n" for line in lines))
        return len(text)

    def flush(self) -> None:
        self._stream.flush()

    def close(self) -> None:
        if self._pending:
            self._stream.write(scrub(self._pending, self._out_of_scope))
            self._pending = ""
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


@contextlib.contextmanager
def scrubbed_stdout(out_of_scope) -> Iterator[None]:
    """The run log is this process's stdout (the tmux pane, piped to the
    log file), so every line printed inside — the agent's streamed events
    included — is scrubbed before it lands there."""
    stream = _ScrubbedStream(sys.stdout, tuple(out_of_scope))
    sys.stdout = stream
    try:
        yield
    finally:
        sys.stdout = stream._stream
        stream.close()


def _ref_map(text: str) -> dict[str, str]:
    pairs = (line.split(None, 1) for line in text.splitlines() if line.strip())
    return {name.strip(): sha for sha, name in pairs}


def _other_worktree_branches(hub: Path) -> frozenset[str]:
    """Branches checked out in the hub's item worktrees; the first entry
    `git worktree list` prints is the hub itself, and is not skipped."""
    blocks = _git(hub, "worktree", "list", "--porcelain").strip().split("\n\n")
    return frozenset(
        line.removeprefix("branch ") for block in blocks[1:] for line in block.splitlines() if line.startswith("branch ")
    )


def _hub_state(repo: str) -> _HubState:
    hub = workspaces.hub_path(repo)
    return _HubState(
        head=_git(hub, "rev-parse", "HEAD").strip(),
        refs=_ref_map(_git(hub, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags")),
        status=_git(hub, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
        remote=_ref_map(_git(hub, "ls-remote", "origin")),
        other_worktrees=_other_worktree_branches(hub),
    )


def _fast_forward(repo: str, branch: str, old: str, new: str) -> bool:
    hub = workspaces.hub_path(repo)
    with workspaces.hub_lock(repo):
        subprocess.run(["git", "-C", str(hub), "fetch", "--quiet", "origin", branch], capture_output=True, timeout=GIT_TIMEOUT_S)
    ancestor = subprocess.run(["git", "-C", str(hub), "merge-base", "--is-ancestor", old, new], capture_output=True, timeout=GIT_TIMEOUT_S)
    return ancestor.returncode == 0


def _hub_changes(repo: str, branch: str, before: _HubState, after: _HubState) -> list[str]:
    # The skip list. Local: branches other items' worktrees have checked out
    # (their own steps commit on them). Origin: those, the concurrent writers
    # in _CONCURRENT_REMOTE_PREFIXES, `HEAD` (it mirrors the default branch,
    # checked below), and the default branch moving to a descendant (a merge).
    # refs/remotes/* is never compared: every farm fetch moves it, and
    # ls-remote is what catches a push.
    skip = before.other_worktrees | after.other_worktrees
    lines = [f"HEAD moved {before.head[:9]} -> {after.head[:9]}"] if before.head != after.head else []
    lines += [
        f"{ref} changed"
        for ref in sorted(before.refs.keys() | after.refs.keys())
        if ref not in skip and before.refs.get(ref) != after.refs.get(ref)
    ]
    if before.status != after.status:
        lines.append("the working tree changed")
    for ref in sorted(before.remote.keys() | after.remote.keys()):
        old, new = before.remote.get(ref), after.remote.get(ref)
        if old == new or ref == "HEAD" or ref in skip or ref.startswith(_CONCURRENT_REMOTE_PREFIXES):
            continue
        if ref == f"refs/heads/{branch}" and old and new and _fast_forward(repo, branch, old, new):
            continue
        lines.append(f"origin {ref} changed (a push)")
    return lines


def _check(bundle: Bundle, before: dict[str, _HubState], watch: Watch, cause: BaseException | None) -> None:
    provider = getattr(cause, "provider", None) or watch.provider
    after = _manifest(bundle.root)
    changes = [
        f"bundle: {path} changed"
        for path in sorted(after.keys() | bundle.manifest.keys())
        if after.get(path) != bundle.manifest.get(path)
    ]
    for repo, state in before.items():
        try:
            changes += [f"{repo}: {line}" for line in _hub_changes(repo, bundle.branches[repo], state, _hub_state(repo))]
        except Exception as exc:
            changes.append(f"{repo}: could not be read after the step ({' '.join(str(exc).split())[:200]})")
    if changes:
        why = "the farm never rolls back a Plan's repos; check them by hand"
        raise ReadOnlyViolation(violation_message(provider, changes, why), rolled_back=False) from cause


@contextlib.contextmanager
def guard(bundle: Bundle, provider: str) -> Iterator[Watch]:
    """Runs the body as a read-only step over the bundle and every in-scope
    hub. A snapshot that cannot be taken means the step never runs."""
    watch = Watch(provider)
    try:
        before = {repo: _hub_state(repo) for repo in bundle.branches}
    except Exception as exc:
        raise SnapshotFailed(f"could not record the Plan's repos before a read-only step, so it did not run: {exc}") from exc
    try:
        yield watch
    except BaseException as exc:
        _check(bundle, before, watch, exc)
        raise
    _check(bundle, before, watch, None)
