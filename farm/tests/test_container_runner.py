"""HZ-416: a Task's Execute runs in a throwaway rootless Podman container.

Two tiers. Everything not marked `real_podman` runs everywhere, through
conftest's fake_podman (farm/tests/fake_podman): it proves the argv, the
lifecycle (one container per run, nothing left in `podman ps -a`), the
fail-closed refusals, the env hand-off, the OOM reason and the
`runner: host` opt-out. fake_podman confines nothing, so the confinement
itself (metric lines 1, 2 and 5) is proven by the `real_podman` tests, which
need `podman` on PATH and the image named by HORIZON_TEST_PODMAN_IMAGE
(pulled on first use). Without Podman they skip with the reason, and a skip
there is NOT a pass: infra/host/DEPLOY.md makes running them with zero skips
part of installing Podman on the farm host.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from domain.py import reasons, run_plan
from farm import container_runner, farmd, job_reports, task_job
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_PODMAN = str(Path(__file__).resolve().parent / "fake_podman")
FAKE_IMAGE = "localhost/horizon-task:fake"
REAL_PODMAN = shutil.which("podman")
REAL_IMAGE = os.environ.get("HORIZON_TEST_PODMAN_IMAGE", "docker.io/library/python:3.12-slim")
FIXTURES = json.loads((REPO_ROOT / "domain" / "fixtures" / "run-plan-cases.json").read_text())


def _artifact(commands, *, cwd=".", env=None, runner=None, reports=None, budget_minutes=1):
    block = {"cwd": cwd, "commands": list(commands), "budget_minutes": budget_minutes}
    if env is not None:
        block["env"] = env
    if runner is not None:
        block["runner"] = runner
    if reports is not None:
        block["reports"] = reports
    return "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def server_runner(artifact):
    """HZ-491: the effective runner the server sends with a job in a repo
    with a pinned image — the plan's own `runner`, else the container."""
    return run_plan.extract(artifact).get("runner") or "container"


def _run(tmp_path, artifact, *, repo, image=FAKE_IMAGE, env_values=None, cpu=None, memory=None, item_id="HZ-416", notify=None):
    state_path = tmp_path / "state" / f"{item_id}.json"
    log_path = tmp_path / "logs" / f"farm-job-{item_id.lower()}.log"
    state_path.parent.mkdir(exist_ok=True)
    log_path.parent.mkdir(exist_ok=True)
    summary = task_job.run_job(
        run_id=416,
        item_id=item_id,
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        runner=server_runner(artifact),
        state_path=state_path,
        log_path=log_path,
        repo_dir=str(repo),
        env_values=env_values or {},
        container_image=image,
        cpu_limit=cpu,
        memory_limit=memory,
        notify=notify,
    )
    return summary, json.loads(state_path.read_text()), log_path.read_text()


