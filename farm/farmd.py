"""farmd — the agent-farm daemon.

Owns tmux sessions, workspaces and the task queue. Executes exactly one step
when the Node orchestrator asks; never sequences anything itself. Runs under
tmux session `farm-daemon` (see run.sh) on port 4100.
"""

import asyncio
import json
import os
import signal
import tempfile
import threading
import time
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# HZ-128: the step model lives in domain/, not in farm/ — an absolute import
# off the repo root, which farmd already runs from (`python -m farm.farmd`).
# HZ-132 put the failure-reason vocabulary there under the same rule, so the
# tags this daemon relays are the ones the server classifies, by construction.
from domain.py import reasons, steps
from . import check_slots, conflict_resolver, pause, rules, tmux_mgr, workspaces
from . import config as farm_config
from .agent_runner import AgentError, assert_provider_auth
from .config import (
    FARM_PORT,
    HORIZON_URL,
    LOGS_DIR,
    QUEUE_DIR,
    SHARED_SECRET,
    STATE_DIR,
    ensure_dirs,
    slugify,
)

import sys
from pathlib import Path

app = FastAPI(title="horizon-farmd")

state = {
    "status": "stopped",  # stopped | starting | running | error
    "project": None,       # {id, name}
    "repos": [],
    "error": None,
    "since": None,
}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pm_session_name() -> str:
    return f"farm-pm-{slugify(state['project']['name'])}" if state["project"] else ""


# HZ-50: raised from 2 to 4 now that per-item git worktrees (workspaces.py)
# mean concurrent steps on different items no longer share a working tree to
# reset/clean/checkout over each other. Steps mostly wait on the Claude API
# and git network calls rather than burning CPU, so 4-way concurrency is
# reasonable even on this host's 2 vCPUs — the exception is run_checks()
# (the repo's own tests/linters), which is genuinely CPU-bound.
#
# HZ-144 answered that exception directly: FARM_MAX_CONCURRENT_CHECKS
# (farm/check_slots.py) caps how many check suites run at once, independently
# of how many agents are in flight. So the two pressures are now tuned
# separately — raise this for queue throughput, lower that for CPU headroom.
# The code default stays 4 deliberately: the cap this host runs is set in
# /etc/horizon/farm.env (see infra/host/DEPLOY.md), and raising the default
# instead would silently re-raise the cap on every other host too.
MAX_EPHEMERAL = int(__import__("os").environ.get("FARM_MAX_EPHEMERAL", "4"))

# run_id -> tmux session name for launched ephemeral runs (so cancel can kill).
RUN_SESSIONS: dict = {}

# run_ids currently claimed by the PM agent (HZ-100). Steps 0/1/2/9 have no
# per-run tmux session of their own — the PM's session persists across the
# farm's lifetime — so this is what /runs/alive checks to prove a claimed PM
# run is still in flight, without which a lost server-side watchdog for a
# genuinely-in-flight PM step could be misread as dead. Populated by
# /internal/steps/started, cleared by /internal/steps/result.
PM_ACTIVE_RUNS: set = set()

# Farm state survives farmd restarts: on boot we ADOPT live agent sessions
# instead of requiring a /farm/start (whose teardown would kill them).
STATE_FILE = STATE_DIR / "farmd-state.json"


def _persist_state() -> None:
    STATE_FILE.write_text(json.dumps({"project": state["project"], "repos": state["repos"]}))


def _adopt_existing() -> None:
    if not STATE_FILE.exists():
        return
    try:
        saved = json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError:
        return
    if not saved.get("project"):
        return
    state.update(status="running", project=saved["project"], repos=saved.get("repos", []), since=_now())
    # Rebuild the run->session map from claimed task files so cancel still works.
    for task_path in (QUEUE_DIR / "runs" / "active").glob("*.json"):
        try:
            task = json.loads(task_path.read_text())
            name = f"farm-run-{task['item']['id'].lower()}-s{task['step']['index']}-a{task.get('attempt', 1)}"
            if tmux_mgr.session_exists(name):
                RUN_SESSIONS[str(task["run_id"])] = name
        except (json.JSONDecodeError, KeyError):
            continue
    print(
        f"farmd: adopted running farm for '{saved['project'].get('name')}' "
        f"({len(RUN_SESSIONS)} in-flight run(s); the watchdog revives the PM if needed)",
        flush=True,
    )


def _teardown() -> None:
    killed = tmux_mgr.kill_all_farm_sessions()
    RUN_SESSIONS.clear()
    for sub in ("pm", "runs", "runs/active"):
        # HZ-130: `*.json*`, not `*.json` — a farmd killed between
        # _write_task_atomic's temp write and its rename() leaves a
        # `<run_id>.<suffix>.json.tmp` behind, which a `*.json` glob would
        # never reach and nothing else ever cleans.
        for f in (QUEUE_DIR / sub).glob("*.json*"):
            f.unlink(missing_ok=True)
    # HZ-194: a step agent's pid and pause-outcome files (see _pause_in_flight).
    for pattern in ("*.pid", "*.paused*"):
        for f in (QUEUE_DIR / "runs" / "active").glob(pattern):
            f.unlink(missing_ok=True)
    if killed:
        print(f"farmd: tore down sessions {killed}", flush=True)


