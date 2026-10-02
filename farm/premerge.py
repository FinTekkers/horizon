"""HZ-183: run the repo's checks on a test-merge before Accept the code merges.

Twice, two PRs that were each green merged into a red main (HZ-130 x HZ-132,
HZ-154 x HZ-156): each was tested against the main it branched from, never
against the main it was about to land on. This module closes that window.
The server's Accept handler (server/src/premerge.js) runs

    python -m farm.premerge <owner/repo> <item-id> <head-sha> --base <base-sha> --timeout-s N --json
        [--check-commands <JSON object: the repo's install/test/lint/e2e commands>]

which makes a scratch worktree off the repo's hub at exactly <base-sha> (the
tip of the PR's base branch, as GitHub reported it to the server), merges
<head-sha> (the PR head, same source) into it, and runs farm/checks.py's
run_checks() there — the one definition of which checks a repo has.

stdout is ONE JSON line and nothing else; progress goes to stderr. Exit 0
only when every check ran green. Every other outcome — red check, conflict,
timeout, missing hub, crash — is `"ok": false` with a `reason`, and the
server refuses to merge on any of them: fail closed, never "skip and merge".

The scratch worktree lives at <WORKSPACES_DIR>/<owner>__<repo>__premerge/<item>,
never in /opt/horizon or the checkout this code is running from — see
assert_scratch_path(). It is reaped unconditionally when the run ends, and
every removal re-checks that path first, so cleanup can never reach an item
worktree under <repo>__items/.

The PR's own suites run with FARM_HOME pointed at a throwaway directory made
for the run, never the farm's: the farm's real FARM_HOME is how this module
finds the hub, but a test in the PR that defaulted or inherited it would be
reading and writing the live farm's queue and workspaces.
"""

import argparse
import contextlib
import fcntl
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import workspaces
from .checks import CheckFailure, output_tail, run_checks
from .config import WORKSPACES_DIR

# Deployed checkouts the pre-merge run must never touch, whatever a caller
# passes in. /opt/horizon is where horizon-server and farmd run from.
DEPLOYED_ROOTS = (Path("/opt/horizon"),)
# The checkout this module is imported from: in production that is
# /opt/horizon itself; in dev it is an item worktree — neither may host a run.
RUNNING_CHECKOUT = Path(__file__).resolve().parents[1]
# Kept back from the caller's budget for the git work and the reap, so the
# checks hit their own deadline (and report a structured "timed_out") before
# the server's wall-clock kill does.
RESERVE_S = 60

# HZ-227: a stderr line starting with this carries one JSON event for the
# server — today only check_slots' queued/granted. Must match EVENT_PREFIX in
# server/src/premerge.js (parseSlotEvent). stdout stays one JSON line.
EVENT_PREFIX = "HORIZON_EVENT "

_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class PremergeRefused(RuntimeError):
    pass


def _premerge_root(repo_full: str) -> Path:
    return WORKSPACES_DIR / f"{repo_full.replace('/', '__')}__premerge"


def premerge_path(repo_full: str, item_id: str) -> Path:
    return _premerge_root(repo_full) / item_id.lower()


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def assert_scratch_path(ws: Path) -> None:
    """Raises PremergeRefused unless `ws` is a <repo>__premerge/<item>
    directory directly under WORKSPACES_DIR. Symlinks are resolved first, so
    a link planted under WORKSPACES_DIR cannot point the run elsewhere."""
    resolved = Path(ws).resolve()
    root = WORKSPACES_DIR.resolve()
    for deployed in DEPLOYED_ROOTS:
        if _within(resolved, deployed.resolve()) or _within(resolved, deployed):
            raise PremergeRefused(f"refusing to run pre-merge checks in a deployed checkout: {resolved}")
    running = RUNNING_CHECKOUT
    if _within(resolved, running) or _within(running, resolved):
        raise PremergeRefused(f"refusing to run pre-merge checks in the running checkout: {resolved}")
    if resolved.parent.parent != root or not resolved.parent.name.endswith("__premerge"):
        raise PremergeRefused(f"pre-merge workspace must be <repo>__premerge/<item> under {root}: {resolved}")


