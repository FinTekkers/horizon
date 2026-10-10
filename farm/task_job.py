"""Detached shell-command jobs for a Task's Execute step (HZ-378).

Execute never improvises: it runs exactly the commands in the approved Run
plan's fenced block (domain/py/run_plan.py), in order, with cwd set to the
plan's cwd. farmd launches this module in a farm-job-<item> tmux session (no
pipe-pane — this runner owns the only log); the runner writes a redacted log
and a JSON state file, and farmd polls the state file to report progress to
the server.

Secrets never ride in argv or task files: farmd resolves the repo's env files
plus the named values farm-side, writes them to a 0600 env file, and this
module reads and unlinks that file before the first command runs. Every log
line passes through checks.redact() before it is written anywhere.

Stop-or-continue (R16): the job stops on the first non-zero exit. Remaining
commands stay pending so Resume retries from the first unfinished one without
re-running a passed command.
"""

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from domain.py import run_plan
from farm.checks import redact


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


def _child_env(env_values: dict) -> dict:
    """Minimal base plus the job's secrets. The base is the small set a shell
    command needs (PATH, HOME, etc); everything else from the farm process
    stays out, so a `env` dump in the log cannot leak farm tuning."""
    base_keys = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR")
    env = {k: v for k, v in os.environ.items() if k in base_keys}
    env.setdefault("PATH", "/usr/bin:/bin")
    for k, v in (env_values or {}).items():
        if isinstance(v, str):
            env[str(k)] = v
    return env


def run_job(
    *,
    run_id,
    item_id: str,
    plan_artifact: str,
    approved_hash: str,
    state_path,
    log_path,
    env_values: dict | None = None,
) -> dict:
    """Runs the approved plan's commands in order. Returns the summary dict
    {run, passed, failed, failing}. Writes the state file and appends to the
    redacted log. Never raises for a command failure or budget breach — those
    are summary outcomes, not crashes. Raises ValueError only for an unreadable
    plan block (a dispatch bug, not a job outcome)."""
    secrets = dict(env_values or {})
    state_path = Path(state_path)
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    block = run_plan.extract(plan_artifact or "")
    cwd = block["cwd"]
    commands = list(block["commands"])
    budget_s = int(block["budget_minutes"]) * 60

    # Resume: keep passed commands done, retry everything else.
    prior = load_state(state_path)
    prior_done: dict[str, dict] = {}
    if prior and isinstance(prior.get("commands"), list):
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
                {"command": c, "cwd": cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for c in commands
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        }
        save_state(state_path, state)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact("the run plan changed since it was approved — zero commands run\n", secrets))
            log.flush()
        return state["summary"]

    # Fresh run truncates the log; a resume appends to it.
    fresh = prior is None or prior.get("status") in (None, "hash_mismatch")
    if fresh:
        log_path.write_text("", encoding="utf-8")
    # State entries, preserving passed commands across resumes.
    entries: list[dict] = []
    for c in commands:
        if c in prior_done:
            entries.append(dict(prior_done[c]))
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
        "commands": entries,
    }
    save_state(state_path, state)

    child = _child_env(secrets)
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
            return state["summary"]
        entry["status"] = "running"
        entry["started_at"] = _now_iso()
        save_state(state_path, state)
        log_line(f"$ {entry['command']} (cwd={cwd})\n")
        cmd_start = time.monotonic()
        try:
            proc = subprocess.Popen(
                ["sh", "-c", entry["command"]],
                cwd=cwd,
                env=child,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
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
            break
        try:
            out, _ = proc.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                out, _ = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                out = ""
            if out:
                for line in out.splitlines():
                    log_line(line + "\n")
            # The timed-out command stays retryable: Resume re-runs it.
            entry["status"] = "pending"
            entry["started_at"] = None
            entry["ended_at"] = None
            entry["exit_code"] = None
            state["status"] = "budget_exceeded"
            state["ended_at"] = _now_iso()
            state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
            save_state(state_path, state)
            log_line(f"budget exceeded after {budget_s}s — job stopped\n")
            return state["summary"]
        if out:
            for line in out.splitlines():
                log_line(line + "\n")
        entry["status"] = "done"
        entry["ended_at"] = _now_iso()
        entry["exit_code"] = proc.returncode
        attempted += 1
        save_state(state_path, state)
        log_line(f"exit {proc.returncode} in {time.monotonic() - cmd_start:.1f}s\n")
        if proc.returncode == 0:
            passed += 1
        else:
            failing.append(entry["command"])
            break

    state["status"] = "finished"
    state["ended_at"] = _now_iso()
    state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
    save_state(state_path, state)
    return state["summary"]


def _read_env_file(path: str | None) -> dict:
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


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
    # Imported here so unit tests can import this module without a FARM_HOME.
    from farm.config import LOGS_DIR, STATE_DIR

    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{str(item_id).lower()}.log"
    env_file = task.get("env_file")
    secrets = _read_env_file(env_file)
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
            env_values=secrets,
        )
    except ValueError as exc:
        print(f"task_job: invalid run plan: {exc}", flush=True)
        return 2
    print(f"task_job: run {run_id} finished: {summary}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