def _ephemeral_sessions() -> list[str]:
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith("farm-run-")]


def _run_session_name(task: dict) -> str:
    """One place derives the tmux session name for an ephemeral run — the
    dispatcher creates it, /steps/cancel kills it."""
    return f"farm-run-{task['item']['id'].lower()}-s{task['step']['index']}-a{task.get('attempt', 1)}"


# Workspace-mutating steps: implement and the automated review, both of
# which call prepare_branch() (reset --hard / clean -fd) on the item's own
# worktree. Since HZ-50 gave every item its own git worktree, different
# items no longer share a tree and can run these fully in parallel — only
# two runs against the SAME item still need to be serialized, or one's scrub
# could clobber the other's in-flight edits.
#
# HZ-117: derived from steps.STEPS's workspaceMutating field, not a
# hand-maintained tuple of indices — an inserted or reordered step carries
# its own flag with it.
def workspace_mutating_indexes(step_table: list[dict]) -> set[int]:
    return {entry["index"] for entry in step_table if entry.get("workspaceMutating")}


# Lane routing: which long-running process handles a dispatched step — the
# persistent PM session ("pm") or an ephemeral farm-dispatched agent
# ("runs"). HZ-117: derived from steps.STEPS's runsIn field. An index absent
# from the table (e.g. a gate, which is never dispatched here at all) falls
# back to `default` — preserves the pre-HZ-117 behavior for an unrecognized
# index.
def lane_for_index(step_table: list[dict], index, default: str = "runs") -> str:
    entry = next((e for e in step_table if e["index"] == index), None)
    if entry is None:
        return default
    return "pm" if entry["runsIn"] == "pm" else default


WORKSPACE_MUTATING_STEPS = frozenset(workspace_mutating_indexes(steps.STEPS))
_WORKSPACE_MUTATING_STEP_STRS = frozenset(str(i) for i in WORKSPACE_MUTATING_STEPS)


def _item_worktree_busy(item_id: str, sessions: list[str]) -> bool:
    prefix = f"farm-run-{item_id.lower()}-s"
    for s in sessions:
        rest = s[len(prefix):] if s.startswith(prefix) else None
        if rest is not None and rest.split("-", 1)[0] in _WORKSPACE_MUTATING_STEP_STRS:
            return True
    return False


