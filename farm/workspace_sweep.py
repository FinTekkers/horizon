"""HZ-670: farmd's hourly sweep of processes left running in finished items'
workspaces, and its count of defunct (zombie) processes. HZ-963: the 5 s pass
that stops orphaned check processes in idle items' workspaces.

farm/run_reaper.py only kills tagged capture workers, browsers and e2e servers
whose lease is in this farm's RUNS_DIR. A test's own fixture server (a
`serve_app.py` the screenshot fixtures start) carries the test's lease, so it
outlived its run by days. This sweep finds such leftovers by where they run:

- **scan()** lists every process of this uid whose cwd or exe is inside an
  item workspace, `WORKSPACES_DIR/<owner>__<repo>__items/<item>/` — matched by
  exact path segments, so `hz-10` is never `hz-1` and `__premerge` or a
  sibling dir never matches — and that started over MIN_AGE_S ago. farmd and
  its ancestors are never listed. A process that holds a tty while its
  session leader lives (a person's shell), or that has a live child the scan
  did not list (a tmux server, a shell running something else), is marked
  spared.
- **kill()** signals the listed processes of items the server reports
  finished, with no claimed task file, no active lease and no held item lock:
  SIGTERM by pid, then SIGKILL after GRACE_S only if the pid still has the
  same start time and the same workspace. Never by name or pattern.
- **sweep_check_orphans()** (HZ-963) runs on farmd's run-sweep tick, next to
  run_reaper.sweep(). It stops the kinds run_reaper hunts (capture worker,
  browser, Playwright runner, e2e server) whose cwd is inside an item *or*
  pre-merge workspace and that started over CHECK_MIN_AGE_S ago — tagged or
  not, any lease or none — once their item is idle: no claimed task file, no
  active lease, no held item lock. The item need not be finished. Only the cwd
  counts here: a node or Chrome exe is never inside a workspace. Every live
  descendant of such a process goes with it (a worker's headless Chrome
  helpers chdir to /), unless something in the tree is spared. An item whose
  ownership can't be read is left running and logged as skipped. Each stop is
  logged with its kind, pid and item. On 22 Nov 2026 e2e servers 26 days old,
  a capture worker with its browsers and a Playwright runner had outlived
  their checks with no usable tag; this hourly sweep only ever looked at
  finished items' __items dirs.
- **count_zombies()** counts state-Z processes by parent pid: only the parent
  can reap them, so Farm health shows which pids hold them.

Fails closed: any /proc read, task file, lease or lock that can't be read
skips that process — or, for the run state, the whole sweep. A log line
carries a pid, an item and an age, never a command line.
"""

import os
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import premerge, procfs, run_reaper, workspaces

MIN_AGE_S = 3600
GRACE_S = 5.0
# HZ-963's pass runs every few seconds, so its floor is short — just long
# enough that a run still writing its task file or lease is never caught.
CHECK_MIN_AGE_S = 120
CHECK_GRACE_S = 1.0
ITEM_SUFFIXES = ("__items",)
CHECK_SUFFIXES = ("__items", "__premerge")
MAX_ZOMBIE_PARENTS = 20
_POLL_S = 0.1


@dataclass(frozen=True)
class Orphan:
    pid: int
    start: int  # stat start ticks: pid + start names one process
    repo_full: str  # "FinTekkers/horizon"
    item_id: str  # lowercased, "hz-595"
    age_s: float
    # Why it must be left alone even if its item is finished: "tty" or "child".
    spared: str | None = None
    # HZ-963: run_reaper.kind_of(), and for a descendant found by the tree
    # walk (not by its own cwd) the pid of the root it descends from.
    kind: str | None = None
    root: int | None = None
    # The workspace dirs it was found in: _same() checks it is still there.
    suffixes: tuple[str, ...] = ITEM_SUFFIXES


def _roots(workspaces_dir: Path) -> list[Path]:
    """WORKSPACES_DIR as configured and as the kernel prints it (symlinks resolved)."""
    roots = [Path(os.path.abspath(workspaces_dir))]
    real = Path(os.path.realpath(workspaces_dir))
    return roots if real == roots[0] else [*roots, real]