def _containers(podman=None):
    out = subprocess.run(
        [podman or os.environ["FARM_PODMAN_BIN"], "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    ).stdout
    return [name for name in out.split() if name.startswith(container_runner.NAME_PREFIX)]


def _wait_for(predicate, what, limit_s=20.0):
    deadline = time.time() + limit_s
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"gave up waiting for {what}")


def _files_under(root: Path) -> set:
    return {str(p.relative_to(root)) for p in root.rglob("*")}


@pytest.fixture
def repo(request, tmp_path):
    """The checkout. A real container mounts it at its own path, and its /tmp
    is the run's throwaway dir, so a checkout under the host's /tmp would
    make Podman create subuid-owned mount points inside that dir — real
    Podman tests keep it under $HOME instead, as /opt/... is on the farm."""
    if "real" not in request.fixturenames:
        path = tmp_path / "repo"
    else:
        cache = Path.home() / ".cache"
        cache.mkdir(exist_ok=True)
        path = Path(tempfile.mkdtemp(prefix="hz416-repo-", dir=cache)) / "repo"
        request.addfinalizer(lambda: shutil.rmtree(path.parent, ignore_errors=True))
    (path / "sub").mkdir(parents=True)
    (path / "README").write_text("checkout\n")
    return path


# ---- The contract: `runner` in the run plan block ----


@pytest.mark.parametrize("case", FIXTURES["runner"], ids=lambda c: c["case"])
def test_the_runner_field_matches_the_shared_fixture(case):
    if case["valid"]:
        block = run_plan.validate(case["block"])
        # HZ-491: the farm reads the block's own field and adds no default.
        assert block.get("runner") == case["runner"]
    else:
        with pytest.raises(ValueError, match="'runner'"):
            run_plan.validate(case["block"])


# ---- The argv: guardrails hold whatever the inputs ----


def _argv(**overrides):
    kwargs = dict(
        image="registry.example/py@sha256:" + "a" * 64,
        name="farm-job-hz-416",
        repo_dir="/srv/checkout",
        workdir="/srv/checkout/pipelines",
        scratch_dir="/state/HZ-416.d/scratch",
        tmp_dir="/state/HZ-416.d/tmp",
        state_dir="/state/HZ-416.d/state",
        logs_dir="/logs/farm-job-hz-416.d",
        env_names=["DATA_API_KEY"],
        cpus="1.5",
        memory="2g",
    )
    kwargs.update(overrides)
    return container_runner.build_run_argv(**kwargs)


def test_the_argv_never_escalates_and_mounts_only_what_it_should():
    """Guardrail 1: no --privileged, no capability, no socket, no env file;
    host networking, the farm user mapped to itself, a read-only image
    filesystem, the repo read-only at its own path with the plan's cwd as
    workdir, and only the job's own state and log dirs."""
    argv = _argv()
    joined = " ".join(argv)
    for banned in ("--privileged", "--cap-add", "podman.sock", "docker.sock", "--env-file", "--security-opt", "--device"):
        assert banned not in joined
    assert argv[:3] == [os.environ["FARM_PODMAN_BIN"], "run", "-d"]
    assert "--network=host" in argv
    assert "--userns=keep-id" in argv
    assert argv[argv.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"
    assert "--read-only" in argv and "--read-only-tmpfs=false" in argv
    assert argv[argv.index("--name") + 1] == "farm-job-hz-416"
    assert argv[argv.index("--cpus") + 1] == "1.5"
    assert argv[argv.index("--memory") + 1] == "2g"
    assert argv[argv.index("--memory-swap") + 1] == "2g"
    mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
    assert mounts == [
        "/srv/checkout:/srv/checkout:ro",
        "/state/HZ-416.d/scratch:/scratch:rw",
        "/state/HZ-416.d/tmp:/tmp:rw",
        "/state/HZ-416.d/state:/state:rw",
        "/logs/farm-job-hz-416.d:/logs:rw",
    ]
    assert argv[argv.index("-w") + 1] == "/srv/checkout/pipelines"
    assert argv[-3:] == ["registry.example/py@sha256:" + "a" * 64, "sleep", "infinity"]


def test_secrets_are_passed_by_name_never_by_value():
    """Guardrail 2: `--env NAME` only — Podman inherits the value from its
    own env. The one `=` is HOME, pointed at the throwaway /tmp."""
    argv = _argv(env_names=["DATA_API_KEY", "DATABASE_URL"])
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--env"] == ["HOME=/tmp", "DATA_API_KEY", "DATABASE_URL"]


def test_the_default_limits_apply_when_the_target_sets_none():
    argv = _argv(cpus=None, memory=None)
    assert argv[argv.index("--cpus") + 1] == container_runner.DEFAULT_CPUS
    assert argv[argv.index("--memory") + 1] == container_runner.DEFAULT_MEMORY


def test_each_checkout_env_file_is_masked_by_an_unreadable_empty_file(tmp_path, repo):
    """farmd reads job secrets from <cwd>/.env and the checkout is mounted
    whole, so every .env (a symlinked one at its target) is bound over with
    an empty mode-000 file from the job dir — never a mounted dir — while
    .git and node_modules are not walked."""
    (repo / ".env").write_text("A=1\n")
    (repo / "sub" / "real.env").write_text("B=2\n")
    (repo / "sub" / ".env").symlink_to("real.env")
    (repo / "node_modules" / "x").mkdir(parents=True)
    (repo / "node_modules" / "x" / ".env").write_text("C=3\n")
    job_dir = tmp_path / "state" / "HZ-416.d"
    (job_dir / "scratch").mkdir(parents=True)
    argv = _argv(repo_dir=str(repo), workdir=str(repo), scratch_dir=str(job_dir / "scratch"))
    mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
    mask = job_dir / "env-mask"
    assert mounts[5:] == [f"{mask}:{repo / '.env'}:ro", f"{mask}:{repo / 'sub' / 'real.env'}:ro"]
    assert mask.stat().st_size == 0 and (mask.stat().st_mode & 0o777) == 0
    # A Resume builds the argv again over the mask the first start left.
    assert _argv(repo_dir=str(repo), workdir=str(repo), scratch_dir=str(job_dir / "scratch")) == argv
    assert argv[-3:] == ["registry.example/py@sha256:" + "a" * 64, "sleep", "infinity"]


def test_a_checkout_without_env_files_gets_no_mask(tmp_path, repo):
    job_dir = tmp_path / "state" / "HZ-416.d"
    argv = _argv(repo_dir=str(repo), workdir=str(repo), scratch_dir=str(job_dir / "scratch"))
    assert len([a for a in argv if a == "-v"]) == 5
    assert not (job_dir / "env-mask").exists()


def test_each_command_is_a_podman_exec_in_the_plans_cwd():
    assert container_runner.exec_argv("farm-job-hz-416", "make test", "/srv/checkout/sub") == [
        os.environ["FARM_PODMAN_BIN"], "exec", "-w", "/srv/checkout/sub", "farm-job-hz-416", "sh", "-c", "make test",
    ]


# ---- Fail closed: never a silent host run ----


def _no_spawn(monkeypatch):
    """Lets podman's own probes (image exists, pull, run -d) through; a
    command — `podman exec` or a host shell — fails the test."""
    real_popen = subprocess.Popen

    def _guard(argv, *args, **kwargs):
        if "exec" in argv or argv[0] in ("sh", "bash"):
            raise AssertionError(f"no command may start when the container is unavailable: {argv}")
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", _guard)


@pytest.mark.parametrize(
    "case,refusal",
    [
        ("no podman", "podman is not installed"),
        ("no image pinned", "this repo has no pinned container image"),
        ("image cannot be pulled", "the container image could not be pulled: localhost/missing:1 (Error: initializing source"),
        ("bad cpu limit", "the container did not start: Error: invalid argument for --cpus or --memory"),
        ("bad memory limit", "the container did not start: Error: invalid argument for --cpus or --memory"),
    ],
)
def test_missing_podman_image_or_limits_run_zero_commands(tmp_path, repo, monkeypatch, case, refusal):
    """Guardrail 3: the job ends `container_unavailable` with every command
    pending and no command started — never on the host — and leaves no
    container behind."""
    image, cpu, memory = FAKE_IMAGE, None, None
    if case == "no podman":
        monkeypatch.setenv("FARM_PODMAN_BIN", str(tmp_path / "no-such-podman"))
    elif case == "no image pinned":
        image = None
    elif case == "image cannot be pulled":
        image = "localhost/missing:1"
    elif case == "bad cpu limit":
        cpu = "-2"
    else:
        memory = "lots"
    _no_spawn(monkeypatch)
    summary, state, log = _run(tmp_path, _artifact(["touch ran.txt"]), repo=repo, image=image, cpu=cpu, memory=memory)
    assert summary == {"run": 0, "passed": 0, "failed": 0, "failing": []}
    assert state["status"] == "container_unavailable"
    assert state["refusal"].startswith(refusal), state["refusal"]
    assert [c["status"] for c in state["commands"]] == ["pending"]
    assert f"Execute refused: {refusal}" in log and "zero commands run" in log
    assert not (repo / "ran.txt").exists()
    monkeypatch.undo()
    assert _containers() == []
    assert not (tmp_path / "state" / "HZ-416.d" / "scratch").exists()


def test_a_missing_image_is_pulled_at_execute_start(tmp_path, repo, monkeypatch):
    """Guardrail 4: the pull happens in the runner (its own tmux session),
    not in checkRunnable or farmd's dispatch."""
    calls = []
    real_run = subprocess.run

    def spy(argv, *args, **kwargs):
        calls.append(list(argv[1:3]))
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    summary, _state, _log = _run(tmp_path, _artifact(["true"]), repo=repo, image="localhost/pull-me:1")
    assert summary["passed"] == 1
    assert ["image", "exists"] in calls and ["pull", "--quiet"] in calls
    assert calls.index(["pull", "--quiet"]) < next(i for i, c in enumerate(calls) if c[0] == "run")


def test_farmd_dispatch_never_touches_podman(tmp_path, repo, monkeypatch):
    """Guardrail 4: launch_job writes the task and starts the runner's tmux
    session — no image check or pull there, so a slow pull holds up only
    its own runner and never the next job's dispatch."""
    monkeypatch.setattr(container_runner, "_podman", lambda *a, **k: (_ for _ in ()).throw(AssertionError("podman at dispatch")))
    monkeypatch.setattr(container_runner, "ensure_image", lambda *a, **k: (_ for _ in ()).throw(AssertionError("pull at dispatch")))
    launched = []
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, command, cwd: launched.append(name))
    run_id = 9418
    task = {
        "run_id": run_id,
        "item": {"id": "HZ-9418"},
        "plan_artifact": _artifact(["true"]),
        "runner": "container",
        "repo_dir": str(repo),
        "container_image": "localhost/pull-me:1",
    }
    try:
        assert farmd.launch_job(task) == "farm-job-hz-9418"
    finally:
        farmd.JOB_SESSIONS.pop(str(run_id), None)
        for suffix in (".json", ".env.json"):
            (QUEUE_DIR / "jobs" / "active" / f"{run_id}{suffix}").unlink(missing_ok=True)
    assert launched == ["farm-job-hz-9418"]


def test_a_slow_pull_never_blocks_a_second_job(tmp_path, repo, monkeypatch):
    """Guardrail 4: two runners at once — one stuck in a slow pull — and the
    other still runs its commands to the end meanwhile."""
    monkeypatch.setenv("FAKE_PODMAN_PULL_DELAY", "8")
    slow = threading.Thread(
        target=_run,
        args=(tmp_path / "a", _artifact(["true"])),
        kwargs={"repo": repo, "image": "localhost/pull-me:slow", "item_id": "HZ-SLOW"},
        daemon=True,
    )
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    started = time.monotonic()
    slow.start()
    try:
        summary, _state, _log = _run(tmp_path / "b", _artifact(["echo fast"]), repo=repo, item_id="HZ-FAST")
        assert summary["passed"] == 1
        assert time.monotonic() - started < 8, "the second job waited for the first one's pull"
        assert slow.is_alive()
    finally:
        slow.join(20)


def test_farmd_forwards_container_unavailable_with_its_reason(monkeypatch, tmp_path):
    run_id, item_id = 9416, "HZ-9416"
    active = QUEUE_DIR / "jobs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / f"{run_id}.json").write_text(json.dumps({"run_id": run_id, "item": {"id": item_id}}))
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "jobs" / f"{item_id}.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item_id": item_id,
                "status": "container_unavailable",
                "refusal": "podman is not installed",
                "commands": [{"command": "echo hi", "cwd": ".", "status": "pending", "exit_code": None}],
                "summary": {"run": 0, "passed": 0, "failed": 0, "failing": []},
            }
        )
    )
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    try:
        farmd._poll_jobs()
    finally:
        (active / f"{run_id}.json").unlink(missing_ok=True)
        (STATE_DIR / "jobs" / f"{item_id}.json").unlink(missing_ok=True)
    assert len(forwarded) == 1
    assert forwarded[0]["ok"] is False
    assert forwarded[0]["error"] == "Execute refused: podman is not installed"
    assert forwarded[0]["reason"] == reasons.REASON["JOB_CONTAINER_UNAVAILABLE"]


