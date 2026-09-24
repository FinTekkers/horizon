"""farmd — the agent-farm daemon.

Owns tmux sessions, workspaces and the task queue. Executes exactly one step
when the Node orchestrator asks; never sequences anything itself. Runs under
tmux session `farm-daemon` (see run.sh) on port 4100.
"""

import json
import threading
import time
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import rules, tmux_mgr, workspaces
from . import config as farm_config
from .claude_runner import ClaudeError, assert_subscription_auth
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
# (the repo's own tests/linters), which is genuinely CPU-bound; if that
# starts timing out under real four-way load, lower this via the env var
# rather than editing code — it stays a variable, not a constant.
MAX_EPHEMERAL = int(__import__("os").environ.get("FARM_MAX_EPHEMERAL", "4"))

# run_id -> tmux session name for launched ephemeral runs (so cancel can kill).
RUN_SESSIONS: dict = {}

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
        for f in (QUEUE_DIR / sub).glob("*.json"):
            f.unlink(missing_ok=True)
    if killed:
        print(f"farmd: tore down sessions {killed}", flush=True)


def _ephemeral_sessions() -> list[str]:
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith("farm-run-")]


def _run_session_name(task: dict) -> str:
    """One place derives the tmux session name for an ephemeral run — the
    dispatcher creates it, /steps/cancel kills it."""
    return f"farm-run-{task['item']['id'].lower()}-s{task['step']['index']}-a{task.get('attempt', 1)}"


# Workspace-mutating steps: implement (11) and the automated review (12),
# both of which call prepare_branch() (reset --hard / clean -fd) on the
# item's own worktree. Since HZ-50 gave every item its own git worktree,
# different items no longer share a tree and can run these fully in
# parallel — only two runs against the SAME item still need to be
# serialized, or one's scrub could clobber the other's in-flight edits.
WORKSPACE_MUTATING_STEPS = (11, 12)


def _item_worktree_busy(item_id: str, sessions: list[str]) -> bool:
    prefix = f"farm-run-{item_id.lower()}-s"
    for s in sessions:
        rest = s[len(prefix):] if s.startswith(prefix) else None
        if rest is not None and rest.split("-", 1)[0] in ("11", "12"):
            return True
    return False


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
    return {**state, "sessions": tmux_mgr.list_farm_sessions()}


@app.post("/farm/start")
async def farm_start(request: Request):
    body = await request.json()
    project, repos = body.get("project"), body.get("repos", [])
    if not project or not project.get("name"):
        return JSONResponse({"error": "project required"}, status_code=400)
    # HZ-5 cost guardrail: refuse to bring agents up on metered API billing.
    try:
        assert_subscription_auth()
    except ClaudeError as exc:
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


@app.post("/steps/run")
async def steps_run(request: Request):
    body = await request.json()
    if state["status"] != "running":
        return JSONResponse({"error": f"farm_not_running (status={state['status']})"}, status_code=409)
    for key in ("run_id", "item", "step"):
        if key not in body:
            return JSONResponse({"error": f"missing {key}"}, status_code=400)
    # Plan steps (0-2) and the review-summary step (9) go to the long-running
    # PM (it has the project context to synthesize); everything else runs as
    # an ephemeral agent via the dispatcher (bounded by FARM_MAX_EPHEMERAL).
    body["project"] = state["project"]
    # Project/repo rules are stamped into the task at enqueue (HZ-9): the
    # queued payload and the session log show verbatim what the agent gets.
    item_repo = body["item"].get("repo") if isinstance(body["item"], dict) else None
    body["rules"] = rules.resolve_rules(state["project"]["name"] if state["project"] else None, item_repo)
    queue = "pm" if body["step"].get("index", 99) in (0, 1, 2, 9) else "runs"
    (QUEUE_DIR / queue).mkdir(parents=True, exist_ok=True)
    task_path = QUEUE_DIR / queue / f"{body['run_id']}.json"
    task_path.write_text(json.dumps(body, indent=2))
    return {"ok": True, "queued": queue}


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


@app.post("/steps/cancel")
async def steps_cancel(request: Request):
    """Cancel a run wherever it is: still queued (drop the task file) or
    already in flight (kill its tmux session so it can't keep pushing to the
    item's branch while a superseding attempt starts)."""
    body = await request.json()
    run_id = str(body.get("run_id"))
    removed = False
    killed = None
    for sub in ("pm", "runs", "runs/active"):
        task_path = QUEUE_DIR / sub / f"{run_id}.json"
        if not task_path.exists():
            continue
        if sub == "runs/active":
            try:
                name = _run_session_name(json.loads(task_path.read_text()))
                if tmux_mgr.session_exists(name):
                    tmux_mgr.kill_session(name)
                    killed = name
                    print(f"farmd: cancelled in-flight run {run_id} (killed {name})", flush=True)
            except Exception as exc:
                print(f"farmd: cancel of run {run_id} could not kill its session: {exc}", flush=True)
        task_path.unlink(missing_ok=True)
        removed = True
    # Fallback: the in-memory map (covers an active task file already consumed).
    session = RUN_SESSIONS.pop(run_id, None)
    if killed is None and session and tmux_mgr.session_exists(session):
        tmux_mgr.kill_session(session)
        killed = session
        removed = True
        print(f"farmd: cancelled run {run_id}, killed {session}", flush=True)
    return {"ok": True, "removed": removed, "killed": killed}


@app.post("/internal/steps/started")
async def internal_steps_started(request: Request):
    """The PM agent's equivalent of the ephemeral dispatcher's own
    _notify_started call above — the PM queue (steps 0/1/2/9) can sit behind
    other PM work just as long as the ephemeral queue can (HZ-57)."""
    body = await request.json()
    active = _notify_started(str(body.get("run_id")))
    return {"ok": True, "active": active}


@app.post("/internal/steps/result")
async def steps_result(request: Request):
    """PM agent reports here; we forward to the Node server with the secret."""
    body = await request.json()
    run_id = body.get("run_id")
    path = "complete" if body.get("ok") else "fail"
    payload = (
        {"summary": body.get("summary", ""), "patch": body.get("patch") or {}, "artifacts": body.get("artifacts") or {}}
        if body.get("ok")
        # category: set by step_agent.py's own exception classification
        # (HZ-33) — passed through verbatim; server/src/app.js validates it
        # against the categories it understands before trusting it.
        else {"error": body.get("error", "unknown agent failure"), "category": body.get("category") or "infra"}
    )
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/{path}"
    for attempt in (1, 2):
        try:
            res = httpx.post(url, json=payload, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
            print(f"farmd: forwarded run {run_id} {path} -> {res.status_code}", flush=True)
            return {"ok": True, "forwarded": res.status_code}
        except Exception as exc:
            print(f"farmd: forward attempt {attempt} for run {run_id} failed: {exc}", flush=True)
            time.sleep(2)
    return JSONResponse({"error": "could not reach horizon server"}, status_code=502)


ensure_dirs()
(QUEUE_DIR / "runs" / "active").mkdir(parents=True, exist_ok=True)
# HZ-5 cost guardrail at boot: covers the adopt path too, which never goes
# through /farm/start — a farm on API billing must not come up at all.
assert_subscription_auth()
_adopt_existing()
threading.Thread(target=_watchdog, daemon=True).start()
threading.Thread(target=_ephemeral_dispatcher, daemon=True).start()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=FARM_PORT)
