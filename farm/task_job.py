"""Detached shell-command jobs for a Task's Execute step (HZ-378).

Execute never improvises: it runs exactly the commands in the approved Run
plan's fenced block (domain/py/run_plan.py), in order, in the plan's cwd
resolved inside the Task repo's deploy-target directory (HZ-415) — never in
Horizon's own checkout, where this runner itself starts. farmd launches this
module in a farm-job-<item> tmux session (no pipe-pane — this runner owns the
only log); the runner writes a redacted log and a JSON state file, and farmd
polls the state file to report progress to the server.

Secrets never ride in argv or task files: farmd resolves the repo's env files
plus the named values farm-side, writes them to a 0600 env file, and this
module reads and unlinks that file before the first command runs. Every log
line passes through checks.redact() before it is written anywhere.

Stop-or-continue (R16): the job stops on the first non-zero exit. Remaining
commands stay pending so Resume retries from the first unfinished one without
re-running a passed command.

HZ-407: output is logged line by line while a command runs, and the runner
nudges farmd (loopback, no body, no secret) whenever its state or log moves,
so the Execute card updates live. A command cut off by the budget or by Stop
ends `stopped`, never `done`; Resume runs it again.
"""

import argparse
import hashlib
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from domain.py import run_plan
from farm import container_runner, job_reports
from farm import task_clone as task_clone_mod
from farm.checks import redact

# HZ-415: Horizon's own checkout, the same rule farmd.py uses. A Task's
# commands never run inside it.
HORIZON_ROOT = Path(__file__).resolve().parent.parent


def plan_hash_of(artifact_md: str) -> str:
    """sha256 hex of the whole Run plan artifact, byte-identical to
    server/src/store.js planHashOf(). The hash covers the artifact, not just
    the block, so any re-run counts as a new plan."""
    return hashlib.sha256((artifact_md or "").encode("utf8")).hexdigest()


def load_state(path: Path) -> dict | None:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def save_state(path: Path, state: dict) -> None:
    """Atomic write (temp file + rename), so farmd never reads a half-written
    state file while this runner writes it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.stem}.", suffix=".json.tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(state, indent=2))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _child_env(env_values: dict, venv: str | None = None) -> dict:
    """Minimal base plus the job's secrets. The base is the small set a shell
    command needs (PATH, HOME, etc); everything else from the farm process
    stays out, so a `env` dump in the log cannot leak farm tuning.

    HZ-431: with a venv, its bin/ goes first on PATH and VIRTUAL_ENV names
    it — applied last, so a plan's env cannot swap the interpreter. A fresh
    dict every time: the farm's own os.environ is never touched."""
    base_keys = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR")
    env = {k: v for k, v in os.environ.items() if k in base_keys}
    env.setdefault("PATH", "/usr/bin:/bin")
    for k, v in (env_values or {}).items():
        if isinstance(v, str):
            env[str(k)] = v
    if venv:
        env["PATH"] = os.pathsep.join([os.path.join(venv, "bin"), env.get("PATH") or "/usr/bin:/bin"])
        env["VIRTUAL_ENV"] = venv
    return env


def _notify_progress(run_id) -> None:
    """HZ-407: tells farmd this job's state or log moved; farmd builds the
    redacted view and forwards it. Empty body, 1 s timeout, errors ignored —
    the next nudge resends the whole view."""
    port = os.environ.get("FARM_PORT", "4100")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/jobs/{run_id}/progress", data=b"", method="POST")
    try:
        urllib.request.urlopen(req, timeout=1).close()
    except Exception:
        pass


# Log lines nudge at most this often; a status change always nudges at once.
NUDGE_MIN_INTERVAL_S = 1.0


def _read_lines(stream, lines: "queue.Queue") -> None:
    """Reader thread: every output line, then None at EOF."""
    try:
        for line in stream:
            lines.put(line)
    except (OSError, ValueError):
        pass
    lines.put(None)


