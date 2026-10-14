"""HZ-416: a Task's Execute runs in a throwaway rootless Podman container.

Two tiers. Everything not marked `real_podman` runs everywhere, through
conftest's fake_podman (farm/tests/fake_podman): it proves the argv, the
lifecycle (nothing left in `podman ps -a`), the fail-closed refusals, the
env hand-off and the `runner: host` opt-out. fake_podman confines nothing,
so the confinement itself (metric lines 1, 2 and 5) is proven by the
`real_podman` tests, which need `podman` on PATH and the image named by
HORIZON_TEST_PODMAN_IMAGE already pulled — they skip otherwise, and
infra/host/DEPLOY.md makes running them on the host part of installing
Podman.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
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


def _run(tmp_path, artifact, *, repo, image=FAKE_IMAGE, env_values=None, cpu=None, memory=None, item_id="HZ-416"):
    state_path = tmp_path / "state" / f"{item_id}.json"
    log_path = tmp_path / "logs" / f"farm-job-{item_id.lower()}.log"
    state_path.parent.mkdir(exist_ok=True)
    log_path.parent.mkdir(exist_ok=True)
    summary = task_job.run_job(
        run_id=416,
        item_id=item_id,
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        state_path=state_path,
        log_path=log_path,
        repo_dir=str(repo),
        env_values=env_values or {},
        container_image=image,
        cpu_limit=cpu,
        memory_limit=memory,
    )
    return summary, json.loads(state_path.read_text()), log_path.read_text()


def _containers(podman=None):
    out = subprocess.run(
        [podman or os.environ["HORIZON_PODMAN_BIN"], "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    ).stdout
    return [name for name in out.split() if name.startswith("horizon-job-")]


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
def repo(tmp_path):
    path = tmp_path / "repo"
    (path / "sub").mkdir(parents=True)
    (path / "README").write_text("checkout\n")
    return path


# ---- The contract: `runner` in the run plan block ----


@pytest.mark.parametrize("case", FIXTURES["runner"], ids=lambda c: c["case"])
def test_the_runner_field_matches_the_shared_fixture(case):
    if case["valid"]:
        block = run_plan.validate(case["block"])
        assert (block.get("runner") or "container") == case["runner"]
    else:
        with pytest.raises(ValueError, match="'runner'"):
            run_plan.validate(case["block"])


# ---- The argv: guardrails hold whatever the inputs ----


def _argv(**overrides):
    kwargs = dict(
        image="registry.example/py@sha256:" + "a" * 64,
        item_id="HZ-416",
        repo_dir="/srv/checkout",
        plan_cwd="pipelines",
        scratch_dir="/state/HZ-416.d/scratch",
        tmp_dir="/state/HZ-416.d/tmp",
        state_dir="/state/HZ-416.d/state",
        log_dir="/logs/farm-job-hz-416.d",
        env_names=["DATA_API_KEY"],
        cpu="1.5",
        memory="2g",
        report_files=["out.json"],
    )
    kwargs.update(overrides)
    return container_runner.build_command(**kwargs)


def test_the_argv_never_escalates_and_mounts_only_what_it_should():
    """Guardrail 1: no --privileged, no capability, no socket, no env file;
    host networking, the farm user, a read-only image filesystem, the repo
    read-only at /repo with the plan's cwd as workdir."""
    argv = _argv()
    joined = " ".join(argv)
    for banned in ("--privileged", "--cap-add", "podman.sock", "docker.sock", "--env-file", "--security-opt", "--device"):
        assert banned not in joined
    assert argv[:3] == [os.environ["HORIZON_PODMAN_BIN"], "run", "--rm"]
    assert "--network=host" in argv
    assert "--userns=keep-id" in argv
    assert argv[argv.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"
    assert "--read-only" in argv and "--read-only-tmpfs=false" in argv
    assert argv[argv.index("--name") + 1] == "horizon-job-hz-416"
    assert argv[argv.index("--cpus") + 1] == "1.5"
    assert argv[argv.index("--memory") + 1] == "2g"
    mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
    assert mounts == [
        "/srv/checkout:/repo:ro",
        "/state/HZ-416.d/scratch:/scratch:rw",
        "/state/HZ-416.d/state:/state:rw",
        "/logs/farm-job-hz-416.d:/logs:rw",
        "/state/HZ-416.d/tmp:/tmp:ro",
        "/state/HZ-416.d/tmp/out.json:/tmp/out.json:rw",
    ]
    assert argv[argv.index("-w") + 1] == "/repo/pipelines"
    assert argv[-1] == "registry.example/py@sha256:" + "a" * 64


def test_secrets_are_passed_by_name_never_by_value():
    """Guardrail 2: `--env NAME` only — Podman inherits the value from its
    own env, so nothing after --env holds an `=`."""
    argv = _argv(env_names=["DATA_API_KEY", "DATABASE_URL"])
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--env"] == ["DATA_API_KEY", "DATABASE_URL"]


def test_the_default_limits_apply_when_the_target_sets_none():
    argv = _argv(cpu=None, memory=None, plan_cwd=".")
    assert argv[argv.index("--cpus") + 1] == container_runner.DEFAULT_CPUS
    assert argv[argv.index("--memory") + 1] == container_runner.DEFAULT_MEMORY
    assert argv[argv.index("-w") + 1] == "/repo"


# ---- Fail closed: never a silent host run ----


def _no_spawn(monkeypatch):
    """Lets the `podman image exists` probe through; any shell or `podman
    run` fails the test."""
    real_popen = subprocess.Popen

    def _guard(argv, *args, **kwargs):
        if "sh" in argv or "run" in argv:
            raise AssertionError(f"no command may start when the container is unavailable: {argv}")
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", _guard)


@pytest.mark.parametrize(
    "case,refusal",
    [
        ("no podman", "podman is not installed"),
        ("no image pinned", "this repo has no pinned container image"),
        ("image not pulled", "the container image is not available: localhost/missing:1"),
    ],
)
def test_missing_podman_or_image_runs_zero_commands(tmp_path, repo, monkeypatch, case, refusal):
    """Guardrail 3: the job ends `container_unavailable` with every command
    pending and no process started — never on the host."""
    image = FAKE_IMAGE
    if case == "no podman":
        monkeypatch.setenv("HORIZON_PODMAN_BIN", str(tmp_path / "no-such-podman"))
    elif case == "no image pinned":
        image = None
    else:
        image = "localhost/missing:1"
    _no_spawn(monkeypatch)
    summary, state, log = _run(tmp_path, _artifact(["touch ran.txt"]), repo=repo, image=image)
    assert summary == {"run": 0, "passed": 0, "failed": 0, "failing": []}
    assert state["status"] == "container_unavailable"
    assert state["refusal"] == refusal
    assert [c["status"] for c in state["commands"]] == ["pending"]
    assert f"Execute refused: {refusal} — zero commands run" in log
    assert not (repo / "ran.txt").exists()


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


def test_a_container_run_goes_through_podman_and_leaves_nothing(tmp_path, repo):
    """Metric 2 (lifecycle leg): success and failure both leave no container
    and wipe the throwaway scratch and tmp dirs."""
    summary, state, log = _run(tmp_path, _artifact(["echo ok", "pwd"], cwd="sub"), repo=repo)
    assert summary == {"run": 2, "passed": 2, "failed": 0, "failing": []}
    assert state["runner"] == "container"
    assert log.splitlines()[:2] == ["env: system", f"container: {FAKE_IMAGE}"]
    assert str(repo / "sub") in log  # fake_podman maps -w /repo/sub back to the host dir
    assert _containers() == []
    job_dir = tmp_path / "state" / "HZ-416.d"
    assert not (job_dir / "scratch").exists() and not (job_dir / "tmp").exists()

    summary, _state, _log = _run(tmp_path, _artifact(["exit 3"]), repo=repo)
    assert summary["failing"] == ["exit 3"]
    assert _containers() == []


def test_the_container_gets_only_the_plans_env_by_name(tmp_path, repo):
    """Metric 5 and guardrail 2 (fake leg): the declared value reaches the
    command, an undeclared host variable does not, and no process's argv
    holds the secret while it runs."""
    secret = "container-secret-value-416"
    release = tmp_path / "release"
    os.environ["HZ416_UNDECLARED"] = "host-only-value"
    seen_in_argv = []

    def scan_argv():
        _wait_for(lambda: (tmp_path / "logs" / "farm-job-hz-416.log").exists() and "waiting" in (tmp_path / "logs" / "farm-job-hz-416.log").read_text(), "the command to start")
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
    assert "FARM_HOME" not in names and "HORIZON_PODMAN_BIN" not in names


def test_inspect_shows_the_targets_cpu_and_memory_limits(tmp_path, repo):
    """Metric 5 (fake leg): the target's limits reach the running container."""
    release = tmp_path / "release"
    inspected = {}

    def inspect():
        _wait_for(lambda: _containers() == ["horizon-job-hz-416"], "the container")
        out = subprocess.run([os.environ["HORIZON_PODMAN_BIN"], "inspect", "horizon-job-hz-416"], capture_output=True, text=True).stdout
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


def test_stop_removes_the_container_and_resume_starts_a_fresh_one(tmp_path, repo, monkeypatch):
    """Metric 2 (Stop leg) and metric 3: farmd's Stop after the runner dies
    leaves no container; Resume remounts the same state dir in a new one and
    skips the passed command."""
    run_id, item_id = 9417, "HZ-9417"
    release = tmp_path / "release"
    artifact = _artifact(
        ["echo kept > /dev/null; echo one >> runs.txt", f"while [ ! -f {release} ]; do sleep 0.05; done; echo two >> runs.txt"]
    )
    task = tmp_path / "task.json"
    task.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item": {"id": item_id},
                "plan_artifact": artifact,
                "approved_hash": task_job.plan_hash_of(artifact),
                "repo_dir": str(repo),
                "container_image": FAKE_IMAGE,
            }
        )
    )
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    env = {**os.environ, "FARM_PORT": "9", "PYTHONPATH": str(REPO_ROOT)}
    runner = subprocess.Popen([sys.executable, "-m", "farm.task_job", "--task", str(task)], cwd=str(REPO_ROOT), env=env)
    try:
        _wait_for(
            lambda: [c["status"] for c in (task_job.load_state(state_path) or {}).get("commands", [])] == ["done", "running"]
            and _containers() == ["horizon-job-hz-9417"],
            "command 2 running in its container",
        )
        assert task_job.load_state(state_path)["commands"][1]["container"] == "horizon-job-hz-9417"
        (state_path.with_suffix(".d") / "state" / "kept.txt").write_text("survives Stop\n")
        os.kill(runner.pid, signal.SIGKILL)  # what tmux kill-session does
        runner.wait(5)
        assert _containers() == ["horizon-job-hz-9417"], "the container outlives its killed client"
        farmd._mark_job_stopped(run_id, item_id)
        assert _containers() == []
        stopped = task_job.load_state(state_path)
        assert [c["status"] for c in stopped["commands"]] == ["done", "stopped"]
        assert "container" not in stopped["commands"][1]

        release.touch()
        monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
        assert task_job.main(["--task", str(task)]) == 0
        final = task_job.load_state(state_path)
        assert [c["status"] for c in final["commands"]] == ["done", "done"]
        assert (repo / "runs.txt").read_text().splitlines() == ["one", "two"]
        assert (state_path.with_suffix(".d") / "state" / "kept.txt").read_text() == "survives Stop\n"
        assert _containers() == []
    finally:
        if runner.poll() is None:
            runner.kill()
        release.touch()
        container_runner.stop_and_remove("horizon-job-hz-9417")
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)
        shutil.rmtree(state_path.with_suffix(".d"), ignore_errors=True)
        shutil.rmtree(log_path.with_suffix(".d"), ignore_errors=True)


