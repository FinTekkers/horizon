"""A Task's Execute commands inside a throwaway rootless Podman container (HZ-416).

One container per job run: `podman run -d ... sleep infinity` once, then one
`podman exec` per command, so an install or a /tmp file from command 1 is
still there for command 2 — the same sequential semantics as a host run.
The container is killed and removed when the run ends (finished, failed,
over budget or stopped); Resume always starts a fresh one. farmd's Stop and
its boot-time reaper remove a container a killed runner left behind.

Mounts, and nothing else is writable (`--read-only` image filesystem):
- the repo's checkout, read-only, at its own host path — so the plan's
  resolved `cwd` (HZ-415) is the workdir unchanged;
- a throwaway scratch dir at /scratch and a throwaway dir at /tmp (also
  $HOME), wiped when the run ends — so nothing the run makes there survives;
- the job's own state dir at /state and its own log dir at /logs — never the
  farm's whole state or log dir, and never the runner's own state file;
- an unreadable empty file over each `.env` in the checkout, so the secrets
  farmd reads from it reach a command only when the plan declares them.

Guardrails, asserted by farm/tests/test_container_runner.py: no
--privileged, no --cap-add, no Podman socket mount, no --env-file, host
networking only (--network=host, because services listen on 127.0.0.1), and
`--userns=keep-id --user <uid>:<gid>` so files land owned by the farm user.
Secrets ride in the podman client's environment via `--env NAME` on
`podman run`, never in argv, so `ps` shows no value.

FARM_PODMAN_BIN overrides the podman binary (tests point it at
farm/tests/fake_podman). Missing Podman or an image that cannot be pulled is
reported, never worked around: task_job ends the job `container_unavailable`
with zero commands run.
"""

import os
import shutil
import subprocess

from .config import farm_home

SCRATCH_MOUNT = "/scratch"
STATE_MOUNT = "/state"
LOGS_MOUNT = "/logs"
TMP_MOUNT = "/tmp"

# Used when the deploy target sets no limit.
DEFAULT_CPUS = "1"
DEFAULT_MEMORY = "1g"

# One name per item, the same as its runner's tmux session (farm-job-<item>),
# so the reaper spares exactly the containers whose runner is still alive.
NAME_PREFIX = "farm-job-"

# Every job container carries `horizon.farm-home=<FARM_HOME>`, and the reaper
# lists only its own farm's: another farm on the same host (a test farmd, a
# second checkout) shares the user's rootless Podman, and its farm-job-*
# containers are never this farm's orphans.
OWNER_LABEL_KEY = "horizon.farm-home"

# What the podman client itself needs from the farm's env (rootless Podman
# finds its runtime dir through XDG_RUNTIME_DIR). None of it reaches the
# container: only `--env NAME` does.
CLIENT_ENV_KEYS = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR", "XDG_RUNTIME_DIR")

# Exit status of a process ended by SIGKILL — what the kernel's OOM killer
# sends — as `podman exec` reports it.
SIGKILL_EXIT = 137


class Unavailable(Exception):
    """Podman, the image or the container itself cannot be had. The message
    is the job's refusal, shown to the owner as is."""


def podman_bin() -> str:
    """The podman binary — FARM_PODMAN_BIN in tests, `podman` on the host."""
    return os.environ.get("FARM_PODMAN_BIN", "podman")


def container_name(item_id: str) -> str:
    return f"{NAME_PREFIX}{str(item_id).lower()}"


def owner_label() -> str:
    """This farm's `key=value` label — FARM_HOME read at call time, so the
    runner and farmd agree on it whatever imported first."""
    return f"{OWNER_LABEL_KEY}={farm_home()}"


def client_env(env_values: dict) -> dict:
    """The podman client's env: its own few keys plus the plan's resolved
    values, which `--env NAME` hands on to the container by name."""
    env = {k: v for k, v in os.environ.items() if k in CLIENT_ENV_KEYS}
    env.setdefault("PATH", "/usr/bin:/bin")
    for k, v in (env_values or {}).items():
        if isinstance(v, str):
            env[str(k)] = v
    return env