def _workspace_of_path(
    path: str | None, roots: list[Path], suffixes: tuple[str, ...] = ITEM_SUFFIXES
) -> tuple[str, str] | None:
    """(repo_full, lowercased item id) when `path` is inside an item workspace
    — or, with "__premerge" in `suffixes`, a pre-merge one."""
    if not path or not path.startswith("/"):
        return None
    for root in roots:
        try:
            parts = Path(path).relative_to(root).parts
        except ValueError:
            continue
        suffix = next((suffix for suffix in suffixes if len(parts) >= 2 and parts[0].endswith(suffix)), None)
        if suffix is None:
            return None
        # GitHub owners can't contain "_", so the first "__" splits owner/repo.
        owner, sep, repo = parts[0].removesuffix(suffix).partition("__")
        if not sep or not owner or not repo or owner.startswith("."):
            return None
        if len(parts[1]) > 64 or not premerge._ITEM_RE.match(parts[1]):
            return None
        return f"{owner}/{repo}", parts[1].lower()
    return None


def _workspace_of(
    pid: int, roots: list[Path], suffixes: tuple[str, ...] = ITEM_SUFFIXES, links: tuple[str, ...] = ("cwd", "exe")
) -> tuple[str, str] | None:
    """The workspace the process's cwd, else its exe, is inside."""
    for name in links:
        found = _workspace_of_path(procfs.link(pid, name), roots, suffixes)
        if found is not None:
            return found
    return None


def scan(
    *,
    workspaces_dir: Path | None = None,
    min_age_s: float = MIN_AGE_S,
    suffixes: tuple[str, ...] = ITEM_SUFFIXES,
    links: tuple[str, ...] = ("cwd", "exe"),
    kinds: tuple[str, ...] | None = None,
) -> list[Orphan]:
    """Every process of this uid in an item workspace that started over
    `min_age_s` ago, farmd and its ancestors aside. Nothing it can't read is
    listed. Signals nothing.

    HZ-963: with `kinds`, only processes of those run_reaper kinds are listed
    by where they run — plus every live descendant of one, whatever its cwd,
    kind or age, carrying its root's workspace. A spared root spares its whole
    tree."""
    roots = _roots(workspaces_dir if workspaces_dir is not None else workspaces.WORKSPACES_DIR)
    uptime = procfs.uptime_s()
    if uptime is None:
        return []
    mine = procfs.ancestors(os.getpid())
    found: dict[int, tuple[procfs.Stat, tuple[str, str], float]] = {}
    kind: dict[int, str | None] = {}
    live: dict[int, procfs.Stat] = {}
    for pid in procfs.own_pids():
        if pid in mine:
            continue
        st = procfs.stat(pid)
        if st is None or st.state in procfs.DEAD_STATES:
            continue
        live[pid] = st
        age = procfs.age_s(st.start, uptime)
        if age is None or age <= min_age_s:
            continue
        where = _workspace_of(pid, roots, suffixes, links)
        if where is None:
            continue
        if kinds is not None:
            kind[pid] = run_reaper.kind_of(pid)
            if kind[pid] not in kinds:
                continue
        found[pid] = (st, where, age)

    root_of: dict[int, int] = {}
    if kinds is not None:
        own_children: dict[int, list[int]] = {}
        for pid, st in live.items():
            own_children.setdefault(st.ppid, []).append(pid)
        todo = [(child, pid) for pid in found for child in own_children.get(pid, [])]
        while todo:
            pid, root = todo.pop()
            if pid in found or pid in root_of:
                continue
            st = live[pid]
            root_of[pid] = root
            found[pid] = (st, found[root][1], procfs.age_s(st.start, uptime) or 0.0)
            kind[pid] = run_reaper.kind_of(pid)
            todo.extend((child, root) for child in own_children.get(pid, []))

    spared: dict[int, str] = {}
    for pid, (st, _, _) in found.items():
        if st.tty_nr != 0 and st.session > 0 and procfs.alive(st.session):
            spared[pid] = "tty"
    # A live child that will not be killed (not listed, or itself spared)
    # spares its parent too, up the tree: a tmux server or shell is never
    # killed out from under work it still runs.
    children: dict[int, list[int]] = {}
    for pid in procfs.all_pids():
        st = procfs.stat(pid)
        if st is not None and st.state not in procfs.DEAD_STATES and st.ppid in found:
            children.setdefault(st.ppid, []).append(pid)
    changed = True
    while changed:
        changed = False
        for pid, kids in children.items():
            if pid not in spared and any(kid not in found or kid in spared for kid in kids):
                spared[pid] = "child"
                changed = True
    for pid, root in root_of.items():
        if root in spared and pid not in spared:
            spared[pid] = spared[root]

    return [
        Orphan(pid, st.start, where[0], where[1], age, spared.get(pid), kind.get(pid), root_of.get(pid), suffixes)
        for pid, (st, where, age) in sorted(found.items())
    ]