# ---- The container path, through fake_podman ----


def test_one_container_runs_every_command_and_leaves_nothing(tmp_path, repo):
    """Metric 2 (lifecycle leg): one container for the whole run — a file
    command 1 leaves in its cwd is there for command 2 — and success and
    failure both leave no container and wipe scratch and /tmp."""
    seen = []
    summary, state, log = _run(
        tmp_path,
        _artifact(["echo one > made.txt", "cat made.txt; rm made.txt", "pwd"], cwd="sub"),
        repo=repo,
        notify=lambda: seen.append(tuple(_containers())),
    )
    assert summary == {"run": 3, "passed": 3, "failed": 0, "failing": []}, log
    assert state["runner"] == "container"
    assert log.splitlines()[:2] == ["env: system", f"container: {FAKE_IMAGE}"]
    assert f"$ pwd (cwd={repo / 'sub'})" in log
    assert set(seen) <= {(), ("farm-job-hz-416",)} and ("farm-job-hz-416",) in seen
    assert _containers() == []
    job_dir = tmp_path / "state" / "HZ-416.d"
    assert not (job_dir / "scratch").exists() and not (job_dir / "tmp").exists()
    assert (job_dir / "state").is_dir() and (tmp_path / "logs" / "farm-job-hz-416.d").is_dir()

    summary, _state, _log = _run(tmp_path, _artifact(["exit 3"]), repo=repo)
    assert summary["failing"] == ["exit 3"]
    assert _containers() == []
    assert not (job_dir / "scratch").exists()