def _podman(*args, timeout: float = 60, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [podman_bin(), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=env,
    )


def _first_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[0][:200] if lines else ""


def available() -> bool:
    """Whether the podman binary resolves at all."""
    return shutil.which(podman_bin()) is not None


def ensure_image(image: str, timeout_s: int = 600) -> None:
    """Pulls the pinned image unless it is already present. Runs in the job's
    own runner (its own tmux session), so a slow pull holds up only this job.
    Raises Unavailable with the reason; never falls back."""
    if not available():
        raise Unavailable("podman is not installed")
    if not image:
        raise Unavailable("this repo has no pinned container image")
    try:
        if _podman("image", "exists", image).returncode == 0:
            return
        pulled = _podman("pull", "--quiet", image, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        raise Unavailable(f"the container image could not be pulled in {timeout_s}s: {image}") from None
    except OSError as exc:
        raise Unavailable(f"podman could not run ({type(exc).__name__})") from None
    if pulled.returncode != 0:
        detail = _first_line(pulled.stderr)
        raise Unavailable(f"the container image could not be pulled: {image}" + (f" ({detail})" if detail else ""))


def build_run_argv(
    *,
    image: str,
    name: str,
    repo_dir: str,
    workdir: str,
    scratch_dir: str,
    tmp_dir: str,
    state_dir: str,
    logs_dir: str,
    env_names: list,
    cpus: str | None = None,
    memory: str | None = None,
) -> list:
    """The `podman run -d` argv that starts the job's container. `env_names`
    are passed as `--env NAME`: Podman inherits each value from its own
    environment, so no value ever appears in argv. HOME is the throwaway
    /tmp, so a `$HOME` write lands there and vanishes with the run."""
    argv = [
        podman_bin(),
        "run",
        "-d",
        "--name",
        name,
        "--label",
        owner_label(),
        "--network=host",
        "--userns=keep-id",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--read-only",
        "--read-only-tmpfs=false",
        "--cpus",
        cpus or DEFAULT_CPUS,
        "--memory",
        memory or DEFAULT_MEMORY,
        # No swap on top: the limit is the limit, so going past it is an
        # OOM kill rather than a slow crawl.
        "--memory-swap",
        memory or DEFAULT_MEMORY,
        "-v",
        f"{repo_dir}:{repo_dir}:ro",
        "-v",
        f"{scratch_dir}:{SCRATCH_MOUNT}:rw",
        "-v",
        f"{tmp_dir}:{TMP_MOUNT}:rw",
        "-v",
        f"{state_dir}:{STATE_MOUNT}:rw",
        "-v",
        f"{logs_dir}:{LOGS_MOUNT}:rw",
        "--env",
        f"HOME={TMP_MOUNT}",
        "-w",
        workdir,
    ]
    # farmd reads job secrets from <cwd>/.env, and the checkout is mounted
    # whole: hide each .env behind an unreadable empty file, so a command can
    # only see the env the plan declared.
    env_files = checkout_env_files(repo_dir)
    if env_files:
        mask = env_mask_file(scratch_dir)
        for env_file in env_files:
            argv += ["-v", f"{mask}:{env_file}:ro"]
    for env_name in env_names or []:
        argv += ["--env", str(env_name)]
    argv += [image, "sleep", "infinity"]
    return argv


# Not walked for .env files: nothing farmd reads lives there, and they can
# be huge.
_ENV_WALK_SKIP = {".git", "node_modules"}


def checkout_env_files(repo_dir: str) -> list:
    """Every `.env` in the checkout, as the real path a read of it reaches —
    a symlinked .env is masked at its target, and one whose target is outside
    the checkout is unreadable inside anyway (nothing else is mounted)."""
    root = os.path.realpath(repo_dir)
    found = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _ENV_WALK_SKIP]
        if ".env" not in filenames:
            continue
        target = os.path.realpath(os.path.join(dirpath, ".env"))
        if os.path.isfile(target) and os.path.commonpath([root, target]) == root:
            found.add(target)
    return sorted(found)


def env_mask_file(scratch_dir: str) -> str:
    """An empty mode-000 file in the job's dir, beside (never inside) the
    mounted dirs. Bound read-only over a .env, it makes `cat .env` fail with
    Permission denied: the farm user has no capability to override it, and
    the read-only bind stops a chmod. A Resume reuses the one already there."""
    mask = os.path.join(os.path.dirname(os.path.normpath(scratch_dir)), "env-mask")
    try:
        if os.path.lexists(mask) and (not os.path.isfile(mask) or os.path.islink(mask) or os.path.getsize(mask)):
            os.unlink(mask)
        if not os.path.lexists(mask):
            os.close(os.open(mask, os.O_RDONLY | os.O_CREAT | os.O_EXCL, 0o000))
        os.chmod(mask, 0o000)
    except OSError as exc:
        raise Unavailable(f"the checkout's .env could not be hidden ({type(exc).__name__})") from None
    return mask


def start_container(argv: list, env: dict) -> None:
    """Runs the `podman run -d` argv. Raises Unavailable when the container
    does not come up (a bad limit, a broken image, no cgroup delegation)."""
    try:
        # cwd "/": the container's conmon inherits it and drops an `oom` file
        # there after an OOM kill — never in the runner's cwd or a checkout.
        started = subprocess.run(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120, env=env, cwd="/"
        )
    except subprocess.TimeoutExpired:
        raise Unavailable("the container did not start in 120s") from None
    except OSError as exc:
        raise Unavailable(f"podman could not run ({type(exc).__name__})") from None
    if started.returncode != 0:
        detail = _first_line(started.stderr)
        raise Unavailable("the container did not start" + (f": {detail}" if detail else ""))


def exec_argv(name: str, command: str, workdir: str, shell: str = "sh") -> list:
    """One command in the job's container, as `<shell> -c`, in the plan's cwd."""
    return [podman_bin(), "exec", "-w", workdir, name, shell, "-c", command]


def container_shell(name: str) -> str:
    """HZ-496: `bash` when the running container's image has it, else `sh`.
    A probe that cannot run says `sh` — every image has that."""
    try:
        res = _podman("exec", name, "sh", "-c", "command -v bash", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return "sh"
    return "bash" if res.returncode == 0 else "sh"


def oom_kills(name: str) -> int | None:
    """The container cgroup's `oom_kill` count (cgroup v2 memory.events),
    or None when it cannot be read. A `podman exec`'d process killed by the
    OOM killer leaves pid 1 alive, so State.OOMKilled never says so — this
    counter does."""
    try:
        res = _podman("exec", name, "cat", "/sys/fs/cgroup/memory.events", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    for line in res.stdout.splitlines():
        key, _, value = line.partition(" ")
        if key == "oom_kill" and value.strip().isdigit():
            return int(value.strip())
    return None


def stop_and_remove(name: str) -> None:
    """Kills the named container and removes it. Never raises — Stop must not
    fail because the container is already gone. Rootless `conmon` outlives a
    killed podman client, so this, not the client's process group, is what
    ends the container."""
    for args in (["kill", name], ["rm", "-f", name]):
        try:
            _podman(*args, timeout=30)
        except OSError:
            return
        except subprocess.SubprocessError:
            continue


def list_job_containers() -> list:
    """Names of this farm's farm-job-* containers, running or not (`podman
    ps -a`) — only those labelled with its own FARM_HOME."""
    try:
        res = _podman("ps", "-a", "--filter", f"label={owner_label()}", "--format", "{{.Names}}", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if res.returncode != 0:
        return []
    return [n for n in res.stdout.split() if n.startswith(NAME_PREFIX)]


def reap_orphans(alive) -> list:
    """Removes each of this farm's farm-job-* containers whose name `alive(name)` says has
    no live runner — what a SIGKILLed runner or a reboot left behind. A
    container whose runner is still up (HZ-408: farmd restarted mid-job) is
    spared. Returns the names removed."""
    reaped = []
    for name in list_job_containers():
        if alive(name):
            continue
        stop_and_remove(name)
        reaped.append(name)
    return reaped
