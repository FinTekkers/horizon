"""HO-837: the Preflight step — a Task's run plan prerequisites, checked on
the real runner as the real run user, before Approve the run.

A code-run step (domain/steps.json `codeRun`): farm/step_agent.py runs run()
here instead of a model. The server stamps the plan it will show at the gate
(`plan_artifact`, `plan_hash`, `runner`), the checkout fields Execute gets,
whether a deploy of the repo's target is running (`deploy_running`) and each
deploy target's last-good tag (`service_tags`). farmd stamps Execute's env
names and uid, whether job runs are on (`jobs_enabled`) and whether the
target's deploy.lock is held (`deploy_lock_held`). A tenant Preflight runs
as the project's run user, like a tenant Execute.

Observe-only, by construction: nothing here writes a file, makes a directory,
takes a lock (a lock is read from /proc/locks), pulls an image, fast-forwards
or creates a clone, starts a deploy, or runs a plan command, `check` or
`version_cmd`. The only process it starts is run_plan_requires' fixed probe
script (and, for a container plan whose image is already here, the same
read-only throwaway probe container the Run plan check uses).

Every check Execute refuses on at start is asked here first, through the
same functions (farm/job_start.py): runner, jobs switch, tenant run user,
cwd and venv, login env, container. Execute keeps its own refusals as the
backstop.

Fail closed: the whole run has CAP_S. A check that raises, or the cap running
out, is an unmet `probe` item naming the check — never "not checked", never
a pass. An unmet item names a kind and a name (a tool, path, variable, file,
lock or service) and why; never a value, a file's content or an exception's
text (only its type, or an Unavailable's own one-line message).
"""

import os
import pwd
import threading
import time
from pathlib import Path

from domain.py import run_plan

from . import container_runner, credentials, job_env, job_start, login_env, run_plan_requires, task_job, workspaces

PREFLIGHT_LABEL = "Preflight"
# The guardrail's cap, and domain/steps.json's timeoutS for the step.
CAP_S = 90
# The longest reason or name the result carries (server/src/orchestrator.js
# sanitizePreflight keeps the same).
TEXT_MAX = 200


def _unmet(kind: str, name: str, reason: str) -> dict:
    return {"kind": kind, "name": str(name)[:TEXT_MAX], "reason": str(reason)[:TEXT_MAX]}


def _safe(exc: BaseException) -> str:
    """What an exception may say on the card: an Unavailable's or a
    CwdRefused's own one-line message (written to be shown), else only its
    type — an arbitrary exception's text could hold a value."""
    if isinstance(exc, (run_plan_requires.Unavailable, run_plan.CwdRefused)):
        return str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    return f"failed ({type(exc).__name__})"


def _run_user(task: dict) -> str:
    project = task.get("project")
    if credentials.is_tenant_project(project):
        return str(project.get("runUser") or "")
    uid = task.get("job_uid")
    try:
        return pwd.getpwuid(uid if isinstance(uid, int) else os.geteuid()).pw_name
    except KeyError:
        return str(uid)


def _deploy_busy(task: dict) -> str | None:
    """Why a deploy of this repo's target counts as running, or None: the
    server's deploy queue (or Horizon's own drain), else a held deploy.lock."""
    running = task.get("deploy_running")
    if isinstance(running, dict):
        target = running.get("target") or "the deploy target"
        status = running.get("status") or "running"
        tag = f" {running['tag']}" if running.get("tag") else ""
        return f"a deploy of {target}{tag} is {status}"
    if task.get("deploy_lock_held") is True:
        return "the target's deploy.lock is held by a running deploy"
    if task.get("deploy_state_key") and task.get("deploy_lock_held") is not False:
        return "the target's deploy.lock could not be read on the runner"
    return None


