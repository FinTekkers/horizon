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
import contextlib
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
from pathlib import Path

from domain.py import run_plan
from farm import container_runner, db_changes, job_media, job_reports, run_reaper
from farm import job_start as job_start_checks
from farm import task_clone as task_clone_mod
from farm.checks import redact

# HZ-415: Horizon's own checkout, the same rule farmd.py uses. A Task's
# commands never run inside it.
HORIZON_ROOT = Path(__file__).resolve().parent.parent

# HZ-491: where a job's commands may run. The server sends one with every
# job (store.js currentRunPlan); this module applies no default of its own.
# HO-837: declared once in farm/job_start.py, which Preflight shares.
RUNNERS = job_start_checks.RUNNERS


def plan_hash_of(artifact_md: str) -> str:
    """sha256 hex of the whole Run plan artifact, byte-identical to
    server/src/store.js planHashOf(). The hash covers the artifact, not just
    the block, so any re-run counts as a new plan."""
    return hashlib.sha256((artifact_md or "").encode("utf8")).hexdigest()


def command_hash_of(command: str) -> str:
    """HO-843: sha256 hex of one command's UTF-8 text, byte-identical to
    server/src/store.js commandHashesOf(). Approve the run stores one per
    command; Execute runs nothing unless every command's hash is approved."""
    return hashlib.sha256((command or "").encode("utf8")).hexdigest()


def frame_hash_of(block: dict) -> str:
    """HO-843: sha256 of every block key but `commands`, as sorted-key JSON —
    the cwd, env, requires, runner field and the rest the commands ran
    under. Farm-side only: stored in the job state and compared on the next
    start, so a passed command is never carried across a changed frame."""
    frame = {key: value for key, value in block.items() if key != "commands"}
    return hashlib.sha256(json.dumps(frame, sort_keys=True, separators=(",", ":")).encode("utf8")).hexdigest()


def _command_hashes_approved(commands: list, approved: list | None) -> bool:
    """HO-843: the second hash check's per-command half. True when the
    server sent no per-command hashes (an approval from before them — the
    whole-artifact hash still binds every command), else only when there is
    exactly one approved hash per command and each equals that command's. A
    null (unapproved) entry never matches."""
    if approved is None:
        return True
    if not isinstance(approved, list) or len(approved) != len(commands):
        return False
    return all(isinstance(h, str) and h == command_hash_of(c) for c, h in zip(commands, approved))


def _passed(entry) -> bool:
    return isinstance(entry, dict) and entry.get("status") == "done" and entry.get("exit_code") == 0 and isinstance(entry.get("command"), str)


