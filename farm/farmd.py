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

from . import tmux_mgr, workspaces
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


MAX_EPHEMERAL = int(__import__("os").environ.get("FARM_MAX_EPHEMERAL", "2"))


def _teardown() -> None:
    killed = tmux_mgr.kill_all_farm_sessions()
    for sub in ("pm", "runs"):
        for f in (QUEUE_DIR / sub).glob("*.json"):
            f.unlink(missing_ok=True)
    if killed:
        print(f"farmd: tore down sessions {killed}", flush=True)


def _ephemeral_sessions() -> list[str]:
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith("farm-run-")]


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
            for task_path in sorted(runs_dir.glob("*.json"), key=lambda p: p.stat().st_mtime)[:slots]:
                task = json.loads(task_path.read_text())
                active = runs_dir / "active"
                active.mkdir(exist_ok=True)
                claimed = active / task_path.name
                task_path.rename(claimed)
                name = f"farm-run-{task['item']['id'].lower()}-s{task['step']['index']}-a{task.get('attempt', 1)}"
                tmux_mgr.new_session(
                    name,
                    f"{sys.executable} -m farm.step_agent --task {claimed}",
                    cwd=str(repo_root),
                    log_file=str(LOGS_DIR / f"{name}.log"),
                )
                print(f"farmd: launched {name}", flush=True)
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


def _watchdog() -> None:
    """Agents die (a stray Ctrl-C in an attached pane, a crash) — revive them.
    Queued tasks survive because the queue lives on disk, not in the agent."""
    while True:
        time.sleep(15)
        with _lock:
            if state["status"] != "running" or not state["project"]:
                continue
            name = _pm_session_name()
        if name and not tmux_mgr.session_exists(name):
            print(f"farmd: watchdog reviving dead session {name}", flush=True)
            try:
                _launch_pm_session()
            except Exception as exc:
                print(f"farmd: watchdog revive failed: {exc}", flush=True)


def _start_async(project: dict, repos: list, token: str | None) -> None:
    try:
        for entry in repos:
            try:
                workspaces.ensure(entry["repo"], token)
                print(f"farmd: workspace ready for {entry['repo']}", flush=True)
            except Exception as exc:  # workspaces are not needed until phase 3
                print(f"farmd: WARNING workspace for {entry['repo']} failed: {exc}", flush=True)

        _launch_pm_session()
        with _lock:
            state.update(status="running", error=None, since=_now())
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
    # Plan steps (0-2) go to the long-running PM; everything else runs as an
    # ephemeral agent via the dispatcher (bounded by FARM_MAX_EPHEMERAL).
    body["project"] = state["project"]
    queue = "pm" if body["step"].get("index", 99) <= 2 else "runs"
    (QUEUE_DIR / queue).mkdir(parents=True, exist_ok=True)
    task_path = QUEUE_DIR / queue / f"{body['run_id']}.json"
    task_path.write_text(json.dumps(body, indent=2))
    return {"ok": True, "queued": queue}


@app.post("/steps/cancel")
async def steps_cancel(request: Request):
    body = await request.json()
    removed = False
    for sub in ("pm", "runs", "runs/active"):
        task_path = QUEUE_DIR / sub / f"{body.get('run_id')}.json"
        if task_path.exists():
            task_path.unlink(missing_ok=True)
            removed = True
    return {"ok": True, "removed": removed}  # in-flight runs are handled by Node staleness checks


@app.post("/internal/steps/result")
async def steps_result(request: Request):
    """PM agent reports here; we forward to the Node server with the secret."""
    body = await request.json()
    run_id = body.get("run_id")
    path = "complete" if body.get("ok") else "fail"
    payload = (
        {"summary": body.get("summary", ""), "patch": body.get("patch") or {}, "artifacts": body.get("artifacts") or {}}
        if body.get("ok")
        else {"error": body.get("error", "unknown agent failure")}
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
threading.Thread(target=_watchdog, daemon=True).start()
threading.Thread(target=_ephemeral_dispatcher, daemon=True).start()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=FARM_PORT)
