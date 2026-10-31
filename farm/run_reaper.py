"""HZ-569: every process a check, test run or pre-merge run starts dies with it.

On 24 Oct 2026 the host ran out of memory: 25 capture workers and 150
headless_shell browsers, up to 36 hours old, held about 10 GB. They came from
checks that had already ended. The capture runner starts `serve` and the
worker in sessions of their own, and Playwright starts its webServer and
browsers detached too, so a check's process-group kill (its timeout, Stop,
pre-merge's cap) never reached them. A process group cannot say who owns a
process; this module makes ownership explicit instead.

- **Tag.** A run sets HORIZON_RUN_ID=<run id> in the environment its children
  start with. Every descendant inherits it — across setsid, Playwright's
  webServer and the browsers it launches. Chromium's helper processes hide
  theirs (they write their titles over their environ), so an untagged
  descendant of a tagged process belongs to that process's run.
- **Lease.** The run writes RUNS_DIR/<run id>.json naming its owner: the pid
  and start time of the process that will reap it. The run is *active* while
  that exact process is alive (not a zombie, not a reused pid).
- **Reap.** When the run ends, however it ends, run_scope() kills every
  process carrying its tag. A timed-out check command is reaped at once
  (checks._run_bounded), and server/src/premerge.js reaps after its cap.
- **Sweep.** farmd sweeps at boot and every RUN_SWEEP_INTERVAL_S: a capture
  worker, browser or e2e server whose tag names a lease in RUNS_DIR whose
  owner is dead is killed, and each kill is logged with the run's item and
  worktree. That covers an owner that was SIGKILLed — a farmd restart, a
  stopped step, the OOM killer.

Ownership is the tag plus a lease in *this* farm's RUNS_DIR, never a name or
a port. A tag with no lease here (another farm home's run, a test's) is never
swept. The kind filter only narrows the sweep further: a service such as
horizon-server is itself `node src/server.js`, and only its missing tag
spares it. Every fintekkers-* service runs as the same uid as the farm, so
"only our uid" protects nothing on its own.

Nothing read from /proc is ever logged except pids, kinds and run tags —
never a command line or another environment variable.
"""

import argparse
import json
import os
import re
import secrets
import signal
import sys
import time
from collections.abc import Callable, Iterator, MutableMapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import config, procfs

RUN_ENV = "HORIZON_RUN_ID"
# Run ids become file names: nothing that could leave RUNS_DIR.
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CAPTURE_WORKER_SCRIPT = "farm/capture/worker.mjs"
# comm is cut at 15 characters: chrome_crashpad_handler shows as chrome_crashpad.
BROWSER_COMMS = ("headless_shell", "chrome", "chromium", "chromium-browse", "chrome_crashpad")
KINDS = ("capture_worker", "browser", "e2e_server")
KILL_WAIT_S = 2.0

# Run ids whose lease this process wrote and has not reaped yet.
_OWNED: set[str] = set()


def _stderr(msg: str) -> None:
    # Never stdout: python -m farm.premerge's stdout is one JSON line.
    print(msg, file=sys.stderr, flush=True)


def _runs_dir(runs_dir: Path | None) -> Path:
    return Path(runs_dir) if runs_dir is not None else config.RUNS_DIR


def valid_run_id(run_id) -> bool:
    return isinstance(run_id, str) and bool(_RUN_ID_RE.match(run_id))


def new_run_id(prefix: str, item_id: str | None = None) -> str:
    item = re.sub(r"[^a-z0-9]+", "-", str(item_id or "").lower()).strip("-")
    parts = [re.sub(r"[^a-z0-9]+", "-", prefix.lower()).strip("-") or "run", item, str(int(time.time())), secrets.token_hex(3)]
    return "-".join(part for part in parts if part)[:128]


def owns(run_id: str | None) -> bool:
    """Whether this process wrote `run_id`'s lease and is still running it."""
    return run_id in _OWNED


# ---- leases ----


def _lease_path(run_id: str, runs_dir: Path | None = None) -> Path | None:
    return _runs_dir(runs_dir) / f"{run_id}.json" if valid_run_id(run_id) else None


def read_lease(run_id: str, runs_dir: Path | None = None) -> dict | None:
    path = _lease_path(run_id, runs_dir)
    if path is None:
        return None
    try:
        lease = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return lease if isinstance(lease, dict) else None


