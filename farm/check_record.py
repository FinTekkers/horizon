"""HZ-257: name the exact commit a passing repo-check run tested.

The implement step runs its checks on the uncommitted working tree and only
commits afterwards (finalize_branch), so "the sha that passed" exists only
once that commit is made. snapshot_tree() records the tree the checks are
about to see — in a throwaway index, so the real index and working tree are
untouched — and passed_sha() names HEAD only when HEAD's tree is exactly that
snapshot. Any difference (a check that rewrote a file, an untracked file left
behind, a git error) means no sha is reported, which only means the next
Accept runs its pre-merge checks.

The two report keys are read by the server's orchestrator.js
(store.js CHECKS_PASSED_SHA_KEY / CHECKS_FINISHED_AT_KEY), which records them
in its check_pass table. Nothing here ever raises: a record is best-effort
and must not fail or slow the check run.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

CHECKS_PASSED_SHA_KEY = "checks_passed_sha"
CHECKS_FINISHED_AT_KEY = "checks_finished_at"

# A normal snapshot takes well under a second; this bounds the whole snapshot
# so a wedged git can never hold up the check run it precedes.
SNAPSHOT_TIMEOUT_S = 10


def _git(ws: Path, *args: str, env: dict | None = None, timeout: float = SNAPSHOT_TIMEOUT_S) -> str:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        timeout=max(timeout, 0.1),
        env=run_env,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result.stdout.strip()


def _snapshot(ws: Path, deadline: float) -> str | None:
    tmpdir = None
    try:
        # A path that does not exist yet: git refuses an empty index file.
        tmpdir = tempfile.mkdtemp(prefix="horizon-check-snapshot-")
        env = {"GIT_INDEX_FILE": str(Path(tmpdir) / "index")}
        _git(ws, "read-tree", "HEAD", env=env, timeout=deadline - time.monotonic())
        _git(ws, "add", "-A", env=env, timeout=deadline - time.monotonic())
        return _git(ws, "write-tree", env=env, timeout=deadline - time.monotonic()) or None
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def snapshot_tree(ws: Path, log=print) -> str | None:
    """The tree id of the working tree as `git add -A` would commit it, or
    None. Built in a temp index; the real index is never written."""
    try:
        return _snapshot(ws, time.monotonic() + SNAPSHOT_TIMEOUT_S)
    except Exception as exc:  # best-effort — never blocks the checks
        log(f"check_record: no snapshot of the tree before the checks ({exc}) — no check pass will be reported")
        return None


def tested_commit(ws: Path, timeout_s: float, log=print) -> tuple[str | None, str | None]:
    """HZ-327: (HEAD's sha, the snapshot tree) a check run's test results are
    stored against. The tree is what "the same commit" means for test
    history: the implement step tests uncommitted work on an unchanged HEAD.
    (None, None) on any error, within timeout_s; never raises."""
    deadline = time.monotonic() + timeout_s
    try:
        head = _git(ws, "rev-parse", "HEAD", timeout=deadline - time.monotonic()) or None
        return head, _snapshot(ws, deadline)
    except Exception as exc:
        log(f"check_record: test results stored without their commit ({exc})")
        return None, None


def passed_sha(ws: Path, tree: str | None, log=print) -> str | None:
    """HEAD's sha when HEAD's tree is exactly `tree` (the snapshot taken
    before the checks), else None. Never raises."""
    if not tree:
        return None
    try:
        head_tree = _git(ws, "rev-parse", "HEAD^{tree}")
        if head_tree != tree:
            log("check_record: the committed tree differs from the one the checks ran on — no check pass reported")
            return None
        return _git(ws, "rev-parse", "HEAD") or None
    except Exception as exc:
        log(f"check_record: could not read HEAD ({exc}) — no check pass reported")
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# run_checks()'s note when at least one check command actually ran and passed.
# A waived note (HZ-304: "checks waived for <repo>: ...") is a green with
# nothing behind it, so it must never become a record that lets Accept skip
# the pre-merge run.
_RAN_NOTE = re.compile(r"[1-9][0-9]* repo check\(s\) passed")


def checks_ran(check_note: str) -> bool:
    return isinstance(check_note, str) and _RAN_NOTE.fullmatch(check_note) is not None


def report_fields(ws: Path, tree: str | None, check_note: str, finished_at: str, log=print) -> dict:
    """The two report keys, or {} when no check ran or no exact sha can be
    named."""
    if not checks_ran(check_note):
        return {}
    sha = passed_sha(ws, tree, log)
    return {CHECKS_PASSED_SHA_KEY: sha, CHECKS_FINISHED_AT_KEY: finished_at} if sha else {}
