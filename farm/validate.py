"""HZ-248: run a repo's checks on `main` for the 'Validate project' pre-flight.

The server's validation (server/src/projectValidate.js) runs

    python -m farm.validate <owner/repo> <run-id> <main-sha> --timeout-s N
        --forbid PATH [--forbid PATH ...] [--check-commands JSON] [--reap-only]
        [--checks-waiver {no_checks,predates_enforcement}]

which makes a fresh scratch worktree off the repo's farm hub at exactly
<main-sha> and runs farm/checks.py's run_checks() there — under the same
check-slot limiter as every other check run. It reads only: nothing is
committed, pushed or deployed, and no clone URL is written to disk (the
worktree reuses the hub).

The worktree lives at <WORKSPACES_DIR>/<owner>__<repo>__validate/<run-id>.
Every run gets its own run-id, so a run never reuses another's directory.
assert_validate_path() refuses any path under a deployed checkout, the
running checkout, ~/.horizon, or a --forbid root (the server passes every
deploy target's checkout), and every create and every removal checks it
first. The worktree and the run's throwaway FARM_HOME are reaped when the
run ends, whatever the outcome; a run the server had to kill is reaped by a
second `--reap-only` call, and a later run sweeps any leftover whose run
lock nobody holds.

stdout is ONE JSON line: {ok, reason, detail, tail, workspace, seconds}.
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
from .checks import CHECKS_WAIVERS, CheckFailure, run_checks
from .config import WORKSPACES_DIR
from .premerge import DEPLOYED_ROOTS, RESERVE_S, RUNNING_CHECKOUT, _git, _has_commit, _remove_scratch, _within, stderr_event

# Every deploy target keeps its state (last-good-tag, self-deploy.log) here.
HORIZON_STATE_ROOT = Path.home() / ".horizon"
CHECKS_HOME_PREFIX = "horizon-validate-farm-home-"

_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_RUN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class ValidateRefused(RuntimeError):
    pass


def _validate_root(repo_full: str) -> Path:
    return WORKSPACES_DIR / f"{repo_full.replace('/', '__')}__validate"


def validate_path(repo_full: str, run_id: str) -> Path:
    return _validate_root(repo_full) / run_id


def assert_validate_path(ws: Path, forbidden=()) -> None:
    """Raises ValidateRefused unless `ws` is a <repo>__validate/<run-id>
    directory directly under WORKSPACES_DIR and outside every forbidden root.
    Symlinks are resolved first, so a planted link cannot point elsewhere."""
    resolved = Path(ws).resolve()
    root = WORKSPACES_DIR.resolve()
    for deployed in (*DEPLOYED_ROOTS, HORIZON_STATE_ROOT, *(Path(p) for p in forbidden)):
        for candidate in {deployed, deployed.resolve()}:
            if _within(resolved, candidate) or _within(candidate, resolved):
                raise ValidateRefused(f"refusing to validate inside a protected path ({candidate}): {resolved}")
    if _within(resolved, RUNNING_CHECKOUT) or _within(RUNNING_CHECKOUT, resolved):
        raise ValidateRefused(f"refusing to validate in the running checkout: {resolved}")
    if resolved.parent.parent != root or not resolved.parent.name.endswith("__validate") or not _RUN_RE.match(resolved.name):
        raise ValidateRefused(f"validate workspace must be <repo>__validate/<run-id> under {root}: {resolved}")


@contextlib.contextmanager
def _run_lock(repo_full: str, run_id: str, *, unlink: bool = True):
    """Held for the whole life of a run's worktree. The leftover sweep only
    reaps a directory whose lock it can take, so a live run — another
    project on the same repo, an overlapping re-validate — is never swept.
    Yields False when someone else holds it."""
    root = _validate_root(repo_full)
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / f".{run_id}.lock"
    with open(lock_path, "w") as fh:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            if unlink:
                lock_path.unlink(missing_ok=True)
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _remove(repo_full: str, hub: Path, ws: Path, forbidden) -> None:
    """Under hub_lock, premerge's one removal sequence, guarded by this
    module's own path check instead of premerge's."""
    with workspaces.hub_lock(repo_full):
        _remove_scratch(hub, ws, guard=lambda path: assert_validate_path(path, forbidden))


def _reap_checks_homes(run_id: str) -> None:
    for home in Path(tempfile.gettempdir()).glob(f"{CHECKS_HOME_PREFIX}{run_id}-*"):
        shutil.rmtree(home, ignore_errors=True)


def reap_leftovers(repo_full: str, hub: Path, forbidden, log=print) -> list[str]:
    """Removes the worktree of every earlier run nobody holds the lock of
    (a run the server killed outright). Returns the run-ids reaped."""
    root = _validate_root(repo_full)
    if not root.is_dir():
        return []
    reaped = []
    for entry in sorted(root.iterdir()):
        if entry.name.startswith(".") or not _RUN_RE.match(entry.name):
            continue
        with _run_lock(repo_full, entry.name) as held:
            if not held:
                continue
            log(f"validate: reaping leftover run {entry.name}")
            _remove(repo_full, hub, entry, forbidden)
            _reap_checks_homes(entry.name)
            reaped.append(entry.name)
    return reaped


def reap_only(repo_full: str, run_id: str, forbidden) -> dict:
    """The server's cleanup after it had to kill a run: the worktree, its
    git worktree entry and the run's FARM_HOME. Never raises."""
    out = {"ok": False, "workspace": None}
    if not _REPO_RE.match(repo_full or "") or not _RUN_RE.match(run_id or ""):
        return {**out, "reason": "bad_input", "detail": f"bad repo or run id: {repo_full!r} {run_id!r}"}
    ws = validate_path(repo_full, run_id)
    out["workspace"] = str(ws)
    try:
        assert_validate_path(ws, forbidden)
        hub = workspaces.hub_path(repo_full)
        with _run_lock(repo_full, run_id) as held:
            if not held:
                return {**out, "reason": "busy", "detail": "the run is still alive"}
            if (hub / ".git").exists():
                _remove(repo_full, hub, ws, forbidden)
            elif ws.exists():
                shutil.rmtree(ws, ignore_errors=True)
            _reap_checks_homes(run_id)
    except Exception as exc:  # noqa: BLE001 — stdout must stay one JSON line
        return {**out, "reason": "crash", "detail": f"{type(exc).__name__}: {exc}"}
    return {**out, "ok": True}