def write_lease(
    run_id: str,
    *,
    item_id: str | None = None,
    caller: str | None = None,
    worktree: str | None = None,
    runs_dir: Path | None = None,
) -> Path:
    """Records this process as `run_id`'s owner. Raises ValueError for an id
    that cannot be a file name, OSError when the file cannot be written."""
    path = _lease_path(run_id, runs_dir)
    if path is None:
        raise ValueError(f"not a run id: {run_id!r}")
    me = procfs.stat(os.getpid())
    if me is None:
        raise OSError(f"cannot read /proc/{os.getpid()}/stat")
    lease = {
        "run_id": run_id,
        "owner_pid": os.getpid(),
        "owner_start": me.start,
        "item_id": item_id,
        "caller": caller,
        "worktree": str(worktree) if worktree is not None else None,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(lease) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def _end_lease(run_id: str, runs_dir: Path | None = None) -> None:
    """The owner is done but something tagged outlived its reap: mark the
    lease ended, so the sweep treats the run as dead though the owner lives."""
    path = _lease_path(run_id, runs_dir)
    lease = read_lease(run_id, runs_dir)
    if path is None or lease is None:
        return
    lease["ended_at"] = datetime.now(timezone.utc).isoformat()
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(lease) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def remove_lease(run_id: str, runs_dir: Path | None = None) -> None:
    path = _lease_path(run_id, runs_dir)
    if path is not None:
        path.unlink(missing_ok=True)


def lease_active(lease: dict) -> bool:
    """The lease's owner is the very process that wrote it, and it is still
    running: not gone, not a zombie its parent has yet to reap, not a pid the
    kernel has handed to someone else, and it has not ended the run."""
    if lease.get("ended_at"):
        return False
    pid, start = lease.get("owner_pid"), lease.get("owner_start")
    if not isinstance(pid, int) or isinstance(pid, bool) or not isinstance(start, int) or pid <= 1:
        return False
    st = procfs.stat(pid)
    return st is not None and st.state not in procfs.DEAD_STATES and st.start == start


# ---- which processes ----


def kind_of(pid: int) -> str | None:
    """capture_worker, browser or e2e_server — the only kinds the sweep kills
    — or None for anything else (npm, sh, python, a service's own process)."""
    st = procfs.stat(pid)
    if st is None:
        return None
    if st.comm in BROWSER_COMMS:
        return "browser"
    argv = procfs.cmdline(pid)
    if not argv or not Path(argv[0]).name.startswith("node"):
        return None
    args = [arg for arg in argv[1:] if not arg.startswith("-")]
    if not args:
        return None
    script = args[0].replace(os.sep, "/")
    if script.endswith(CAPTURE_WORKER_SCRIPT):
        return "capture_worker"
    if script == "src/server.js" or script.endswith("/src/server.js"):
        return "e2e_server"
    if "vite" in Path(script).parts or Path(script).name in ("vite", "vite.js"):
        return "e2e_server" if "preview" in args[1:] else None
    return None


def _tagged(run_ids, spared: set[int]) -> list[tuple[int, str]]:
    """(pid, run id) for every live process of this uid that belongs to one
    of `run_ids`, never one in `spared`.

    A process belongs to a run when it carries the run's tag, or when it
    carries no readable tag and descends from one that does. The second case
    is Chromium's: its zygote, GPU and utility processes write their titles
    over their own environ, so /proc shows none of it — but the browser that
    forked them is tagged. A descendant with a tag of its own (a nested run)
    is judged by that tag instead."""
    tags: dict[int, str | None] = {}
    children: dict[int, list[int]] = {}
    for pid in procfs.own_pids():
        st = procfs.stat(pid)
        if st is None or st.state in procfs.DEAD_STATES:
            continue
        tags[pid] = procfs.environ_value(pid, RUN_ENV)
        children.setdefault(st.ppid, []).append(pid)
    out, seen = [], set()
    todo = [(pid, tag) for pid, tag in tags.items() if tag is not None and tag in run_ids]
    while todo:
        pid, run_id = todo.pop()
        if pid in seen:
            continue
        seen.add(pid)
        if pid in spared:
            continue
        out.append((pid, run_id))
        todo.extend((child, run_id) for child in children.get(pid, []) if tags.get(child) is None)
    return out


def _signal_all(pids: list[int], grace_s: float) -> int:
    """SIGTERM each, SIGKILL whatever outlives `grace_s`. Returns how many
    are still alive after that."""
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline and any(procfs.alive(pid) for pid in pids):
        time.sleep(0.05)
    for pid in pids:
        if procfs.alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    deadline = time.monotonic() + KILL_WAIT_S
    while time.monotonic() < deadline and any(procfs.alive(pid) for pid in pids):
        time.sleep(0.05)
    return sum(1 for pid in pids if procfs.alive(pid))


def _reap(run_id: str, grace_s: float) -> tuple[int, int]:
    """(signalled, survivors) for every process tagged `run_id`, of any kind:
    only the run's own descendants carry its tag. Never this process or its
    ancestors — a nested run inherits the tag from the very process reaping."""
    if not valid_run_id(run_id):
        return 0, 0
    pids = [pid for pid, _tag in _tagged({run_id}, procfs.ancestors(os.getpid()))]
    if not pids:
        return 0, 0
    return len(pids), _signal_all(pids, grace_s)


def reap_run(run_id: str, *, grace_s: float = 1.0, log: Callable[[str], None] = _stderr) -> int:
    """Stops every process tagged `run_id`. Returns how many were signalled.
    Never raises: a reap that fails is logged and the caller's result stands."""
    try:
        signalled, survivors = _reap(run_id, grace_s)
    except Exception as exc:  # noqa: BLE001 — cleanup never changes a run's outcome
        log(f"run_reaper: could not reap run {run_id} ({type(exc).__name__}: {exc})")
        return 0
    if signalled:
        tail = f", {survivors} still alive" if survivors else ""
        log(f"run_reaper: run {run_id} ended — stopped {signalled} process(es) it left running{tail}")
    return signalled


@contextmanager
def run_scope(
    env: MutableMapping[str, str],
    *,
    item_id: str | None = None,
    caller: str | None = None,
    worktree=None,
    adopt: bool = False,
    prefix: str = "run",
    runs_dir: Path | None = None,
    log: Callable[[str], None] = _stderr,
) -> Iterator[str]:
    """Tags `env` (the environment the run's children start with) with a run
    id, leases it to this process, and reaps every tagged process on exit —
    on return, exception and KeyboardInterrupt alike.

    An env that already carries a tag is a nested run (a pre-merge's
    run_checks, a check inside a check): its id is yielded and nothing else
    happens, so the outer run's lease and processes are left to the outer
    run. adopt=True is the exception: python -m farm.premerge takes the id
    server/src/premerge.js chose and leases it to itself.

    The lease is removed only when the reap leaves nothing tagged alive;
    otherwise it is marked ended and farmd's sweep finishes the job."""
    existing = env.get(RUN_ENV)
    if existing and not adopt:
        yield existing
        return
    run_id = existing if valid_run_id(existing) else new_run_id(prefix, item_id)
    env[RUN_ENV] = run_id
    try:
        write_lease(run_id, item_id=item_id, caller=caller, worktree=worktree, runs_dir=runs_dir)
    except (OSError, ValueError) as exc:
        log(f"run_reaper: no lease for run {run_id} ({exc}) — if this process dies, its processes are not swept")
    _OWNED.add(run_id)
    try:
        yield run_id
    finally:
        _OWNED.discard(run_id)
        try:
            signalled, survivors = _reap(run_id, 1.0)
            if signalled:
                log(f"run_reaper: run {run_id} ended — stopped {signalled} process(es) it left running")
            if survivors:
                log(f"run_reaper: {survivors} process(es) of run {run_id} outlived SIGKILL — left to the sweep")
                _end_lease(run_id, runs_dir)
            else:
                remove_lease(run_id, runs_dir)
        except Exception as exc:  # noqa: BLE001 — cleanup never changes a run's outcome
            log(f"run_reaper: could not reap run {run_id} ({type(exc).__name__}: {exc})")


# ---- farmd's sweep ----


def active_lease_items(runs_dir: Path | None = None) -> set[str]:
    """HZ-670: the lowercased item id of every active lease in RUNS_DIR, for
    farm/workspace_sweep.py. A lease with no item_id names its item by its
    worktree (<hub>__items/<id> or <hub>__premerge/<id>). Raises when the dir
    can't be listed, a lease can't be read or parsed, or an active lease names
    no item either way: the caller then kills nothing."""
    runs_dir = _runs_dir(runs_dir)
    if not runs_dir.exists():
        return set()
    items: set[str] = set()
    for name in sorted(os.listdir(runs_dir)):
        if not name.endswith(".json"):
            continue
        try:
            lease = json.loads((runs_dir / name).read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue  # removed since the listing: that run is over
        if not isinstance(lease, dict):
            raise ValueError(f"lease {name} is not an object")
        if not lease_active(lease):
            continue
        item_id = lease.get("item_id")
        if not isinstance(item_id, str) or not item_id:
            item_id = _item_of_worktree(lease.get("worktree"))
        if item_id is None:
            raise ValueError(f"active lease {name} names no item")
        items.add(item_id.lower())
    return items


def _item_of_worktree(worktree) -> str | None:
    if not isinstance(worktree, str):
        return None
    parts = Path(worktree).parts
    for root, item in zip(parts, parts[1:]):
        if root.endswith(("__items", "__premerge")) and item:
            return item
    return None


def _leases(runs_dir: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    try:
        paths = sorted(runs_dir.glob("*.json"))
    except OSError:
        return out
    for path in paths:
        lease = read_lease(path.stem, runs_dir)
        if lease is not None:
            out[path.stem] = lease
    return out


def sweep(*, runs_dir: Path | None = None, grace_s: float = 1.0, log: Callable[[str], None] = _stderr) -> list[dict]:
    """Kills every capture worker, browser and e2e server whose tag names a
    lease in RUNS_DIR whose owner is gone. Returns one dict per kill:
    {pid, kind, run_id, item_id, worktree}.

    Spared, always: a process whose run is active; one whose tag has no lease
    here; an untagged one; any other kind. A dead lease with nothing tagged
    left alive is removed."""
    runs_dir = _runs_dir(runs_dir)
    dead = {run_id: lease for run_id, lease in _leases(runs_dir).items() if not lease_active(lease)}
    if not dead:
        return []
    tagged = _tagged(dead.keys(), procfs.ancestors(os.getpid()))
    kills = []
    for pid, run_id in tagged:
        kind = kind_of(pid)
        if kind is None:
            continue
        lease = dead[run_id]
        kills.append(
            {"pid": pid, "kind": kind, "run_id": run_id, "item_id": lease.get("item_id"), "worktree": lease.get("worktree")}
        )
    if kills:
        _signal_all([kill["pid"] for kill in kills], grace_s)
    for kill in kills:
        log(
            f"run_reaper: killed {kill['kind']} pid={kill['pid']} run={kill['run_id']} "
            f"item={kill['item_id']} worktree={kill['worktree']}"
        )
    left = {run_id for pid, run_id in tagged if procfs.alive(pid)}
    for run_id in dead:
        if run_id not in left:
            remove_lease(run_id, runs_dir)
    return kills


# ---- metric 5's evidence ----


def _age_s(start_ticks: int) -> float:
    age = procfs.age_s(start_ticks)
    if age is None:
        raise OSError("cannot read /proc/uptime")
    return age


def report(*, runs_dir: Path | None = None) -> dict:
    """Every capture worker, browser and e2e server of this uid with its age,
    and the oldest active run's age. `ok` is false when a capture worker or
    browser — or a tagged e2e server — is older than that run (or exists at
    all with no run active). An untagged
    e2e server is listed but never counted: horizon-server is one."""
    longest = 0.0
    for lease in _leases(_runs_dir(runs_dir)).values():
        st = procfs.stat(lease["owner_pid"]) if lease_active(lease) else None
        if st is not None:
            longest = max(longest, _age_s(st.start))
    processes, too_old = [], 0
    for pid in procfs.own_pids():
        kind = kind_of(pid)
        st = procfs.stat(pid)
        if kind is None or st is None or st.state in procfs.DEAD_STATES:
            continue
        tag = procfs.environ_value(pid, RUN_ENV)
        age = round(_age_s(st.start), 1)
        counted = kind != "e2e_server" or tag is not None
        # With no run active, no capture worker or browser should exist at all.
        old = counted and (age > longest or longest == 0)
        too_old += old
        processes.append({"pid": pid, "kind": kind, "age_s": age, "run_id": tag, "older_than_runs": old})
    return {"ok": too_old == 0, "longest_active_run_s": round(longest, 1), "too_old": too_old, "processes": processes}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m farm.run_reaper", description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run", metavar="RUN_ID", help="stop every process of this run, unless its owner is still running")
    group.add_argument("--sweep", action="store_true", help="one sweep, as farmd runs it")
    group.add_argument("--report", action="store_true", help="list target processes; exit 1 if any outlived every active run")
    args = parser.parse_args(argv)
    if args.report:
        out = report()
        print(json.dumps(out, indent=2))
        return 0 if out["ok"] else 1
    if args.sweep:
        print(json.dumps({"killed": len(sweep())}))
        return 0
    lease = read_lease(args.run)
    if lease is not None and lease_active(lease):
        print(json.dumps({"killed": 0, "skipped": "the run's owner is still running"}))
        return 0
    killed = reap_run(args.run)
    if not _tagged({args.run}, procfs.ancestors(os.getpid())):
        remove_lease(args.run)
    print(json.dumps({"killed": killed}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
