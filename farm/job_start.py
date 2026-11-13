"""HO-837: the read-only start-up checks Execute and the Preflight step share.

Execute's runners (farm/task_job.py, farm/tenant_job.py and farmd's
launch_job and /steps/run job route) refuse a job on these before its first
command; farm/preflight.py asks the same questions before Approve the run, so
the two cannot drift: one function per question, called from both places.

Every function here only reads. None creates a directory, clones, pulls,
fast-forwards or takes a lock. Each refusal is one line naming a field or a
path, never a value.
"""

from pathlib import Path

from domain.py import run_plan

from . import login_env

# HZ-491: where a job runs; the server sends one and the farm applies no default.
RUNNERS = ("host", "container")
# HZ-772: a tenant job runs as its run user, on the host only.
TENANT_HOST_ONLY = "tenant jobs run on the host runner only"


def runner_refusal(runner) -> str | None:
    """Why `runner` is no job runner, or None. Execute raises it as a
    ValueError; farmd's job route answers job_runner_missing."""
    if runner in RUNNERS:
        return None
    return f"job runner must be one of {', '.join(RUNNERS)}, got {runner!r}"


def tenant_runner_refusal(runner) -> str | None:
    """Why a tenant job cannot run on `runner`, or None."""
    return None if runner == "host" else TENANT_HOST_ONLY


def resolve_dirs(repo_dir, plan_cwd, *, runner: str, venv_dir, forbid: str) -> tuple[str, str | None]:
    """(cwd, venv) a job's commands run with: the plan's cwd inside the
    checkout (HZ-415) and, on the host, the repo's venv (HZ-431). A container
    run ignores the host venv (HZ-416), so nothing is resolved for it. Raises
    run_plan.CwdRefused (one line) — the cwd_refused refusal."""
    cwd = run_plan.resolve_cwd(repo_dir, plan_cwd, forbid=forbid)
    venv = None if runner == "container" else run_plan.resolve_venv(repo_dir, venv_dir, forbid=forbid)
    return cwd, venv


def tenant_login(test_env_file, project_id, workspace) -> dict[str, str]:
    """HZ-772: a tenant job's test-login values — the file must live under the
    project's own directory. {} when the repo sets none. Raises
    login_env.LoginEnvError (path and cause only)."""
    if not test_env_file:
        return {}
    login_env.tenant_env_path(test_env_file, project_id)
    return login_env.load_login_env(test_env_file, workspace=Path(workspace))
