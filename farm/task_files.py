"""Reading a queued task file — shared by farmd's dispatcher and the PM agent.

HZ-212: farmd now claims PM tasks itself, so the boundary check that used to
live only in pm_agent.py has two callers. It lives here rather than in
pm_agent.py because importing pm_agent renders farm/roles/pm.md at import
time, which farmd has no reason to do.
"""

import json
from pathlib import Path


def read_task(path: Path) -> tuple[dict | None, str]:
    """HZ-130: reads one queued task file WITHOUT ever deleting it.

    Returns `(task, "")` when the file is usable, or `(None, reason)` when it
    is not: a truncated or corrupt payload, a file we could not read at all,
    or valid JSON missing the one field the PM cannot proceed without.

    OSError is caught alongside JSONDecodeError on purpose, and that does not
    turn this into "catch wider and continue" — the caller retries a bounded
    number of times and then *reports*, so a file we cannot read still ends in
    a report rather than in silence.

    `run_id` is validated here, at the boundary, rather than being trusted
    deeper in: process() reads it before its own try block, so a task file
    that parses but carries no run_id used to kill the loop with a KeyError
    *after* the file had already been unlinked — the same silent-loss shape as
    the malformed case, on a neighbouring input. Nothing else is validated
    here: any other missing field surfaces inside process(), which reports it.
    """
    try:
        task = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return None, f"unparseable JSON ({exc})"
    except OSError as exc:
        return None, f"unreadable ({exc})"
    if not isinstance(task, dict):
        return None, f"not a JSON object (got {type(task).__name__})"
    if task.get("run_id") in (None, ""):
        return None, "no run_id field"
    return task, ""


def read_launchable_task(path: Path) -> tuple[dict | None, str]:
    """read_task() plus the fields farmd needs to launch a session for it.

    farmd names the session from item.id and step.index (_run_session_name),
    so a task missing either would raise on every dispatcher tick instead of
    being reported once."""
    task, why = read_task(path)
    if task is None:
        return None, why
    step, item = task.get("step"), task.get("item")
    index = step.get("index") if isinstance(step, dict) else None
    if not isinstance(index, int) or isinstance(index, bool):
        return None, "no integer step.index field"
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
        return None, "no item.id field"
    return task, ""