def test_a_tmp_report_is_read_from_the_jobs_own_tmp_dir(tmp_path):
    """Contract case: a `--report /tmp/<name>` file is pre-created in the
    job's tmp dir (bound at /tmp/<name>), read from there — never from the
    host's /tmp — and nested /tmp paths are not bound."""
    tmp_dir = tmp_path / "tmp"
    tmp_dir.mkdir()
    names = task_job._tmp_report_files(
        ["run --report /tmp/out.json", "run --report /tmp/a/b.json", "run --report rel.json"], ["/tmp/declared.json"], tmp_dir
    )
    assert names == ["out.json", "declared.json"]
    assert sorted(p.name for p in tmp_dir.iterdir()) == ["declared.json", "out.json"]
    (tmp_dir / "out.json").write_text('{"ok": true}')
    host_tmp = Path("/tmp/out.json")
    host_had = host_tmp.exists()
    reports = job_reports.collect_reports(
        ["run --report /tmp/out.json"], [], str(tmp_path), {}, forbid=None, tmp_root=str(tmp_dir)
    )
    assert reports[0]["status"] == "inlined" and '{"ok": true}' in reports[0]["text"]
    assert host_tmp.exists() == host_had


# ---- `runner: host`: exactly as before HZ-416 ----


def test_a_host_plan_runs_on_the_host_with_the_same_cwd_env_and_log(tmp_path, repo, monkeypatch):
    """Metric 4 (farm leg): no podman is involved — a missing binary does not
    matter — the cwd is the host checkout, the env is the host child env, and
    the log has no container line."""
    monkeypatch.setenv("HORIZON_PODMAN_BIN", str(tmp_path / "no-such-podman"))
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