def _prepare_scratch(state_path: Path, item_id: str) -> Path:
    """A fresh per-start scratch dir inside the job's state dir — the only
    place a container run may leave new files besides state and logs. Wiped
    on every start (Resume included), so one start never reads another's
    leftovers; run reports are already captured in the state file."""
    scratch = Path(state_path).parent / "scratch" / str(item_id)
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True, exist_ok=True)
    return scratch


def _container_report_mounts(commands: list, declared: list, scratch: Path) -> list:
    """(host_file, container_path) binds for `--report /tmp/<name>` files.
    Each host file is pre-created empty under scratch (a missing host path
    would make Podman mount a directory instead). Only direct children of
    /tmp qualify — nested and relative report paths stay on read-only mounts
    and fail closed at write time."""
    mounts = []
    for path in job_reports.report_paths(commands, declared or []):
        if not os.path.isabs(path):
            continue
        parts = PurePosixPath(path).parts
        if len(parts) != 3 or parts[0] != "/" or parts[1] != "tmp":
            continue
        if parts[2] in (".", ".."):
            continue
        host_file = scratch / parts[2]
        host_file.touch(exist_ok=True)
        mounts.append((str(host_file), path))
    return mounts


def run_job(
    *,
    run_id,
    item_id: str,
    plan_artifact: str,
    approved_hash: str,
    state_path,
    log_path,
    repo_dir: str | None,
    venv_dir: str | None = None,
    env_values: dict | None = None,
    redact_values: dict | None = None,
    notify=None,
    task_clone: bool = False,
    container_image: str | None = None,
    cpu_limit: str | None = None,
    memory_limit: str | None = None,
) -> dict:
    """Runs the approved plan's commands in order. Returns the summary dict
    {run, passed, failed, failing}. Writes the state file and appends to the
    redacted log. Never raises for a command failure or budget breach — those
    are summary outcomes, not crashes. Raises ValueError only for an unreadable
    plan block (a dispatch bug, not a job outcome). `notify`, when given, is
    called after each state change and (throttled) after new log lines.

    HZ-415: `repo_dir` is the Task repo's deploy-target checkout, required
    with no default. The plan's cwd is resolved inside it on every start —
    Resume included — before the first command; a cwd that leaves it ends
    the job `cwd_refused` with zero commands run.

    HZ-431: `venv_dir` is the deploy target's optional venv setting (None:
    `<repo_dir>/.venv` if it exists). It is resolved right after the cwd, on
    every start; a venv outside the checkout is refused the same way. The
    log's first line of each start names the env: `env: <venv>` or
    `env: system`.

    HZ-440: with `task_clone`, `repo_dir` is the target's separate task
    clone (taskDir), never the deploy checkout. It is fast-forwarded to
    origin/main before the cwd is resolved, on a fresh start, a re-approved
    plan, or a Resume that has passed nothing or was refused — a Resume after
    a pass keeps HEAD where it was. A clone that cannot fast-forward ends the
    job `cwd_refused` with zero commands run. Each start logs
    `task clone HEAD: <sha>` after the env line.

    HZ-416: `block["runner"]` selects where the commands run — `container`
    (the default when absent) or an explicit `host`. The container path runs
    one throwaway `podman run --rm` per command (farm/container_runner.py):
    the checkout mounted read-only at /repo, a fresh scratch dir plus the
    state and log dirs writable, host networking, only the plan's env, and
    the target's CPU/memory limits. `venv_dir` is ignored there — a host
    virtualenv's binaries do not run in the image; the log names `system`.
    Missing Podman or no pinned `container_image` ends the job
    `container_unavailable` with zero commands run — never a host run."""
    last_nudge = [0.0]

    def nudge(*, force: bool = True) -> None:
        if notify is None:
            return
        now = time.time()
        if not force and now - last_nudge[0] < NUDGE_MIN_INTERVAL_S:
            return
        last_nudge[0] = now
        notify()

    # Every value either set is masked in the log; only env_values reach the
    # commands' environment (redact_values are host credentials and every
    # <cwd>/.env value, named by the plan or not).
    secrets = {**(redact_values or {}), **(env_values or {})}
    state_path = Path(state_path)
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    block = run_plan.extract(plan_artifact or "")
    plan_cwd = block["cwd"]
    commands = list(block["commands"])
    budget_s = int(block["budget_minutes"]) * 60
    # HZ-416: absent means the container; only an explicit `host` runs on the
    # host. validate() already refused any other value.
    runner = block.get("runner") or "container"

    # Resume: keep passed commands done, retry everything else.
    prior = load_state(state_path)
    prior_done: dict[str, dict] = {}
    # Only a prior run of this same approved plan counts: after a re-approval
    # every command runs again.
    if prior and prior.get("approved_hash") == approved_hash and isinstance(prior.get("commands"), list):
        for entry in prior["commands"]:
            if (
                isinstance(entry, dict)
                and entry.get("status") == "done"
                and entry.get("exit_code") == 0
                and isinstance(entry.get("command"), str)
            ):
                prior_done[entry["command"]] = entry

    # Double hash gate: the server refused pre-dispatch already; a plan edited
    # between dispatch and exec still runs zero commands here.
    if plan_hash_of(plan_artifact or "") != approved_hash:
        state = {
            "run_id": run_id,
            "item_id": item_id,
            "status": "hash_mismatch",
            "started_at": _now_iso(),
            "ended_at": _now_iso(),
            "budget_s": budget_s,
            "approved_hash": approved_hash,
            "commands": [
                {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for c in commands
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        }
        save_state(state_path, state)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact("the run plan changed since it was approved — zero commands run\n", secrets))
            log.flush()
        return state["summary"]

    # HZ-440: a Resume of the same plan after a pass runs the rest of the
    # commands on the commit the earlier ones ran on.
    refresh = task_clone and (not prior_done or (prior or {}).get("status") == "cwd_refused")

    # HZ-415: checked on every start, never cached. Fails closed: no command
    # runs, and nothing falls back to this runner's own cwd. Commands a prior
    # run passed stay recorded so a later Resume still skips them.
    try:
        if refresh:
            # The clone itself must pass the HZ-415 guard before git runs in it.
            run_plan.resolve_cwd(repo_dir, ".", forbid=str(HORIZON_ROOT))
            task_clone_mod.fast_forward(repo_dir)
        cwd = run_plan.resolve_cwd(repo_dir, plan_cwd, forbid=str(HORIZON_ROOT))
        # HZ-416: a container run ignores the host venv — its binaries do not
        # run in the image — so there is nothing to resolve or refuse here.
        venv = None if runner == "container" else run_plan.resolve_venv(repo_dir, venv_dir, forbid=str(HORIZON_ROOT))
    except run_plan.CwdRefused as exc:
        refusal = str(exc).splitlines()[0] if str(exc) else "cwd refused"
        state = {
            "run_id": run_id,
            "item_id": item_id,
            "status": "cwd_refused",
            "refusal": refusal,
            "started_at": _now_iso(),
            "ended_at": _now_iso(),
            "budget_s": budget_s,
            "approved_hash": approved_hash,
            "commands": [
                dict(prior_done[c])
                if c in prior_done
                else {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for c in commands
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        }
        save_state(state_path, state)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact(f"Execute refused: {refusal} — zero commands run\n", secrets))
            log.flush()
        nudge()
        return state["summary"]

    # HZ-416: fail closed before the first log line or command — a missing
    # Podman or pinned image ends the job here, never as a silent host run.
    if runner == "container":
        if not container_runner.podman_available():
            container_refusal = "podman is not installed"
        elif not container_image:
            container_refusal = "this repo has no pinned container image"
        elif not container_runner.image_present(container_image):
            container_refusal = f"the container image is not available: {container_image}"
        else:
            container_refusal = None
        if container_refusal:
            state = {
                "run_id": run_id,
                "item_id": item_id,
                "status": "container_unavailable",
                "refusal": container_refusal,
                "started_at": _now_iso(),
                "ended_at": _now_iso(),
                "budget_s": budget_s,
                "approved_hash": approved_hash,
                "commands": [
                    dict(prior_done[c])
                    if c in prior_done
                    else {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                    for c in commands
                ],
                "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
            }
            save_state(state_path, state)
            with log_path.open("a", encoding="utf-8") as log:
                log.write(redact(f"Execute refused: {container_refusal} — zero commands run\n", secrets))
                log.flush()
            nudge()
            return state["summary"]

    # Fresh run truncates the log; a resume appends to it.
    fresh = prior is None or prior.get("status") in (None, "hash_mismatch")
    if fresh:
        log_path.write_text("", encoding="utf-8")
    # HZ-434: where this start's output begins in the append-only log, in
    # bytes. farmd forwards only log[log_offset:], so Verify never judges an
    # earlier attempt's output; the log itself stays whole on disk.
    try:
        log_offset = log_path.stat().st_size
    except OSError:
        log_offset = 0
    # HZ-431: only the venv path or `system` — never PATH or another value.
    # HZ-416: a container run ignores the host venv, so it always names
    # `system` here, then the image its commands ran in.
    with log_path.open("a", encoding="utf-8") as log:
        log.write(redact(f"env: {venv or 'system'}\n", secrets))
        if runner == "container":
            log.write(redact(f"container: {container_image}\n", secrets))
        if task_clone:
            log.write(redact(f"task clone HEAD: {task_clone_mod.head(repo_dir)}\n", secrets))
    # State entries, preserving passed commands across resumes.
    entries: list[dict] = []
    for c in commands:
        if c in prior_done:
            # HZ-434: passed in an earlier attempt and skipped in this one.
            entries.append({**prior_done[c], "resumed": True})
        else:
            entries.append(
                {"command": c, "cwd": cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
            )
    state = {
        "run_id": run_id,
        "item_id": item_id,
        "status": "running",
        "started_at": _now_iso(),
        "ended_at": None,
        "budget_s": budget_s,
        "approved_hash": approved_hash,
        "runner": runner,
        "log_offset": log_offset,
        "commands": entries,
    }
    save_state(state_path, state)
    nudge()

    child = _child_env(env_values or {}, venv)
    job_start = time.monotonic()
    failing: list[str] = []
    passed = 0
    attempted = 0

    def log_line(line: str) -> None:
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact(line if line.endswith("\n") else line + "\n", secrets))
            log.flush()

    for entry in entries:
        if entry["status"] == "done" and entry.get("exit_code") == 0:
            attempted += 1
            passed += 1
            continue
        elapsed = time.monotonic() - job_start
        remaining = budget_s - elapsed
        if remaining <= 0:
            state["status"] = "budget_exceeded"
            state["ended_at"] = _now_iso()
            state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
            save_state(state_path, state)
            log_line(f"budget exceeded after {elapsed:.1f}s of {budget_s}s — job stopped\n")
            nudge()
            return state["summary"]
        entry["status"] = "running"
        entry["started_at"] = _now_iso()
        save_state(state_path, state)
        log_line(f"$ {entry['command']} (cwd={cwd})\n")
        nudge()
        cmd_start = time.monotonic()
        try:
            proc = subprocess.Popen(
                ["sh", "-c", entry["command"]],
                cwd=cwd,
                env=child,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
        except Exception as exc:
            entry["status"] = "done"
            entry["ended_at"] = _now_iso()
            entry["exit_code"] = 127
            attempted += 1
            failing.append(entry["command"])
            save_state(state_path, state)
            log_line(f"could not start command: {type(exc).__name__}\n")
            nudge()
            break
        # HZ-407: farmd's Stop kills this process group, which outlives the
        # runner's own tmux session (start_new_session).
        entry["pgid"] = proc.pid
        save_state(state_path, state)
        lines: queue.Queue = queue.Queue()
        reader = threading.Thread(target=_read_lines, args=(proc.stdout, lines), daemon=True)
        reader.start()
        deadline = time.monotonic() + remaining
        eof = False
        unsent = False
        over_budget = False
        while not eof:
            if time.monotonic() >= deadline:
                over_budget = True
                break
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                line = ""
            if line is None:
                eof = True
            elif line:
                log_line(line)
                unsent = True
            if unsent:
                before = last_nudge[0]
                nudge(force=False)
                unsent = last_nudge[0] == before
        if not over_budget:
            # Output closed; the command itself may still be running.
            try:
                proc.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                over_budget = True
        if over_budget:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            reader.join(timeout=5)
            while True:
                try:
                    line = lines.get_nowait()
                except queue.Empty:
                    break
                if line:
                    log_line(line)
            # Cut off mid-command: stopped, never done. Resume re-runs it.
            entry.pop("pgid", None)
            entry["status"] = "stopped"
            entry["ended_at"] = _now_iso()
            entry["exit_code"] = None
            state["status"] = "budget_exceeded"
            state["ended_at"] = _now_iso()
            state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
            save_state(state_path, state)
            log_line(f"budget exceeded after {budget_s}s — job stopped\n")
            nudge()
            return state["summary"]
        entry.pop("pgid", None)
        entry["status"] = "done"
        entry["ended_at"] = _now_iso()
        entry["exit_code"] = proc.returncode
        attempted += 1
        save_state(state_path, state)
        log_line(f"exit {proc.returncode} in {time.monotonic() - cmd_start:.1f}s\n")
        nudge()
        if proc.returncode == 0:
            passed += 1
        else:
            failing.append(entry["command"])
            break

    # HZ-434: the plan's own report files, read here while the job's secrets
    # are still in hand for redact(). Also after a failed command: a partial
    # report is still evidence. Reading them never keeps the job from ending.
    try:
        state["reports"] = job_reports.collect_reports(
            commands, block.get("reports", []), cwd, secrets, forbid=str(HORIZON_ROOT)
        )
    except Exception as exc:
        state["reports"] = [{"path": "(reports)", "status": "refused", "bytes": 0, "text": f"could not be read ({type(exc).__name__})"}]
    state["status"] = "finished"
    state["ended_at"] = _now_iso()
    state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
    save_state(state_path, state)
    nudge()
    return state["summary"]


def _read_env_file(path: str | None) -> tuple[dict, dict]:
    """(env, redact): the commands' env values, and the host credentials
    that are only masked in the log."""
    if not path:
        return {}, {}
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return {}, {}
    if not isinstance(data, dict):
        return {}, {}

    def _strings(section) -> dict:
        return {str(k): v for k, v in section.items() if isinstance(v, str)} if isinstance(section, dict) else {}

    return _strings(data.get("env")), _strings(data.get("redact"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="farm.task_job")
    parser.add_argument("--task", required=True, help="claimed job task file (queue/jobs/active/<run>.json)")
    args = parser.parse_args(argv)
    try:
        task = json.loads(Path(args.task).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"task_job: cannot read task file: {exc}", flush=True)
        return 2
    run_id = task.get("run_id")
    item_id = (task.get("item") or {}).get("id") or ""
    artifact = task.get("plan_artifact") or ""
    approved_hash = task.get("approved_hash") or ""
    # HZ-415: a task file written before this field existed has none, and is
    # refused at start.
    repo_dir = task.get("repo_dir")
    # Imported here so unit tests can import this module without a FARM_HOME.
    from farm.config import LOGS_DIR, STATE_DIR

    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{str(item_id).lower()}.log"
    env_file = task.get("env_file")
    secrets, redact_only = _read_env_file(env_file)
    try:
        if env_file:
            Path(env_file).unlink(missing_ok=True)
    except OSError:
        pass
    try:
        summary = run_job(
            run_id=run_id,
            item_id=item_id,
            plan_artifact=artifact,
            approved_hash=approved_hash,
            state_path=state_path,
            log_path=log_path,
            repo_dir=repo_dir,
            venv_dir=task.get("venv_dir"),
            env_values=secrets,
            redact_values=redact_only,
            notify=lambda: _notify_progress(run_id),
            task_clone=bool(task.get("task_clone")),
        )
    except ValueError as exc:
        print(f"task_job: invalid run plan: {exc}", flush=True)
        return 2
    print(f"task_job: run {run_id} finished: {summary}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