def _checks(task: dict, deadline: float, unmet: list, progress: dict) -> None:
    """The checks, in order, each appending its unmet items. One that raises
    is an unmet `probe` naming it. `progress["check"]` names the one running,
    for a timeout."""
    tenant = credentials.is_tenant_project(task.get("project"))
    runner = task.get("runner")
    state: dict = {}

    def step(name: str, fn) -> None:
        progress["check"] = name
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 — fail closed, never a pass
            unmet.append(_unmet("probe", name, _safe(exc)))

    def plan() -> None:
        artifact = task.get("plan_artifact") or ""
        try:
            state["block"] = run_plan.extract(artifact)
        except ValueError:
            unmet.append(_unmet("plan", "run plan", "the Run plan artifact carries no valid run-plan block"))
            return
        if not task.get("plan_hash") or task_job.plan_hash_of(artifact) != task.get("plan_hash"):
            unmet.append(_unmet("plan", "run plan", "the plan Preflight received is not the plan on record"))

    def runner_check() -> None:
        if job_start.runner_refusal(runner):
            unmet.append(_unmet("runner", str(runner or "none"), "the server named no job runner (host or container)"))

    def jobs() -> None:
        if task.get("jobs_enabled") is not True:
            reason = (
                "job runs are disabled on the farm (FARM_JOBS_ENABLED=0)"
                if task.get("jobs_enabled") is False
                else "the farm did not say whether job runs are enabled"
            )
            unmet.append(_unmet("jobs", "FARM_JOBS_ENABLED", reason))

    def run_user() -> None:
        name = _run_user(task) or "run_user"
        refusal = job_start.tenant_runner_refusal(runner)
        if refusal:
            unmet.append(_unmet("run_user", name, refusal))
        if not isinstance(task.get("job_uid"), int):
            unmet.append(_unmet("run_user", name, "the run user's account or session env could not be built"))
        repo = (task.get("item") or {}).get("repo")
        clone = workspaces.tenant_task_clone_path(repo) if isinstance(repo, str) and repo else None
        if clone is None or not (clone / ".git").is_dir():
            unmet.append(_unmet("run_user", name, "the run user's task clone does not exist yet"))
            return
        state["repo_dir"] = str(clone)

    def dirs() -> None:
        block = state.get("block")
        if block is None:
            return
        repo_dir = state.get("repo_dir") if tenant else task.get("repo_dir")
        if tenant and repo_dir is None:
            return
        try:
            cwd, _ = job_start.resolve_dirs(
                repo_dir,
                block["cwd"],
                runner="host" if tenant else runner,
                venv_dir=None if tenant else task.get("venv_dir"),
                forbid=str(task_job.HORIZON_ROOT),
            )
        except run_plan.CwdRefused as exc:
            unmet.append(_unmet("cwd", block["cwd"], _safe(exc)))
            return
        state["cwd"], state["repo_dir"] = cwd, repo_dir

    def login() -> None:
        if "cwd" not in state:
            return
        test_env_file = task.get("test_env_file")
        try:
            if tenant:
                job_start.tenant_login(test_env_file, (task.get("project") or {}).get("id"), state["repo_dir"])
            else:
                job_env.login_values(test_env_file, state["repo_dir"])
        except login_env.LoginEnvError as exc:
            # The path and the cause only; the values were never kept.
            unmet.append(_unmet("login_env", exc.path, exc.why))

    def container() -> None:
        if runner != "container":
            return
        image = task.get("container_image")
        if not image:
            unmet.append(_unmet("container", "image", "this repo has no pinned container image"))
        elif not container_runner.available():
            unmet.append(_unmet("container", "podman", "podman is not installed on the runner"))
        elif not container_runner.image_present(image):
            unmet.append(_unmet("container", image, "the image is not on the runner, and preflight never pulls it"))

    def deploy() -> None:
        busy = _deploy_busy(task)
        state["deploy_busy"] = busy
        if busy:
            running = task.get("deploy_running")
            name = running.get("target") if isinstance(running, dict) and running.get("target") else "deploy"
            unmet.append(_unmet("deploy", name, busy))

    def requires() -> None:
        if "cwd" not in state:
            return
        gaps = run_plan_requires.check_entries(
            state["block"],
            repo_dir=state["repo_dir"],
            venv_dir=None if tenant else task.get("venv_dir"),
            runner=runner,
            container_image=task.get("container_image"),
            forbid=str(task_job.HORIZON_ROOT),
            deadline=deadline,
            test_env_file=task.get("test_env_file"),
            job_env_names=task.get("job_env_names"),
            job_uid=task.get("job_uid") if isinstance(task.get("job_uid"), int) else None,
            strict=True,
            service_tags=task.get("service_tags") if isinstance(task.get("service_tags"), dict) else None,
            deploy_busy=state.get("deploy_busy"),
        )
        unmet.extend(_unmet(gap.kind, gap.name, gap.reason) for gap in gaps)

    step("plan", plan)
    step("runner", runner_check)
    step("jobs", jobs)
    if tenant:
        step("run_user", run_user)
    step("cwd", dirs)
    step("login_env", login)
    step("container", container)
    step("deploy", deploy)
    step("requires", requires)


def run(task: dict, *, deadline: float) -> dict:
    """The preflight result: {passed, runner, run_user, plan_hash, unmet:
    [{kind, name, reason}]}. `deadline` is time.monotonic()-based; when it
    passes, the checks still running are abandoned and the result is unmet
    `probe` "timed out". Never raises."""
    unmet: list[dict] = []
    progress = {"check": "preflight"}
    worker = threading.Thread(target=_checks, args=(task, deadline, unmet, progress), name="preflight", daemon=True)
    worker.start()
    worker.join(max(0.0, deadline - time.monotonic()))
    found = list(unmet)
    if worker.is_alive():
        found.append(_unmet("probe", progress["check"], f"timed out: preflight has {CAP_S}s"))
    return {
        "passed": not found,
        "runner": task.get("runner"),
        "run_user": _run_user(task),
        "plan_hash": task.get("plan_hash"),
        "unmet": found,
    }


def summary(result: dict) -> str:
    """One line for the step's output."""
    where = f"on {result.get('runner') or 'no runner'} as {result.get('run_user') or 'unknown'}"
    if result.get("passed"):
        return f"preflight passed {where}"
    count = len(result.get("unmet") or [])
    return f"preflight found {count} unmet prerequisite{'' if count == 1 else 's'} {where}"


def _cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def render(result: dict) -> str:
    """The step's artifact: the verdict and one row per unmet item."""
    lines = ["## Preflight", "", f"**{'passed' if result.get('passed') else 'unmet'}** — {summary(result)}"]
    unmet = result.get("unmet") or []
    if unmet:
        lines += ["", "| Kind | Name | Why |", "| --- | --- | --- |"]
        lines += [f"| {_cell(u['kind'])} | `{_cell(u['name'])}` | {_cell(u['reason'])} |" for u in unmet]
    return "\n".join(lines)


def deploy_lock_held(state_key) -> bool:
    """Whether the deploy target's ~/.horizon/<stateKey>/deploy.lock is held
    now — read from /proc/locks, never taken. farmd calls it, as the user the
    deploy scripts run as. A state key that is not a plain name reads False."""
    if not isinstance(state_key, str) or not state_key or "/" in state_key or state_key.startswith("."):
        return False
    from . import procfs

    return procfs.lock_held(str(Path.home() / ".horizon" / state_key / "deploy.lock"))