def _write_task_atomic(path: Path, body: dict) -> None:
    """HZ-130: no poller may ever observe a half-written task file.

    The plain `write_text` this replaces let a poller read a truncated payload
    mid-write; on the PM lane that turned into silent data loss (an
    unparseable file was deleted and nobody was told). Writing to a temp file
    and rename()-ing it means the final path only ever holds a complete
    payload — the file appears whole or not at all.

    Three properties the temp name has to carry, each load-bearing:

    * same directory as the target — rename() cannot cross filesystems;
    * a `.json.tmp` suffix — every reader here globs `*.json`, which must
      never match a partial file (_adopt_existing, _select_dispatchable,
      _session_for_run, _reconcile_claimed_runs, _run_state, and the PM
      agent's own poll);
    * unique per call, via mkstemp — a fixed `<run_id>.json.tmp` would let two
      writes for the same run interleave into one temp file, which is the very
      race this function exists to close.

    On any failure the temp file is removed and the exception propagates: the
    caller must see a failed enqueue, and the final path is never left holding
    a partial payload (it is not written at all until the rename).
    """
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.stem}.", suffix=".json.tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(body, indent=2))
        # mkstemp is 0600; these files are only ever read by this user's own
        # agents, but keep the permissions the write_text this replaces
        # produced rather than quietly tightening them.
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _select_dispatchable(task_paths: list, sessions: list[str], slots: int) -> list:
    """Pure selection logic, factored out of the dispatcher loop so it's
    testable without tmux/threads: given queued task files (oldest first),
    the currently live ephemeral session names, and free slots, returns
    which task files to launch this tick."""
    selected = []
    busy = list(sessions)
    for task_path in task_paths:
        if len(selected) >= slots:
            break
        try:
            task = json.loads(task_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        step_idx = task.get("step", {}).get("index")
        item_id = task.get("item", {}).get("id") or ""
        if step_idx in WORKSPACE_MUTATING_STEPS and _item_worktree_busy(item_id, busy):
            continue
        selected.append(task_path)
        if step_idx in WORKSPACE_MUTATING_STEPS:
            busy.append(_run_session_name(task))
    return selected


def _notify_started(run_id) -> bool:
    """Tells the Node server this run's agent actually launched — flips its
    watchdog from the queue-wait timer to the execution timer (HZ-57).
    Returns whether the run is still active server-side; a run cancelled
    while queued (its own queue watchdog fired, or a human acted) reports
    back False and must NOT be launched.

    Fails OPEN on any farmd/network problem (unreachable server, non-2xx):
    this call is an optimization, not the safety backstop — the server's own
    queue and execution timers are what actually bound a run that goes
    silent, so a failed notify here must not strand a legitimate task in the
    queue forever.
    """
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/started"
    for attempt in (1, 2):
        try:
            res = httpx.post(url, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
            if res.status_code == 200:
                return bool(res.json().get("active", True))
            print(f"farmd: started notify for run {run_id} -> {res.status_code}", flush=True)
            return True
        except Exception as exc:
            print(f"farmd: started notify attempt {attempt} for run {run_id} failed: {exc}", flush=True)
            time.sleep(2)
    return True


def _report_run_dead(run_id, name: str) -> bool:
    """HZ-101: reports a claimed run whose session is gone — the farm side of
    reconciliation. No retry loop here (unlike _notify_started/steps_result):
    a failed attempt must NOT remove the task file, so the next reconcile
    pass (RECONCILE_INTERVAL_S later) is the retry, not an inline sleep."""
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/fail"
    payload = {
        "error": f"farmd: session '{name}' is gone for run {run_id} (reconciliation)",
        # Already declared retryable in domain/reasons.json, which is where
        # the server's AUTO_RETRY_REASONS is derived from too (HZ-132) —
        # HZ-76's default-safe rule stands, no new reason is introduced.
        "reason": reasons.REASON["UNREACHABLE"],
    }
    try:
        res = httpx.post(url, json=payload, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
        print(f"farmd: reconcile reported run {run_id} dead -> {res.status_code}", flush=True)
        return res.status_code == 200
    except Exception as exc:
        print(f"farmd: reconcile could not report run {run_id} dead: {exc}", flush=True)
        return False


def _reconcile_one_claimed_run(task_path: Path) -> None:
    try:
        task = json.loads(task_path.read_text())
        run_id = str(task["run_id"])
        name = _run_session_name(task)
        claimed_at = task.get("claimed_at")
    except (json.JSONDecodeError, KeyError, OSError):
        return
    if claimed_at is None:
        # Claimed by a farmd build that predates HZ-101's stamp (or a
        # corrupt/edited file) — we cannot prove how long it's been claimed,
        # so we cannot tell "still launching" from "dead". Guardrail: when
        # the check can't be performed, do nothing.
        return
    if time.time() - claimed_at < farm_config.RECONCILE_GRACE_S:
        return  # _claim_and_launch has renamed the file but may not have
        # finished creating the tmux session yet.
    if tmux_mgr.session_exists(name):
        return  # alive — never touch it, never report it, never remove it
    if not _notify_started(run_id):
        # The server no longer considers this run active (a cancel whose
        # /steps/cancel callback to farmd was dropped, or a prior reconcile
        # pass's /fail already landed and this is a retry of the
        # not-yet-removed file). Release our own bookkeeping only — no kill
        # (nothing to kill, the session is already gone) and no /fail
        # report, which would double-report an already-resolved run.
        print(f"farmd: reconcile releasing run {run_id} — server no longer active", flush=True)
        task_path.unlink(missing_ok=True)
        RUN_SESSIONS.pop(run_id, None)
        return
    if _report_run_dead(run_id, name):
        task_path.unlink(missing_ok=True)
        RUN_SESSIONS.pop(run_id, None)
    # else: server unreachable or non-2xx — leave the file in place, the next
    # reconcile pass retries; an unreachable server is not evidence the run
    # is dead.


def _reconcile_claimed_runs() -> None:
    """HZ-101: farmd holds the truth about whether a claimed run's agent is
    alive — this closes the gap where a dead session was only discovered when
    the server's own execution timer expired (up to STEP_TIMEOUT_S later).
    Runs once at boot (after _adopt_existing) and on a loop while farmd is up
    (see _reconcile_loop).

    Proof of death is the absence of a session, nothing weaker: a live
    session is never touched, killed, or reported, and its task file is
    never removed — checked first, unconditionally, in
    _reconcile_one_claimed_run. Only once a session is confirmed gone do we
    ask the server whether it still considers the run active, to choose
    between reporting it dead and quietly releasing a run the server (e.g. a
    cancel) already gave up on.

    Each claimed run is isolated in its own try/except: one corrupt task
    file, or a crash unlinking one run's file (report already sent, disk
    error before removal), must not abort reconciliation of the rest of the
    batch — and must not crash the daemon, since this also runs inline at
    module import (farmd boot).
    """
    for task_path in sorted((QUEUE_DIR / "runs" / "active").glob("*.json")):
        try:
            _reconcile_one_claimed_run(task_path)
        except Exception as exc:
            print(f"farmd: reconcile error for {task_path.name}: {exc}", flush=True)


def _reconcile_loop() -> None:
    while True:
        time.sleep(farm_config.RECONCILE_INTERVAL_S)
        try:
            _reconcile_claimed_runs()
        except Exception as exc:
            print(f"farmd: reconcile error: {exc}", flush=True)


def _claim_and_launch(task_path, runs_dir: Path, repo_root: Path) -> str | None:
    """Claims one queued task file (rename into runs/active) and launches its
    ephemeral tmux session — unless the server reports the run is no longer
    active, in which case the claimed file is dropped and nothing launches
    (HZ-57: a task must not run after the server has already given up on
    it, e.g. its queue watchdog already fired). Factored out of the
    dispatcher loop so it's testable without tmux/threads, same as
    _select_dispatchable above. Returns the launched session name, or None
    if the run was stale."""
    task = json.loads(task_path.read_text())
    active = runs_dir / "active"
    active.mkdir(exist_ok=True)
    claimed = active / task_path.name
    task_path.rename(claimed)
    # HZ-101: stamped as its own write because rename() does not update
    # mtime — the reconciler needs a true "time since claimed" to tell a run
    # still mid-launch (session not created yet) from one whose session is
    # actually gone, and stat().st_mtime here would still read the original
    # enqueue time, not this claim.
    task["claimed_at"] = time.time()
    # HZ-130: atomic, same as the enqueue in steps_run —
    # _reconcile_one_claimed_run and _session_for_run both read this file
    # live, concurrently with this write. Behaviour is unchanged; only the
    # partial-read window is gone.
    _write_task_atomic(claimed, task)
    if not _notify_started(task["run_id"]):
        print(f"farmd: run {task['run_id']} no longer active server-side — not launching", flush=True)
        claimed.unlink(missing_ok=True)
        return None
    name = _run_session_name(task)
    tmux_mgr.new_session(
        name,
        f"{sys.executable} -m farm.step_agent --task {claimed}",
        cwd=str(repo_root),
        log_file=str(LOGS_DIR / f"{name}.log"),
    )
    RUN_SESSIONS[str(task["run_id"])] = name
    print(f"farmd: launched {name}", flush=True)
    return name


def _ephemeral_dispatcher() -> None:
    """Launches queued ephemeral steps, at most MAX_EPHEMERAL at once."""
    runs_dir = QUEUE_DIR / "runs"
    repo_root = Path(__file__).resolve().parent.parent
    while True:
        time.sleep(3)
        if state["status"] != "running":
            continue
        try:
            slots = MAX_EPHEMERAL - len(_ephemeral_sessions())
            if slots <= 0:
                continue
            candidates = sorted(runs_dir.glob("*.json"), key=lambda p: p.stat().st_mtime)
            for task_path in _select_dispatchable(candidates, _ephemeral_sessions(), slots):
                _claim_and_launch(task_path, runs_dir, repo_root)
        except Exception as exc:
            print(f"farmd: dispatcher error: {exc}", flush=True)


def _launch_pm_session() -> None:
    slug = slugify(state["project"]["name"])
    repo_root = Path(__file__).resolve().parent.parent
    tmux_mgr.new_session(
        f"farm-pm-{slug}",
        f"{sys.executable} -m farm.pm_agent --project '{state['project']['name']}'",
        cwd=str(repo_root),
        log_file=str(LOGS_DIR / f"pm-{slug}.log"),
    )


def _concierge_session_name() -> str:
    return f"farm-concierge-{slugify(state['project']['name'])}" if state["project"] else ""


def _maybe_launch_concierge() -> bool:
    """WhatsApp concierge (HZ-7) — launches only with FARM_WA_ENABLED=1."""
    if not farm_config.FARM_WA_ENABLED or not state["project"]:
        return False
    slug = slugify(state["project"]["name"])
    repo_root = Path(__file__).resolve().parent.parent
    tmux_mgr.new_session(
        f"farm-concierge-{slug}",
        f"{sys.executable} -m farm.concierge_agent --project '{state['project']['name']}'",
        cwd=str(repo_root),
        log_file=str(LOGS_DIR / f"concierge-{slug}.log"),
    )
    return True


def _watchdog() -> None:
    """Agents die (a stray Ctrl-C in an attached pane, a crash) — revive them.
    Queued tasks survive because the queue lives on disk, not in the agent."""
    while True:
        time.sleep(15)
        with _lock:
            if state["status"] != "running" or not state["project"]:
                continue
            name = _pm_session_name()
            concierge = _concierge_session_name() if farm_config.FARM_WA_ENABLED else ""
        if name and not tmux_mgr.session_exists(name):
            print(f"farmd: watchdog reviving dead session {name}", flush=True)
            try:
                _launch_pm_session()
            except Exception as exc:
                print(f"farmd: watchdog revive failed: {exc}", flush=True)
        if concierge and not tmux_mgr.session_exists(concierge):
            print(f"farmd: watchdog reviving dead session {concierge}", flush=True)
            try:
                _maybe_launch_concierge()
            except Exception as exc:
                print(f"farmd: watchdog revive failed: {exc}", flush=True)


def _start_async(project: dict, repos: list, token: str | None) -> None:
    try:
        for entry in repos:
            try:
                workspaces.ensure(entry["repo"], token)
                # Drops worktree metadata for item worktrees whose directory
                # a prior farmd's teardown removed but the hub still thinks
                # are registered — a farm crashed mid-run leaves this behind.
                workspaces.prune_worktrees(entry["repo"])
                print(f"farmd: workspace ready for {entry['repo']}", flush=True)
            except Exception as exc:  # workspaces are not needed until phase 3
                print(f"farmd: WARNING workspace for {entry['repo']} failed: {exc}", flush=True)

        _launch_pm_session()
        if _maybe_launch_concierge():
            print("farmd: WhatsApp concierge launched", flush=True)
        with _lock:
            state.update(status="running", error=None, since=_now())
            _persist_state()
        print(f"farmd: farm running for project '{project['name']}'", flush=True)
    except Exception as exc:
        with _lock:
            state.update(status="error", error=str(exc)[:300], since=_now())
        print(f"farmd: start FAILED: {exc}", flush=True)


@app.get("/")
def root():
    return {"service": "horizon-farmd"}


@app.get("/farm/status")
def farm_status():
    # `agents` / `checks` are additive (HZ-144): the Node server's
    # waitForFarmRunning reads only `status` and `error` from this route, so
    # new keys can't break it. They exist because the check limiter is
    # otherwise invisible — a run blocked on a check slot looks identical to
    # a run that is simply slow, and "who is waiting" was the one thing the
    # file-lock design gave up versus a farmd-brokered lease.
    return {
        **state,
        "sessions": tmux_mgr.list_farm_sessions(),
        "agents": {"limit": MAX_EPHEMERAL, "busy": len(_ephemeral_sessions())},
        "checks": check_slots.status(),
    }


@app.post("/farm/start")
async def farm_start(request: Request):
    body = await request.json()
    project, repos = body.get("project"), body.get("repos", [])
    if not project or not project.get("name"):
        return JSONResponse({"error": "project required"}, status_code=400)
    # HZ-5 cost guardrail: refuse to bring agents up on metered API billing.
    try:
        assert_provider_auth()
    except AgentError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    with _lock:
        if state["status"] == "running" and state["project"] and state["project"].get("id") == project.get("id"):
            # Same project: recover a dead PM session in place — queue untouched.
            if not tmux_mgr.session_exists(_pm_session_name()):
                _launch_pm_session()
                return {"ok": True, "recovered": True}
            return {"ok": True, "already": True}
        _teardown()
        ensure_dirs()
        state.update(status="starting", project=project, repos=repos, error=None, since=_now())
    threading.Thread(target=_start_async, args=(project, repos, body.get("token")), daemon=True).start()
    return {"ok": True, "starting": True}


@app.post("/farm/stop")
def farm_stop():
    with _lock:
        _teardown()
        STATE_FILE.unlink(missing_ok=True)
        state.update(status="stopped", project=None, repos=[], error=None, since=_now())
    return {"ok": True}


def _run_state(run_id: str, pm_queue: list, runs_queue: list, busy: int) -> dict:
    """A run's semantic state, never its tmux session name (HZ-54): queued
    while its task file sits in the PM or ephemeral-runs queue, running once
    the dispatcher has claimed it (moved it into runs/active — matched by
    neither glob here, so it falls through to "running")."""
    if any(p.stem == run_id for p in pm_queue):
        return {"state": "queued", "reason": "waiting for the PM agent"}
    if any(p.stem == run_id for p in runs_queue):
        return {"state": "queued", "reason": f"waiting for a free agent slot ({busy}/{MAX_EPHEMERAL} in use)"}
    return {"state": "running"}


@app.post("/runs/status")
async def runs_status(request: Request):
    """Batched queued/running lookup for the Node poller (HZ-54): the UI must
    never see a tmux session name, only this small state vocabulary."""
    body = await request.json()
    run_ids = [str(r) for r in body.get("run_ids", [])]
    pm_queue = list((QUEUE_DIR / "pm").glob("*.json"))
    runs_queue = list((QUEUE_DIR / "runs").glob("*.json"))
    busy = len(_ephemeral_sessions())
    return {"states": {rid: _run_state(rid, pm_queue, runs_queue, busy) for rid in run_ids}}


def _run_alive(run_id: str) -> bool:
    """HZ-100: proof-of-life for the Node reconciliation sweep — deliberately
    stricter than /runs/status above (which defaults an unknown run_id to
    "running" for the UI's fail-soft display, HZ-54). Here an unknown run_id
    must resolve to False: the sweep only ever calls this for a run whose own
    server-side watchdog has already gone missing, so a false positive here
    (reporting alive when the farm has genuinely lost the run) would let a
    truly stranded run sit forever."""
    active_path = QUEUE_DIR / "runs" / "active" / f"{run_id}.json"
    if active_path.exists():
        try:
            task = json.loads(active_path.read_text())
        except (json.JSONDecodeError, OSError):
            return False
        return tmux_mgr.session_exists(_run_session_name(task))
    if (QUEUE_DIR / "runs" / f"{run_id}.json").exists():
        return True  # still queued for a free ephemeral slot
    if (QUEUE_DIR / "pm" / f"{run_id}.json").exists():
        return True  # still queued for the PM agent
    if run_id in PM_ACTIVE_RUNS:
        return tmux_mgr.session_exists(_pm_session_name())
    session = RUN_SESSIONS.get(run_id)
    return bool(session and tmux_mgr.session_exists(session))


@app.post("/runs/alive")
async def runs_alive(request: Request):
    """HZ-100: the one place the server asks whether a run is alive — never
    inspects tmux sessions itself, so orchestrator.js stays free of farm
    implementation details. Alive means the farm still holds a queued/claimed
    task file for the run, or has a live tmux session tracking it."""
    body = await request.json()
    run_ids = [str(r) for r in body.get("run_ids", [])]
    return {"alive": {rid: _run_alive(rid) for rid in run_ids}}


@app.post("/steps/run")
async def steps_run(request: Request):
    body = await request.json()
    if state["status"] != "running":
        return JSONResponse({"error": f"farm_not_running (status={state['status']})"}, status_code=409)
    for key in ("run_id", "item", "step"):
        if key not in body:
            return JSONResponse({"error": f"missing {key}"}, status_code=400)
    # Plan/review-summary steps go to the long-running PM (it has the project
    # context to synthesize); everything else runs as an ephemeral agent via
    # the dispatcher (bounded by FARM_MAX_EPHEMERAL). HZ-117: which is which
    # comes from steps.STEPS's runsIn field, not a hardcoded index tuple.
    body["project"] = state["project"]
    # Project/repo rules are stamped into the task at enqueue (HZ-9) as a
    # list of unrendered parts — render_rules_section() (farm/rules.py) does
    # the actual whole-part-drop-with-note decision later, at prompt-build
    # time, so this queued payload is the *inputs* to that render, not the
    # rendered prompt text itself.
    item_repo = body["item"].get("repo") if isinstance(body["item"], dict) else None
    body["rules"] = rules.resolve_rules(state["project"]["name"] if state["project"] else None, item_repo)
    queue = lane_for_index(steps.STEPS, body["step"].get("index", 99))
    (QUEUE_DIR / queue).mkdir(parents=True, exist_ok=True)
    task_path = QUEUE_DIR / queue / f"{body['run_id']}.json"
    # HZ-130: the enqueue write. A poller globbing this directory used to be
    # able to read this file mid-write and get truncated JSON.
    _write_task_atomic(task_path, body)
    return {"ok": True, "queued": queue}


@app.post("/conflicts/resolve")
async def conflicts_resolve(request: Request):
    """HZ-92: merge-conflict resolution with no tmux session, no queue file
    and no run row. Runs inline (off the event loop thread so a slow git/test
    run doesn't stall other requests) and returns the outcome directly; the
    Node orchestrator decides what an escalation means (send back to the full
    implement step).

    HZ-154: a plain `git merge` is still the first thing tried and still the
    only thing most calls do. When it conflicts, the resolver may now dispatch
    up to two bounded agent calls inline — one to resolve the conflicted hunks,
    one to review only what that resolution changed — so this handler is no
    longer LLM-free. The request and response contracts are unchanged; a
    scoped success just carries three extra keys (mode/resolution/review) that
    this route already passes straight through.

    HZ-188: one run per item. item_lock is tried once, before the thread
    starts; if a resolver or an implement/review step already owns the item's
    worktree this answers 409 resolve_in_progress and starts nothing. The
    lock is released when the thread returns (or raises), and by the kernel
    if farmd itself dies."""
    body = await request.json()
    if state["status"] != "running":
        return JSONResponse({"error": f"farm_not_running (status={state['status']})"}, status_code=409)
    item = body.get("item") or {}
    item_id, repo = item.get("id"), item.get("repo")
    if not item_id or not repo:
        return JSONResponse({"error": "item.id and item.repo are required"}, status_code=400)
    try:
        with workspaces.item_lock(repo, item_id, wait_s=0):
            result = await asyncio.to_thread(
                conflict_resolver.resolve, repo, item_id, body.get("branch"), body.get("base_branch")
            )
    except workspaces.ItemBusy:
        return JSONResponse({"error": "resolve_in_progress"}, status_code=409)
    except Exception as exc:
        print(f"farmd: conflict resolution for {item_id} failed: {exc}", flush=True)
        return JSONResponse({"error": str(exc)[:300]}, status_code=500)
    return {"ok": True, **result}


# Each pipe-pane read is capped; the UI pages with `offset`.
LOG_READ_CAP = 64 * 1024


def _session_for_run(run_id: str) -> str | None:
    """Resolve a run to its ephemeral tmux session: the in-memory map first,
    then the claimed task files (covers a farmd restarted mid-run). PM-queue
    runs (steps 0/1/2/9) share the PM session's log and resolve to nothing."""
    name = RUN_SESSIONS.get(run_id)
    if name:
        return name
    for task_path in (QUEUE_DIR / "runs" / "active").glob("*.json"):
        try:
            task = json.loads(task_path.read_text())
            if str(task.get("run_id")) == run_id:
                return _run_session_name(task)
        except (json.JSONDecodeError, KeyError):
            continue
    return None


@app.get("/runs/{run_id}/log")
def run_log(run_id: str, offset: int = 0):
    """Tail the run's pipe-pane log (HZ-5): the same stream shown in the tmux
    pane, paged by byte offset for the UI's Live activity panel."""
    name = _session_for_run(str(run_id))
    if not name:
        return JSONResponse({"error": "unknown run"}, status_code=404)
    log_path = LOGS_DIR / f"{name}.log"
    offset = max(0, offset)
    content = b""
    if log_path.exists():
        with log_path.open("rb") as f:
            f.seek(offset)
            content = f.read(LOG_READ_CAP)
    return {
        "content": content.decode("utf-8", "replace"),
        "next_offset": offset + len(content),
        "active": tmux_mgr.session_exists(name),
    }


PAUSE_POLL_S = 0.2
PAUSE_TIMEOUT_MAX_S = 300


def _pause_timeout(raw) -> float:
    """The pause's checkpoint bound from the request body. A pause must never
    be refused, so a missing, non-numeric or non-positive value falls back to
    the default and anything else is clamped to 1..PAUSE_TIMEOUT_MAX_S."""
    try:
        value = float(raw) if not isinstance(raw, bool) else None
    except (TypeError, ValueError):
        value = None
    if value is None or value != value or value <= 0:  # value != value: NaN
        value = farm_config.PAUSE_CHECKPOINT_TIMEOUT_S
    return min(max(value, 1), PAUSE_TIMEOUT_MAX_S)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def _pause_in_flight(run_id: str, name: str, timeout_s: float) -> dict:
    """HZ-194: asks a running step agent to save its work before its session
    is killed. SIGTERM goes to the agent's pid (step_agent.main writes it);
    the agent stops its children, pushes a WIP checkpoint and writes
    `<run_id>.paused`. The session stays alive while it does, so the
    dispatcher's per-item mutex (_item_worktree_busy) holds back a resumed
    attempt until the save is over. Returns {outcome, detail}; the caller
    kills the session afterwards whatever happened, so the pause itself is
    never blocked for longer than timeout_s."""
    active = QUEUE_DIR / "runs" / "active"
    outcome_path = active / f"{run_id}.paused"
    try:
        pid = int((active / f"{run_id}.pid").read_text().strip())
    except (OSError, ValueError):
        return {"outcome": "failed", "detail": "the step agent's pid is unknown, so it could not be asked to save"}
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        return {"outcome": "failed", "detail": f"could not signal the step agent: {exc}"}
    print(f"farmd: pausing run {run_id} — asked {name} to checkpoint (up to {timeout_s:g}s)", flush=True)
    deadline = time.monotonic() + timeout_s
    while True:
        found = pause.read_outcome(outcome_path)
        if found is not None:
            return {"outcome": found["outcome"], "detail": str(found.get("detail") or "")}
        if not _pid_alive(pid):
            found = pause.read_outcome(outcome_path)
            if found is not None:
                return {"outcome": found["outcome"], "detail": str(found.get("detail") or "")}
            return {"outcome": "failed", "detail": "the step agent exited without saying whether it saved"}
        if time.monotonic() >= deadline:
            return {"outcome": "timed_out", "detail": f"the checkpoint did not finish within {timeout_s:g}s"}
        await asyncio.sleep(PAUSE_POLL_S)


@app.post("/steps/cancel")
async def steps_cancel(request: Request):
    """Cancel a run wherever it is: still queued (drop the task file) or
    already in flight (kill its tmux session so it can't keep pushing to the
    item's branch while a superseding attempt starts).

    HZ-194: `reason: "pause"` (sent only when an operator pauses the item)
    first lets an in-flight run checkpoint its work — see _pause_in_flight —
    and the response then carries `checkpoint: {outcome, detail}`. Every
    other cancel (reject, supersede, abandon) still kills at once."""
    body = await request.json()
    run_id = str(body.get("run_id"))
    pausing = body.get("reason") == "pause"
    checkpoint = None
    removed = False
    killed = None
    for sub in ("pm", "runs", "runs/active"):
        task_path = QUEUE_DIR / sub / f"{run_id}.json"
        if not task_path.exists():
            continue
        if sub == "runs/active":
            try:
                name = _run_session_name(json.loads(task_path.read_text()))
                if pausing and tmux_mgr.session_exists(name):
                    checkpoint = await _pause_in_flight(run_id, name, _pause_timeout(body.get("checkpoint_timeout_s")))
                    print(f"farmd: pause of run {run_id}: checkpoint {checkpoint['outcome']}", flush=True)
                if tmux_mgr.session_exists(name):
                    tmux_mgr.kill_session(name)
                    killed = name
                    print(f"farmd: cancelled in-flight run {run_id} (killed {name})", flush=True)
            except Exception as exc:
                print(f"farmd: cancel of run {run_id} could not kill its session: {exc}", flush=True)
            for leftover in (f"{run_id}.pid", f"{run_id}.paused"):
                (QUEUE_DIR / sub / leftover).unlink(missing_ok=True)
        task_path.unlink(missing_ok=True)
        removed = True
    # Fallback: the in-memory map (covers an active task file already consumed).
    session = RUN_SESSIONS.pop(run_id, None)
    if killed is None and session and tmux_mgr.session_exists(session):
        tmux_mgr.kill_session(session)
        killed = session
        removed = True
        print(f"farmd: cancelled run {run_id}, killed {session}", flush=True)
    response = {"ok": True, "removed": removed, "killed": killed}
    if pausing:
        # Queued (or already gone): no agent ran, so there is nothing to save.
        response["checkpoint"] = checkpoint or {"outcome": "not_running", "detail": "no agent was running"}
    return response


@app.post("/internal/steps/started")
async def internal_steps_started(request: Request):
    """The PM agent's equivalent of the ephemeral dispatcher's own
    _notify_started call above — the PM queue (steps 0/1/2/9) can sit behind
    other PM work just as long as the ephemeral queue can (HZ-57)."""
    body = await request.json()
    run_id = str(body.get("run_id"))
    active = _notify_started(run_id)
    if active:
        # HZ-100: marks this run alive for /runs/alive until steps_result
        # reports it done/failed — the PM has already unlinked its task file
        # by this point (claim-before-work), so this is the only record left
        # that this specific run is the one the PM session is working on.
        PM_ACTIVE_RUNS.add(run_id)
    return {"ok": True, "active": active}


@app.get("/internal/snapshot")
def internal_snapshot():
    """The concierge's read path (HZ-140).

    farmd holds FARM_SHARED_SECRET; no agent session does any more, including
    the concierge's own. So the concierge reads the work-item snapshot the
    same way the PM agent reports results: over loopback, through farmd, with
    no credential of its own.

    Exposure, decided explicitly rather than left implicit: /internal/* is
    unauthenticated on 127.0.0.1, so any local agent with Bash can now read
    this snapshot. That is accepted — every step agent is already handed its
    item's full contents in its prompt, farmd binds to loopback only, and this
    route grants no write capability whatsoever. It cannot approve a gate,
    which is the capability HZ-140 exists to take away.
    """
    try:
        res = httpx.get(f"{HORIZON_URL}/api/farm/snapshot", headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
        if res.status_code != 200:
            # Upstream status/body are not passed through: a 401 here is a
            # farmd misconfiguration, not something the concierge can act on.
            print(f"farmd: snapshot fetch -> {res.status_code}", flush=True)
            return JSONResponse({"error": "could not reach horizon server"}, status_code=502)
        return res.json()
    except Exception as exc:
        print(f"farmd: snapshot fetch failed: {exc}", flush=True)
        return JSONResponse({"error": "could not reach horizon server"}, status_code=502)


@app.post("/internal/steps/result")
async def steps_result(request: Request):
    """PM agent reports here; we forward to the Node server with the secret."""
    body = await request.json()
    run_id = body.get("run_id")
    PM_ACTIVE_RUNS.discard(str(run_id))
    path = "complete" if body.get("ok") else "fail"
    if body.get("ok"):
        payload = {"summary": body.get("summary", ""), "patch": body.get("patch") or {}, "artifacts": body.get("artifacts") or {}}
    else:
        payload = {"error": body.get("error", "unknown agent failure")}
        # HZ-76: only a small, explicit set of reasons (e.g. "turn_cap") is
        # ever auto-retried server-side — anything absent here just pauses
        # for a human, same as before this existed.
        if body.get("reason"):
            payload["reason"] = body["reason"]
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/{path}"
    for attempt in (1, 2):
        try:
            res = httpx.post(url, json=payload, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
            print(f"farmd: forwarded run {run_id} {path} -> {res.status_code}", flush=True)
        except Exception as exc:
            print(f"farmd: forward attempt {attempt} for run {run_id} failed: {exc}", flush=True)
            time.sleep(2)
            continue
        # HZ-184: a rejected report (e.g. a 400 over the route's length limit)
        # is a lost result — the run would sit active until the server's
        # watchdog called it a timeout. Never report that as delivered.
        if not 200 <= res.status_code < 300:
            print(f"farmd: server REJECTED run {run_id} {path} ({res.status_code}): {res.text[:300]}", flush=True)
            return JSONResponse({"error": "horizon server rejected the result", "forwarded": res.status_code}, status_code=502)
        return {"ok": True, "forwarded": res.status_code}
    return JSONResponse({"error": "could not reach horizon server"}, status_code=502)


ensure_dirs()
(QUEUE_DIR / "runs" / "active").mkdir(parents=True, exist_ok=True)
# HZ-5 cost guardrail at boot: covers the adopt path too, which never goes
# through /farm/start — a farm on API billing must not come up at all.
assert_provider_auth()
_adopt_existing()
_reconcile_claimed_runs()
threading.Thread(target=_watchdog, daemon=True).start()
threading.Thread(target=_ephemeral_dispatcher, daemon=True).start()
threading.Thread(target=_reconcile_loop, daemon=True).start()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=FARM_PORT)
