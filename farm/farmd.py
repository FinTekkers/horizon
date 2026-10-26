"""farmd — the agent-farm daemon.

Owns tmux sessions, workspaces and the task queue. Executes exactly one step
when the Node orchestrator asks; never sequences anything itself. Runs under
tmux session `farm-daemon` (see run.sh) on port 4100.
"""

import asyncio
import json
import os
import re
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
from domain.py import reasons, run_plan, steps
from . import caretaker_ruling, check_slots, conflict_cancel, conflict_resolver, container_runner, job_reports, knowledge, login_env, pause, rules, run_reaper, task_job, tmux_mgr, workspaces
from . import config as farm_config
from .checks import CHECK_SLOTS, default_check_slots, redact
from .task_files import read_launchable_task
from .agent_runner import AgentError, assert_provider_auth
from .config import (
    FARM_PORT,
    HORIZON_URL,
    LOGS_DIR,
    PM_MALFORMED_GRACE_S,
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

# HZ-477: extra runs-lane slots, next to the MAX_EPHEMERAL general ones, that
# only a short step (SHORT_STEPS: planning and review steps) may use. On
# 14 Oct a 1-minute planning step waited 27 minutes behind four 40-minute
# implements. Slots are counted, not pinned: a short step takes a general slot
# while one is free, and a long step starts only while fewer than MAX_EPHEMERAL
# long steps run. 0 restores the pre-HZ-477 slot behaviour (the queue keeps its
# stage order). Read once at import, like MAX_EPHEMERAL.
FARM_EXPRESS_SLOTS = max(0, int(__import__("os").environ.get("FARM_EXPRESS_SLOTS", "1")))

# HZ-212: PM steps (0/1/2/9) run as their own farm-run-* sessions now, but
# keep the PM lane's limit — one at a time, as when a single long-lived
# farm-pm-<project> session ran them serially. They do not use MAX_EPHEMERAL
# slots, so a PM step never waits behind implement backlog or vice versa.
PM_LANE_CAP = 1

# The retired long-lived PM session (HZ-212). farmd kills any it finds at
# boot; it never launches one.
LEGACY_PM_SESSION_PREFIX = "farm-pm-"

# HZ-209: the one WhatsApp concierge, whatever the active project. It keeps
# the farm-concierge- prefix, which tmux_mgr's WA_APPROVAL_SECRET grant and
# teardown key on; "_" is never in a slugify()'d name, so no per-project
# farm-concierge-<slug> can be this session.
CONCIERGE_SESSION_PREFIX = "farm-concierge-"
CONCIERGE_SESSION = "farm-concierge-_shared"

# run_id -> tmux session name for launched ephemeral runs (so cancel can kill).
RUN_SESSIONS: dict = {}

# HZ-378: run_id -> tmux session name for detached shell-command jobs. One
# active job per item; jobs never use MAX_EPHEMERAL slots and get no agent
# timer — the run plan's own budget_minutes bounds them instead.
JOB_SESSIONS: dict = {}


def _jobs_enabled() -> bool:
    """Kill switch: FARM_JOBS_ENABLED=0 refuses every new job dispatch with
    409, while in-flight jobs finish untouched."""
    return os.environ.get("FARM_JOBS_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")

# Farm state survives farmd restarts: on boot we ADOPT live agent sessions
# instead of requiring a /farm/start (whose teardown would kill them).
STATE_FILE = STATE_DIR / "farmd-state.json"


def _persist_state() -> None:
    STATE_FILE.write_text(json.dumps({"project": state["project"], "repos": state["repos"]}))


def _pid_farm_home(pid: int) -> Path | None:
    """The FARM_HOME process `pid` runs under (config.py's default when it
    has none), or None if its environment cannot be read. An empty environ
    is unreadable too, not "no FARM_HOME": a process still inside execve,
    before its new env block is mapped, reads as zero bytes."""
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    for entry in raw.split(b"\0"):
        if entry.startswith(b"FARM_HOME=") and len(entry) > len(b"FARM_HOME="):
            return Path(entry[len(b"FARM_HOME=") :].decode(errors="replace"))
    return Path.home() / ".horizon-farm"


def _session_in_this_farm(name: str) -> bool:
    """Whether a pane of session `name` runs under this farmd's FARM_HOME.
    Every farm on the host shares one tmux server — a test farmd started on
    a temp FARM_HOME must never retire the real farm's session."""
    ours = farm_config.FARM_HOME.resolve()
    for pid in tmux_mgr.pane_pids(name):
        home = _pid_farm_home(pid)
        if home is not None and home.resolve() == ours:
            return True
    return False


def _retire_legacy_pm_sessions() -> list[str]:
    """HZ-212 cutover: kills any long-lived farm-pm-* session left by an older
    farmd on this FARM_HOME, so it cannot keep polling queue/pm alongside the
    dispatcher. A farm-pm-* of another FARM_HOME is left alone.

    Its in-flight step (if any) has no farm record left, so /runs/alive
    reports it dead and the server fails it once with a retryable reason
    (its own timer or the HZ-100 sweep). Queued queue/pm files are untouched; the
    dispatcher claims them.

    Deletes nothing on disk: the old session-id files and PM logs are only
    listed for the operator to archive."""
    killed = []
    for name in tmux_mgr.list_farm_sessions():
        if not name.startswith(LEGACY_PM_SESSION_PREFIX):
            continue
        if not _session_in_this_farm(name):
            print(f"farmd: leaving legacy PM session {name} alone — not running under {farm_config.FARM_HOME}", flush=True)
            continue
        tmux_mgr.kill_session(name)
        killed.append(name)
    if killed:
        print(f"farmd: retired legacy PM session(s) {killed} — PM steps now run as farm-run-* sessions", flush=True)
    stale = sorted([*STATE_DIR.glob("pm-session-*.txt"), *LOGS_DIR.glob("pm-*.log")])
    if stale:
        print(
            "farmd: legacy PM files, no longer read (kept; the operator may archive them): "
            + ", ".join(str(path) for path in stale),
            flush=True,
        )
    return killed


def _adopt_existing() -> None:
    # Before any early return: a farm-pm-* session can outlive a missing or
    # corrupt state file, and would otherwise race the dispatcher on queue/pm.
    _retire_legacy_pm_sessions()
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
        f"({len(RUN_SESSIONS)} in-flight run(s))",
        flush=True,
    )


def _job_session_name(item_id: str) -> str:
    """One place derives the tmux session name for a job — launch_job creates
    it, /jobs/stop kills it, _adopt_jobs re-adopts it."""
    return f"{tmux_mgr.JOB_SESSION_PREFIX}{str(item_id).lower()}"


def _adopt_jobs() -> None:
    """Rebuilds the run->session map for jobs from claimed task files, so a
    farmd restarted mid-job keeps reporting it. A farm-job-* session with no
    task file is left alone: its runner finishes and its state file stays for
    the server to read, but no report is sent twice.

    HZ-416: then every farm-job-* container with no live farm-job-* tmux
    session of the same name — what a killed runner or a reboot left — is
    removed. A container whose runner is still up keeps running."""
    for task_path in (QUEUE_DIR / "jobs" / "active").glob("*.json"):
        if task_path.name.endswith(".env.json"):
            continue
        try:
            task = json.loads(task_path.read_text())
            name = _job_session_name(task["item"]["id"])
            if tmux_mgr.session_exists(name):
                JOB_SESSIONS[str(task["run_id"])] = name
        except (json.JSONDecodeError, KeyError):
            continue
    if JOB_SESSIONS:
        print(f"farmd: adopted {len(JOB_SESSIONS)} in-flight job(s)", flush=True)
    reaped = container_runner.reap_orphans(tmux_mgr.session_exists) if container_runner.available() else []
    if reaped:
        print(f"farmd: removed {len(reaped)} orphaned job container(s): {', '.join(reaped)}", flush=True)


def _read_dotenv(path: Path) -> dict:
    """KEY=VALUE lines, no export, no quoting rules beyond stripping one pair
    of matching quotes. Comments (#) and blank lines skipped. Never raises."""
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def _resolve_job_env(cwd: str, env_refs: dict, login: dict | None = None) -> dict:
    """Farm-side secret resolution: every $NAME the plan's env block names is
    read from <cwd>/.env first, then from the repo's test-login file (HZ-553,
    `login`), then from this process's own environment. The server sends no
    values — only the repo, the plan artifact and the file's path — so
    dispatch bodies and task files never hold a secret. An empty value still
    counts as set and hides the later sources, as an empty .env entry does."""
    dotenv = _read_dotenv(Path(cwd) / ".env") if cwd else {}
    login = login or {}
    resolved: dict[str, str] = {}
    for _local, ref in (env_refs or {}).items():
        name = ref[1:] if isinstance(ref, str) and ref.startswith("$") else None
        if not name:
            continue
        value = dotenv.get(name, login.get(name, os.environ.get(name)))
        if isinstance(value, str) and value:
            resolved[name] = value
    return resolved


def _host_redact_values() -> dict:
    """The two host credentials every job log is scrubbed of. Redaction only:
    a command gets them in its env only when the plan's env block names them."""
    return {name: os.environ[name] for name in ("GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET") if os.environ.get(name)}


def _job_redact_values(cwd: str | None, login: dict | None = None) -> dict:
    """Everything a job log is scrubbed of beyond the plan's named env values:
    the host credentials plus every <cwd>/.env value, named by the plan or not
    — a command run in cwd can load or print .env itself. The .env keys are
    namespaced so a same-named host credential never displaces one. HZ-553:
    likewise every test-login file value, under checks' login_env: prefix."""
    dotenv = _read_dotenv(Path(cwd) / ".env") if cwd else {}
    values = {f"dotenv:{k}": v for k, v in dotenv.items() if v}
    values.update({f"login_env:{k}": v for k, v in (login or {}).items() if v})
    values.update(_host_redact_values())
    return values


def _teardown() -> None:
    killed = tmux_mgr.kill_all_farm_sessions()
    RUN_SESSIONS.clear()
    JOB_SESSIONS.clear()
    for sub in ("pm", "runs", "runs/active", "jobs", "jobs/active"):
        # HZ-130: `*.json*`, not `*.json` — a farmd killed between
        # _write_task_atomic's temp write and its rename() leaves a
        # `<run_id>.<suffix>.json.tmp` behind, which a `*.json` glob would
        # never reach and nothing else ever cleans.
        for f in (QUEUE_DIR / sub).glob("*.json*"):
            f.unlink(missing_ok=True)
    # HZ-194: a step agent's pid and pause-outcome files (see _pause_in_flight);
    # HZ-321: and the stop-reason a deploy stop leaves for it.
    for pattern in ("*.pid", "*.paused*", "*.stop-reason"):
        for f in (QUEUE_DIR / "runs" / "active").glob(pattern):
            f.unlink(missing_ok=True)
    # HZ-378: a job's 0600 env file is unlinked by the runner at start; a
    # teardown removes any a killed runner left behind.
    for f in (QUEUE_DIR / "jobs" / "active").glob("*.env.json"):
        f.unlink(missing_ok=True)
    if killed:
        print(f"farmd: tore down sessions {killed}", flush=True)