def test_a_host_venv_is_ignored_in_the_container(tmp_path, repo):
    """Contract case: a checkout's .venv — even one that would be refused —
    does not reach a container run; the log names `env: system` and the
    image."""
    outside = tmp_path / "elsewhere"
    (outside / "bin").mkdir(parents=True)
    (repo / ".venv").symlink_to(outside)
    summary, _state, log = _run(tmp_path, _artifact(['echo "VE=${VIRTUAL_ENV:--}"']), repo=repo)
    assert summary["passed"] == 1, log
    assert log.splitlines()[:2] == ["env: system", f"container: {FAKE_IMAGE}"]
    assert "VE=-" in log
    assert str(outside) not in log


def test_the_container_gets_only_the_plans_env_by_name(tmp_path, repo):
    """Metric 5 and guardrail 2 (fake leg): the declared value reaches the
    command, an undeclared host variable does not, and no process's argv
    holds the secret while it runs."""
    secret = "container-secret-value-416"
    release = tmp_path / "release"
    log_file = tmp_path / "logs" / "farm-job-hz-416.log"
    os.environ["HZ416_UNDECLARED"] = "host-only-value"
    seen_in_argv = []

    def scan_argv():
        _wait_for(lambda: log_file.exists() and "waiting" in log_file.read_text(), "the command to start")
        for proc in Path("/proc").iterdir():
            try:
                if secret.encode() in (proc / "cmdline").read_bytes():
                    seen_in_argv.append(proc.name)
            except OSError:
                continue
        release.touch()

    scanner = threading.Thread(target=scan_argv, daemon=True)
    scanner.start()
    try:
        artifact = _artifact(
            [f'echo waiting; while [ ! -f {release} ]; do sleep 0.05; done; env | sort; echo "got=$DATA_API_KEY"'],
            env={"API_KEY": "$DATA_API_KEY"},
        )
        summary, _state, log = _run(tmp_path, artifact, repo=repo, env_values={"DATA_API_KEY": secret})
    finally:
        del os.environ["HZ416_UNDECLARED"]
        release.touch()
        scanner.join(10)
    assert summary["passed"] == 1, log
    assert seen_in_argv == []
    assert secret not in log
    assert "got=[redacted]" in log, "the declared value reached the command"
    names = {line.split("=", 1)[0] for line in log.splitlines() if "=" in line and not line.startswith(("$", "env:"))}
    assert "DATA_API_KEY" in names
    assert "HZ416_UNDECLARED" not in names
    assert "FARM_HOME" not in names and "FARM_PODMAN_BIN" not in names


def test_inspect_shows_the_targets_cpu_and_memory_limits(tmp_path, repo):
    """Metric 5 (fake leg): the target's limits reach the running container."""
    release = tmp_path / "release"
    inspected = {}

    def inspect():
        _wait_for(lambda: _containers() == ["farm-job-hz-416"], "the container")
        out = subprocess.run([os.environ["FARM_PODMAN_BIN"], "inspect", "farm-job-hz-416"], capture_output=True, text=True).stdout
        inspected.update(json.loads(out)[0])
        release.touch()

    probe = threading.Thread(target=inspect, daemon=True)
    probe.start()
    try:
        _run(tmp_path, _artifact([f"while [ ! -f {release} ]; do sleep 0.05; done"]), repo=repo, cpu="1.5", memory="512m")
    finally:
        release.touch()
        probe.join(10)
    assert inspected["HostConfig"]["NanoCpus"] == 1_500_000_000
    assert inspected["HostConfig"]["Memory"] == 512 * 1024 * 1024
    assert not any(".env" in m["Source"] for m in inspected["Mounts"]), "no host env file is mounted"


def _fake_oom(name):
    """A command that, under fake_podman, bumps the container's oom_kill
    count and dies of SIGKILL — what the kernel's OOM killer does."""
    return f"echo 1 > {os.environ['FARM_FAKE_PODMAN_DIR']}/{name}.oom; kill -9 $$"


def test_an_oom_kill_fails_the_run_with_a_reason_naming_the_limit(tmp_path, repo):
    """Metric 5 (fake leg): memory.events' oom_kill rose, so the failed
    command records why, in the state, the log and the forwarded artifact's
    command lines — which the server keeps, so a reload shows it."""
    summary, state, log = _run(tmp_path, _artifact([_fake_oom("farm-job-hz-416"), "echo never"]), repo=repo, memory="512m")
    assert summary["failed"] == 1 and summary["run"] == 1
    reason = "killed: out of memory — over the container's 512m memory limit"
    assert state["commands"][0]["exit_code"] == 137
    assert state["commands"][0]["failure_reason"] == reason
    assert reason in log
    assert farmd._command_lines(state["commands"], {})[0].endswith(f"— {reason}")
    assert state["commands"][1]["status"] == "pending"
    assert _containers() == []


@pytest.mark.parametrize(
    "before,after,code,oom",
    [(0, 1, 137, True), (0, 0, 137, False), (None, None, 137, True), (None, None, 1, False), (0, 1, 1, True)],
)
def test_oom_is_judged_by_the_cgroup_counter_then_by_sigkill(tmp_path, repo, monkeypatch, before, after, code, oom):
    """Contract case: a readable oom_kill count decides; only when it cannot
    be read does a SIGKILL exit (137) count as the memory limit."""
    counts = iter([before, after])
    monkeypatch.setattr(container_runner, "oom_kills", lambda name: next(counts))
    _summary, state, _log = _run(tmp_path, _artifact([f"exit {code}"]), repo=repo)
    assert ("failure_reason" in state["commands"][0]) is oom


