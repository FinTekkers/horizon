"""A Task's Execute commands inside a throwaway rootless Podman container (HZ-416).

One `podman run --rm` per command, never reused: Stop kills the one running
now, Resume starts new ones remounting the same state dir, and a reboot
leaves nothing behind. The repo's checkout is mounted read-only at /repo
(the plan's `cwd` selects the workdir under it, so `-w /repo/<cwd>`); a
writable scratch dir, the job's state dir and the log dir are the only
writable mounts. The image's own filesystem is mounted read-only with no
tmpfs, and /tmp is a read-only dir from scratch, so a stray write fails
instead of vanishing — the one exception is a `--report /tmp/<name>` file,
pre-created in that dir and bind-mounted writable (see task_job). Secrets
ride in the podman client's environment via `--env NAME`, never in argv, so
`ps` shows no value.

Guardrails, asserted by farm/tests/test_container_runner.py: no
--privileged, no --cap-add, no Podman socket mount, no --env-file, host
networking only (--network=host, because services listen on 127.0.0.1).
`venv_dir` is ignored here on purpose: a host virtualenv's binaries do not
run in the image — the image's own interpreter is used.

HORIZON_PODMAN_BIN overrides the podman binary (tests point it at
farm/tests/fake_podman). Missing Podman or a missing image is reported,
never worked around: task_job ends the job `container_unavailable` with zero
commands run.
"""

import os
import shutil
import subprocess

# Fixed paths inside the container.
REPO_MOUNT = "/repo"
SCRATCH_MOUNT = "/scratch"
STATE_MOUNT = "/state"
LOGS_MOUNT = "/logs"
TMP_MOUNT = "/tmp"

# Used when the deploy target sets no limit.
DEFAULT_CPUS = "2"
DEFAULT_MEMORY = "4g"

# What the podman client itself needs from the farm's env (rootless Podman
# finds its runtime dir through XDG_RUNTIME_DIR). None of it reaches the
# container: only `--env NAME` does.
CLIENT_ENV_KEYS = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR", "XDG_RUNTIME_DIR")


def podman_bin() -> str:
    """The podman binary — HORIZON_PODMAN_BIN in tests, `podman` on the host."""
    return os.environ.get("HORIZON_PODMAN_BIN", "podman")


def container_name(item_id: str) -> str:
    """The container's --name: one per item, so Stop finds the run that is up
    now without tracking per-command state."""
    return f"horizon-job-{str(item_id).lower()}"


def container_workdir(plan_cwd: str) -> str:
    cwd = (plan_cwd or ".").strip().strip("/") or "."
    return REPO_MOUNT if cwd == "." else f"{REPO_MOUNT}/{cwd}"


def client_env(env_values: dict) -> dict:
    """The podman client's env: its own few keys plus the plan's resolved
    values, which `--env NAME` hands on to the container by name."""
    env = {k: v for k, v in os.environ.items() if k in CLIENT_ENV_KEYS}
    env.setdefault("PATH", "/usr/bin:/bin")
    for k, v in (env_values or {}).items():
        if isinstance(v, str):
            env[str(k)] = v
    return env


def build_command(
    *,
    image: str,
    item_id: str,
    repo_dir: str,
    plan_cwd: str,
    scratch_dir: str,
    tmp_dir: str,
    state_dir: str,
    log_dir: str,
    env_names: list,
    cpu: str | None = None,
    memory: str | None = None,
    report_files: list | None = None,
) -> list:
    """The `podman run` argv for one command (the caller appends
    ["sh", "-c", command]). `env_names` are passed as `--env NAME` — Podman
    inherits each value from its own environment, so no value ever appears in
    argv. `tmp_dir` is the host dir shown read-only at /tmp; `report_files`
    are names already created in it, each bind-mounted writable at
    /tmp/<name>."""
    argv = [
        podman_bin(),
        "run",
        "--rm",
        "--name",
        container_name(item_id),
        "--network=host",
        "--userns=keep-id",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--read-only",
        "--read-only-tmpfs=false",
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
        "-v",
        f"{tmp_dir}:{TMP_MOUNT}:ro",
    ]
    for name in report_files or []:
        argv += ["-v", f"{os.path.join(tmp_dir, name)}:{TMP_MOUNT}/{name}:rw"]
    argv += ["-w", container_workdir(plan_cwd)]
    for env_name in env_names or []:
        argv += ["--env", str(env_name)]
    argv += [image]
    return argv


def podman_available() -> bool:
    """Whether the podman binary resolves at all."""
    return shutil.which(podman_bin()) is not None


def image_present(image: str) -> bool:
    """Whether the pinned image is already pulled. Never pulls: a missing
    image fails the job closed instead of fetching at run time."""
    if not image:
        return False
    try:
        return (
            subprocess.run(
                [podman_bin(), "image", "exists", image],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def stop_and_remove(name: str) -> None:
    """Kills the named container and removes it. Never raises — Stop must not
    fail because the container already exited on its own. Rootless `conmon`
    can outlive a killed podman client, so this, not the client's process
    group, is what ends the container."""
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