def _ephemeral_sessions() -> list[str]:
    return [s for s in tmux_mgr.list_farm_sessions() if s.startswith("farm-run-")]


def _run_session_name(task: dict) -> str:
    """One place derives the tmux session name for an ephemeral run — the
    dispatcher creates it, /steps/cancel kills it."""
    return f"farm-run-{task['item']['id'].lower()}-s{task['step']['index']}-a{task.get('attempt', 1)}"


def _session_step_index(name: str) -> int | None:
    """The step index in a farm-run-<item>-s<idx>-a<n> name, or None.
    rsplit, because an item id may itself contain "-s"."""
    head, sep, tail = name.rpartition("-s")
    if not head or not sep:
        return None
    index = tail.split("-a", 1)[0]
    return int(index) if index.isdigit() else None


def _lane_busy(sessions: list[str]) -> dict[str, int]:
    """Live farm-run-* sessions per lane. An unparseable name counts as
    "runs", so it can only ever hold back implement-lane work, never PM."""
    busy = {"pm": 0, "runs": 0}
    for name in sessions:
        index = _session_step_index(name)
        busy["pm" if index is not None and lane_for_index(LANE_ROWS, index) == "pm" else "runs"] += 1
    return busy


def _runs_lane_slots(sessions: list[str]) -> tuple[int, int]:
    """HZ-477: (free runs-lane slots, how many of them a long step may use).
    Every runs-lane step counts against MAX_EPHEMERAL + FARM_EXPRESS_SLOTS; a
    long step (any not in SHORT_STEPS, an unparseable name included)
    also counts against MAX_EPHEMERAL alone, so the express slot never runs
    one. Reads both caps at call time, so a test can patch them."""
    runs = long_runs = 0
    for name in sessions:
        index = _session_step_index(name)
        if index is not None and lane_for_index(LANE_ROWS, index) == "pm":
            continue
        runs += 1
        long_runs += index not in SHORT_STEPS
    return MAX_EPHEMERAL + FARM_EXPRESS_SLOTS - runs, MAX_EPHEMERAL - long_runs


def _by_stage(task_paths: list[Path]) -> list[Path]:
    """HZ-477: queued runs-lane tasks, furthest along their own kind's flow
    first (stage_for_index). The sort is stable and the input is oldest
    first, so equal stages keep oldest first. A task whose file cannot be read
    or names no known step ranks last, but stays in the list and still runs."""
    def stage(task_path: Path) -> int:
        try:
            task = json.loads(task_path.read_text())
        except (json.JSONDecodeError, OSError):
            return -1
        step = task.get("step") if isinstance(task, dict) else None
        return stage_for_index(step.get("index") if isinstance(step, dict) else None)

    return sorted(task_paths, key=lambda task_path: -stage(task_path))


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


# Lane routing: which queue and cap handle a dispatched step — the PM lane
# ("pm": queue/pm, capped at PM_LANE_CAP), the ephemeral lane ("runs":
# queue/runs, MAX_EPHEMERAL) or the job lane ("job": queue/jobs, one active
# job per item). Since HZ-212 both agent lanes run as per-task farm-run-*
# sessions; since HZ-371 both launch farm.step_agent. runsIn keeps its name.
# HZ-117: derived from steps.STEPS's runsIn field. An index absent
# from the table (e.g. a gate, which is never dispatched here at all) falls
# back to `default` — preserves the pre-HZ-117 behavior for an unrecognized
# index.
def lane_for_index(step_table: list[dict], index, default: str = "runs") -> str:
    entry = next((e for e in step_table if e["index"] == index), None)
    if entry is None:
        return default
    if entry["runsIn"] == "pm":
        return "pm"
    if entry["runsIn"] == "job":
        return "job"
    return default


# HZ-413: every kind's farm rows, for lane accounting by a session's step
# index alone (_lane_busy, the deploy pause). An index is global across kinds,
# so no two rows share one, and a Task's PM step counts against the PM lane
# rather than falling back to "runs" as an index absent from steps.STEPS would.
LANE_ROWS = [entry for view in steps.FARM_VIEWS.values() for entry in view]

# HZ-477: the step indexes the express slot may take (`"short": true` in
# domain/steps.json), and each row's stage: its position within its own item
# kind's rows, never the raw global index, so a Task or Plan step never
# outranks a change step just by sitting later in the table.
SHORT_STEPS = frozenset(
    row["index"] for kind in steps.FARM_VIEWS for row in steps.steps_for(kind) if row.get("short") is True
)
STAGE_BY_INDEX = {
    row["index"]: row["index"] - steps.first_step_index(kind) for kind in steps.FARM_VIEWS for row in steps.steps_for(kind)
}


def stage_for_index(index) -> int:
    """A step index's stage, or -1 for a non-int or an index no row has: such
    a task ranks last."""
    if not isinstance(index, int) or isinstance(index, bool):
        return -1
    return STAGE_BY_INDEX.get(index, -1)


# HZ-383: whether a dispatched task's step belongs to its item's kind. A
# server that sends item.kind is held to the full check — the row at
# step.index must be that kind's row with that label. A payload with no kind
# comes from a server that predates item kinds, so it is a change step, and
# is refused only if its index is another kind's row.
def step_kind_mismatch(item: dict, step: dict) -> bool:
    kind = item.get("kind")
    index = step.get("index")
    if kind is None:
        return any(entry["index"] == index for k, view in steps.FARM_VIEWS.items() if k != "change" for entry in view)
    try:
        steps.entry_for_dispatch(index, kind, step.get("label"))
    except KeyError:
        return True
    return False


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


def _select_dispatchable(task_paths: list, sessions: list[str], slots: int, long_slots: int | None = None) -> list:
    """Pure selection logic, factored out of the dispatcher loop so it's
    testable without tmux/threads: given queued task files (oldest first),
    the currently live ephemeral session names, and free slots, returns
    which task files to launch this tick. HZ-477: `long_slots`, when given,
    caps how many of them may be long steps; a long step past it is skipped,
    not stopped at, so a short step behind it can still take the express slot."""
    selected = []
    long_selected = 0
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
        if _provisioning(task.get("item", {}).get("repo")):
            continue  # HZ-207: its hub is still cloning; stays queued
        is_long = step_idx not in SHORT_STEPS
        if is_long and long_slots is not None and long_selected >= long_slots:
            continue  # HZ-477: general slots full; only a short step may start
        selected.append(task_path)
        long_selected += is_long
        if step_idx in WORKSPACE_MUTATING_STEPS:
            busy.append(_run_session_name(task))
    return selected


def _select_pm_dispatchable(task_paths: list, sessions: list[str], now: float | None = None) -> tuple[list, list]:
    """Pure selection for the PM lane, like _select_dispatchable: returns
    (launch, unusable). `launch` holds at most PM_LANE_CAP minus the live PM
    sessions, oldest first, and only files read_launchable_task accepts.
    `unusable` holds (path, why) for rejected files older than
    PM_MALFORMED_GRACE_S — walked past, never blocking newer tasks (HZ-130)."""
    now = time.time() if now is None else now
    slots = PM_LANE_CAP - _lane_busy(sessions)["pm"]
    launch, unusable = [], []
    for task_path in task_paths:
        task, why = read_launchable_task(task_path)
        if task is not None:
            if len(launch) < slots:
                launch.append(task_path)
            continue
        try:
            age = now - task_path.stat().st_mtime
        except OSError:
            continue  # vanished under us (a cancel): nothing to report
        if age >= PM_MALFORMED_GRACE_S:
            unusable.append((task_path, why))
    return launch, unusable