def test_stop_removes_the_container_and_resume_starts_a_fresh_one(tmp_path, repo, monkeypatch):
    """Metric 2 (Stop leg) and metric 3: farmd's Stop after the runner dies
    leaves no container and no scratch dir; Resume starts a new container
    with the same state dir and skips the passed command."""
    run_id, item_id = 9417, "HZ-9417"
    release = tmp_path / "release"
    artifact = _artifact(
        ["echo one >> runs.txt", f"while [ ! -f {release} ]; do sleep 0.05; done; echo two >> runs.txt"]
    )
    task = tmp_path / "task.json"
    task.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item": {"id": item_id},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
                "runner": server_runner(artifact),
                "repo_dir": str(repo),
                "container_image": FAKE_IMAGE,
            }
        )
    )
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    job_dir = state_path.with_suffix(".d")
    env = {**os.environ, "FARM_PORT": "9", "PYTHONPATH": str(REPO_ROOT)}
    runner = subprocess.Popen([sys.executable, "-m", "farm.task_job", "--task", str(task)], cwd=str(REPO_ROOT), env=env)
    try:
        _wait_for(
            lambda: [c["status"] for c in (task_job.load_state(state_path) or {}).get("commands", [])] == ["done", "running"]
            and _containers() == ["farm-job-hz-9417"],
            "command 2 running in the job's container",
        )
        (job_dir / "state" / "kept.txt").write_text("survives Stop\n")
        (job_dir / "scratch" / "gone.txt").write_text("throwaway\n")
        os.kill(runner.pid, signal.SIGKILL)  # what tmux kill-session does
        runner.wait(5)
        assert _containers() == ["farm-job-hz-9417"], "the container outlives its killed runner"
        farmd._mark_job_stopped(run_id, item_id)
        assert _containers() == []
        assert not (job_dir / "scratch").exists() and not (job_dir / "tmp").exists()
        stopped = task_job.load_state(state_path)
        assert [c["status"] for c in stopped["commands"]] == ["done", "stopped"]

        release.touch()
        monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
        assert task_job.main(["--task", str(task)]) == 0
        final = task_job.load_state(state_path)
        assert [c["status"] for c in final["commands"]] == ["done", "done"]
        assert (repo / "runs.txt").read_text().splitlines() == ["one", "two"]
        assert (job_dir / "state" / "kept.txt").read_text() == "survives Stop\n"
        assert _containers() == []
    finally:
        if runner.poll() is None:
            runner.kill()
        release.touch()
        container_runner.stop_and_remove("farm-job-hz-9417")
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)
        shutil.rmtree(job_dir, ignore_errors=True)
        shutil.rmtree(log_path.with_suffix(".d"), ignore_errors=True)


def test_a_tmp_report_is_read_from_the_jobs_own_tmp_dir(tmp_path):
    """Contract case: a container's /tmp is the job's tmp dir, so a
    `--report /tmp/<path>` is read from there — never from the host's /tmp."""
    tmp_dir = tmp_path / "tmp"
    (tmp_dir / "nested").mkdir(parents=True)
    (tmp_dir / "nested" / "out.json").write_text('{"ok": true}')
    host_tmp = Path("/tmp/nested/out.json")
    host_had = host_tmp.exists()
    reports = job_reports.collect_reports(
        ["run --report /tmp/nested/out.json"], [], str(tmp_path), {}, forbid=None, tmp_root=str(tmp_dir)
    )
    assert reports[0]["status"] == "inlined" and '{"ok": true}' in reports[0]["text"]
    assert host_tmp.exists() == host_had


def _recording_popen(monkeypatch):
    """Records every argv subprocess.Popen is given, then runs it."""
    seen = []
    real_popen = subprocess.Popen

    def _record(argv, *args, **kwargs):
        seen.append(list(argv))
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", _record)
    return seen


BASH_ONLY = 'set -euo pipefail; a=(x y); [[ ${#a[@]} -eq 2 ]]; echo "BASH=${BASH_VERSION:+yes}"'


def test_a_container_command_runs_under_bash_when_the_image_has_it(tmp_path, repo, monkeypatch):
    """HZ-496 metric 2: the image has bash, so each `podman exec` is
    `bash -c`, the log names no fallback, and bash-only syntax passes."""
    seen = _recording_popen(monkeypatch)
    summary, _state, log = _run(tmp_path, _artifact([BASH_ONLY]), repo=repo)
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}, log
    execs = [argv for argv in seen if argv[1:2] == ["exec"] and argv[-1] == BASH_ONLY]
    assert [argv[-3:] for argv in execs] == [["bash", "-c", BASH_ONLY]]
    assert not any(line.startswith("shell:") for line in log.splitlines())
    assert "BASH=yes" in log


def test_an_image_without_bash_runs_commands_under_sh_and_says_so(tmp_path, repo, monkeypatch):
    """HZ-496 metric 2: no bash in the image, so the run falls back to
    `sh -c`, the log names `sh`, and a POSIX command still passes."""
    seen = _recording_popen(monkeypatch)
    posix = 'test "$(echo ok)" = ok && echo POSIX-OK'
    summary, _state, log = _run(tmp_path, _artifact([posix]), repo=repo, image="localhost/horizon-task:nobash")
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}, log
    execs = [argv for argv in seen if argv[1:2] == ["exec"] and argv[-1] == posix]
    assert [argv[-3:] for argv in execs] == [["sh", "-c", posix]]
    assert "shell: sh" in log.splitlines()
    assert "POSIX-OK" in log


def test_the_shell_probe_says_sh_when_podman_cannot_run(monkeypatch, tmp_path):
    monkeypatch.setenv("FARM_PODMAN_BIN", str(tmp_path / "no-such-podman"))
    assert container_runner.container_shell("farm-job-hz-496") == "sh"


# ---- `runner: host`: exactly as before HZ-416 ----