def _same(orphan: Orphan, roots: list[Path]) -> bool:
    """The pid still names the process scan() saw: alive, same start time,
    same item workspace. A reused pid fails the start check. A descendant
    found by the tree walk was never in the workspace itself: its start time
    alone names it."""
    st = procfs.stat(orphan.pid)
    if st is None or st.state in procfs.DEAD_STATES or st.start != orphan.start:
        return False
    if orphan.root is not None:
        return True
    return _workspace_of(orphan.pid, roots, orphan.suffixes) == (orphan.repo_full, orphan.item_id)


def _idle_items(runs_dir: Path | None = None) -> Callable[[str, str], bool | None]:
    """item_idle(repo_full, item_id): True when no claimed task file, active
    lease or held item lock names the item, False when one does, None when its
    lock can't be read. Raises when the task files or leases can't be read:
    the caller then kills nothing."""
    active = workspaces._active_item_ids(strict=True)
    leased = run_reaper.active_lease_items(runs_dir)
    idle: dict[tuple[str, str], bool | None] = {}

    def item_idle(repo_full: str, item_id: str) -> bool | None:
        key = (repo_full, item_id)
        if key not in idle:
            if item_id in active or item_id in leased:
                idle[key] = False
            else:
                try:
                    idle[key] = not workspaces.item_lock_held(repo_full, item_id)
                except Exception:
                    idle[key] = None
        return idle[key]

    return item_idle


