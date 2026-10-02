"""HZ-256: stop the processes one item's conflict resolver started.

The resolver runs on a thread inside farmd, so it cannot be killed; it unwinds
itself once conflict_resolver.request_cancel() sets its event. What CAN be
killed is what it is waiting on: the resolution/review agent (a direct child of
farmd, in farmd's own process group) and the repo's checks (each in a session
of its own, with grandchildren). Neither leaves a pgid this module could know
without changing how every agent and check is spawned, so the sweep finds them
by where they run instead: every one of them runs with its cwd inside the
item's worktree, which nothing else may use while the resolver holds the
item's lock.

Signals go to single pids, never to a process group: the agent shares farmd's
group, so a group kill would take farmd down with it.

Nothing read from /proc here (cmdline, environ) is ever logged — only counts.
"""

import os
import signal
import time
from pathlib import Path

PROC = Path("/proc")


def _stat(pid: int) -> tuple[str, str, int] | None:
    """(comm, state, ppid) of a live process, or None once it is gone."""
    try:
        raw = (PROC / str(pid) / "stat").read_text()
    except OSError:
        return None
    # "1234 (comm with spaces) S 1 ..." — comm can hold spaces and ')'.
    close = raw.rfind(")")
    fields = raw[close + 2 :].split()
    return raw[raw.find("(") + 1 : close], fields[0], int(fields[1])


def _alive(pid: int) -> bool:
    st = _stat(pid)
    return st is not None and st[1] not in ("Z", "X")


def _inside(path: Path, ws: Path) -> bool:
    # On a path boundary: hz-25's sweep must never match hz-256's worktree.
    return path == ws or ws in path.parents


def _ancestors(pid: int) -> set[int]:
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        st = _stat(pid)
        if st is None:
            break
        pid = st[2]
    return seen


def _pids_in(ws: Path) -> set[int]:
    """Live processes of this uid whose cwd is in `ws`, plus every descendant
    of those — a check's grandchildren may have changed directory.

    Never farmd itself or its ancestors, and never a `git` that is farmd's own
    direct child: that is the resolver's own git call (reset, abort, the push
    fence's cleanup), which must finish so the worktree is left clean."""
    ws = Path(os.path.realpath(ws))
    me = os.getpid()
    uid = os.getuid()
    spared = _ancestors(me)
    children: dict[int, list[int]] = {}
    matched: set[int] = set()
    for entry in os.listdir(PROC):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            if os.stat(PROC / entry).st_uid != uid:
                continue
        except OSError:
            continue
        st = _stat(pid)
        if st is None or st[1] in ("Z", "X") or pid in spared:
            continue
        comm, _state, ppid = st
        children.setdefault(ppid, []).append(pid)
        if ppid == me and comm == "git":
            continue
        try:
            cwd = Path(os.readlink(PROC / entry / "cwd"))
        except OSError:
            continue
        if _inside(cwd, ws):
            matched.add(pid)
    found = set()
    todo = list(matched)
    while todo:
        pid = todo.pop()
        if pid in found or pid in spared:
            continue
        found.add(pid)
        todo.extend(children.get(pid, []))
    return found


def sweep_worktree(ws: Path, *, grace_s: float = 1.0) -> int:
    """SIGTERM every process tied to `ws`, SIGKILL whatever is left after
    `grace_s`. Returns how many processes it signalled."""
    pids = _pids_in(ws)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline and any(_alive(pid) for pid in pids):
        time.sleep(0.05)
    for pid in pids:
        if _alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    return len(pids)
