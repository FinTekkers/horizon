"""A Task's Execute commands inside a throwaway rootless Podman container (HZ-416).

One `podman run --rm` per command, never reused: Stop kills the one running
now, Resume starts new ones remounting the same state dir, and a reboot
leaves nothing behind. The repo's checkout is mounted read-only at /repo
(the plan's `cwd` selects the workdir under it); a writable scratch dir, the
job's state dir and the log dir are the only writable mounts. The container's
/tmp is a read-only empty dir, so a stray write fails instead of vanishing —
the one exception is a `--report /tmp/<name>` file, which is bind-mounted
from scratch before the run (see task_job). Secrets ride in the podman
client's environment via `--env NAME`, never in argv, so `ps` shows no value.

Guardrails, asserted by farm/tests/test_container_runner.py: no
--privileged, no --cap-add, no Podman socket mount, no --env-file, host
networking only (--network=host, because services listen on 127.0.0.1).
`venv_dir` is ignored here on purpose: a host virtualenv's binaries do not
run in the image — the image's own interpreter is used.

HORIZON_PODMAN_BIN overrides the podman binary (tests point it at
farm/tests/fake_podman.py). Missing Podman or a missing image is reported,
never worked around: task_job ends the job `container_unavailable` with zero
commands run.
"""

import os
import queue
import shutil
import subprocess
import threading
import time

# Fixed paths inside the container. The repo lives at /repo (read-only); the
# plan's `cwd` names the workdir under it, so `-w /repo/<cwd>`.
REPO_MOUNT = "/repo"
SCRATCH_MOUNT = "/scratch"
STATE_MOUNT = "/state"
LOGS_MOUNT = "/logs"
# Read-only on purpose: a write outside scratch/state/logs fails, it never
# silently vanishes with the container. `--report /tmp/<name>` files are the
# exception — see task_job, which bind-mounts each one from scratch.
TMP_MOUNT = "/tmp"

# Used when the deploy target sets no limit.
DEFAULT_CPUS = "2"
DEFAULT_MEMORY = "4g"


def podman_bin() -> str:
    """The podman binary — HORIZON_PODMAN_BIN in tests, `podman` on the host."""
    return os.environ.get("HORIZON_PODMAN_BIN", "podman")


def container_name(item_id: str) -> str:
    """The container's --name: one per item, so Stop finds the run that is up
    now without tracking per-command state."""
    return f"horizon-job-{str(item_id).lower()}"


def _container_workdir(plan_cwd: str) -> str:
    cwd = (plan_cwd or ".").strip() or "."
    return REPO_MOUNT if cwd == "." else f"{REPO_MOUNT}/{cwd}"


def build_command(
    *,
    image: str,
    item_id: str,
    repo_dir: str,
    plan_cwd: str,
    scratch_dir: str,
    state_dir: str,
    log_dir: str,
    env_names: list,
    cpu: str | None = None,
    memory: str | None = None,
    report_mounts: list | None = None,
    empty_tmp_dir: str | None = None,
) -> list:
    """The `podman run` argv for one command (the caller appends
    ["sh", "-c", command]). `env_names` are passed as `--env NAME` — Podman
    inherits each value from its own environment, so no value ever appears in
    argv. `report_mounts` are (host_file, container_path) pairs for
    `--report /tmp/<name>` files; `empty_tmp_dir` is the read-only /tmp."""
    name = container_name(item_id)
    uid, gid = os.getuid(), os.getgid()
    argv = [
        podman_bin(),
        "run",
        "--rm",
        "--name",
        name,
        "--network=host",
        "--userns=keep-id",
        "--user",
        f"{uid}:{gid}",
        "--cpus",
        cpu or DEFAULT_CPUS,
        "--memory",
        memory or DEFAULT_MEMORY,
        "-v",
        f"{repo_dir}:{REPO_MOUNT}:ro",
        "-v",
        f"{scratch_dir}:{SCRATCH_MOUNT}:rw",
        "-v",
        f"{state_dir}:{STATE_MOUNT}:rw",
        "-v",
        f"{log_dir}:{LOGS_MOUNT}:rw",
    ]
    if empty_tmp_dir:
        argv += ["-v", f"{empty_tmp_dir}:{TMP_MOUNT}:ro"]
    for host_file, container_path in report_mounts or []:
        argv += ["-v", f"{host_file}:{container_path}:rw"]
    argv += ["-w", _container_workdir(plan_cwd)]
    for env_name in env_names or []:
        argv += ["--env", str(env_name)]
    argv += [image]
    return argv


def podman_available() -> bool:
    """Whether the podman binary resolves at all."""
    return shutil.which(podman_bin()) is not None


def image_present(image: str) -> bool:
    """Whether the pinned image is already pulled. A missing binary reads as
    absent too — the caller names which one in its refusal."""
    if not image:
        return False
    try:
        return (
            subprocess.run(
                [podman_bin(), "image", "exists", image],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        )
    except OSError:
        return False


def _read_lines(stream, lines: "queue.Queue") -> None:
    """Reader thread: every output line, then None at EOF."""
    try:
        for line in stream:
            lines.put(line)
    except (OSError, ValueError):
        pass
    lines.put(None)


def run_in_container(
    base_argv: list,
    command: str,
    *,
    name: str,
    env: dict,
    log_line,
    deadline: float,
) -> tuple:
    """Runs one command in a throwaway container. Streams each output line to
    `log_line` while time.monotonic() stays under `deadline`. Returns
    (exit_code, timed_out): timed_out means the budget ran out mid-command —
    the container was killed and removed — and exit_code is then None. A
    command the container actually ran to completion reports its own exit
    code, including a kill by Stop (non-zero). Never raises for a container
    failure; a spawn failure raises OSError like Popen does."""
    proc = subprocess.Popen(
        [*base_argv, "sh", "-c", command],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines: queue.Queue = queue.Queue()
    reader = threading.Thread(target=_read_lines, args=(proc.stdout, lines), daemon=True)
    reader.start()
    eof = False
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
    if not over_budget:
        # Output closed; the command itself may still be running.
        try:
            proc.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            over_budget = True
    if over_budget:
        stop_and_remove(name)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
        reader.join(timeout=5)
        while True:
            try:
                line = lines.get_nowait()
            except queue.Empty:
                break
            if line:
                log_line(line)
        return None, True
    return proc.returncode, False


def stop_and_remove(name: str) -> None:
    """Kills the named container and removes it. Never raises — Stop must not
    fail because the container already exited on its own."""
    for argv in (["kill", name], ["rm", "-f", name]):
        try:
            subprocess.run(
                [podman_bin(), *argv],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except OSError:
            return
        except subprocess.SubprocessError:
            continue
