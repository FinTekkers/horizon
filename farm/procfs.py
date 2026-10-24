"""Reading /proc: one parser for farm/conflict_cancel.py and farm/run_reaper.py.

Nothing read here (cmdline, environ) is ever logged by a caller — only
counts, pids, kinds and the run tag farm/run_reaper.py reads for itself.
"""

import os
from dataclasses import dataclass
from pathlib import Path

PROC = Path("/proc")
DEAD_STATES = ("Z", "X")


@dataclass(frozen=True)
class Stat:
    comm: str
    state: str
    ppid: int
    # Field 22 of /proc/<pid>/stat, in clock ticks since boot. With the pid it
    # names one process: a reused pid has a different start time.
    start: int


def stat(pid: int) -> Stat | None:
    """The process's stat line, or None once it is gone."""
    try:
        raw = (PROC / str(pid) / "stat").read_text()
    except OSError:
        return None
    # "1234 (comm with spaces) S 1 ..." — comm can hold spaces and ')'.
    close = raw.rfind(")")
    fields = raw[close + 2 :].split()
    try:
        return Stat(raw[raw.find("(") + 1 : close], fields[0], int(fields[1]), int(fields[19]))
    except (IndexError, ValueError):
        return None


def alive(pid: int) -> bool:
    """Running or sleeping; a zombie waiting for its parent is not alive."""
    st = stat(pid)
    return st is not None and st.state not in DEAD_STATES


def ancestors(pid: int) -> set[int]:
    """`pid` and every process above it, up to (not including) init."""
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        st = stat(pid)
        if st is None:
            break
        pid = st.ppid
    return seen


def own_pids() -> list[int]:
    """Every pid this uid owns, in /proc order."""
    uid = os.getuid()
    out = []
    for entry in os.listdir(PROC):
        if not entry.isdigit():
            continue
        try:
            if os.stat(PROC / entry).st_uid != uid:
                continue
        except OSError:
            continue
        out.append(int(entry))
    return out


def cmdline(pid: int) -> list[str]:
    """argv, or [] for a kernel thread, a zombie or a process that is gone."""
    try:
        raw = (PROC / str(pid) / "cmdline").read_bytes()
    except OSError:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def environ_value(pid: int, name: str) -> str | None:
    """One variable from the process's starting environment, or None. Only
    that one value is ever decoded."""
    try:
        raw = (PROC / str(pid) / "environ").read_bytes()
    except OSError:
        return None
    prefix = name.encode() + b"="
    for entry in raw.split(b"\0"):
        if entry.startswith(prefix):
            return entry[len(prefix) :].decode("utf-8", "replace")
    return None