def _git(path: Path, *args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(path), *args], capture_output=True, text=True, timeout=max(timeout, 1)
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[-300:]}")
    return result


def _has_commit(hub: Path, sha: str) -> bool:
    return _git(hub, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


@contextlib.contextmanager
def _item_lock(repo_full: str, item_id: str):
    """One pre-merge run per item at a time. A filesystem lock, not the
    server's in-memory guard: it survives a server restart mid-run, and the
    scratch path is shared by every run for the item. Yields False when
    another run holds it."""
    root = _premerge_root(repo_full)
    root.mkdir(parents=True, exist_ok=True)
    with open(root / f".{item_id.lower()}.lock", "w") as fh:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _remove_scratch(hub: Path, ws: Path) -> None:
    """The ONLY place this module deletes anything in the farm's workspaces.
    Caller holds hub_lock. assert_scratch_path() runs first, every time, so
    whatever `ws` turns out to be, nothing outside <repo>__premerge/<item> is
    removed — never an item worktree under <repo>__items/."""
    assert_scratch_path(ws)
    _git(hub, "worktree", "remove", "--force", str(ws), check=False)
    if ws.exists():
        shutil.rmtree(ws, ignore_errors=True)
    _git(hub, "worktree", "prune", check=False)


def _reap(repo_full: str, hub: Path, ws: Path) -> None:
    """Unconditional — this worktree is outside the item pool's eviction, so
    the reap is the only thing bounding its disk use. Same sequence and lock
    as workspaces.reap_item_worktree()."""
    with workspaces.hub_lock(repo_full):
        _remove_scratch(hub, ws)


def stderr_event(event: dict) -> None:
    """Fire-and-forget: one EVENT_PREFIX line on stderr, never raises."""
    try:
        print(EVENT_PREFIX + json.dumps(event), file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 — an event is never worth failing a run over
        pass


def premerge_check(
    repo_full: str,
    item_id: str,
    head_sha: str,
    base_sha: str,
    *,
    timeout_s: float,
    log=print,
    on_slot_event=None,
    configured=None,
) -> dict:
    """Never raises for an expected outcome: returns the CLI's result dict."""
    started = time.monotonic()
    deadline = started + max(timeout_s - RESERVE_S, 1)
    out = {"ok": False, "base_sha": base_sha, "head_sha": head_sha}

    if not _REPO_RE.match(repo_full or "") or not _ITEM_RE.match(item_id or ""):
        return {**out, "reason": "bad_input", "detail": f"bad repo or item id: {repo_full!r} {item_id!r}"}
    if not _SHA_RE.match(head_sha or "") or not _SHA_RE.match(base_sha or ""):
        return {**out, "reason": "bad_input", "detail": "head and base must be full 40-character commit shas"}

    ws = premerge_path(repo_full, item_id)
    out["workspace"] = str(ws)
    try:
        assert_scratch_path(ws)
    except PremergeRefused as exc:
        return {**out, "reason": "bad_workspace", "detail": str(exc)}

    hub = workspaces.hub_path(repo_full)
    if not (hub / ".git").exists():
        return {**out, "reason": "no_hub", "detail": f"no hub checkout for {repo_full} — start the farm so the repo hub exists"}

    with _item_lock(repo_full, item_id) as held:
        if not held:
            return {**out, "reason": "busy", "detail": "pre-merge checks are already running for this item"}
        checks_home = Path(tempfile.mkdtemp(prefix="horizon-premerge-farm-home-"))
        try:
            with workspaces.hub_lock(repo_full):
                _git(hub, "fetch", "origin", "--prune")
                for sha in (base_sha, head_sha):
                    if not _has_commit(hub, sha):
                        # Not on any fetched branch (e.g. a deleted head ref) —
                        # GitHub serves reachable commits by sha.
                        _git(hub, "fetch", "origin", sha, check=False)
                missing = [sha for sha in (base_sha, head_sha) if not _has_commit(hub, sha)]
                if missing:
                    return {**out, "reason": "crash", "detail": f"commit(s) not found after fetch: {', '.join(missing)}"}
                if ws.exists():
                    _remove_scratch(hub, ws)
                ws.parent.mkdir(parents=True, exist_ok=True)
                _git(hub, "worktree", "add", "--detach", str(ws), base_sha)

            log(f"premerge: merging {head_sha[:12]} into {base_sha[:12]} in {ws}")
            merge = _git(
                ws,
                "-c", "user.name=Horizon pre-merge",
                "-c", "user.email=horizon-premerge@localhost",
                "merge", "--no-ff", "--no-edit", head_sha,
                check=False,
                timeout=deadline - time.monotonic(),
            )
            if merge.returncode != 0:
                return {**out, "reason": "merge_conflict", "detail": output_tail(merge.stdout + "\n" + merge.stderr)}
            out["merge_sha"] = _git(ws, "rev-parse", "HEAD").stdout.strip()

            try:
                note = run_checks(
                    ws,
                    log=log,
                    require_ran=True,
                    deadline=deadline,
                    item_id=item_id,
                    caller="premerge",
                    child_env={"FARM_HOME": str(checks_home)},
                    on_slot_event=on_slot_event,
                    configured=configured,
                )
            except CheckFailure as exc:
                if exc.reason == "timed_out":
                    return {**out, "reason": "timed_out", "failing_check": exc.command, "detail": str(exc)}
                if exc.reason == "none_ran":
                    return {**out, "reason": "no_checks_detected", "detail": str(exc)}
                return {**out, "reason": "checks_failed", "failing_check": exc.command, "tail": exc.tail}
            return {**out, "ok": True, "note": note, "seconds": round(time.monotonic() - started)}
        except subprocess.TimeoutExpired as exc:
            return {**out, "reason": "timed_out", "detail": f"git timed out: {exc.cmd}"}
        except Exception as exc:  # noqa: BLE001 — every surprise is a fail-closed "crash"
            return {**out, "reason": "crash", "detail": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                _reap(repo_full, hub, ws)
            finally:
                shutil.rmtree(checks_home, ignore_errors=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m farm.premerge", description=__doc__.splitlines()[0])
    parser.add_argument("repo")
    parser.add_argument("item_id")
    parser.add_argument("head_sha")
    parser.add_argument("--base", required=True, dest="base_sha")
    parser.add_argument("--timeout-s", type=float, default=1200)
    parser.add_argument("--json", action="store_true", help="accepted for clarity; output is always JSON")
    parser.add_argument(
        "--check-commands",
        default=None,
        help="HZ-245: JSON {install,test,lint,e2e} configured for the repo in Admin; absent means auto-detect",
    )
    args = parser.parse_args(argv)

    configured = None
    if args.check_commands is not None:
        # Fail closed: an unreadable config must never fall back to
        # auto-detect, which would judge the merge by different checks.
        with contextlib.suppress(json.JSONDecodeError):
            configured = json.loads(args.check_commands)
        if not isinstance(configured, dict):
            detail = f"--check-commands is not a JSON object: {args.check_commands[:200]!r}"
            print(json.dumps({"ok": False, "reason": "crash", "detail": detail}), flush=True)
            return 1

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    try:
        result = premerge_check(
            args.repo,
            args.item_id,
            args.head_sha,
            args.base_sha,
            timeout_s=args.timeout_s,
            log=log,
            on_slot_event=stderr_event,
            configured=configured,
        )
    except Exception as exc:  # noqa: BLE001 — stdout must stay one JSON line
        result = {"ok": False, "reason": "crash", "detail": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