def test_a_host_plan_runs_on_the_host_with_the_same_cwd_env_and_log(tmp_path, repo, monkeypatch):
    """Metric 4 (farm leg): no podman is involved — a missing binary does not
    matter — the cwd is the host checkout, the env is the host child env, and
    the log has no container line."""
    monkeypatch.setenv("FARM_PODMAN_BIN", str(tmp_path / "no-such-podman"))
    artifact = _artifact(['pwd; echo "KEY=$DATA_API_KEY"; echo marker > made.txt'], cwd="sub", runner="host")
    summary, state, log = _run(tmp_path, artifact, repo=repo, image=None, env_values={"DATA_API_KEY": "host-plan-value-1"})
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    assert state["runner"] == "host"
    lines = log.splitlines()
    assert lines[0] == "env: system"
    assert not any(line.startswith("container:") for line in lines)
    assert lines[1] == f"$ {state['commands'][0]['command']} (cwd={repo / 'sub'})"
    assert str(repo / "sub") in lines[2]
    assert "KEY=[redacted]" in log
    assert (repo / "sub" / "made.txt").read_text() == "marker\n"
    assert not (tmp_path / "state" / "HZ-416.d").exists(), "a host run makes no container dirs"


# ---- HZ-491: the job's runner, not the block's, decides ----


def test_the_jobs_runner_wins_over_the_blocks_and_there_is_no_default(tmp_path, repo, monkeypatch):
    """HZ-491 metric 4: run_job runs where the server said. A block that asks
    for the container, sent as host, never touches Podman; a job with no
    runner raises before any command runs."""
    monkeypatch.setenv("FARM_PODMAN_BIN", str(tmp_path / "no-such-podman"))
    monkeypatch.setattr(container_runner, "ensure_image", lambda *a, **k: (_ for _ in ()).throw(AssertionError("podman on a host run")))
    artifact = _artifact(["echo marker > made.txt"], runner="container")
    state_path, log_path = tmp_path / "job.json", tmp_path / "job.log"
    common = dict(run_id=491, item_id="HZ-491", plan_artifact=artifact, approved_hash=task_job.plan_hash_of(artifact),
                  state_path=state_path, log_path=log_path, repo_dir=str(repo), container_image=None)
    summary = task_job.run_job(runner="host", **common)
    assert summary["passed"] == 1
    assert json.loads(state_path.read_text())["runner"] == "host"
    assert (repo / "made.txt").read_text() == "marker\n"
    (repo / "made.txt").unlink()
    state_path.unlink()
    for runner in (None, "", "docker"):
        with pytest.raises(ValueError, match="job runner must be one of host, container"):
            task_job.run_job(runner=runner, **common)
    assert not (repo / "made.txt").exists()
    assert not state_path.exists()


def test_a_no_runner_block_sent_as_container_still_fails_closed_with_no_image(tmp_path, repo, monkeypatch):
    """HZ-491 guardrail 2: the container is never swapped for the host on the
    farm — a container job with no image ends container_unavailable."""
    _no_spawn(monkeypatch)
    artifact = _artifact(["touch ran.txt"])
    summary, state, _log = _run(tmp_path, artifact, repo=repo, image=None)
    assert summary["run"] == 0
    assert state["status"] == "container_unavailable"
    assert not (repo / "ran.txt").exists()


# ---- Real rootless Podman: the confinement itself ----


# Rootless Podman keeps its runtime dir in XDG_RUNTIME_DIR, else under
# $TMPDIR — which here is the suite's leak-guarded sandbox, so its
# podman-run-<uid> and containers-user-<uid> would be left there (HZ-238).
# A host with no login session (no /run/user/<uid>) gets the dir Podman uses
# outside the suite: podman-run-<uid> in the real temp dir, the sandbox's parent.
_SANDBOX = tempfile.gettempdir()
_HOST_TMP = os.path.dirname(_SANDBOX) if os.path.basename(_SANDBOX).startswith("horizon-run-") else _SANDBOX
_RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR") or (
    f"/run/user/{os.getuid()}"
    if os.path.isdir(f"/run/user/{os.getuid()}")
    else os.path.join(_HOST_TMP, f"podman-run-{os.getuid()}")
)
os.makedirs(_RUNTIME_DIR, mode=0o700, exist_ok=True)
_REAL_ENV = {**os.environ, **({"XDG_RUNTIME_DIR": _RUNTIME_DIR} if _RUNTIME_DIR else {})}


def _real_ready():
    if not REAL_PODMAN:
        return "podman is not installed on this host (see infra/host/DEPLOY.md) — NOT verified"
    pulled = subprocess.run([REAL_PODMAN, "image", "exists", REAL_IMAGE], capture_output=True, env=_REAL_ENV)
    if pulled.returncode != 0:
        pulled = subprocess.run([REAL_PODMAN, "pull", "--quiet", REAL_IMAGE], capture_output=True, timeout=600, env=_REAL_ENV)
    if pulled.returncode != 0:
        return f"image {REAL_IMAGE} could not be pulled (set HORIZON_TEST_PODMAN_IMAGE) — NOT verified"
    return None


_REAL_SKIP = _real_ready()
real_podman = pytest.mark.skipif(_REAL_SKIP is not None, reason=_REAL_SKIP or "")


@pytest.fixture
def real(monkeypatch):
    monkeypatch.setenv("FARM_PODMAN_BIN", REAL_PODMAN)
    if _RUNTIME_DIR:
        monkeypatch.setenv("XDG_RUNTIME_DIR", _RUNTIME_DIR)
    return REAL_PODMAN


def _confinement(repo: Path, sibling: Path) -> str:
    denied = [f"{repo}/x", f"{repo}/sub/x", "/opt/horizon/x", "/var/tmp/x", "/etc/x", "/x", f"{sibling}/x"]
    allowed = ["/scratch/x", "/state/x", "/logs/x", "/tmp/x", "$HOME/x"]
    return (
        f"for p in {' '.join(denied)}; do "
        '(mkdir -p "$(dirname $p)" && echo hi > "$p") 2>/dev/null && echo "WROTE $p" || echo "DENIED $p"; done; '
        f"for p in {' '.join(allowed)}; do "
        'echo hi > "$p" && echo "WROTE $p" || echo "DENIED $p"; done; '
        'echo "UID=$(id -u)"; echo "PWD=$(pwd)"'
    )


