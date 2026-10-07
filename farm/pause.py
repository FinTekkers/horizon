"""Graceful pause of a running step agent (HZ-194).

Pausing an item used to kill its agent's tmux session outright, and the next
attempt's prepare_branch() then scrubbed everything the killed attempt had
written. Now farmd sends the step agent SIGTERM first, and this module turns
that signal into something step_agent can act on safely:

- inside an `interruptible()` region (the agent run, the repo checks) the
  handler raises PauseRequested once, then disarms itself — step_agent stops
  every child process, checkpoints the tree and writes an outcome file;
- after the agent has run but outside such a region (finalize, publishing)
  the signal is only recorded, so a push to the PR branch is never cut in
  half; main() reports it when the step ends;
- anywhere else there is nothing of this attempt's to save, so the handler
  writes outcome "nothing" straight away and farmd kills the session as
  before, without waiting out its bound.

PauseRequested is a BaseException on purpose: the existing `except
Exception` / `except CheckFailure` salvage paths must never mistake a pause
for an exhausted or failed run. farmd reads the outcome file — it never
reads this process's exit status.
"""

import contextlib
import json
import os
import signal
from pathlib import Path

# Outcome vocabulary shared with farmd's /steps/cancel response
# (`checkpoint.outcome`) and server/src/orchestrator.js's activity lines.
SAVED = "saved"
NOTHING = "nothing"
SKIPPED = "skipped"
FAILED = "failed"

# HZ-321: why farmd sent the SIGTERM, read from `<run_id>.stop-reason` next to
# the outcome file. Absent means an operator's pause, as before.
STOP_PAUSE = "pause"
STOP_DEPLOY = "deploy"


class PauseRequested(BaseException):
    """Raised by the SIGTERM handler. `at_entry` is True when the pause had
    arrived before the interruptible region started — i.e. before the work
    that region guards had begun."""

    def __init__(self, at_entry: bool = False):
        super().__init__("paused by an operator")
        self.at_entry = at_entry


_IDLE, _ARMED, _DEFERRED = "idle", "armed", "deferred"
_state = {"phase": _IDLE, "pending": False, "outcome_path": None}


def install_sigterm_handler(outcome_path: Path) -> None:
    """Called once by step_agent.main(). `outcome_path` is where an idle-phase
    pause reports outcome "nothing"."""
    _state.update(phase=_IDLE, pending=False, outcome_path=Path(outcome_path))
    signal.signal(signal.SIGTERM, _on_sigterm)


def _on_sigterm(signum, frame) -> None:
    if _state["pending"]:
        return  # a second SIGTERM never interrupts the salvage of the first
    _state["pending"] = True
    if _state["phase"] == _ARMED:
        _state["phase"] = _DEFERRED  # disarmed: this raises exactly once
        raise PauseRequested()
    if _state["phase"] == _IDLE and _state["outcome_path"] is not None:
        write_outcome(_state["outcome_path"], NOTHING, "the attempt had not started work that could be saved")


def pending() -> bool:
    return _state["pending"]


@contextlib.contextmanager
def interruptible():
    """A region a pause may interrupt. Entering it with a pause already
    recorded raises PauseRequested(at_entry=True). Leaving it — normally or
    not — leaves the handler deferring, because work now exists that a later
    signal must not cut in half."""
    if _state["pending"]:
        _state["phase"] = _DEFERRED
        raise PauseRequested(at_entry=True)
    _state["phase"] = _ARMED
    try:
        yield
    finally:
        _state["phase"] = _DEFERRED


def _children() -> dict[int, list[int]]:
    """ppid -> [pid] for every process visible in /proc (Linux only)."""
    tree: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue  # exited while we looked
        # The command name (field 2) is parenthesised and may itself hold
        # spaces or parentheses; ppid is the second field after its last ')'.
        fields = stat[stat.rfind(")") + 2 :].split()
        if len(fields) > 1:
            tree.setdefault(int(fields[1]), []).append(int(entry.name))
    return tree


def descendants(pid: int | None = None) -> list[int]:
    tree = _children()
    found, stack = [], [os.getpid() if pid is None else pid]
    while stack:
        for child in tree.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


def kill_descendants(sig: int = signal.SIGKILL) -> int:
    """Signals every descendant of this process — the claude CLI and every
    check command, grandchildren included (checks run in their own session,
    so tmux's SIGHUP never reached them). The whole tree is collected before
    anything is signalled: a parent killed first would orphan its children
    out of reach. Returns how many were signalled."""
    count = 0
    for pid in descendants():
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, sig)
            count += 1
    for pid in descendants():
        # Reap direct children so none lingers as a zombie in /proc.
        with contextlib.suppress(ChildProcessError, OSError):
            os.waitpid(pid, os.WNOHANG)
    return count


def write_outcome(path: Path, outcome: str, detail: str = "") -> None:
    """Atomic: farmd polls for this file and must never read half of it.
    The temp name keeps the `.paused` stem out of every `*.json` glob."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(json.dumps({"outcome": outcome, "detail": detail}))
    os.replace(tmp, path)


def report(outcome: str, detail: str = "") -> None:
    """Writes the outcome to the path install_sigterm_handler() was given; a
    no-op when none was (execute() called directly, as in tests)."""
    if _state["outcome_path"] is not None:
        write_outcome(_state["outcome_path"], outcome, detail)


def stop_reason() -> str:
    """STOP_DEPLOY when farmd stopped this run for a self-deploy (it writes
    the sibling `<run_id>.stop-reason` before the SIGTERM), else STOP_PAUSE."""
    path = _state["outcome_path"]
    if path is None:
        return STOP_PAUSE
    try:
        text = Path(path).with_suffix(".stop-reason").read_text().strip()
    except OSError:
        return STOP_PAUSE
    return STOP_DEPLOY if text == STOP_DEPLOY else STOP_PAUSE


def reported() -> bool:
    path = _state["outcome_path"]
    return path is not None and Path(path).exists()


def read_outcome(path: Path) -> dict | None:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("outcome"), str) else None
