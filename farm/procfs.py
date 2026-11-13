"""Reading /proc: one parser for farm/conflict_cancel.py, farm/run_reaper.py
and farm/workspace_sweep.py.

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
    # Fields 6 and 7: the session leader's pid and the controlling tty (0 for none).
    session: int = 0
    tty_nr: int = 0


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
        return Stat(
            raw[raw.find("(") + 1 : close], fields[0], int(fields[1]), int(fields[19]), int(fields[3]), int(fields[4])
        )
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


def all_pids() -> list[int]:
    """Every pid in /proc, whoever owns it — only for counting zombies."""
    return [int(entry) for entry in os.listdir(PROC) if entry.isdigit()]


def link(pid: int, name: str) -> str | None:
    """Where the process's `cwd` or `exe` link points, without the kernel's
    " (deleted)" suffix for a directory or file removed since; None when it
    can't be read."""
    try:
        target = os.readlink(PROC / str(pid) / name)
    except OSError:
        return None
    return target.removesuffix(" (deleted)")


def uptime_s() -> float | None:
    """Seconds since boot, or None when /proc/uptime can't be read."""
    try:
        return float((PROC / "uptime").read_text(encoding="ascii").split()[0])
    except (OSError, IndexError, ValueError):
        return None


def age_s(start_ticks: int, uptime: float | None = None) -> float | None:
    """How long ago a process with this stat start time started, or None when
    /proc/uptime can't be read. `uptime` saves the read for a caller that
    ages many processes at once."""
    if uptime is None:
        uptime = uptime_s()
    if uptime is None:
        return None
    return max(0.0, uptime - start_ticks / os.sysconf("SC_CLK_TCK"))


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


def held_locks() -> set[tuple[int, int, int]]:
    """HO-837: (major, minor, inode) of every file a lock is held on now,
    read from /proc/locks — a pure read: nothing is opened for writing and no
    lock is taken. A file's lock is held when (os.major(st_dev),
    os.minor(st_dev), st_ino) is in the set. Raises OSError when /proc/locks
    cannot be read, so a caller never reads "free" from a failed read."""
    held: set[tuple[int, int, int]] = set()
    for line in (PROC / "locks").read_text().splitlines():
        # "1: FLOCK  ADVISORY  WRITE 1234 08:01:131074 0 EOF"; a blocked
        # waiter's line has a "->" after its number and holds nothing.
        fields = line.split()
        if len(fields) < 6 or fields[1] == "->":
            continue
        try:
            major, minor, inode = fields[5].split(":")
            held.add((int(major, 16), int(minor, 16), int(inode)))
        except ValueError:
            continue
    return held


def lock_held(path: str) -> bool:
    """HO-837: whether any process holds a lock on `path` now. Only stats the
    path — never opens it — so no lock is ever taken. A missing file holds no
    lock. Matched by inode alone: btrfs and overlay report a subvolume's
    st_dev, but /proc/locks names the superblock's, so a device match would
    miss a held lock. An inode that collides across filesystems reads as
    held, which blocks — never as free. Raises OSError (other than a missing
    file) and the /proc/locks read's OSError."""
    try:
        inode = os.stat(path).st_ino
    except FileNotFoundError:
        return False
    return any(held == inode for _, _, held in held_locks())
