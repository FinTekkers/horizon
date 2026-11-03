"""HZ-750: a fix round's targeted run — the slot that failed last round,
re-run alone on the tests that failed, before the full checks.

The repo opts a slot in through Admin (the server sends `targeted_slots` with
the task, beside `check_commands`); nothing here reads the branch. The failing
tests reach the slot's command as data in checks.FAILED_TESTS_ENV, one
`file` or `file:line` per line, taken from last round's JUnit rows. How the
command uses them is the repo's own business: a script that ignores the
variable just runs its suite.

Never weaker than the full checks: a targeted pass is always followed by the
full run in the same round, and anything that makes the list doubtful —
empty, unreadable, over the cap — runs the full checks instead.
"""

from __future__ import annotations

import fnmatch
import os
import subprocess
from pathlib import Path, PurePosixPath

from . import checks, dep_cache
from .checks import CheckFailure

FAILED_TESTS_ENV = checks.FAILED_TESTS_ENV
# Over either cap, the list is not sent and the round runs full.
MAX_ENTRIES = 200
MAX_BYTES = 16_384
# The slots a targeted run may narrow. Install and lint name no tests.
TARGETABLE_SLOTS = frozenset({"test", "e2e"})
KILL_SWITCH_ENV = "FARM_TARGETED_CHECKS"
# A fix that changes one of these needs the full run's install. Matched by
# basename, anywhere in the tree.
MANIFEST_PATTERNS = (
    *(name for name, _ in dep_cache.LOCKFILES),
    "package.json",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "requirements*.txt",
)
GIT_TIMEOUT_S = 30
_BAD_CHARS = ("\n", "\r", "\0", ":")


def _entry(row: dict) -> str | None:
    """One row's `file` or `file:line`, or None when the row is unreadable."""
    file = row.get("file")
    if not isinstance(file, str) or not file.strip():
        return None
    if any(ch in file for ch in _BAD_CHARS):
        return None
    path = PurePosixPath(file)
    if path.is_absolute() or file.startswith("\\") or ".." in path.parts:
        return None
    line = row.get("line")
    if isinstance(line, int) and not isinstance(line, bool) and line >= 1:
        return f"{file}:{line}"
    return file


def failed_tests_value(rows: list[dict]) -> str | None:
    """FAILED_TESTS_ENV's value for these failing-test rows: one entry per
    line, deduped in first-seen order. None when the list is empty, any row
    is unreadable, or the value is over MAX_ENTRIES or MAX_BYTES."""
    entries: list[str] = []
    for row in rows or ():
        entry = _entry(row) if isinstance(row, dict) else None
        if entry is None:
            return None
        entries.append(entry)
    entries = list(dict.fromkeys(entries))
    if not entries or len(entries) > MAX_ENTRIES:
        return None
    value = "\n".join(entries)
    if len(value.encode()) > MAX_BYTES:
        return None
    return value


def _changed_files(ws: Path, since: str) -> list[str] | None:
    """Paths changed between `since` and HEAD, or None when git can't say."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(ws), "diff", "--name-only", since, "HEAD"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return [line for line in proc.stdout.splitlines() if line]


def _changed_why(ws: Path, fix_base: str | None) -> str | None:
    """Why what the fix turn changed rules out a targeted run, or None."""
    if not fix_base:
        return "no fix-turn base to compare against"
    changed = _changed_files(ws, fix_base)
    if changed is None:
        return "could not tell what the fix turn changed"
    for path in changed:
        name = path.rsplit("/", 1)[-1]
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in MANIFEST_PATTERNS):
            return f"the fix turn changed {path}, so the install must run"
        if path.startswith(checks.BRANCH_SCRIPTS_DIR):
            return f"the fix turn changed {path}, so the branch's check scripts must run"
    return None


def skip_reason(
    failure: CheckFailure | None,
    targeted_slots,
    *,
    rounds: int,
    ws: Path,
    fix_base: str | None,
) -> str | None:
    """None when this round may start with a targeted run of failure.slot;
    else why not, for the log. Every reason means: run the full checks."""
    if os.environ.get(KILL_SWITCH_ENV, "1").strip().lower() in ("0", "false", "no", "off"):
        return f"{KILL_SWITCH_ENV} is off"
    if rounds == 0 or failure is None:
        return "the first check run of this step"
    slot = failure.slot
    if slot is None or slot not in TARGETABLE_SLOTS:
        return f"the {slot or 'failing'} check is not a test slot"
    if not isinstance(targeted_slots, (list, tuple)) or slot not in targeted_slots:
        return f"the {slot} slot is not opted in"
    if failure.reason != "failed":
        return f"last round did not reach a test result ({failure.reason})"
    if failed_tests_value(failure.failed_tests) is None:
        return "last round's failing tests are empty, unreadable or over the cap"
    return _changed_why(ws, fix_base)