def _carried_commands(
    prior: dict | None,
    commands: list,
    *,
    approved_hash: str,
    approved_command_hashes: list | None,
    carry_through: int | None,
    frame_hash: str,
    runner: str | None,
    clone_head,
) -> tuple[dict[int, dict], str | None]:
    """The commands a start may skip as already passed, by index, and why:
    ("same", ...) for a Resume of the same approved plan — today's rule,
    each passed command at the same position — or ("command", ...) after a
    per-command re-approval (HO-843).

    A per-command carry needs the server's `carry_through` k (sent only
    after a per-command approval) and the approved per-command hashes; the
    prior run's frame hash and runner equal to this start's; and, for a task
    clone, its HEAD unmoved (`clone_head`, a callable, is read only then).
    It carries entry i < k only while entry i passed, ran exactly
    commands[i], and its stored hash equals both this command's hash and
    the approved one — position and hash, never text alone. It stops at the
    first entry that fails, so nothing at or after the patched command, nor
    after any gap, is skipped. A state from before the hashes carries none."""
    if not prior or not isinstance(prior.get("commands"), list):
        return {}, None
    entries = prior["commands"]
    if prior.get("approved_hash") == approved_hash:
        same = {i: entries[i] for i in range(min(len(entries), len(commands))) if _passed(entries[i]) and entries[i]["command"] == commands[i]}
        return same, ("same" if same else None)
    if not isinstance(carry_through, int) or isinstance(carry_through, bool) or carry_through < 1:
        return {}, None
    if not isinstance(approved_command_hashes, list) or len(approved_command_hashes) != len(commands):
        return {}, None
    if prior.get("frame_hash") != frame_hash or prior.get("runner") != runner:
        return {}, None
    if clone_head is not None:
        head = clone_head()
        if not head or head == "unknown" or prior.get("clone_head") != head:
            return {}, None
    carried: dict[int, dict] = {}
    for i in range(min(carry_through, len(commands), len(entries))):
        entry = entries[i]
        current = command_hash_of(commands[i])
        if not (_passed(entry) and entry["command"] == commands[i] and entry.get("hash") == current == approved_command_hashes[i]):
            break
        carried[i] = entry
    return carried, ("command" if carried else None)


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
        os.chmod(tmp, 0o640 if _in_tenant_results(path) else 0o644)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _in_tenant_results(path: Path) -> bool:
    """HZ-772: a tenant job's state file, under config.TENANT_JOBS_DIR, is
    0640 — readable by the farm user's group only."""
    from farm import config

    return Path(path).parent.parent == Path(config.TENANT_JOBS_DIR)


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


def container_dirs(state_path: Path, log_path: Path) -> dict:
    """HZ-416: the host dirs a container job mounts. `state` and `logs` are
    the job's own (never the farm's whole state or log dir, and never this
    runner's own state file or log) and persist across Stop, Resume and a
    farmd restart; `scratch` and `tmp` (/tmp and $HOME inside) are
    throwaway — wiped on every start and again when the run ends."""
    job_dir = Path(state_path).with_suffix(".d")
    return {
        "state": job_dir / "state",
        "scratch": job_dir / "scratch",
        "tmp": job_dir / "tmp",
        "logs": Path(log_path).with_suffix(".d"),
    }


THROWAWAY_DIRS = ("scratch", "tmp")


def wipe_throwaway(state_path: Path, log_path: Path) -> None:
    """Removes the run's scratch and /tmp dirs — after a run of any outcome,
    and from farmd's Stop when the runner was killed first."""
    dirs = container_dirs(state_path, log_path)
    for key in THROWAWAY_DIRS:
        shutil.rmtree(dirs[key], ignore_errors=True)


def _oom_reason(memory_limit: str | None) -> str:
    return f"killed: out of memory — over the container's {memory_limit or container_runner.DEFAULT_MEMORY} memory limit"


def run_job(**kwargs) -> dict:
    """Runs the approved plan's commands in order (see _run_job). HZ-416: a
    container run's container is killed and removed, and its scratch and
    /tmp dirs wiped, however _run_job ends — the reports were read first.
    HZ-738: a task clone's run holds clone_lock shared throughout, so a
    read-only step never fast-forwards the clone under it."""
    started: list = []
    # HZ-569: a host command's processes carry this run's tag, so the ones
    # that leave its process group (a test's servers, its browsers) are
    # reaped when the job ends, and swept by farmd when Stop kills the runner.
    run_tag: dict[str, str] = {}
    with run_reaper.run_scope(
        run_tag, item_id=kwargs.get("item_id"), caller="job", worktree=kwargs.get("repo_dir"), prefix="job"
    ), contextlib.ExitStack() as stack:
        if kwargs.get("task_clone"):
            _hold_clone_lock(stack, kwargs.get("repo_dir"))
        try:
            return _run_job(started=started, run_tag=run_tag, **kwargs)
        finally:
            if started:
                container_runner.stop_and_remove(started[0])
                wipe_throwaway(kwargs["state_path"], kwargs["log_path"])


# HO-838: the job's prerequisite re-check cap. farmd's dispatch re-check ran
# moments earlier under the same cap.
PREREQ_RECHECK_S = 25