@real_podman
def test_real_the_container_can_write_only_scratch_tmp_state_and_logs(tmp_path, repo, real):
    """Metric 1: the pinned image, the non-root farm user, the repo read-only
    at its own path with the plan's cwd as workdir; writes fail in the repo,
    /opt/horizon, a sibling job's state dir and everywhere else but scratch,
    /tmp ($HOME), the job's state and its logs. Metric 2: none of the
    throwaway writes is left behind, and no container is."""
    # Beside the repo, not under the host's /tmp: inside, /tmp is the run's
    # own throwaway dir, so a /tmp sibling would prove nothing.
    sibling = repo.parent / "state" / "HZ-OTHER.d" / "state"
    sibling.mkdir(parents=True)
    before_repo = _files_under(repo)
    host_x_before = Path("/tmp/x").exists()
    summary, _state, log = _run(tmp_path, _artifact([_confinement(repo, sibling)], cwd="sub"), repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    for path in (f"{repo}/x", f"{repo}/sub/x", "/opt/horizon/x", "/var/tmp/x", "/etc/x", "/x", f"{sibling}/x"):
        assert f"DENIED {path}" in log, log
    for path in ("/scratch/x", "/state/x", "/logs/x", "/tmp/x", "/x"):
        assert f"WROTE {path}" in log or f"WROTE /tmp{path}" in log, log
    assert f"UID={os.getuid()}" in log and os.getuid() != 0
    assert f"PWD={repo / 'sub'}" in log
    assert f"container: {REAL_IMAGE}" in log
    assert _files_under(repo) == before_repo
    assert list(sibling.iterdir()) == []
    assert Path("/tmp/x").exists() == host_x_before, "the container's /tmp is never the host's"
    assert _containers(real) == []
    job_dir = tmp_path / "state" / "HZ-416.d"
    assert (job_dir / "state" / "x").exists() and (tmp_path / "logs" / "farm-job-hz-416.d" / "x").exists()
    assert not (job_dir / "scratch").exists() and not (job_dir / "tmp").exists()


@real_podman
def test_real_a_bash_command_runs_in_an_image_with_bash(tmp_path, repo, real):
    """HZ-496 metric 2 (real leg): REAL_IMAGE has bash, so bash-only syntax
    passes and the log names no fallback."""
    summary, _state, log = _run(tmp_path, _artifact([BASH_ONLY]), repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    assert not any(line.startswith("shell:") for line in log.splitlines())
    assert "BASH=yes" in log
    assert _containers(real) == []


MARKERS = 'echo m > /scratch/marker-416; echo m > "$HOME/home-marker-416"; echo m > /tmp/tmp-marker-416'


def _no_markers_anywhere(tmp_path):
    for root in (tmp_path, Path("/tmp"), Path.home()):
        found = [p for p in root.rglob("*marker-416") if p.is_file()] if root == tmp_path else [
            p for p in (root / "marker-416", root / "home-marker-416", root / "tmp-marker-416") if p.exists()
        ]
        assert found == [], found


@real_podman
@pytest.mark.parametrize("ending", ["success", "failure", "budget"])
def test_real_no_container_or_marker_is_left_after_any_ending(tmp_path, repo, real, monkeypatch, ending):
    """Metric 2: markers written to scratch, $HOME and /tmp, then the run
    succeeds, fails or is cut off — and `podman ps -a` is clean, scratch is
    gone and no marker exists on the host."""
    command = {"success": MARKERS, "failure": MARKERS + "; exit 4", "budget": MARKERS + "; sleep 600"}[ending]
    if ending == "budget":
        skew = {}
        real_monotonic = time.monotonic

        def jump():
            _wait_for(lambda: _containers(real) == ["farm-job-hz-416"], "the container", 60)
            time.sleep(1)
            skew["s"] = 120.0

        monkeypatch.setattr(task_job.time, "monotonic", lambda: real_monotonic() + skew.get("s", 0.0))
        threading.Thread(target=jump, daemon=True).start()
    summary, state, log = _run(tmp_path, _artifact([command]), repo=repo, image=REAL_IMAGE)
    expected = {"success": "finished", "failure": "finished", "budget": "budget_exceeded"}[ending]
    assert state["status"] == expected, log
    assert _containers(real) == []
    assert not (tmp_path / "state" / "HZ-416.d" / "scratch").exists()
    _no_markers_anywhere(tmp_path)


@real_podman
def test_real_stop_leaves_no_container_or_marker(tmp_path, repo, real):
    """Metric 2 (Stop) and metric 3 (HZ-407 Stop in a container): the runner
    is killed mid-command, farmd's Stop removes the container and the
    throwaway dirs, and Resume finishes in a fresh container."""
    run_id, item_id = 9419, "HZ-9419"
    artifact = _artifact([MARKERS, "sleep 600", "true"], budget_minutes=15)
    task = tmp_path / "task.json"
    task.write_text(json.dumps({
        "run_id": run_id, "item": {"id": item_id}, "plan_artifact": artifact,
        "approved_hash": task_job.plan_hash_of(artifact), "runner": "container", "repo_dir": str(repo), "container_image": REAL_IMAGE,
    }))
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    env = {**os.environ, "FARM_PORT": "9", "PYTHONPATH": str(REPO_ROOT)}
    runner = subprocess.Popen([sys.executable, "-m", "farm.task_job", "--task", str(task)], cwd=str(REPO_ROOT), env=env)
    try:
        _wait_for(
            lambda: [c["status"] for c in (task_job.load_state(state_path) or {}).get("commands", [])] == ["done", "running", "pending"],
            "command 2 running",
            60,
        )
        os.kill(runner.pid, signal.SIGKILL)
        runner.wait(5)
        farmd._mark_job_stopped(run_id, item_id)
        assert _containers(real) == []
        assert not (state_path.with_suffix(".d") / "scratch").exists()
        _no_markers_anywhere(STATE_DIR)
        _no_markers_anywhere(tmp_path)
        assert [c["status"] for c in task_job.load_state(state_path)["commands"]] == ["done", "stopped", "pending"]
    finally:
        if runner.poll() is None:
            runner.kill()
        container_runner.stop_and_remove(container_runner.container_name(item_id))
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)
        shutil.rmtree(state_path.with_suffix(".d"), ignore_errors=True)
        shutil.rmtree(log_path.with_suffix(".d"), ignore_errors=True)


@real_podman
def test_real_env_holds_only_declared_and_base_variables_and_limits_apply(tmp_path, repo, real):
    """Metric 5: `env` inside lists the plan's names plus Podman's and the
    image's own base; `podman inspect` shows the CPU and memory limits; no
    host env file is mounted. Guardrail 2: the value is not in any argv."""
    (repo / ".env").write_text("DATA_API_KEY=from-dotenv\n")
    image_env = json.loads(subprocess.run([real, "image", "inspect", REAL_IMAGE], capture_output=True, text=True).stdout)[0]
    image_names = {e.split("=", 1)[0] for e in (image_env.get("Config") or {}).get("Env") or []}
    go = tmp_path / "state" / "HZ-416.d" / "state" / "go"  # /state/go inside
    inspected = {}

    def inspect():
        _wait_for(lambda: _containers(real) == ["farm-job-hz-416"], "the container", 60)
        out = subprocess.run([real, "inspect", "farm-job-hz-416"], capture_output=True, text=True).stdout
        inspected.update(json.loads(out)[0])
        argvs = [p / "cmdline" for p in Path("/proc").iterdir() if p.name.isdigit()]
        inspected["argv_has_secret"] = any(b"real-secret-416" in _read(p) for p in argvs)
        go.touch()

    probe = threading.Thread(target=inspect, daemon=True)
    probe.start()
    try:
        # HZ-496: bash (this image has it) exports its own SHLVL and `_`.
        artifact = _artifact(["while [ ! -f /state/go ]; do sleep 0.1; done; env -u SHLVL -u _"], env={"K": "$DATA_API_KEY"})
        summary, _state, log = _run(
            tmp_path, artifact, repo=repo, image=REAL_IMAGE, env_values={"DATA_API_KEY": "real-secret-416"}, cpu="1", memory="256m"
        )
    finally:
        probe.join(10)
    assert summary["passed"] == 1, log
    names = {line.split("=", 1)[0] for line in log.splitlines() if "=" in line and not line.startswith(("$", "env:"))}
    assert "DATA_API_KEY" in names
    assert names - {"DATA_API_KEY"} <= image_names | {"PATH", "HOME", "HOSTNAME", "TERM", "container", "USER", "PWD"}
    assert inspected["HostConfig"]["NanoCpus"] == 1_000_000_000
    assert inspected["HostConfig"]["Memory"] == 256 * 1024 * 1024
    assert not any(str(m.get("Source", "")).endswith(".env") for m in inspected["Mounts"])
    assert inspected["argv_has_secret"] is False


@real_podman
def test_real_a_checkout_env_file_cannot_be_read_inside(tmp_path, repo, real):
    """The checkout's .env holds the secrets farmd resolves job env from; a
    plan that declares none cannot read them through the repo mount."""
    (repo / ".env").write_text("DATA_API_KEY=dotenv-secret-416\n")
    (repo / "sub" / ".env").write_text("OTHER_KEY=dotenv-secret-416\n")
    probe = 'for f in .env sub/.env; do cat "$f" && echo "READ $f" || echo "BLOCKED $f"; done'
    summary, _state, log = _run(tmp_path, _artifact([probe]), repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    assert "BLOCKED .env" in log and "BLOCKED sub/.env" in log, log
    assert "READ .env" not in log and "READ sub/.env" not in log and "dotenv-secret-416" not in log
    assert (repo / ".env").read_text() == "DATA_API_KEY=dotenv-secret-416\n"
    assert _containers(real) == []


@real_podman
def test_real_over_the_memory_limit_is_killed_with_a_reason_naming_it(tmp_path, repo, real):
    """Metric 5: allocating past the limit is killed, and the run fails with
    a reason naming the limit — from memory.events, since pid 1 lives on."""
    hog = "python3 -c \"b = bytearray(512 * 1024 * 1024); print(len(b))\""
    summary, state, log = _run(tmp_path, _artifact([hog]), repo=repo, image=REAL_IMAGE, memory="128m")
    assert summary["failed"] == 1, log
    assert state["commands"][0]["failure_reason"] == "killed: out of memory — over the container's 128m memory limit"
    assert "over the container's 128m memory limit" in log
    assert _containers(real) == []
    assert not (Path.cwd() / "oom").exists() and not (repo / "oom").exists(), "conmon's oom file lands in no checkout"


@real_podman
def test_real_a_tmp_report_survives_the_container(tmp_path, repo, real):
    """Contract case: a report written to /tmp inside the container is read
    back into the run's reports before the container and /tmp are gone."""
    artifact = _artifact(['sh -c \'echo "{\\"rows\\": 3}" > "$1"\' _ /tmp/out.json --report /tmp/out.json'])
    summary, state, log = _run(tmp_path, artifact, repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    assert state["reports"][0]["status"] == "inlined"
    assert '"rows": 3' in state["reports"][0]["text"]
    assert not (tmp_path / "state" / "HZ-416.d" / "tmp").exists()


def _read(path):
    try:
        return path.read_bytes()
    except OSError:
        return b""
