"""HZ-772: the run-user half of a tenant Task job.

    python -m farm.tenant_job --task <path>

infra/host/tenant-entry execs this as the project's run user, with exactly
the tenant session env (this project's token, HOME and FARM_HOME under the
run user's home) and the task it wrote 0600 under that FARM_HOME. It does as
the run user what farmd's launch_job does as the farm user for an internal
job, then hands over to farm.task_job in this same process:

  1. clones (or reuses) the run user's own task clone of the item's repo —
     the server's repo_dir names a farm-user path, so it is never used;
  2. resolves the plan's cwd and venv inside that clone;
  3. reads the project's own test-env file, as the run user;
  4. resolves the plan's env and the redact set (farm/job_env.py) — the
     host values it falls back to are this session's, so this project's own;
  5. writes them to a 0600 env file the runner unlinks at start.

Its state and log go to the task's results_dir, which farmd reads. Any
failure before the first command ends the job `cwd_refused` there, with a
reason that names fields only and zero commands run — never a fallback to
another checkout, env or user.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from domain.py import run_plan
from farm import config, job_env, login_env, task_job, workspaces


class Refused(Exception):
    """The job must not start. One line, field names only, safe to show."""


def _write_private(path: Path, data: dict) -> None:
    """Atomic 0600 write, in a 0700 dir."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.stem}.", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data))
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def prepare(task: dict) -> dict:
    """Points `task` at the run user's own clone and writes its 0600 env file
    under $FARM_HOME/jobs/. Returns the task as farm.task_job reads it.
    Raises Refused with nothing written to the env file."""
    try:
        block = run_plan.extract(task.get("plan_artifact") or "")
    except ValueError:
        raise Refused("the run plan block could not be read") from None
    if task.get("runner") != "host":
        raise Refused("tenant jobs run on the host runner only")
    repo = (task.get("item") or {}).get("repo")
    if not isinstance(repo, str) or not repo:
        raise Refused("the task names no item repo")
    try:
        clone = str(workspaces.ensure_tenant_task_clone(repo))
    except (RuntimeError, OSError):
        raise Refused("the run user's task clone could not be prepared") from None
    try:
        cwd = run_plan.resolve_cwd(clone, block["cwd"], forbid=str(task_job.HORIZON_ROOT))
        run_plan.resolve_venv(clone, None, forbid=str(task_job.HORIZON_ROOT))
    except run_plan.CwdRefused as exc:
        raise Refused(str(exc).splitlines()[0] if str(exc) else "cwd refused") from None
    login: dict[str, str] = {}
    test_env_file = task.get("test_env_file")
    if test_env_file:
        try:
            login_env.tenant_env_path(test_env_file, (task.get("project") or {}).get("id"))
            login = login_env.load_login_env(test_env_file, workspace=Path(clone))
        except login_env.LoginEnvError:
            raise Refused("tenant test_env_file could not be used") from None
    env_path = config.farm_home() / "jobs" / f"{task['run_id']}.env.json"
    _write_private(
        env_path,
        {
            "env": job_env.resolve_job_env(cwd, block.get("env", {}), login),
            "redact": job_env.job_redact_values(cwd, login),
        },
    )
    # A task clone the runner fast-forwards; its venv is <clone>/.venv.
    task.update(repo_dir=clone, task_clone=True, venv_dir=None, env_file=str(env_path))
    return task


def refuse(task: dict, reason: str) -> None:
    """Records the job `cwd_refused` in its results dir, as task_job does for
    a refused cwd: every command pending, zero run."""
    item_id = str((task.get("item") or {}).get("id") or "")
    state_path, log_path = task_job.tenant_result_paths(task["results_dir"], item_id)
    try:
        block = run_plan.extract(task.get("plan_artifact") or "")
        commands, plan_cwd, budget_s = list(block["commands"]), block["cwd"], int(block["budget_minutes"]) * 60
    except (ValueError, KeyError, TypeError):
        commands, plan_cwd, budget_s = [], None, 0
    now = task_job._now_iso()
    task_job.save_state(
        state_path,
        {
            "run_id": task.get("run_id"),
            "item_id": item_id,
            "status": "cwd_refused",
            "refusal": reason,
            "started_at": now,
            "ended_at": now,
            "budget_s": budget_s,
            "approved_hash": task.get("approved_hash") or "",
            "commands": [
                {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for c in commands
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        },
    )
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"{task_job.running_as_line()}\nExecute refused: {reason} — zero commands run\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="farm.tenant_job")
    parser.add_argument("--task", required=True)
    args = parser.parse_args(argv)
    task_path = Path(args.task)
    try:
        task = json.loads(task_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"tenant_job: cannot read task file ({type(exc).__name__})", flush=True)
        return 2
    if not isinstance(task, dict) or not task.get("results_dir") or not task.get("run_id"):
        print("tenant_job: refused: the task names no results_dir or run_id", flush=True)
        return 2
    try:
        prepared = prepare(task)
    except Refused as exc:
        print(f"tenant_job: refused: {exc}", flush=True)
        try:
            refuse(task, str(exc))
        except OSError as write_exc:
            print(f"tenant_job: could not record the refusal ({type(write_exc).__name__})", flush=True)
        task_job._notify_progress(task.get("run_id"))
        return 2
    _write_private(task_path, prepared)
    return task_job.main(["--task", str(task_path)])


if __name__ == "__main__":
    sys.exit(main())