def _forward_result(body: dict) -> int | None:
    """Relays an agent's result to the Node server's /complete, /blocked or
    /fail. Returns the server's status code, or None if it could not be
    reached."""
    run_id = body.get("run_id")
    path = "complete" if body.get("ok") else "fail"
    if body.get("ok") and isinstance(body.get("blocked"), dict):
        # HZ-346: an implement run stopped by a rule with no code changes —
        # recorded as blocked server-side, never as a completion or failure.
        path = "blocked"
        payload = {"rule": body["blocked"].get("rule", ""), "needs": body["blocked"].get("needs", "")}
    elif body.get("ok"):
        payload = {"summary": body.get("summary", ""), "patch": body.get("patch") or {}, "artifacts": body.get("artifacts") or {}}
        # HZ-570: the rows the test-runs post will carry, so the server holds
        # the deploy drain and review for them until they are stored.
        if isinstance(body.get("test_runs"), list):
            payload["test_runs_expected"] = sum(
                len(run["tests"]) for run in body["test_runs"] if isinstance(run, dict) and isinstance(run.get("tests"), list)
            )
    else:
        payload = {"error": body.get("error", "unknown agent failure")}
        # HZ-76: only a small, explicit set of reasons (e.g. "turn_cap") is
        # ever auto-retried server-side — anything absent here just pauses
        # for a human, same as before this existed.
        if body.get("reason"):
            payload["reason"] = body["reason"]
        # HZ-422: a usage limit names what hit it and when it lifts, so the
        # server can fall back to the next model or wait for the reset.
        for key in ("reset_at", "provider", "model"):
            if isinstance(body.get(key), str) and body[key]:
                payload[key] = body[key][:100]
    # HZ-327: the check run's flakes ride on the result itself, either way.
    if isinstance(body.get("flakes"), list) and body["flakes"]:
        payload["flakes"] = body["flakes"]
    # HZ-407: a job's final view rides on its result, so the server closes the
    # run and stores the view in one write — a late nudge can't be lost to it.
    if isinstance(body.get("job_view"), dict) and path in ("complete", "fail"):
        payload["job_view"] = body["job_view"]
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/{path}"
    status = None
    for attempt in (1, 2):
        try:
            res = httpx.post(url, json=payload, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
            print(f"farmd: forwarded run {run_id} {path} -> {res.status_code}", flush=True)
        except Exception as exc:
            print(f"farmd: forward attempt {attempt} for run {run_id} failed: {exc}", flush=True)
            time.sleep(2)
            continue
        if not 200 <= res.status_code < 300:
            print(f"farmd: server REJECTED run {run_id} {path} ({res.status_code}): {res.text[:300]}", flush=True)
        status = res.status_code
        break
    if status is not None and isinstance(body.get("test_runs"), list) and body["test_runs"]:
        _in_background(_forward_test_runs, run_id, body["test_runs"])
    return status


def _in_background(fn, *args) -> None:
    """Off the result's request: the step agent is waiting on it (30 s), and
    a slow test-runs post must never make it retry the result."""
    threading.Thread(target=fn, args=args, daemon=True).start()


# HZ-570: test-runs posts not yet confirmed stored, one file per run, kept
# across a server restart (and a farmd one) until the server confirms them.
TEST_RUNS_OUTBOX = STATE_DIR / "test-runs-outbox"
# How long a spooled upload is retried before it is abandoned; the server's
# STORED_RESULTS_RETRY_WINDOW_S holds review for the same span.
TEST_RUNS_RETRY_MAX_S = float(os.environ.get("FARM_TEST_RUNS_RETRY_MAX_S", "900"))
# Seconds between tries of one file: 2, 4, 8, 16, then every 30.
TEST_RUNS_BACKOFF_S = (2, 4, 8, 16, 30)
_outbox_lock = threading.Lock()
_outbox_busy: set[str] = set()


def _forward_test_runs(run_id, test_runs: list) -> None:
    """HZ-327: the per-test results, after the result itself so the server
    already holds this run's rerun flakes. Separate from /complete because a
    whole suite's rows can outgrow that route's body limit.

    HZ-570: no longer one try. The rows are spooled to TEST_RUNS_OUTBOX first
    and the file is kept until the server answers 2xx (stored: a retry
    replaces the run's rows, so it never adds a copy) or 4xx (rejected: a
    retry cannot help). On a 5xx or no answer — a deploy restarting the
    server — _test_runs_outbox_loop tries again."""
    path = TEST_RUNS_OUTBOX / f"{run_id}.json"
    try:
        TEST_RUNS_OUTBOX.mkdir(parents=True, exist_ok=True)
        _write_task_atomic(path, {"run_id": run_id, "test_runs": test_runs, "spooled_at": time.time()})
    except OSError as exc:
        print(f"farmd: could not spool test results for run {run_id} ({exc}); one try only", flush=True)
        _post_test_runs(run_id, test_runs)
        return
    _drain_outbox_file(path)


def _post_test_runs(run_id, test_runs) -> str | None:
    """One post. "stored" on a 2xx, "rejected" on a 4xx, None to retry."""
    try:
        res = httpx.post(
            f"{HORIZON_URL}/api/farm/steps/{run_id}/test-runs",
            json={"test_runs": test_runs},
            headers={"x-farm-secret": SHARED_SECRET},
            timeout=15,
        )
    except Exception as exc:
        print(f"farmd: test results for run {run_id} not stored yet: {exc}", flush=True)
        return None
    print(f"farmd: forwarded run {run_id} test-runs -> {res.status_code}", flush=True)
    if 200 <= res.status_code < 300:
        return "stored"
    if 400 <= res.status_code < 500:
        return "rejected"
    return None


def _abandon_test_runs(run_id, why: str) -> None:
    """Tells the server farmd stopped retrying, so review stops waiting. One
    try: a lost call leaves review waiting out its own window."""
    try:
        httpx.post(
            f"{HORIZON_URL}/api/farm/steps/{run_id}/test-runs/abandon",
            json={"why": why},
            headers={"x-farm-secret": SHARED_SECRET},
            timeout=15,
        )
    except Exception as exc:
        print(f"farmd: could not tell the server run {run_id}'s test results were abandoned: {exc}", flush=True)


def _drain_outbox_file(path: Path) -> bool:
    """Posts one spooled upload. True when the file is gone (stored, rejected,
    abandoned or unreadable), False when it stays for a retry. A file another
    thread is already posting is left to it."""
    with _outbox_lock:
        if path.name in _outbox_busy:
            return False
        _outbox_busy.add(path.name)
    try:
        try:
            body = json.loads(path.read_text())
        except FileNotFoundError:
            return True
        except (OSError, json.JSONDecodeError) as exc:
            print(f"farmd: unreadable test-results spool {path.name} dropped: {exc}", flush=True)
            path.unlink(missing_ok=True)
            return True
        run_id = body.get("run_id")
        outcome = _post_test_runs(run_id, body.get("test_runs"))
        if outcome is not None:
            path.unlink(missing_ok=True)
            if outcome == "rejected":
                _abandon_test_runs(run_id, "rejected")
            return True
        spooled_at = body.get("spooled_at")
        age = time.time() - (spooled_at if isinstance(spooled_at, (int, float)) else path.stat().st_mtime)
        if age >= TEST_RUNS_RETRY_MAX_S:
            print(f"farmd: test results for run {run_id} abandoned after {int(age)}s", flush=True)
            path.unlink(missing_ok=True)
            _abandon_test_runs(run_id, "gave_up")
            return True
        return False
    finally:
        with _outbox_lock:
            _outbox_busy.discard(path.name)


def _test_runs_outbox_loop(poll_s: float = 1.0) -> None:
    """HZ-570: retries spooled test-runs posts with TEST_RUNS_BACKOFF_S, and
    picks up the files a killed farmd left behind (tried at once)."""
    tries: dict[str, int] = {}
    next_at: dict[str, float] = {}
    while True:
        time.sleep(poll_s)
        try:
            now = time.time()
            present = {p.name: p for p in TEST_RUNS_OUTBOX.glob("*.json")}
            for name in list(tries):
                if name not in present:
                    tries.pop(name, None)
                    next_at.pop(name, None)
            for name, path in sorted(present.items()):
                if name not in next_at:
                    # A file spooled moments ago is still on its first post.
                    try:
                        next_at[name] = path.stat().st_mtime + TEST_RUNS_BACKOFF_S[0]
                    except OSError:
                        continue
                if now < next_at[name]:
                    continue
                if _drain_outbox_file(path):
                    tries.pop(name, None)
                    next_at.pop(name, None)
                    continue
                n = tries.get(name, 0) + 1
                tries[name] = n
                next_at[name] = time.time() + TEST_RUNS_BACKOFF_S[min(n, len(TEST_RUNS_BACKOFF_S) - 1)]
        except Exception as exc:
            print(f"farmd: test-results outbox error: {exc}", flush=True)


def _report_unusable_task(path: Path, why: str) -> bool:
    """HZ-130, moved here with the PM inbox (HZ-212): a queue/pm file that
    can never be launched is reported once, under the same retryable reason
    the old PM runner used, and released only once the server took it (or no
    longer knows the run). Otherwise it stays for the next tick."""
    run_id = path.stem
    error = f"farmd: PM task file {path.name} was unusable: {why}"
    print(f"farmd: run {run_id}: {error}", flush=True)
    status = _forward_result({"run_id": run_id, "ok": False, "error": error[:300], "reason": reasons.REASON["UNREACHABLE"]})
    if status is None or not (200 <= status < 300 or status == 404):
        return False
    path.unlink(missing_ok=True)
    return True


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


def _fetch_rules_override(task) -> dict | None:
    """HZ-246: the rules the server serves right now for this task's project
    and repo ({"project": str|None, "repo": str|None}; None means "use the
    file"), or None if the server can't be asked. One short attempt: a miss
    keeps the dispatch-time rules already in the task."""
    project = task.get("project") if isinstance(task.get("project"), dict) else {}
    item = task.get("item") if isinstance(task.get("item"), dict) else {}
    params = {k: v for k, v in (("project", project.get("name")), ("repo", item.get("repo"))) if isinstance(v, str)}
    try:
        res = httpx.get(
            f"{HORIZON_URL}/api/farm/rules", params=params, headers={"x-farm-secret": SHARED_SECRET}, timeout=5
        )
        if res.status_code != 200:
            print(f"farmd: rules refresh for run {task.get('run_id')} -> {res.status_code}", flush=True)
            return None
        data = res.json()
        return data if isinstance(data, dict) else None
    except Exception as exc:
        print(f"farmd: rules refresh for run {task.get('run_id')} failed: {exc}", flush=True)
        return None


def _refresh_rules(task) -> bool:
    """Re-resolves task["rules"] from the server's current DB rules, so a save
    made while the task was queued reaches this step. Returns whether it did;
    on a failed fetch the dispatch-time rules stand (never the bare file when
    a DB version was stamped)."""
    fresh = _fetch_rules_override(task)
    if fresh is None:
        return False
    project = task.get("project") if isinstance(task.get("project"), dict) else {}
    item = task.get("item") if isinstance(task.get("item"), dict) else {}
    task["rules_override"] = {k: v for k, v in fresh.items() if k in ("project", "repo") and isinstance(v, str)}
    task["rules"] = rules.resolve_rules(project.get("name"), item.get("repo"), task["rules_override"])
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


def _sweep_runs() -> None:
    """HZ-569: kill the capture workers, browsers and e2e servers whose run's
    owner is gone — a step killed by Stop or a crash, a pre-merge run past its
    cap, a check this farmd ran before it restarted. A run whose owner is
    still alive, in tmux or anywhere else, is never touched (run_reaper.sweep).
    Each kill is logged with its run, item and worktree."""
    try:
        run_reaper.sweep(log=lambda line: print(f"farmd: {line}", flush=True))
    except Exception as exc:
        print(f"farmd: run sweep error: {type(exc).__name__}: {exc}", flush=True)


def _run_sweep_loop(stop: threading.Event | None = None) -> None:
    """Sweeps every RUN_SWEEP_INTERVAL_S (read each tick) until `stop` is set."""
    stop = stop or threading.Event()
    while not stop.wait(farm_config.RUN_SWEEP_INTERVAL_S):
        _sweep_runs()


def _knowledge_sources() -> list[dict]:
    """HZ-537: GET /api/farm/knowledge/sources for farm/knowledge.py."""
    res = httpx.get(
        f"{HORIZON_URL}/api/farm/knowledge/sources", headers={"x-farm-secret": SHARED_SECRET}, timeout=10
    )
    res.raise_for_status()
    sources = res.json().get("sources")
    return sources if isinstance(sources, list) else []


def _report_knowledge_doc(project_id: int, slug: str, body: dict) -> None:
    """HZ-537: PUT one knowledge_doc row for farm/knowledge.py."""
    res = httpx.put(
        f"{HORIZON_URL}/api/farm/knowledge/docs/{project_id}/{slug}",
        json=body,
        headers={"x-farm-secret": SHARED_SECRET},
        timeout=10,
    )
    res.raise_for_status()


def _knowledge_loop() -> None:
    """HZ-537: re-extracts project knowledge PDFs whose git sha changed
    (farm/knowledge.py). Inert while no project with its definitions switch on
    names a source: the server then lists none."""
    while True:
        time.sleep(farm_config.KNOWLEDGE_INTERVAL_S)
        try:
            knowledge.sync_once(_knowledge_sources, _report_knowledge_doc, provision=_provision_hub)
        except Exception as exc:
            print(f"farmd: knowledge sync error: {exc}", flush=True)


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
    # HZ-246: the prompt is built from this file moments from now — read the
    # rules fresh here rather than trusting the enqueue-time stamp.
    if _refresh_rules(task):
        _write_task_atomic(claimed, task)
    name = _run_session_name(task)
    # HZ-212: same session naming, same per-run log, fresh interpreter and
    # env on every step. HZ-371: one runner for both lanes — the lane only
    # decides the queue and the cap.
    tmux_mgr.new_session(
        name,
        f"{sys.executable} -m farm.step_agent --task {claimed}",
        cwd=str(repo_root),
        log_file=str(LOGS_DIR / f"{name}.log"),
    )
    RUN_SESSIONS[str(task["run_id"])] = name
    print(f"farmd: launched {name}", flush=True)
    return name


def _job_login_env(task: dict) -> dict[str, str]:
    """HZ-553: the Task repo's test-login file, read now. The path is the one
    the server sent from the item's own repo row in Admin — never anything
    the run plan names. {} when none is set. Raises login_env.LoginEnvError
    (path and cause, never a value) when the file cannot be used. Only called
    once the cwd resolved, so repo_dir is set."""
    path = task.get("test_env_file")
    if not path:
        return {}
    return login_env.load_login_env(path, workspace=Path(task["repo_dir"]))


def launch_job(task: dict) -> str:
    """Launches one job's detached runner in farm-job-<item>. The task holds
    the plan artifact and the approved hash — never secret values. Resolves
    the job's env farm-side into a 0600 file the runner unlinks at start, then
    launches with no pipe-pane (the runner owns the only log). Returns the
    tmux session name.

    HZ-415: the plan's cwd is resolved inside the task's repo_dir (the Task
    repo's deploy-target checkout) before anything else, and the job's .env
    is read from there — never from Horizon's own checkout. Raises
    run_plan.CwdRefused, with no file written and no session started, when it
    does not resolve; the runner checks again on its own start.

    HZ-440: with `task_clone`, repo_dir is the target's separate task clone;
    the runner fast-forwards it after this check, so a cwd or .env that
    exists only on the new origin/main is not seen here.

    HZ-553: the repo's test-login file is read after the cwd resolves and
    before anything is written; a LoginEnvError propagates with no file
    written and no session started. Its values go only into the 0600 env
    file — never os.environ."""
    from farm.config import LOGS_DIR as _LOGS, STATE_DIR as _STATE

    run_id = task["run_id"]
    item_id = task["item"]["id"]
    artifact = task.get("plan_artifact") or ""
    block = run_plan.extract(artifact)
    cwd = run_plan.resolve_cwd(task.get("repo_dir"), block["cwd"], forbid=str(task_job.HORIZON_ROOT))
    # HZ-431: a venv outside the checkout is refused here too (a CwdRefused).
    # HZ-416: only a host run uses the venv; a container run ignores it.
    # HZ-491: the server's effective runner, never the block's own field.
    if task["runner"] == "host":
        run_plan.resolve_venv(task.get("repo_dir"), task.get("venv_dir"), forbid=str(task_job.HORIZON_ROOT))
    login = _job_login_env(task)
    env_values = _resolve_job_env(cwd, block.get("env", {}), login)
    active = QUEUE_DIR / "jobs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    env_path = active / f"{run_id}.env.json"
    fd, tmp_name = tempfile.mkstemp(dir=str(active), prefix=f"{run_id}.env.", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps({"env": env_values, "redact": _job_redact_values(cwd, login)}))
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, env_path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    task["env_file"] = str(env_path)
    task["claimed_at"] = time.time()
    claimed = active / f"{run_id}.json"
    _write_task_atomic(claimed, task)
    name = _job_session_name(item_id)
    # The runner itself starts in Horizon's checkout; only its commands move.
    tmux_mgr.new_session(name, f"{sys.executable} -m farm.task_job --task {claimed}", cwd=str(task_job.HORIZON_ROOT))
    JOB_SESSIONS[str(run_id)] = name
    (_STATE / "jobs").mkdir(parents=True, exist_ok=True)
    _LOGS.mkdir(parents=True, exist_ok=True)
    print(f"farmd: launched {name} for run {run_id}", flush=True)
    return name


# HZ-378: an Execute artifact's own ceiling — the runner's summary plus its
# full redacted log. Mirrors server/src/orchestrator.js's JOB_LOG_MAX_CHARS:
# farmd caps before the POST (the route's body limit is 1 MB) and the server
# caps again on receipt, so the two can never disagree about the marker.
JOB_LOG_MAX_CHARS = 512 * 1024
JOB_LOG_TRUNCATED_MARKER = "\n\n[...truncated: job log exceeded 512 KB; showing the first 512 KB]"


def cap_job_artifact(text: str) -> str:
    content = text or ""
    if len(content) > JOB_LOG_MAX_CHARS:
        return content[:JOB_LOG_MAX_CHARS] + JOB_LOG_TRUNCATED_MARKER
    return content


def job_artifact_md(
    summary_text: str,
    log_text: str,
    *,
    commands: list[str] | None = None,
    reports_md: str = "",
    full_log: str = "",
) -> str:
    """The Execute step's artifact: the one-line summary plus the runner's
    redacted log, capped with a marker. Pure, so tests cover it without
    tmux or threads.

    HZ-434: with `commands` it is this attempt's evidence — each command's
    outcome, the plan's report files, then only this attempt's log. The
    server's digest keeps sections head-first, so the reports come before
    the log and the `Full log:` pointer sits in the first section."""
    if commands is None:
        return cap_job_artifact(f"## Commands\n{summary_text}\n\n## Log\n{log_text or '(no output)'}\n")
    head = "\n".join([summary_text, *commands] + ([f"\n{full_log}"] if full_log else []))
    reports = f"{reports_md}\n" if reports_md else ""
    return cap_job_artifact(f"## Commands\n{head}\n\n{reports}## Log (this attempt)\n{log_text or '(no output)'}\n")


def _command_lines(entries, secrets: dict) -> list[str]:
    """One line per state command: its outcome, then its redacted text."""
    lines = []
    for c in entries or []:
        if not isinstance(c, dict):
            continue
        command = redact(str(c.get("command", "")), secrets)
        if c.get("status") == "done" and c.get("exit_code") is not None:
            outcome = f"exit {c['exit_code']}"
        else:
            outcome = "not run" if c.get("status") == "pending" else str(c.get("status") or "not run")
        earlier = " (passed in an earlier attempt)" if c.get("resumed") else ""
        # HZ-416: e.g. the container's memory limit killed it.
        why = f" — {c['failure_reason']}" if isinstance(c.get("failure_reason"), str) else ""
        lines.append(f"- {outcome} — `{command}`{earlier}{why}")
    return lines


def _read_attempt_log(log_path: Path, offset) -> tuple[str, int, int]:
    """(text, start, end): the log from byte `offset` on, decoded. An offset
    past the end (a log replaced since) reads from the start. Reads no more
    than the artifact cap can hold."""
    try:
        with log_path.open("rb") as f:
            end = os.fstat(f.fileno()).st_size
            start = offset if isinstance(offset, int) and not isinstance(offset, bool) and 0 <= offset <= end else 0
            f.seek(start)
            data = f.read(JOB_LOG_MAX_CHARS * 4 + 1)
    except OSError:
        return "", 0, 0
    return data.decode("utf-8", "replace"), start, end


def _poll_jobs() -> None:
    """Forwards finished jobs to the server once, then releases their task
    files. Called from _watchdog (no third loop thread) and directly by
    tests. Each job isolated: one corrupt file never aborts the rest.

    HZ-408: a task file is released only once the server answered 2xx or 4xx.
    No answer or a 5xx (the server restarting in a deploy) keeps it for the
    next poll, so a result is never lost; a resend after a crash between the
    server's ack and the unlink is answered stale, so the run ends once."""
    from farm.config import LOGS_DIR as _LOGS, STATE_DIR as _STATE

    for task_path in sorted((QUEUE_DIR / "jobs" / "active").glob("*.json")):
        if task_path.name.endswith(".env.json") or task_path.name.endswith(".json.tmp"):
            continue
        try:
            task = json.loads(task_path.read_text())
            run_id = str(task["run_id"])
            item_id = task["item"]["id"]
            state_file = _STATE / "jobs" / f"{item_id}.json"
            try:
                state = json.loads(state_file.read_text())
            except (OSError, json.JSONDecodeError):
                state = None
            # A previous run's state (before a Resume or re-dispatch) stays on
            # disk until the new runner overwrites it: never report it as this run's.
            if state and str(state.get("run_id")) != run_id:
                state = None
            if not state or state.get("status") == "running":
                name = JOB_SESSIONS.get(run_id) or _job_session_name(item_id)
                if tmux_mgr.session_exists(name):
                    continue
                # Session gone with no terminal state: report it dead once.
                if _report_run_dead(run_id, name):
                    task_path.unlink(missing_ok=True)
                    JOB_SESSIONS.pop(run_id, None)
                continue
            status = state.get("status")
            summary = state.get("summary") or {}
            if status == "finished":
                run_n = summary.get("run", 0)
                passed = summary.get("passed", 0)
                failed = summary.get("failed", 0)
                failing = ", ".join(summary.get("failing") or [])
                text = f"{run_n} command(s) run, {passed} passed, {failed} failed"
                if failing:
                    text += f": {failing}"
                log_name = JOB_SESSIONS.get(run_id) or _job_session_name(item_id)
                log_path = _LOGS / f"{log_name}.log"
                if "log_offset" in state:
                    # HZ-434: this attempt's slice of the append-only log.
                    log_text, start, end = _read_attempt_log(log_path, state.get("log_offset"))
                    artifact_md = job_artifact_md(
                        text,
                        log_text,
                        commands=_command_lines(state.get("commands"), _job_secrets(task)),
                        reports_md=job_reports.reports_md(state.get("reports") or []),
                        full_log=(
                            f"Full log: `{log_path}` (this attempt is bytes {start:,}–{end:,}); "
                            f"also `GET /api/items/{item_id}/job/log?format=text`."
                        ),
                    )
                else:
                    # A runner from before HZ-434 wrote no offset: today's shape.
                    try:
                        log_text = log_path.read_text()
                    except OSError:
                        log_text = ""
                    artifact_md = job_artifact_md(text, log_text)
                code = _forward_result(
                    {
                        "run_id": task["run_id"],
                        "ok": True,
                        "summary": text[:600],
                        "artifacts": {"artifact_md": artifact_md},
                        "job_view": _job_view(run_id, task),
                    }
                )
            elif status == "budget_exceeded":
                code = _forward_result(
                    {
                        "run_id": task["run_id"],
                        "ok": False,
                        "error": "the job ran past the run plan's time budget and was stopped",
                        "reason": reasons.REASON["JOB_BUDGET_EXCEEDED"],
                        "job_view": _job_view(run_id, task),
                    }
                )
            elif status == "hash_mismatch":
                code = _forward_result(
                    {
                        "run_id": task["run_id"],
                        "ok": False,
                        "error": "the run plan changed since it was approved — send it back to Run plan and approve it again",
                        "reason": reasons.REASON["PLAN_CHANGED_SINCE_APPROVAL"],
                    }
                )
            elif status == "cwd_refused":
                code = _forward_result(
                    {
                        "run_id": task["run_id"],
                        "ok": False,
                        "error": f"Execute refused: {state.get('refusal') or 'cwd refused'}"[:300],
                        "reason": reasons.REASON["JOB_CWD_REFUSED"],
                        "job_view": _job_view(run_id, task),
                    }
                )
            elif status == "container_unavailable":
                code = _forward_result(
                    {
                        "run_id": task["run_id"],
                        "ok": False,
                        "error": f"Execute refused: {state.get('refusal') or 'no container to run in'}"[:300],
                        "reason": reasons.REASON["JOB_CONTAINER_UNAVAILABLE"],
                        "job_view": _job_view(run_id, task),
                    }
                )
            else:
                continue
            if code is None or code >= 500:
                print(f"farmd: job result for run {run_id} not delivered ({code}) — kept for the next poll", flush=True)
                continue
            if code >= 400:
                print(f"farmd: job result for run {run_id} refused ({code}) — task file released, result not recorded", flush=True)
            task_path.unlink(missing_ok=True)
            (task_path.parent / f"{task['run_id']}.env.json").unlink(missing_ok=True)
            JOB_SESSIONS.pop(run_id, None)
        except Exception as exc:
            print(f"farmd: job poll error for {task_path.name}: {exc}", flush=True)


def _queued(queue: Path) -> list[Path]:
    """Queued task files, oldest first; a file cancelled between the glob
    and the stat sorts out of this batch."""
    dated = []
    for path in queue.glob("*.json"):
        try:
            dated.append((path.stat().st_mtime, path))
        except OSError:
            continue
    return [path for _mtime, path in sorted(dated, key=lambda pair: pair[0])]


def _dispatch_pm_lane(runs_dir: Path, repo_root: Path) -> None:
    launch, unusable = _select_pm_dispatchable(_queued(QUEUE_DIR / "pm"), _ephemeral_sessions())
    # One report per tick, as the old PM poll did: a report can block on the
    # server for up to two timeouts, and this thread also feeds the runs lane.
    for task_path, why in unusable[:1]:
        _report_unusable_task(task_path, why)
    for task_path in launch:
        _claim_and_launch(task_path, runs_dir, repo_root)


def _dispatch_runs_lane(runs_dir: Path, repo_root: Path) -> None:
    sessions = _ephemeral_sessions()
    slots, long_slots = _runs_lane_slots(sessions)
    if slots <= 0:
        return
    for task_path in _select_dispatchable(_by_stage(_queued(runs_dir)), sessions, slots, long_slots):
        _claim_and_launch(task_path, runs_dir, repo_root)


def _dispatch_tick() -> None:
    """One dispatcher pass. Each lane has its own try, so an error in one
    can never starve the other."""
    runs_dir = QUEUE_DIR / "runs"
    repo_root = Path(__file__).resolve().parent.parent
    for lane, dispatch in (("pm", _dispatch_pm_lane), ("runs", _dispatch_runs_lane)):
        try:
            dispatch(runs_dir, repo_root)
        except Exception as exc:
            print(f"farmd: dispatcher error ({lane} lane): {exc}", flush=True)


def _ephemeral_dispatcher() -> None:
    """Launches queued steps: PM steps at most PM_LANE_CAP at once, every
    other step at most MAX_EPHEMERAL at once, plus FARM_EXPRESS_SLOTS more
    for short steps only (HZ-477), furthest-along stage first."""
    while True:
        time.sleep(3)
        if state["status"] != "running":
            continue
        _dispatch_tick()


def _concierge_session_name() -> str:
    return CONCIERGE_SESSION if state["project"] else ""


def _retire_legacy_concierge_sessions() -> list[str]:
    """HZ-209: kills any per-project farm-concierge-<slug> session on this
    FARM_HOME — an older farmd's, or one left from before the active project
    changed — so exactly one concierge ever polls WhatsApp. Never kills
    CONCIERGE_SESSION, and leaves another FARM_HOME's sessions alone. Its
    state files stay; the shared concierge copies them once on start."""
    killed = []
    for name in tmux_mgr.list_farm_sessions():
        if not name.startswith(CONCIERGE_SESSION_PREFIX) or name == CONCIERGE_SESSION:
            continue
        if not _session_in_this_farm(name):
            print(f"farmd: leaving concierge session {name} alone — not running under {farm_config.FARM_HOME}", flush=True)
            continue
        tmux_mgr.kill_session(name)
        killed.append(name)
    if killed:
        print(f"farmd: retired per-project concierge session(s) {killed} — one {CONCIERGE_SESSION} serves them all", flush=True)
    return killed


def _maybe_launch_concierge() -> bool:
    """WhatsApp concierge (HZ-7) — launches only with FARM_WA_ENABLED=1.

    HZ-209: one session, CONCIERGE_SESSION, for every enabled project. Every
    launch (boot and the watchdog's revive) retires per-project sessions
    first, so a second concierge can never run alongside it."""
    if not farm_config.FARM_WA_ENABLED or not state["project"]:
        return False
    _retire_legacy_concierge_sessions()
    slug = slugify(state["project"]["name"])
    repo_root = Path(__file__).resolve().parent.parent
    tmux_mgr.new_session(
        CONCIERGE_SESSION,
        f"{sys.executable} -m farm.concierge_agent --project '{state['project']['name']}' --legacy-slug {slug}",
        cwd=str(repo_root),
        log_file=str(LOGS_DIR / "concierge-_shared.log"),
    )
    return True


def _watchdog() -> None:
    """The concierge dies (a stray Ctrl-C in an attached pane, a crash) —
    revive it. PM steps have no long-lived session to revive (HZ-212): a dead
    farm-run-* session is reconcile's job. Finished jobs are forwarded here
    too (HZ-378) — no third loop thread."""
    while True:
        time.sleep(15)
        with _lock:
            if state["status"] != "running" or not state["project"]:
                continue
            concierge = _concierge_session_name() if farm_config.FARM_WA_ENABLED else ""
        if concierge and not tmux_mgr.session_exists(concierge):
            print(f"farmd: watchdog reviving dead session {concierge}", flush=True)
            try:
                _maybe_launch_concierge()
            except Exception as exc:
                print(f"farmd: watchdog revive failed: {exc}", flush=True)
        try:
            _poll_jobs()
        except Exception as exc:
            print(f"farmd: job poll failed: {exc}", flush=True)


def _non_empty_str(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


# HZ-207: /farm/start provisions hubs only for the farm project's repos, so a
# task from any other enabled project may name a repo with no hub yet. Its
# clone runs in the background; the runs lane holds the repo's tasks queued
# while it does. A failed clone just leaves the set — the task then launches
# and step_agent fails it visibly ("workspace not provisioned"), not silently.
_PROVISIONING: set[str] = set()
# The token from the last /farm/start, in memory only: never written to a
# task file, the state file or a log line.
_hub_auth = {"token": None}


def _hub_token() -> str | None:
    return _hub_auth["token"] or os.environ.get("GITHUB_TOKEN") or None


def _provisioning(repo) -> bool:
    with _lock:
        return repo in _PROVISIONING


def _provision_hub(repo: str) -> bool:
    """Starts cloning `repo`'s hub unless a clone is already in flight.
    Returns whether this call started one."""
    with _lock:
        if repo in _PROVISIONING:
            return False
        _PROVISIONING.add(repo)
    threading.Thread(target=_clone_hub, args=(repo,), daemon=True).start()
    return True


def _clone_hub(repo: str) -> None:
    token = _hub_token()
    try:
        workspaces.ensure(repo, token)
        print(f"farmd: workspace ready for {repo}", flush=True)
    except Exception as exc:
        detail = str(exc)
        if token:
            detail = detail.replace(token, "***")
        print(f"farmd: WARNING workspace for {repo} failed: {detail}", flush=True)
    finally:
        with _lock:
            _PROVISIONING.discard(repo)


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
    # `agents` / `checks` / `pm_agents` are additive (HZ-144, HZ-212): the
    # Node server's waitForFarmRunning reads only `status` and `error` from
    # this route, so new keys can't break it. `agents.busy` counts the runs
    # lane only, the slots MAX_EPHEMERAL bounds; `express` (HZ-477) counts the
    # runs beyond them, in the FARM_EXPRESS_SLOTS only short steps may use.
    # They exist because the check limiter is otherwise invisible — a run blocked on a check slot looks identical to
    # a run that is simply slow, and "who is waiting" was the one thing the
    # file-lock design gave up versus a farmd-brokered lease.
    busy = _lane_busy(_ephemeral_sessions())
    return {
        **state,
        "sessions": tmux_mgr.list_farm_sessions(),
        "agents": {"limit": MAX_EPHEMERAL, "busy": min(busy["runs"], MAX_EPHEMERAL)},
        "express": {"limit": FARM_EXPRESS_SLOTS, "busy": max(0, busy["runs"] - MAX_EPHEMERAL)},
        "pm_agents": {"limit": PM_LANE_CAP, "busy": busy["pm"]},
        "checks": check_slots.status(),
        # HZ-571: free memory and how many runs wait on it to start.
        "memory": check_slots.memory_status(),
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
            # Same project: nothing to recover — PM steps have no long-lived
            # session since HZ-212, and the queue is untouched.
            return {"ok": True, "already": True}
        _teardown()
        ensure_dirs()
        state.update(status="starting", project=project, repos=repos, error=None, since=_now())
        _hub_auth["token"] = body.get("token")
    threading.Thread(target=_start_async, args=(project, repos, body.get("token")), daemon=True).start()
    return {"ok": True, "starting": True}


@app.post("/farm/stop")
def farm_stop():
    with _lock:
        _teardown()
        STATE_FILE.unlink(missing_ok=True)
        state.update(status="stopped", project=None, repos=[], error=None, since=_now())
    return {"ok": True}


def _run_state(
    run_id: str,
    pm_queue: list,
    runs_queue: list,
    busy: int,
    general_full: bool = False,
    memory_waits: frozenset = frozenset(),
    memory_note: str | None = None,
) -> dict:
    """A run's semantic state, never its tmux session name (HZ-54): queued
    while its task file sits in the PM or ephemeral-runs queue, running once
    the dispatcher has claimed it (moved it into runs/active — matched by
    neither glob here, so it falls through to "running"). HZ-477: with every
    general slot held by a long step, a queued long step names that wait, not
    a free express slot it can never use. HZ-571: a claimed run whose checks
    are held by the memory gate (memory_waits, from check_slots' waiting
    markers) is queued again, named with the current figure (memory_note)."""
    if any(p.stem == run_id for p in pm_queue):
        return {"state": "queued", "reason": "waiting for the PM agent"}
    for p in runs_queue:
        if p.stem != run_id:
            continue
        if general_full and not _queued_short(p):
            return {
                "state": "queued",
                "reason": f"waiting for a free general agent slot ({MAX_EPHEMERAL}/{MAX_EPHEMERAL} running long steps; the express slot takes short steps only)",
            }
        return {"state": "queued", "reason": f"waiting for a free agent slot ({busy}/{MAX_EPHEMERAL + FARM_EXPRESS_SLOTS} in use)"}
    if run_id in memory_waits:
        return {"state": "queued", "reason": f"waiting for memory ({memory_note})" if memory_note else "waiting for memory"}
    return {"state": "running"}


def _queued_short(task_path: Path) -> bool:
    """HZ-477: whether a queued task file is a short step. An unreadable file
    or one with no known index counts as long, as the dispatcher treats it."""
    try:
        task = json.loads(task_path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    step = task.get("step") if isinstance(task, dict) else None
    index = step.get("index") if isinstance(step, dict) else None
    return isinstance(index, int) and index in SHORT_STEPS


@app.post("/runs/status")
async def runs_status(request: Request):
    """Batched queued/running lookup for the Node poller (HZ-54): the UI must
    never see a tmux session name, only this small state vocabulary."""
    body = await request.json()
    run_ids = [str(r) for r in body.get("run_ids", [])]
    pm_queue = list((QUEUE_DIR / "pm").glob("*.json"))
    runs_queue = list((QUEUE_DIR / "runs").glob("*.json"))
    sessions = _ephemeral_sessions()
    busy = _lane_busy(sessions)["runs"]
    general_full = _runs_lane_slots(sessions)[1] <= 0
    memory_waits = frozenset(
        str(w["run_id"]) for w in check_slots.waiting_runs() if w.get("waiting_on") == "memory" and w.get("run_id")
    )
    reading = check_slots.memory_reading() if memory_waits else None
    memory_note = reading.describe() if reading else None
    return {
        "states": {
            rid: _run_state(rid, pm_queue, runs_queue, busy, general_full, memory_waits, memory_note) for rid in run_ids
        }
    }


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
        return True  # still queued for the PM lane
    job_path = QUEUE_DIR / "jobs" / "active" / f"{run_id}.json"
    if job_path.exists():
        try:
            task = json.loads(job_path.read_text())
        except (json.JSONDecodeError, OSError):
            return False
        return tmux_mgr.session_exists(_job_session_name(task["item"]["id"]))
    session = RUN_SESSIONS.get(run_id) or JOB_SESSIONS.get(run_id)
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
    # HZ-207: every task carries its own project and repo, and a task without
    # them is refused — never filled in from the farm's own state["project"],
    # which would hand one project's rules to another project's item.
    project = body.get("project")
    if not isinstance(project, dict) or project.get("id") is None or not _non_empty_str(project.get("name")):
        return JSONResponse({"error": "missing project"}, status_code=400)
    item_repo = body["item"].get("repo") if isinstance(body["item"], dict) else None
    if not _non_empty_str(item_repo):
        return JSONResponse({"error": "missing item.repo"}, status_code=400)
    if not isinstance(body["step"], dict) or step_kind_mismatch(body["item"], body["step"]):
        return JSONResponse({"error": "step kind mismatch"}, status_code=400)
    if not (workspaces.hub_path(item_repo) / ".git").exists():
        _provision_hub(item_repo)
    # Plan/review-summary steps go to the PM lane (one at a time); everything
    # else to the ephemeral lane (bounded by FARM_MAX_EPHEMERAL). Both launch
    # farm.step_agent (HZ-371). The dispatcher launches both (HZ-212). HZ-117: which is which
    # comes from steps.STEPS's runsIn field, not a hardcoded index tuple.
    #
    # Project/repo rules are stamped into the task at enqueue (HZ-9) as a
    # list of unrendered parts — render_rules_section() (farm/rules.py) does
    # the actual whole-part-drop-with-note decision later, at prompt-build
    # time, so this queued payload is the *inputs* to that render, not the
    # rendered prompt text itself.
    # HZ-246: rules_override is what the server's DB serves for this project
    # and repo at dispatch; _claim_and_launch refreshes it at claim time.
    body["rules"] = rules.resolve_rules(project["name"], item_repo, body.get("rules_override"))
    # HZ-383: in the item kind's own rows — checked above, so the kind is known.
    view = steps.FARM_VIEWS[body["item"].get("kind") or "change"]
    queue = lane_for_index(view, body["step"].get("index", 99))
    if queue == "job":
        if not _jobs_enabled():
            return JSONResponse({"error": "jobs_disabled"}, status_code=409)
        item_id = body["item"].get("id") or ""
        for existing in (QUEUE_DIR / "jobs" / "active").glob("*.json"):
            if existing.name.endswith(".env.json"):
                continue
            try:
                if json.loads(existing.read_text())["item"].get("id") == item_id:
                    return JSONResponse({"error": "job_already_running"}, status_code=409)
            except (json.JSONDecodeError, KeyError, OSError):
                continue
        if not body.get("plan_artifact") or not body.get("approved_hash"):
            return JSONResponse({"error": "missing plan_artifact or approved_hash"}, status_code=400)
        # HZ-491: the server works out where the job runs and sends it; the
        # farm applies no default, so a job naming no runner is refused.
        if body.get("runner") not in task_job.RUNNERS:
            return JSONResponse({"error": "job_runner_missing"}, status_code=400)
        # The server armed a queue watchdog at dispatch; a job that never
        # reports started would be failed as never_picked_up mid-run. This
        # flips it to the execution budget, which markFarmRunStarted leaves
        # unarmed for the job lane — so no agent timer ever bounds a job. A
        # run the server already gave up on is not launched at all, the same
        # rule _claim_and_launch applies to agent runs. Fails open when the
        # server cannot be reached.
        if not _notify_started(body["run_id"]):
            print(f"farmd: run {body['run_id']} no longer active server-side — not launching", flush=True)
            return {"ok": True, "queued": queue, "stale": True}
        try:
            name = launch_job(body)
        except run_plan.CwdRefused as exc:
            return JSONResponse({"error": f"cwd refused: {exc}"}, status_code=400)
        except login_env.LoginEnvError as exc:
            # HZ-553: str(exc) is the path and the cause, never a value.
            return JSONResponse({"error": f"login_env_refused: {exc}"}, status_code=400)
        except ValueError as exc:
            return JSONResponse({"error": f"invalid run plan: {exc}"}, status_code=400)
        return {"ok": True, "queued": queue, "session": name}
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
    if farmd itself dies.

    HZ-256: a run stopped by /conflicts/cancel answers 409 cancelled — nothing
    was pushed, and the Node side neither escalates nor sends the item back."""
    body = await request.json()
    if state["status"] != "running":
        return JSONResponse({"error": f"farm_not_running (status={state['status']})"}, status_code=409)
    item = body.get("item") or {}
    item_id, repo = item.get("id"), item.get("repo")
    if not item_id or not repo:
        return JSONResponse({"error": "item.id and item.repo are required"}, status_code=400)
    try:
        with workspaces.item_lock(repo, item_id, wait_s=0):
            # HZ-245: the repo's Admin-configured check commands, when the
            # server sent any. HZ-304: absent means no commands — the checks
            # fail by name unless the server also sent a checks_waiver.
            extra = {"configured": body["check_commands"]} if body.get("check_commands") else {}
            if body.get("checks_waiver"):
                extra["checks_waiver"] = body["checks_waiver"]
            # HZ-494: the repo's test-login env file — a path; read at check time.
            if isinstance(body.get("test_env_file"), str) and body["test_env_file"]:
                extra["test_env_file"] = body["test_env_file"]
            result = await asyncio.to_thread(
                conflict_resolver.resolve, repo, item_id, body.get("branch"), body.get("base_branch"), **extra
            )
    except workspaces.ItemBusy:
        return JSONResponse({"error": "resolve_in_progress"}, status_code=409)
    except conflict_resolver.Cancelled:
        print(f"farmd: conflict resolution for {item_id} was cancelled — nothing pushed", flush=True)
        return JSONResponse({"error": "cancelled"}, status_code=409)
    except Exception as exc:
        print(f"farmd: conflict resolution for {item_id} failed: {exc}", flush=True)
        return JSONResponse({"error": str(exc)[:300]}, status_code=500)
    return {"ok": True, **result}


@app.post("/caretaker/ruling")
async def caretaker_ruling_route(request: Request):
    """HZ-273: one bounded agent call proposing an operator ruling, returned
    directly — no tmux session, queue file or run row. The proposal is only a
    proposal: the Node server checks it in code and is the only side that
    edits the issue. 400 for a missing key, 503 when the provider is not
    authenticated; an unusable model reply is a 200 {"unsure": true}."""
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "a JSON object is required"}, status_code=400)
    for key in caretaker_ruling.REQUIRED_KEYS:
        if not isinstance(body.get(key), str):
            return JSONResponse({"error": f"missing {key}"}, status_code=400)
    try:
        assert_provider_auth()
    except Exception as exc:
        return JSONResponse({"error": f"provider not authenticated: {exc}"[:300]}, status_code=503)
    return await asyncio.to_thread(
        caretaker_ruling.propose, body["item_id"], body["request"], body["metric"], body["guardrails"]
    )


# HZ-256: the only farmd route that checks its caller itself. farmd binds to
# 127.0.0.1 anyway; this route can stop a run, so it does not rely on that.
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
CONFLICT_CANCEL_POLL_S = 0.2


def _conflict_cancel_wait_s() -> float:
    try:
        return max(0.0, float(os.environ.get("FARM_CONFLICT_CANCEL_WAIT_S", "30")))
    except ValueError:
        return 30.0


def _fence_pushes(repo: str) -> None:
    # A push already inside hub_lock finishes; none can start after this,
    # because _push_guarded() re-checks the cancel event under the same lock.
    with workspaces.hub_lock(repo):
        pass


@app.post("/conflicts/cancel")
async def conflicts_cancel(request: Request):
    """HZ-256: stop one item's running conflict resolver, for a self-deploy
    (server/src/deployDrain.js is the only caller). Sets the resolver's cancel
    event, fences off any push, then kills the processes running in the item's
    worktree — again on every poll, so one started after a sweep dies too —
    until the resolver has unwound and released the item's lock, or
    FARM_CONFLICT_CANCEL_WAIT_S runs out.

    Only the named item: no other item's run, lock or worktree is touched. No
    resolver running for it answers 200 and changes nothing. Works whatever
    the farm's status, so a pausing farm can still be drained."""
    host = request.client.host if request.client else None
    if host not in LOOPBACK_HOSTS:
        return JSONResponse({"error": "loopback only"}, status_code=403)
    try:
        body = await request.json()
    except ValueError:
        body = None
    item_id = body.get("item") if isinstance(body, dict) else None
    repo = body.get("repo") if isinstance(body, dict) else None
    if not _non_empty_str(item_id) or not _non_empty_str(repo):
        return JSONResponse({"error": "item and repo are required"}, status_code=400)
    if not conflict_resolver.request_cancel(repo, item_id):
        return {"ok": True, "cancelled": False, "killed": 0, "lock_released": not workspaces.item_lock_held(repo, item_id)}

    deadline = time.monotonic() + _conflict_cancel_wait_s()
    ws = workspaces.workspace_path(repo, item_id)
    # Fence before the first sweep: killing a push's helper processes mid-
    # transfer could move the remote branch yet report nothing pushed.
    try:
        await asyncio.wait_for(asyncio.to_thread(_fence_pushes, repo), timeout=max(0.0, deadline - time.monotonic()))
    except asyncio.TimeoutError:
        pass
    killed = await asyncio.to_thread(conflict_cancel.sweep_worktree, ws)
    while conflict_resolver.is_active(repo, item_id) or workspaces.item_lock_held(repo, item_id):
        if time.monotonic() >= deadline:
            break
        killed += await asyncio.to_thread(conflict_cancel.sweep_worktree, ws)
        await asyncio.sleep(CONFLICT_CANCEL_POLL_S)
    released = not conflict_resolver.is_active(repo, item_id) and not workspaces.item_lock_held(repo, item_id)
    print(
        f"farmd: cancelled conflict resolution for {item_id} — {killed} process(es) stopped, "
        f"lock {'released' if released else 'still held'}",
        flush=True,
    )
    return {"ok": True, "cancelled": True, "killed": killed, "lock_released": released}


def _job_task_for_run(run_id: str) -> tuple[Path | None, dict | None]:
    for task_path in (QUEUE_DIR / "jobs" / "active").glob("*.json"):
        if task_path.name.endswith(".env.json"):
            continue
        try:
            task = json.loads(task_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if str(task.get("run_id")) == str(run_id):
            return task_path, task
    return None, None


# HZ-407: how many of the log's last lines ride in a job view.
JOB_LOG_TAIL_LINES = 20
# An item id as it may name a log file: no `/`, no `..`.
_JOB_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def _job_secrets(task: dict) -> dict:
    """Every value a job's log is scrubbed of — the plan's resolved env values
    plus the redact set — so command text in a view is scrubbed the same way.
    HZ-415: the .env is the one in the resolved repo cwd; a cwd that does not
    resolve gets the host credentials only, and no .env is read."""
    try:
        block = run_plan.extract(task.get("plan_artifact") or "")
    except ValueError:
        return {}
    try:
        cwd = run_plan.resolve_cwd(task.get("repo_dir"), block["cwd"], forbid=str(task_job.HORIZON_ROOT))
    except run_plan.CwdRefused:
        return _job_redact_values(None)
    # HZ-553: the test-login file is read again for each view. If it broke
    # since launch, the view falls back to today's set ({}): the runner's own
    # log was already scrubbed with the launch-time values.
    try:
        login = _job_login_env(task)
    except login_env.LoginEnvError:
        login = {}
    return {**_job_redact_values(cwd, login), **_resolve_job_env(cwd, block.get("env", {}), login)}


def _job_log_path(run_id, item_id: str) -> Path:
    from farm.config import LOGS_DIR as _LOGS

    name = JOB_SESSIONS.get(str(run_id)) or _job_session_name(item_id)
    return _LOGS / f"{name}.log"


def _job_log_tail(run_id, item_id: str, lines: int = JOB_LOG_TAIL_LINES) -> list[str]:
    """The last lines of the runner's own log file, already redacted."""
    try:
        with _job_log_path(run_id, item_id).open("rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 16 * 1024))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    return text.splitlines()[-lines:]


def _job_view(run_id: str, task: dict) -> dict:
    """The job's current status for the server's GET /api/items/:id/job and
    the Execute card (HZ-407): each command (text redacted) with its status,
    elapsed seconds against the budget, and the log's last redacted lines."""
    from farm.config import STATE_DIR as _STATE

    item_id = task["item"]["id"]
    name = JOB_SESSIONS.get(str(run_id)) or _job_session_name(item_id)
    try:
        state = json.loads((_STATE / "jobs" / f"{item_id}.json").read_text())
    except (OSError, json.JSONDecodeError):
        state = None
    # A previous run's state (before a Resume's runner writes) is not this run's.
    if state and str(state.get("run_id")) != str(run_id):
        state = None
    secrets = _job_secrets(task)
    commands = [
        {
            "command": redact(str(c.get("command", "")), secrets),
            "status": c.get("status"),
            "exit_code": c.get("exit_code"),
            "started_at": c.get("started_at"),
            "ended_at": c.get("ended_at"),
        }
        for c in (state.get("commands", []) if state else [])
        if isinstance(c, dict)
    ]
    budget_s = state.get("budget_s", 0) if state else 0
    started_at = state.get("started_at") if state else None
    ended_at = state.get("ended_at") if state else None
    try:
        until = datetime.fromisoformat(ended_at).timestamp() if ended_at else time.time()
        elapsed = max(0, int(until - datetime.fromisoformat(started_at).timestamp())) if started_at else 0
    except (ValueError, TypeError, OSError):
        elapsed = 0
    status = state.get("status", "running") if state else "running"
    if status == "running" and not tmux_mgr.session_exists(name):
        status = "unknown"
    return {
        "status": status,
        "elapsedS": elapsed,
        "budgetS": budget_s,
        "startedAt": started_at,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "commands": commands,
        "logTail": [redact(line, secrets) for line in _job_log_tail(run_id, item_id)],
    }


def _forward_progress(run_id, view: dict) -> None:
    """HZ-407: the job's latest view to the server, which stores it on the run
    and pushes it down the item's stream. One try: the next nudge resends the
    whole view."""
    try:
        res = httpx.post(
            f"{HORIZON_URL}/api/farm/steps/{run_id}/progress",
            json=view,
            headers={"x-farm-secret": SHARED_SECRET},
            timeout=5,
        )
        if not 200 <= res.status_code < 300:
            print(f"farmd: job progress for run {run_id} -> {res.status_code}", flush=True)
    except Exception as exc:
        print(f"farmd: job progress for run {run_id} not delivered: {exc}", flush=True)


@app.post("/jobs/{run_id}/progress")
def jobs_progress(run_id: str, request: Request):
    """Loopback only: the runner's nudge that its state or log moved. The
    runner sends no body and holds no farm secret; the view is built here."""
    host = request.client.host if request.client else None
    if host not in LOOPBACK_HOSTS:
        return JSONResponse({"error": "loopback only"}, status_code=403)
    _task_path, task = _job_task_for_run(run_id)
    if not task:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    _in_background(_forward_progress, task["run_id"], _job_view(run_id, task))
    return {"ok": True}


def _mark_job_stopped(run_id, item_id: str) -> None:
    """HZ-407: after Stop killed the runner, its command's process group
    (which outlives the tmux session) is killed too, and the command that was
    running is recorded `stopped` — never left `running`, never `done`.

    HZ-416: a container run's container is then killed and removed — after
    the process group, since rootless conmon outlives its client — and its
    scratch and /tmp dirs are wiped, as the runner itself would have."""
    from farm.config import STATE_DIR as _STATE

    state_path = _STATE / "jobs" / f"{item_id}.json"
    state = task_job.load_state(state_path)
    if not state or str(state.get("run_id")) != str(run_id):
        return
    now = datetime.now(timezone.utc).isoformat()
    for entry in state.get("commands", []):
        if not isinstance(entry, dict) or entry.get("status") != "running":
            continue
        pgid = entry.pop("pgid", None)
        if isinstance(pgid, int) and pgid > 1:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        entry["status"] = "stopped"
        entry["ended_at"] = now
        entry["exit_code"] = None
    if state.get("runner") == "container":
        container_runner.stop_and_remove(container_runner.container_name(item_id))
        task_job.wipe_throwaway(state_path, _job_log_path(run_id, item_id))
    if state.get("status") == "running":
        state["status"] = "stopped"
        state["ended_at"] = now
    task_job.save_state(state_path, state)
    try:
        with _job_log_path(run_id, item_id).open("a", encoding="utf-8") as log:
            log.write("stopped by the owner\n")
    except OSError:
        pass


@app.post("/jobs/stop")
async def jobs_stop(request: Request):
    """Loopback only: the server's Stop run button. Kills the job's tmux
    session (its runner and its current command group die together); the
    runner's state file keeps every passed command done so Resume skips them."""
    host = request.client.host if request.client else None
    if host not in LOOPBACK_HOSTS:
        return JSONResponse({"error": "loopback only"}, status_code=403)
    body = await request.json()
    run_id = str(body.get("run_id") or "")
    task_path, task = _job_task_for_run(run_id)
    if not task_path or not task:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    name = JOB_SESSIONS.get(run_id) or _job_session_name(task["item"]["id"])
    if not tmux_mgr.session_exists(name):
        return JSONResponse({"error": "job not running"}, status_code=409)
    tmux_mgr.kill_session(name)
    _mark_job_stopped(run_id, task["item"]["id"])
    # Built before the session is forgotten, so the log path still resolves.
    view = _job_view(run_id, task)
    JOB_SESSIONS.pop(run_id, None)
    task_path.unlink(missing_ok=True)
    (task_path.parent / f"{task['run_id']}.env.json").unlink(missing_ok=True)
    done = sum(1 for c in view["commands"] if c.get("status") == "done" and c.get("exit_code") == 0)
    print(f"farmd: stopped job {run_id} (killed {name})", flush=True)
    return {"ok": True, "killed": True, "commandsDone": done, "view": view}


@app.get("/jobs/{run_id}")
def jobs_status(run_id: str, request: Request):
    """Loopback only: the server polls (and proxies) one job's status."""
    host = request.client.host if request.client else None
    if host not in LOOPBACK_HOSTS:
        return JSONResponse({"error": "loopback only"}, status_code=403)
    _task_path, task = _job_task_for_run(run_id)
    if not task:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    return _job_view(run_id, task)


@app.get("/jobs/{run_id}/log")
def jobs_log(run_id: str, request: Request, offset: int = 0, item_id: str | None = None):
    """Loopback only: pages the runner's own redacted log file, the same
    shape as /runs/{run_id}/log so the server proxies it verbatim. HZ-407:
    once Stop released the task file, `item_id` still finds the log."""
    host = request.client.host if request.client else None
    if host not in LOOPBACK_HOSTS:
        return JSONResponse({"error": "loopback only"}, status_code=403)
    _task_path, task = _job_task_for_run(run_id)
    if task:
        item_id = task["item"]["id"]
    elif not item_id or not _JOB_ITEM_ID_RE.match(item_id):
        return JSONResponse({"error": "unknown job"}, status_code=404)
    name = JOB_SESSIONS.get(str(run_id)) or _job_session_name(item_id)
    log_path = _job_log_path(run_id, item_id)
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


# HZ-245: `owner/name`, each part starting with an alphanumeric — so no
# `.`/`..` segment and no extra `/` can reach hub_path().
_REPO_NAME_RE = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$")


@app.post("/repos/check-defaults")
async def repos_check_defaults(request: Request):
    """HZ-245: what auto-detection would run for a repo, labelled by slot
    (install/test/lint/e2e) — Admin shows it as placeholders. Read-only: no
    git, no lock, no writes. Detected on the hub clone, so it is a hint; a
    missing hub gives all nulls."""
    body = await request.json()
    repo = body.get("repo") if isinstance(body, dict) else None
    if not isinstance(repo, str) or not _REPO_NAME_RE.match(repo):
        return JSONResponse({"error": "repo must be owner/name"}, status_code=400)
    hub = workspaces.hub_path(repo)
    if not (hub / ".git").exists():
        return {"repo": repo, "defaults": {slot: None for slot in CHECK_SLOTS}}
    return {"repo": repo, "defaults": await asyncio.to_thread(default_check_slots, hub)}


# Each pipe-pane read is capped; the UI pages with `offset`.
LOG_READ_CAP = 64 * 1024


def _session_for_run(run_id: str) -> str | None:
    """Resolve a run to its ephemeral tmux session: the in-memory map first,
    then the claimed task files (covers a farmd restarted mid-run). PM steps
    (0/1/2/9) resolve the same way since HZ-212, each to its own log."""
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
    other cancel (reject, supersede, abandon) still kills at once.

    HZ-321: `reason: "deploy"` (a self-deploy's drain ran out of time) is a
    pause too. `<run_id>.stop-reason` tells the step agent why before the
    SIGTERM, so it saves a deploy checkpoint (step_agent._deploy_checkpoint)
    instead of a pause one."""
    body = await request.json()
    run_id = str(body.get("run_id"))
    reason = body.get("reason")
    pausing = reason in ("pause", "deploy")
    checkpoint = None
    removed = False
    killed = None
    for sub in ("pm", "runs", "runs/active", "jobs/active"):
        task_path = QUEUE_DIR / sub / f"{run_id}.json"
        if not task_path.exists():
            continue
        if sub == "jobs/active":
            try:
                task = json.loads(task_path.read_text())
                name = _job_session_name(task["item"]["id"])
                if tmux_mgr.session_exists(name):
                    tmux_mgr.kill_session(name)
                    killed = name
                    print(f"farmd: cancelled job {run_id} (killed {name})", flush=True)
            except Exception as exc:
                print(f"farmd: cancel of job {run_id} could not kill its session: {exc}", flush=True)
            (QUEUE_DIR / sub / f"{run_id}.env.json").unlink(missing_ok=True)
            JOB_SESSIONS.pop(run_id, None)
        if sub == "runs/active":
            try:
                task = json.loads(task_path.read_text())
                name = _run_session_name(task)
                if pausing and tmux_mgr.session_exists(name):
                    if reason == "deploy" and lane_for_index(LANE_ROWS, task["step"]["index"]) == "pm":
                        # A PM step keeps nothing in a workspace: no agent to ask.
                        checkpoint = {"outcome": "nothing", "detail": "a PM step keeps no work to save"}
                    else:
                        if reason == "deploy":
                            (QUEUE_DIR / sub / f"{run_id}.stop-reason").write_text("deploy")
                        checkpoint = await _pause_in_flight(run_id, name, _pause_timeout(body.get("checkpoint_timeout_s")))
                    print(f"farmd: {reason} of run {run_id}: checkpoint {checkpoint['outcome']}", flush=True)
                if tmux_mgr.session_exists(name):
                    tmux_mgr.kill_session(name)
                    killed = name
                    print(f"farmd: cancelled in-flight run {run_id} (killed {name})", flush=True)
            except Exception as exc:
                print(f"farmd: cancel of run {run_id} could not kill its session: {exc}", flush=True)
            for leftover in (f"{run_id}.pid", f"{run_id}.paused", f"{run_id}.stop-reason"):
                (QUEUE_DIR / sub / leftover).unlink(missing_ok=True)
        task_path.unlink(missing_ok=True)
        removed = True
    # Fallback: the in-memory map (covers an active task file already consumed).
    session = RUN_SESSIONS.pop(run_id, None) or JOB_SESSIONS.pop(run_id, None)
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

    HZ-209 widens it, also on purpose: the snapshot is scope=enabled, the
    items of EVERY enabled project, because one concierge serves them all.
    A step agent working on one project can therefore read every enabled
    project's items through here. Still read-only; a disabled project's
    items are never in it.
    """
    try:
        res = httpx.get(
            f"{HORIZON_URL}/api/farm/snapshot",
            params={"scope": "enabled"},
            headers={"x-farm-secret": SHARED_SECRET},
            timeout=15,
        )
        if res.status_code != 200:
            # Upstream status/body are not passed through: a 401 here is a
            # farmd misconfiguration, not something the concierge can act on.
            print(f"farmd: snapshot fetch -> {res.status_code}", flush=True)
            return JSONResponse({"error": "could not reach horizon server"}, status_code=502)
        return res.json()
    except Exception as exc:
        print(f"farmd: snapshot fetch failed: {exc}", flush=True)
        return JSONResponse({"error": "could not reach horizon server"}, status_code=502)


def _notify_checks(run_id, phase: str) -> None:
    """HZ-458: relays an implement run's "checks started/ended" to the server,
    which pauses the run's step clock in between. Fails OPEN like
    _notify_started: a lost call leaves the server's clock running, which is
    how a run was timed before."""
    url = f"{HORIZON_URL}/api/farm/steps/{run_id}/checks"
    for attempt in (1, 2):
        try:
            res = httpx.post(url, json={"phase": phase}, headers={"x-farm-secret": SHARED_SECRET}, timeout=15)
            if res.status_code != 200:
                print(f"farmd: checks {phase} notify for run {run_id} -> {res.status_code}", flush=True)
            return
        except Exception as exc:
            print(f"farmd: checks {phase} notify attempt {attempt} for run {run_id} failed: {exc}", flush=True)
            time.sleep(2)


@app.post("/internal/steps/checks")
async def steps_checks(request: Request):
    """The implement step reports its checks starting and ending here; we
    forward to the Node server with the secret. Always ok: see _notify_checks."""
    body = await request.json()
    run_id, phase = body.get("run_id"), body.get("phase")
    if isinstance(run_id, int) and phase in ("start", "end"):
        await asyncio.to_thread(_notify_checks, run_id, phase)
    return {"ok": True}


@app.post("/internal/steps/result")
async def steps_result(request: Request):
    """Agents report here; we forward to the Node server with the secret."""
    body = await request.json()
    status = _forward_result(body)
    if status is None:
        return JSONResponse({"error": "could not reach horizon server"}, status_code=502)
    # HZ-184: a rejected report (e.g. a 400 over the route's length limit)
    # is a lost result — the run would sit active until the server's
    # watchdog called it a timeout. Never report that as delivered.
    if not 200 <= status < 300:
        return JSONResponse({"error": "horizon server rejected the result", "forwarded": status}, status_code=502)
    return {"ok": True, "forwarded": status}


ensure_dirs()
(QUEUE_DIR / "runs" / "active").mkdir(parents=True, exist_ok=True)
(QUEUE_DIR / "jobs" / "active").mkdir(parents=True, exist_ok=True)
# HZ-5 cost guardrail at boot: covers the adopt path too, which never goes
# through /farm/start — a farm on API billing must not come up at all.
assert_provider_auth()
_adopt_existing()
_adopt_jobs()
_reconcile_claimed_runs()
# HZ-569: a check this farmd ran before a restart left its processes with no
# owner; they go now, not on the first tick.
_sweep_runs()
threading.Thread(target=_watchdog, daemon=True).start()
threading.Thread(target=_ephemeral_dispatcher, daemon=True).start()
threading.Thread(target=_reconcile_loop, daemon=True).start()
threading.Thread(target=_test_runs_outbox_loop, daemon=True).start()
threading.Thread(target=_run_sweep_loop, daemon=True).start()
threading.Thread(target=_knowledge_loop, daemon=True).start()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=FARM_PORT)