def _prereq_recheck(task: dict, approved_hash: str) -> list[dict]:
    """HO-838: the Preflight checks (farm/preflight.py, the one engine) on
    the approved plan, as this runner is about to run it — the unmet items,
    [] when every check holds. Read-only; takes no lock of its own. Fails
    closed: an error or a malformed result is an unmet `probe`, never a pass.
    The env names and uid are the ones farmd stamped at launch. HO-838: the
    plan hash was already checked by the double hash gate just before, so a
    `plan` unmet is dropped here — the hash_mismatch path owns it."""
    from farm import preflight

    # What farmd stamps at launch, filled from this runner when absent (a
    # task file farmd did not stamp, or a tenant run user farmd could not
    # resolve): this process is the one about to run the commands, so its
    # uid is Execute's, and it runs only because farmd's job lane launched it
    # with job runs on. Env names are not filled: an unstamped task's env is
    # checked as the engine always has (farm/run_plan_requires.py).
    own = {"job_uid": os.geteuid(), "jobs_enabled": True}
    checked = {**task, **{key: value for key, value in own.items() if task.get(key) is None}, "plan_hash": approved_hash}
    try:
        result = preflight.run(checked, deadline=time.monotonic() + PREREQ_RECHECK_S, cap_s=PREREQ_RECHECK_S)
    except Exception as exc:  # noqa: BLE001 — fail closed, never a pass
        return [{"kind": "probe", "name": "prerequisite re-check", "reason": f"failed ({type(exc).__name__})"}]
    raw = result.get("unmet") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        return [{"kind": "probe", "name": "prerequisite re-check", "reason": "no result"}]
    # A malformed entry is an unmet `probe`, never dropped.
    unmet = [
        item if isinstance(item, dict) else {"kind": "probe", "name": "prerequisite re-check", "reason": "malformed result"}
        for item in raw
        if not (isinstance(item, dict) and item.get("kind") == "plan")
    ]
    if unmet:
        return unmet
    # Only plan gaps: the hash gate owns those. Otherwise a pass must say so.
    if raw or result.get("passed") is True:
        return []
    return [{"kind": "probe", "name": "prerequisite re-check", "reason": "no result"}]


def _hold_clone_lock(stack: contextlib.ExitStack, repo_dir: str | None) -> None:
    """HZ-738: Execute's shared clone_lock, released when `stack` closes. A
    clone that fails the HZ-415 guard is never written to, not even the lock
    file; that clone, or one whose lock cannot open, runs without it, and
    _run_job's own refusal reports it exactly as before."""
    try:
        run_plan.resolve_cwd(repo_dir, ".", forbid=str(HORIZON_ROOT))
        stack.enter_context(task_clone_mod.clone_lock(repo_dir, shared=True))
    except run_plan.CwdRefused:
        return


