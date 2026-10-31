"""HZ-670: farmd's hourly sweep of processes left running in finished items'
workspaces, and its count of defunct (zombie) processes.

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


def _roots(workspaces_dir: Path) -> list[Path]:
    """WORKSPACES_DIR as configured and as the kernel prints it (symlinks resolved)."""
    roots = [Path(os.path.abspath(workspaces_dir))]
    real = Path(os.path.realpath(workspaces_dir))
    return roots if real == roots[0] else [*roots, real]


def _workspace_of_path(path: str | None, roots: list[Path]) -> tuple[str, str] | None:
    """(repo_full, lowercased item id) when `path` is inside an item workspace."""
    if not path or not path.startswith("/"):
        return None
    for root in roots:
        try:
            parts = Path(path).relative_to(root).parts
        except ValueError:
            continue
        if len(parts) < 2 or not parts[0].endswith("__items"):
            return None
        # GitHub owners can't contain "_", so the first "__" splits owner/repo.
        owner, sep, repo = parts[0].removesuffix("__items").partition("__")
        if not sep or not owner or not repo or owner.startswith("."):
            return None
        if len(parts[1]) > 64 or not premerge._ITEM_RE.match(parts[1]):
            return None
        return f"{owner}/{repo}", parts[1].lower()
    return None


def _workspace_of(pid: int, roots: list[Path]) -> tuple[str, str] | None:
    """The item workspace the process's cwd, else its exe, is inside."""
    for name in ("cwd", "exe"):
        found = _workspace_of_path(procfs.link(pid, name), roots)
        if found is not None:
            return found
    return None


def scan(*, workspaces_dir: Path | None = None, min_age_s: float = MIN_AGE_S) -> list[Orphan]:
    """Every process of this uid in an item workspace that started over
    `min_age_s` ago, farmd and its ancestors aside. Nothing it can't read is
    listed. Signals nothing."""
    roots = _roots(workspaces_dir if workspaces_dir is not None else workspaces.WORKSPACES_DIR)
    uptime = procfs.uptime_s()
    if uptime is None:
        return []
    mine = procfs.ancestors(os.getpid())
    found: dict[int, tuple[procfs.Stat, tuple[str, str], float]] = {}
    for pid in procfs.own_pids():
        if pid in mine:
            continue
        st = procfs.stat(pid)
        if st is None or st.state in procfs.DEAD_STATES:
            continue
        age = procfs.age_s(st.start, uptime)
        if age is None or age <= min_age_s:
            continue
        where = _workspace_of(pid, roots)
        if where is None:
            continue
        found[pid] = (st, where, age)

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

    return [
        Orphan(pid, st.start, where[0], where[1], age, spared.get(pid))
        for pid, (st, where, age) in sorted(found.items())
    ]


def _same(orphan: Orphan, roots: list[Path]) -> bool:
    """The pid still names the process scan() saw: alive, same start time,
    same item workspace. A reused pid fails the start check."""
    st = procfs.stat(orphan.pid)
    if st is None or st.state in procfs.DEAD_STATES or st.start != orphan.start:
        return False
    return _workspace_of(orphan.pid, roots) == (orphan.repo_full, orphan.item_id)


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
        active = workspaces._active_item_ids(strict=True)
        leased = run_reaper.active_lease_items()
    except Exception:
        log("workspace sweep: skipped, run state unreadable")
        return []

    idle: dict[tuple[str, str], bool] = {}

    def item_idle(repo_full: str, item_id: str) -> bool:
        key = (repo_full, item_id)
        if key not in idle:
            if item_id not in finished or item_id in active or item_id in leased:
                idle[key] = False
            else:
                try:
                    idle[key] = not workspaces.item_lock_held(repo_full, item_id)
                except Exception:
                    idle[key] = False
        return idle[key]

    termed: list[Orphan] = []
    for orphan in orphans:
        if not item_idle(orphan.repo_full, orphan.item_id):
            continue
        if orphan.spared is not None:
            log(f"workspace sweep: spared pid={orphan.pid} item={orphan.item_id} ({orphan.spared})")
            continue
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
        log(f"workspace sweep: killed pid={orphan.pid} item={orphan.item_id} age={int(orphan.age_s)}s")
    return [{"pid": orphan.pid, "item_id": orphan.item_id, "age_s": round(orphan.age_s, 1)} for orphan in termed]


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