def _terminate(
    orphans: list[Orphan],
    roots: list[Path],
    grace_s: float,
    signal_fn: Callable[[int, int], None],
    sleep: Callable[[float], None],
) -> list[Orphan]:
    """SIGTERM each orphan that _same() still names, then — after one shared
    grace — SIGKILL each that still is. Returns the orphans sent SIGTERM."""
    termed: list[Orphan] = []
    for orphan in orphans:
        if not _same(orphan, roots):
            continue
        try:
            signal_fn(orphan.pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        termed.append(orphan)

    # One shared grace for every process signalled above.
    waited = 0.0
    while waited < grace_s and any(_same(orphan, roots) for orphan in termed):
        sleep(_POLL_S)
        waited += _POLL_S
    for orphan in termed:
        if _same(orphan, roots):
            try:
                signal_fn(orphan.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    return termed


def kill(
    orphans: list[Orphan],
    finished: set[str],
    *,
    workspaces_dir: Path | None = None,
    grace_s: float = GRACE_S,
    signal_fn: Callable[[int, int], None] = os.kill,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> list[dict]:
    """Kills the orphans of items in `finished` (lowercased ids) that no run
    holds. Returns one {pid, item_id, age_s} per process sent SIGTERM."""
    if not orphans:
        return []
    roots = _roots(workspaces_dir if workspaces_dir is not None else workspaces.WORKSPACES_DIR)
    try:
        item_idle = _idle_items()
    except Exception:
        log("workspace sweep: skipped, run state unreadable")
        return []

    chosen: list[Orphan] = []
    for orphan in orphans:
        if orphan.item_id not in finished or not item_idle(orphan.repo_full, orphan.item_id):
            continue
        if orphan.spared is not None:
            log(f"workspace sweep: spared pid={orphan.pid} item={orphan.item_id} ({orphan.spared})")
            continue
        chosen.append(orphan)
    termed = _terminate(chosen, roots, grace_s, signal_fn, sleep)
    for orphan in termed:
        log(f"workspace sweep: killed pid={orphan.pid} item={orphan.item_id} age={int(orphan.age_s)}s")
    return [{"pid": orphan.pid, "item_id": orphan.item_id, "age_s": round(orphan.age_s, 1)} for orphan in termed]


# (pid, start) of every process sweep_check_orphans() has logged as skipped
# and still sees: the pass runs every few seconds, so each is logged once.
_skip_logged: set[tuple[int, int]] = set()


def sweep_check_orphans(
    *,
    workspaces_dir: Path | None = None,
    runs_dir: Path | None = None,
    min_age_s: float = CHECK_MIN_AGE_S,
    grace_s: float = CHECK_GRACE_S,
    signal_fn: Callable[[int, int], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> list[dict]:
    """HZ-963: stops every orphaned check process — a capture worker, browser,
    Playwright runner or e2e server whose cwd is inside an item or pre-merge
    workspace, with its descendants — whose item no task file, active lease or
    item lock holds. Returns one {pid, kind, item_id, age_s, reason} per
    process sent SIGTERM. An item whose lock can't be read, and a spared tree
    (a person's tty), is left running and logged as skipped; task files or
    leases that can't be read skip the whole pass. `signal_fn` defaults to
    os.kill as it is at call time."""
    orphans = scan(
        workspaces_dir=workspaces_dir, min_age_s=min_age_s, suffixes=CHECK_SUFFIXES, links=("cwd",), kinds=run_reaper.KINDS
    )
    if not orphans:
        _skip_logged.clear()
        return []
    roots = _roots(workspaces_dir if workspaces_dir is not None else workspaces.WORKSPACES_DIR)
    try:
        item_idle = _idle_items(runs_dir)
    except Exception:
        log("workspace sweep: orphan pass skipped, run state unreadable")
        return []

    chosen: list[Orphan] = []
    skipped: set[tuple[int, int]] = set()
    for orphan in orphans:
        idle = item_idle(orphan.repo_full, orphan.item_id)
        if idle is False:
            continue  # an active run owns it
        if idle is None or orphan.spared is not None:
            key = (orphan.pid, orphan.start)
            skipped.add(key)
            if key not in _skip_logged:
                log(
                    f"workspace sweep: skipped {orphan.kind or 'process'} pid={orphan.pid} item={orphan.item_id} "
                    f"reason={orphan.spared or 'unclear'}"
                )
            continue
        chosen.append(orphan)
    _skip_logged.clear()
    _skip_logged.update(skipped)

    termed = _terminate(chosen, roots, grace_s, signal_fn or os.kill, sleep)
    for orphan in termed:
        log(f"workspace sweep: killed {orphan.kind or 'process'} pid={orphan.pid} item={orphan.item_id} reason=orphan")
    return [
        {"pid": o.pid, "kind": o.kind, "item_id": o.item_id, "age_s": round(o.age_s, 1), "reason": "orphan"} for o in termed
    ]


def count_zombies(*, max_parents: int = MAX_ZOMBIE_PARENTS) -> dict:
    """{count, parents: [{ppid, count}], at}: every state-Z process on the
    host, by the parent that has yet to reap it, most first. No names."""
    by_parent: dict[int, int] = {}
    for pid in procfs.all_pids():
        st = procfs.stat(pid)
        if st is not None and st.state == "Z":
            by_parent[st.ppid] = by_parent.get(st.ppid, 0) + 1
    parents = sorted(by_parent.items(), key=lambda kv: (-kv[1], kv[0]))[:max_parents]
    return {
        "count": sum(by_parent.values()),
        "parents": [{"ppid": ppid, "count": count} for ppid, count in parents],
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