def _run_job(
    *,
    started: list,
    run_tag: dict | None = None,
    run_id,
    item_id: str,
    plan_artifact: str,
    approved_hash: str,
    runner: str | None,
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
    first_line: str | None = None,
    media_roots: tuple = (),
    prereq_task: dict | None = None,
    approved_command_hashes: list | None = None,
    carry_through: int | None = None,
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

    HZ-416/HZ-491: `runner` selects where the commands run — `container` or
    `host`, the effective runner the server approved and sent with the job.
    The plan block's own `runner` is not read here, and there is no default:
    any other value raises ValueError with zero commands run. The container path
    (farm/container_runner.py) pulls `container_image` if needed, starts one
    container for this run and `podman exec`s each command in it: the
    checkout read-only at its own path with the resolved cwd as workdir, a
    fresh scratch dir and /tmp plus the job's own state and log dirs
    writable, host networking, only the plan's env, and the target's CPU
    and memory limits. Its name is appended to `started` so run_job tears it
    down. `venv_dir` is ignored there — a host virtualenv's binaries do not
    run in the image; the log names `system`. Missing Podman, no pinned or
    pullable image, or a container that will not start ends the job
    `container_unavailable` with zero commands run — never a host run. A
    command the OOM killer ended fails with `failure_reason` naming the
    memory limit.

    HZ-772: `first_line`, when given, is logged (redacted) at the head of each
    start's output, before the env line — a tenant job's `running as` line.

    HZ-815: `media_roots`, config.MEDIA_OUTPUT_ROOTS for a farm host run, are
    the dirs besides the checkout a plan's `outputs` may be copied from.

    HO-838: `prereq_task` is the job's task file as farmd stamped it. main()
    always passes it, so every start re-runs the Preflight checks
    (_prereq_recheck) once the clone is fast-forwarded and the cwd resolved,
    before the container or any command. A check that fails, raises or runs
    out of time ends the job `prereq_refused`, zero commands run. A direct
    call with no task (a unit test of the run itself) has nothing to check.

    HO-843: `approved_command_hashes`, when the server sends them, are the
    approved hash of each command: the second hash check runs zero commands
    unless every command's hash matches. `carry_through` k, sent only after a
    per-command re-approval of command k, lets a start skip the passed
    commands before k (_carried_commands) and run from k. Each state entry
    records its command's `hash`; the state records the plan's frame hash,
    the runner and, for a task clone, its HEAD. A hash_mismatch rewrites the
    state with every command pending, so it carries nothing afterwards —
    that loses the passed prefix, and fails safe."""
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
    # HZ-491: the server's effective runner, required — never a default here.
    refusal = job_start_checks.runner_refusal(runner)
    if refusal:
        raise ValueError(refusal)

    prior = load_state(state_path)
    frame_hash = frame_hash_of(block)

    # Double hash gate: the server refused pre-dispatch already; a plan edited
    # between dispatch and exec still runs zero commands here. HO-843: so does
    # any command whose hash is not approved.
    if plan_hash_of(plan_artifact or "") != approved_hash or not _command_hashes_approved(commands, approved_command_hashes):
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

    # Resume: keep passed commands done, retry everything else. Only a prior
    # run of this same approved plan counts — after a re-approval every
    # command runs again — except after a per-command re-approval (HO-843).
    # The task clone must pass the HZ-415 guard before git reads its HEAD.
    def clone_head():
        try:
            run_plan.resolve_cwd(repo_dir, ".", forbid=str(HORIZON_ROOT))
        except run_plan.CwdRefused:
            return None
        return task_clone_mod.head(repo_dir)

    prior_done, carry = _carried_commands(
        prior,
        commands,
        approved_hash=approved_hash,
        approved_command_hashes=approved_command_hashes,
        carry_through=carry_through,
        frame_hash=frame_hash,
        runner=runner,
        clone_head=clone_head if task_clone else None,
    )
    if carry == "command":
        # HO-843: and only in the same resolved cwd the passed commands ran in.
        try:
            carried_cwd, _ = job_start_checks.resolve_dirs(repo_dir, plan_cwd, runner=runner, venv_dir=venv_dir, forbid=str(HORIZON_ROOT))
        except run_plan.CwdRefused:
            carried_cwd = None
        if any(entry.get("cwd") != carried_cwd for entry in prior_done.values()):
            prior_done, carry = {}, None

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
        # HZ-416: a container run ignores the host venv — its binaries do not
        # run in the image — so there is nothing to resolve or refuse here.
        # HO-837: the same check Preflight makes before Approve the run.
        cwd, venv = job_start_checks.resolve_dirs(repo_dir, plan_cwd, runner=runner, venv_dir=venv_dir, forbid=str(HORIZON_ROOT))
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
                dict(prior_done[i])
                if i in prior_done
                else {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for i, c in enumerate(commands)
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        }
        save_state(state_path, state)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact(f"Execute refused: {refusal} — zero commands run\n", secrets))
            log.flush()
        nudge()
        return state["summary"]

    # HO-838: the host may have drifted since approval. Checked after the
    # fast-forward, so a path the new commit adds is there, and before the
    # container starts (so no image is pulled) or any command runs.
    unmet = _prereq_recheck(prereq_task, approved_hash) if prereq_task is not None else []
    if unmet:
        from farm import preflight

        refusal = preflight.drift_text(unmet)
        state = {
            "run_id": run_id,
            "item_id": item_id,
            "status": "prereq_refused",
            "refusal": refusal.splitlines()[0],
            "unmet": unmet,
            "started_at": _now_iso(),
            "ended_at": _now_iso(),
            "budget_s": budget_s,
            "approved_hash": approved_hash,
            "commands": [
                dict(prior_done[i])
                if i in prior_done
                else {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                for i, c in enumerate(commands)
            ],
            "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
        }
        save_state(state_path, state)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(redact(f"Execute refused: {refusal}\nzero commands run\n", secrets))
            log.flush()
        nudge()
        return state["summary"]

    # HZ-416: fail closed before the first log line or command — no Podman,
    # no image or no container ends the job here, never as a silent host run.
    name = container_runner.container_name(item_id)
    # HZ-496: host runs are always bash; a container's is probed once it is up.
    shell = "bash"
    if runner == "container":
        try:
            container_runner.ensure_image(container_image)
            dirs = container_dirs(state_path, log_path)
            for key, path in dirs.items():
                if key in THROWAWAY_DIRS:
                    shutil.rmtree(path, ignore_errors=True)
                path.mkdir(parents=True, exist_ok=True)
            # A container a killed runner left behind would hold the name.
            container_runner.stop_and_remove(name)
            started.append(name)
            container_runner.start_container(
                container_runner.build_run_argv(
                    image=container_image,
                    name=name,
                    repo_dir=os.path.realpath(repo_dir),
                    workdir=cwd,
                    scratch_dir=str(dirs["scratch"]),
                    tmp_dir=str(dirs["tmp"]),
                    state_dir=str(dirs["state"]),
                    logs_dir=str(dirs["logs"]),
                    # The plan's declared names, as farmd resolved them.
                    env_names=sorted(env_values or {}),
                    cpus=cpu_limit,
                    memory=memory_limit,
                ),
                # The podman client gets the plan's values, the container
                # only their names.
                container_runner.client_env(env_values or {}),
            )
            shell = container_runner.container_shell(name)
        except container_runner.Unavailable as exc:
            state = {
                "run_id": run_id,
                "item_id": item_id,
                "status": "container_unavailable",
                "refusal": str(exc),
                "started_at": _now_iso(),
                "ended_at": _now_iso(),
                "budget_s": budget_s,
                "approved_hash": approved_hash,
                "commands": [
                    dict(prior_done[i])
                    if i in prior_done
                    else {"command": c, "cwd": plan_cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None}
                    for i, c in enumerate(commands)
                ],
                "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
            }
            save_state(state_path, state)
            with log_path.open("a", encoding="utf-8") as log:
                log.write(redact(f"Execute refused: {exc} — zero commands run\n", secrets))
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
        if first_line:
            log.write(redact(f"{first_line}\n", secrets))
        log.write(redact(f"env: {venv or 'system'}\n", secrets))
        if runner == "container":
            log.write(redact(f"container: {container_image}\n", secrets))
            # HZ-496: bash is the default; only the fallback is named.
            if shell != "bash":
                log.write(redact(f"shell: {shell}\n", secrets))
        head = task_clone_mod.head(repo_dir) if task_clone else None
        if task_clone:
            log.write(redact(f"task clone HEAD: {head}\n", secrets))
        if carry == "command":
            log.write(redact(f"resumed after a per-command approval: {len(prior_done)} passed command(s) kept, running from command {len(prior_done) + 1}\n", secrets))
    # State entries, preserving passed commands across resumes. HO-843: each
    # records its command's hash, so a later per-command carry can check it.
    entries: list[dict] = []
    for i, c in enumerate(commands):
        if i in prior_done:
            # HZ-434: passed in an earlier attempt and skipped in this one.
            entries.append({**prior_done[i], "hash": command_hash_of(c), "resumed": True})
        else:
            entries.append(
                {"command": c, "cwd": cwd, "status": "pending", "started_at": None, "ended_at": None, "exit_code": None, "hash": command_hash_of(c)}
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
        "frame_hash": frame_hash,
        "log_offset": log_offset,
        "commands": entries,
    }
    if task_clone:
        state["clone_head"] = head
    save_state(state_path, state)
    nudge()

    # HZ-814: the declared tables' counts before the first command, outside
    # the command budget. A Resume of the same approved plan keeps the first
    # attempt's: the run's changes are measured from before it began.
    db_block = block.get("db_changes")
    if db_block:
        # HO-843: a per-command carry keeps it too — the carried commands'
        # changes were counted from that first snapshot.
        if prior and (prior.get("approved_hash") == approved_hash or carry == "command") and isinstance(prior.get("db_before"), dict):
            state["db_before"] = prior["db_before"]
        else:
            _log_db_line(log_path, db_changes.counting_line(db_block["tables"], "before the run"), secrets)
            state["db_before"] = _db_snapshot(
                lambda: db_changes.snapshot(
                    _db_connection(db_block, env_values),
                    db_block["tables"],
                    deadline=time.monotonic() + db_changes.PHASE_CAP_S,
                ),
                db_block["tables"],
            )
        save_state(state_path, state)
        nudge()

    child = {**_child_env(env_values or {}, venv), **(run_tag or {})}
    if started:
        # HZ-416: `podman exec` needs only the client's own env — the
        # container got the plan's values when it started.
        child = container_runner.client_env({})
        # A fresh container has no OOM kill yet; compared after a failure.
        oom_seen = container_runner.oom_kills(name)
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
            _finish_db_changes(state, db_block, env_values, log_line)
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
                container_runner.exec_argv(name, entry["command"], cwd, shell) if started else ["bash", "-c", entry["command"]],
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
            if started:
                # HZ-416: the exec'd process outlives its killed client.
                container_runner.stop_and_remove(name)
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
            _finish_db_changes(state, db_block, env_values, log_line)
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
        if started and proc.returncode != 0:
            # HZ-416: the cgroup's oom_kill count rose, or (unreadable) the
            # command died of SIGKILL — the memory limit ended it.
            oom_now = container_runner.oom_kills(name)
            if (oom_now is not None and oom_seen is not None and oom_now > oom_seen) or (
                oom_now is None and proc.returncode == container_runner.SIGKILL_EXIT
            ):
                entry["failure_reason"] = _oom_reason(memory_limit)
            oom_seen = oom_now
        save_state(state_path, state)
        log_line(f"exit {proc.returncode} in {time.monotonic() - cmd_start:.1f}s\n")
        if entry.get("failure_reason"):
            log_line(entry["failure_reason"] + "\n")
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
            commands,
            block.get("reports", []),
            cwd,
            secrets,
            forbid=str(HORIZON_ROOT),
            tmp_root=str(container_dirs(state_path, log_path)["tmp"]) if started else None,
        )
    except Exception as exc:
        state["reports"] = [{"path": "(reports)", "status": "refused", "bytes": 0, "text": f"could not be read ({type(exc).__name__})"}]
    # HZ-815: the plan's declared media, copied into the item's store before
    # a container run's /tmp is wiped. A plan with none writes no `media`
    # key and touches no dir; collecting never keeps the job from ending.
    outputs = block.get("outputs") or []
    if outputs:
        state["media"] = _collect_media(
            outputs, cwd, repo_dir, state_path, item_id, secrets, media_roots, container_dirs(state_path, log_path)["tmp"] if started else None
        )
    _finish_db_changes(state, db_block, env_values, log_line)
    state["status"] = "finished"
    state["ended_at"] = _now_iso()
    state["summary"] = {"run": attempted, "passed": passed, "failed": len(failing), "failing": list(failing)}
    save_state(state_path, state)
    nudge()
    return state["summary"]


def _collect_media(outputs, cwd, repo_dir, state_path, item_id, secrets, media_roots, tmp_dir) -> list[dict]:
    """HZ-815: job_media.collect_media() for this run. Only a host run of the
    farm's own may read config.MEDIA_OUTPUT_ROOTS; a container or tenant run
    gets its checkout (and a container's own /tmp) only. Never raises."""
    tenant = _in_tenant_results(state_path)
    try:
        return job_media.collect_media(
            outputs,
            cwd,
            repo_dir,
            job_media.media_dir_for(state_path, item_id),
            secrets,
            forbid=str(HORIZON_ROOT),
            tmp_root=str(tmp_dir) if tmp_dir else None,
            extra_roots=() if tmp_dir or tenant else tuple(media_roots or ()),
            file_mode=0o640 if tenant else 0o644,
        )
    except Exception as exc:
        return [
            {
                "name": "outputs",
                "path": "(outputs)",
                "kind": None,
                "mime": None,
                "bytes": 0,
                "durationS": None,
                "width": None,
                "height": None,
                "status": job_media.REFUSED,
                "reason": f"could not be collected ({type(exc).__name__})",
            }
        ]


def _db_connection(db_block: dict, env_values: dict | None) -> str | None:
    """HZ-814: the connection's resolved value — the plan's `env` reference
    `$NAME`, resolved farm-side like every env value (job_env) and already in
    the secrets redact() masks. None when it did not resolve."""
    value = (env_values or {}).get(db_block["connection"][1:])
    return value if isinstance(value, str) and value else None


def _db_snapshot(take, tables: list[str]) -> dict:
    """A snapshot that cannot fail the run: anything it raises marks every
    table snapshot_error."""
    try:
        return take()
    except Exception:
        return db_changes.failed(tables, db_changes.SNAPSHOT_ERROR)


def _log_db_line(log_path: Path, line: str, secrets: dict) -> None:
    try:
        with Path(log_path).open("a", encoding="utf-8") as log:
            log.write(redact(f"{line}\n", secrets))
    except OSError:
        pass


def _finish_db_changes(state: dict, db_block: dict | None, env_values: dict | None, log_line, *, cap_s: float | None = None) -> None:
    """HZ-814: the after snapshot and the stored summary, `state["db_changes"]`,
    taken on every path where commands ran — before the terminal status is
    written, so farmd never forwards the run without it. `cap_s` caps the
    whole phase (db_changes.PHASE_CAP_S by default). Never raises, and never
    changes the run's status, summary or exit code; a plan with no
    `db_changes` block writes nothing."""
    if not db_block:
        return
    tables = db_block["tables"]
    try:
        if not isinstance(state.get("db_before"), dict):
            # Stopped before the first count finished: nothing to compare with.
            state["db_changes"] = db_changes.summarize(None, None, tables)
        else:
            log_line(db_changes.counting_line(tables, "after the run"))
            deadline = time.monotonic() + (db_changes.PHASE_CAP_S if cap_s is None else cap_s)
            after = _db_snapshot(lambda: db_changes.settled_after(_db_connection(db_block, env_values), tables, deadline=deadline), tables)
            state["db_changes"] = db_changes.summarize(state["db_before"], after, tables)
    except Exception:
        state["db_changes"] = db_changes.summarize(db_changes.failed(tables, db_changes.SNAPSHOT_ERROR), None, tables)
    try:
        log_line(db_changes.result_line(state["db_changes"]))
    except Exception:
        pass


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


def tenant_result_paths(results_dir, item_id: str) -> tuple[Path, Path]:
    """HZ-772: a tenant job's (state, log) in its project's results dir, named
    as the internal state file and log are."""
    return Path(results_dir) / f"{item_id}.json", Path(results_dir) / f"farm-job-{str(item_id).lower()}.log"


def running_as_line() -> str:
    """HZ-772: the user this runner runs as — a tenant log's first line."""
    uid = os.getuid()
    try:
        import pwd

        name = pwd.getpwuid(uid).pw_name
    except (KeyError, ImportError):
        name = "?"
    return f"running as {name} (uid {uid})"


def mark_stopped(state_path: Path, log_path: Path, run_id) -> None:
    """HZ-772: what farmd's _mark_job_stopped does for an internal job, done by
    a tenant runner itself — farmd cannot signal the run user's processes or
    write its state. The running command's process group is killed and it is
    recorded `stopped`, never `done`."""
    state = load_state(state_path)
    if not state or str(state.get("run_id")) != str(run_id):
        return
    now = _now_iso()
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
    if state.get("status") == "running":
        state["status"] = "stopped"
        state["ended_at"] = now
    # HZ-814: farmd waits only TENANT_STOP_WAIT_S for this, so a tenant Stop
    # takes no after snapshot: each declared table is snapshot_not_taken.
    if isinstance(state.get("db_before"), dict) and "db_changes" not in state:
        state["db_changes"] = db_changes.summarize(None, None, list(state["db_before"].get("tables") or {}))
    save_state(state_path, state)
    try:
        with Path(log_path).open("a", encoding="utf-8") as log:
            log.write("stopped by the owner\n")
    except OSError:
        pass


STOP_SIGNALS = (signal.SIGHUP, signal.SIGTERM)


def _stop_on_signal(state_path: Path, log_path: Path, run_id) -> dict:
    """HZ-772: farmd's Stop kills a tenant job's tmux session; sudo relays the
    SIGHUP (or a SIGTERM) to this runner, which records the stop itself and
    exits. Returns the handlers it replaced, for main() to put back."""

    def stop(signum, _frame):
        for sig in STOP_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        mark_stopped(state_path, log_path, run_id)
        raise SystemExit(128 + signum)

    return {sig: signal.signal(sig, stop) for sig in STOP_SIGNALS}


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
    from farm.config import LOGS_DIR, MEDIA_OUTPUT_ROOTS, STATE_DIR

    # HZ-772: a tenant job (run as its run user by farm.tenant_job) writes its
    # state and log to its project's results dir, which farmd reads.
    results_dir = task.get("results_dir")
    first_line = None
    replaced: dict = {}
    if results_dir:
        state_path, log_path = tenant_result_paths(results_dir, item_id)
        first_line = running_as_line()
        replaced = _stop_on_signal(state_path, log_path, run_id)
    else:
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
            runner=task.get("runner"),
            state_path=state_path,
            log_path=log_path,
            repo_dir=repo_dir,
            venv_dir=task.get("venv_dir"),
            env_values=secrets,
            redact_values=redact_only,
            notify=lambda: _notify_progress(run_id),
            task_clone=bool(task.get("task_clone")),
            container_image=task.get("container_image"),
            cpu_limit=task.get("cpu_limit"),
            memory_limit=task.get("memory_limit"),
            first_line=first_line,
            media_roots=() if results_dir else MEDIA_OUTPUT_ROOTS,
            # HO-838: every start re-checks the prerequisites.
            prereq_task=task,
            # HO-843: absent from a server before per-command approval.
            approved_command_hashes=task.get("approved_command_hashes"),
            carry_through=task.get("carry_through"),
        )
    except ValueError as exc:
        print(f"task_job: invalid run plan: {exc}", flush=True)
        return 2
    finally:
        for sig, handler in replaced.items():
            signal.signal(sig, handler)
    print(f"task_job: run {run_id} finished: {summary}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