# ---- Real rootless Podman: the confinement itself ----


def _real_ready():
    if not REAL_PODMAN:
        return "podman is not installed on this host (see infra/host/DEPLOY.md)"
    exists = subprocess.run([REAL_PODMAN, "image", "exists", REAL_IMAGE], capture_output=True)
    if exists.returncode != 0:
        return f"image {REAL_IMAGE} is not pulled (podman pull it, or set HORIZON_TEST_PODMAN_IMAGE)"
    return None


real_podman = pytest.mark.skipif(_real_ready() is not None, reason=_real_ready() or "")


@pytest.fixture
def real(monkeypatch):
    monkeypatch.setenv("HORIZON_PODMAN_BIN", REAL_PODMAN)
    return REAL_PODMAN


CONFINEMENT = (
    "for p in /repo/x /repo/sub/x /opt/horizon/x /tmp/x /var/tmp/x /etc/x /x; do "
    '(mkdir -p "$(dirname $p)" && echo hi > "$p") 2>/dev/null && echo "WROTE $p" || echo "DENIED $p"; done; '
    'echo hi > /scratch/x && echo "WROTE /scratch/x"; '
    'echo hi > /state/x && echo "WROTE /state/x"; echo hi > /logs/x && echo "WROTE /logs/x"; '
    'echo "UID=$(id -u)"; echo "PWD=$(pwd)"'
)