def validate_checks(
    repo_full: str,
    run_id: str,
    main_sha: str,
    *,
    timeout_s: float,
    forbidden=(),
    configured=None,
    log=print,
    on_slot_event=None,
    checks_waiver=None,
) -> dict:
    """Never raises for an expected outcome: returns the CLI's result dict."""
    started = time.monotonic()
    deadline = started + max(timeout_s - RESERVE_S, 1)
    out = {"ok": False, "main_sha": main_sha}

    if not _REPO_RE.match(repo_full or "") or not _RUN_RE.match(run_id or ""):
        return {**out, "reason": "bad_input", "detail": f"bad repo or run id: {repo_full!r} {run_id!r}"}
    if not _SHA_RE.match(main_sha or ""):
        return {**out, "reason": "bad_input", "detail": "main must be a full 40-character commit sha"}

    ws = validate_path(repo_full, run_id)
    out["workspace"] = str(ws)
    try:
        assert_validate_path(ws, forbidden)
    except ValidateRefused as exc:
        return {**out, "reason": "bad_workspace", "detail": str(exc)}

    hub = workspaces.hub_path(repo_full)
    if not (hub / ".git").exists():
        return {**out, "reason": "no_hub", "detail": f"no hub checkout for {repo_full} — start the farm so the repo hub exists"}

    with _run_lock(repo_full, run_id) as held:
        if not held:
            return {**out, "reason": "busy", "detail": "this validation run is already in progress"}
        checks_home = Path(tempfile.mkdtemp(prefix=f"{CHECKS_HOME_PREFIX}{run_id}-"))
        try:
            reap_leftovers(repo_full, hub, forbidden, log=log)
            with workspaces.hub_lock(repo_full):
                if not _has_commit(hub, main_sha):
                    _git(hub, "fetch", "origin", "--prune")
                    if not _has_commit(hub, main_sha):
                        _git(hub, "fetch", "origin", main_sha, check=False)
                if not _has_commit(hub, main_sha):
                    return {**out, "reason": "crash", "detail": f"main commit not found after fetch: {main_sha}"}
                ws.parent.mkdir(parents=True, exist_ok=True)
                assert_validate_path(ws, forbidden)
                _git(hub, "worktree", "add", "--detach", str(ws), main_sha)

            log(f"validate: running checks on main {main_sha[:12]} in {ws}")
            try:
                note = run_checks(
                    ws,
                    log=log,
                    deadline=deadline,
                    item_id=run_id,
                    caller="validate",
                    child_env={"FARM_HOME": str(checks_home)},
                    on_slot_event=on_slot_event,
                    configured=configured,
                    checks_waiver=checks_waiver,
                    # HZ-406: this is main itself, so there is no branch copy
                    # to gate on — and the detached worktree may lack origin/main.
                    branch_gate=False,
                )
            except CheckFailure as exc:
                if exc.reason == "timed_out":
                    return {**out, "reason": "timed_out", "failing_check": exc.command, "detail": str(exc)}
                if exc.reason == "none_ran":
                    return {**out, "reason": "no_checks_detected", "detail": str(exc)}
                return {**out, "reason": "checks_failed", "failing_check": exc.command, "detail": f"{exc.command} failed", "tail": exc.tail}
            return {**out, "ok": True, "detail": note, "seconds": round(time.monotonic() - started)}
        except subprocess.TimeoutExpired as exc:
            return {**out, "reason": "timed_out", "detail": f"git timed out: {exc.cmd}"}
        except Exception as exc:  # noqa: BLE001 — every surprise is a fail-closed "crash"
            return {**out, "reason": "crash", "detail": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                _remove(repo_full, hub, ws, forbidden)
            finally:
                shutil.rmtree(checks_home, ignore_errors=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m farm.validate", description=__doc__.splitlines()[0])
    parser.add_argument("repo")
    parser.add_argument("run_id")
    parser.add_argument("main_sha", nargs="?", default="")
    parser.add_argument("--timeout-s", type=float, default=1500)
    parser.add_argument("--forbid", action="append", default=[], help="a root the run must stay outside of")
    parser.add_argument("--check-commands", default=None, help="JSON {install,test,lint,e2e} configured in Admin")
    parser.add_argument("--reap-only", action="store_true", help="only remove this run's leftovers")
    parser.add_argument(
        "--checks-waiver", choices=CHECKS_WAIVERS, default=None, help="HZ-304: the repo is marked 'no checks' in Admin"
    )
    args = parser.parse_args(argv)

    if args.reap_only:
        result = reap_only(args.repo, args.run_id, args.forbid)
        print(json.dumps(result), flush=True)
        return 0 if result.get("ok") is True else 1

    configured = None
    if args.check_commands is not None:
        # Fail closed, as premerge does: never run as "no commands".
        with contextlib.suppress(json.JSONDecodeError):
            configured = json.loads(args.check_commands)
        if not isinstance(configured, dict):
            detail = f"--check-commands is not a JSON object: {args.check_commands[:200]!r}"
            print(json.dumps({"ok": False, "reason": "crash", "detail": detail}), flush=True)
            return 1

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    try:
        result = validate_checks(
            args.repo,
            args.run_id,
            args.main_sha,
            timeout_s=args.timeout_s,
            forbidden=args.forbid,
            configured=configured,
            log=log,
            on_slot_event=stderr_event,
            checks_waiver=args.checks_waiver,
        )
    except Exception as exc:  # noqa: BLE001 — stdout must stay one JSON line
        result = {"ok": False, "reason": "crash", "detail": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
