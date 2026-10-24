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

from . import procfs

PROC = procfs.PROC
_alive = procfs.alive


def _inside(path: Path, ws: Path) -> bool:
    # On a path boundary: hz-25's sweep must never match hz-256's worktree.
    return path == ws or ws in path.parents


def _pids_in(ws: Path) -> set[int]:
    """Live processes of this uid whose cwd is in `ws`, plus every descendant
    of those — a check's grandchildren may have changed directory.

    Never farmd itself or its ancestors, and never a `git` that is farmd's own
    direct child: that is the resolver's own git call (reset, abort, the push
    fence's cleanup), which must finish so the worktree is left clean."""
    ws = Path(os.path.realpath(ws))
    me = os.getpid()
    spared = procfs.ancestors(me)
    children: dict[int, list[int]] = {}
    matched: set[int] = set()
    for pid in procfs.own_pids():
        st = procfs.stat(pid)
        if st is None or st.state in procfs.DEAD_STATES or pid in spared:
            continue
        children.setdefault(st.ppid, []).append(pid)
        if st.ppid == me and st.comm == "git":
            continue
        try:
            cwd = Path(os.readlink(PROC / str(pid) / "cwd"))
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