@real_podman
def test_real_the_container_can_write_only_scratch_state_and_logs(tmp_path, repo, real):
    """Metric 1: pinned image, the farm user, the repo read-only at /repo with
    the plan's cwd as workdir; writes fail everywhere but scratch, state and
    logs. Metric 2: none of it is left behind."""
    before_repo = _files_under(repo)
    host_x_before = Path("/tmp/x").exists()
    summary, _state, log = _run(tmp_path, _artifact([CONFINEMENT], cwd="sub"), repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    for path in ("/repo/x", "/repo/sub/x", "/opt/horizon/x", "/tmp/x", "/var/tmp/x", "/etc/x", "/x"):
        assert f"DENIED {path}" in log, log
    for path in ("/scratch/x", "/state/x", "/logs/x"):
        assert f"WROTE {path}" in log, log
    assert f"UID={os.getuid()}" in log and os.getuid() != 0
    assert "PWD=/repo/sub" in log
    assert f"container: {REAL_IMAGE}" in log
    assert _files_under(repo) == before_repo
    assert Path("/tmp/x").exists() == host_x_before, "the container's /tmp is never the host's"
    assert _containers(real) == []
    job_dir = tmp_path / "state" / "HZ-416.d"
    assert (job_dir / "state" / "x").exists() and (tmp_path / "logs" / "farm-job-hz-416.d" / "x").exists()
    assert not (job_dir / "scratch").exists(), "scratch is throwaway"


@real_podman
def test_real_no_container_is_left_after_failure_or_budget_kill(tmp_path, repo, real, monkeypatch):
    """Metric 2: a failing run and a run killed mid-command both leave
    `podman ps -a` clean."""
    _run(tmp_path, _artifact(["exit 4"]), repo=repo, image=REAL_IMAGE)
    assert _containers(real) == []
    clock = {"t": time.monotonic()}
    real_monotonic = time.monotonic

    def jump():
        _wait_for(lambda: _containers(real) == ["horizon-job-hz-416"], "the container", 60)
        clock["skew"] = 120.0

    monkeypatch.setattr(task_job.time, "monotonic", lambda: real_monotonic() + clock.get("skew", 0.0))
    killer = threading.Thread(target=jump, daemon=True)
    killer.start()
    summary, state, _log = _run(tmp_path, _artifact(["sleep 600"]), repo=repo, image=REAL_IMAGE)
    killer.join(10)
    assert state["status"] == "budget_exceeded"
    assert _containers(real) == []


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
        _wait_for(lambda: _containers(real) == ["horizon-job-hz-416"], "the container", 60)
        out = subprocess.run([real, "inspect", "horizon-job-hz-416"], capture_output=True, text=True).stdout
        inspected.update(json.loads(out)[0])
        argvs = [p / "cmdline" for p in Path("/proc").iterdir() if p.name.isdigit()]
        inspected["argv_has_secret"] = any(b"real-secret-416" in _read(p) for p in argvs)
        go.touch()

    probe = threading.Thread(target=inspect, daemon=True)
    probe.start()
    try:
        artifact = _artifact(["while [ ! -f /state/go ]; do sleep 0.1; done; env"], env={"K": "$DATA_API_KEY"})
        summary, _state, log = _run(
            tmp_path, artifact, repo=repo, image=REAL_IMAGE, env_values={"DATA_API_KEY": "real-secret-416"}, cpu="1", memory="256m"
        )
    finally:
        probe.join(10)
    assert summary["passed"] == 1, log
    names = {line.split("=", 1)[0] for line in log.splitlines() if "=" in line and not line.startswith(("$", "env:"))}
    assert "DATA_API_KEY" in names
    assert names - {"DATA_API_KEY"} <= image_names | {"PATH", "HOME", "HOSTNAME", "TERM", "container", "USER"}
    assert inspected["HostConfig"]["NanoCpus"] == 1_000_000_000
    assert inspected["HostConfig"]["Memory"] == 256 * 1024 * 1024
    assert not any(str(m.get("Source", "")).endswith(".env") for m in inspected["Mounts"])
    assert inspected["argv_has_secret"] is False


@real_podman
def test_real_a_tmp_report_survives_the_container(tmp_path, repo, real):
    """Contract case: a report written to /tmp/<name> inside the container is
    read back into the run's reports after the container is gone."""
    artifact = _artifact(['sh -c \'echo "{\\"rows\\": 3}" > "$1"\' _ /tmp/out.json --report /tmp/out.json'])
    summary, state, log = _run(tmp_path, artifact, repo=repo, image=REAL_IMAGE)
    assert summary["passed"] == 1, log
    assert state["reports"][0]["status"] == "inlined"
    assert '"rows": 3' in state["reports"][0]["text"]


def _read(path):
    try:
        return path.read_bytes()
    except OSError:
        return b""
