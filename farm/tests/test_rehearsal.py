"""HO-839: a Task run plan's rehearsal, in a side-effect-free sandbox, before
anyone can approve the run (farm/rehearsal.py, farmd's /internal/rehearsal,
the Preflight step's hook in farm/step_agent.py).

Two tiers, as in test_container_runner.py. The fake tier runs everywhere
through conftest's fake_podman: the sandbox argv, the 210 s cap, the pull
kept outside it, the no-fallback refusals, the step-to-farmd linkage and the
pre-pull route. fake_podman confines nothing, so the sandbox itself (metric
lines 1-5, the tenant and `host` runners) is proven by the `real_podman`
tests, which need `podman`, HORIZON_TEST_PODMAN_IMAGE and — for the database
lines — HORIZON_TEST_PG_IMAGE (a Postgres image with psql; pulled on first
use). Without them they skip with the reason; with FARM_REQUIRE_REAL_SANDBOX=1
(the gate host) they FAIL instead, so a skip can never pass for a proof.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from domain.py import run_plan, steps
from farm import container_runner, db_changes, farmd, preflight, rehearsal, step_agent, task_job
from farm.agent_runner import AgentError
from farm.config import QUEUE_DIR

TESTS_DIR = Path(__file__).resolve().parent
REPLAY_DIR = TESTS_DIR / "fixtures" / "run_plans" / "replay"
REPLAYS = sorted(p.stem for p in REPLAY_DIR.glob("*.json"))
FAKE_IMAGE = "localhost/horizon-rehearsal:fake"
REAL_PODMAN = shutil.which("podman")
REAL_IMAGE = os.environ.get("HORIZON_TEST_PODMAN_IMAGE", "docker.io/library/python:3.12-slim")
PG_IMAGE = os.environ.get("HORIZON_TEST_PG_IMAGE", "docker.io/library/postgres:16-alpine")
REQUIRE_REAL = os.environ.get("FARM_REQUIRE_REAL_SANDBOX") == "1"
SECRET = "hz839-planted-secret-7f3a"
STDERR_MARK = "hz839-planted-stderr-c41d"

client = TestClient(farmd.app)


# ---- helpers ----


def artifact_of(block: dict) -> str:
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def make_repo(tmp_path, files: dict) -> Path:
    """A committed checkout holding `files` — `git status --porcelain` empty."""
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    for rel, text in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "seed")
    assert git(repo, "status", "--porcelain") == ""
    return repo


def replay(name: str) -> dict:
    return json.loads((REPLAY_DIR / f"{name}.json").read_text())


def plan(commands, *, rehearsal_block=None, proof=None, runner="host", **extra) -> dict:
    block = {"cwd": ".", "commands": list(commands), "budget_minutes": 5, "runner": runner, **extra}
    if proof is not None:
        block["proof"] = proof
    if rehearsal_block is not None:
        block["rehearsal"] = rehearsal_block
    run_plan.validate(block)
    return block


def rehearse(block, repo, *, image=FAKE_IMAGE, scope="full", runner=None, **kwargs) -> dict:
    return rehearsal.run(
        block,
        plan_hash="h-839",
        scope=scope,
        repo_dir=str(repo) if scope == "full" else None,
        cwd=str(repo) if scope == "full" else None,
        runner=runner or block.get("runner", "host"),
        image=image,
        item_id="T-839",
        **kwargs,
    )


@pytest.fixture
def captured(monkeypatch):
    """Every `podman run -d` argv a rehearsal starts, and its client env."""
    seen = []
    real_start = container_runner.start_container

    def spy(argv, env):
        seen.append({"argv": list(argv), "env": dict(env)})
        return real_start(argv, env)

    monkeypatch.setattr(container_runner, "start_container", spy)
    return seen


def mounts(argv) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]


def env_flags(argv) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv) if a == "--env"]


def no_leftover_containers():
    state = Path(os.environ["FARM_FAKE_PODMAN_DIR"])
    return not state.is_dir() or not list(state.glob(f"{container_runner.REHEARSAL_PREFIX}*.json"))


def preflight_task(repo, block, **overrides) -> dict:
    """A Preflight task as the server and farmd stamp it (test_preflight.py's)."""
    artifact = artifact_of(block)
    task = {
        "run_id": 839,
        "attempt": 1,
        "item": {"id": "T-839", "kind": "task", "repo": "acme/ledger"},
        "step": {"key": "task.preflight", "index": steps.step_index_of("task.preflight"), "label": preflight.PREFLIGHT_LABEL, "agent": "DevOps"},
        "plan_artifact": artifact,
        "plan_hash": task_job.plan_hash_of(artifact),
        "runner": block.get("runner", "host"),
        "repo_dir": str(repo),
        "venv_dir": None,
        "container_image": None,
        "deploy_running": None,
        "service_tags": {},
        "jobs_enabled": True,
        "job_env_names": [],
        "job_uid": os.geteuid(),
    }
    task.update(overrides)
    return task


@pytest.fixture
def active_task():
    """Writes a claimed Preflight task where farmd finds it; removed after."""
    written = []

    def put(task):
        path = QUEUE_DIR / "runs" / "active" / f"{task['run_id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(task))
        written.append(path)
        return task

    yield put
    for path in written:
        path.unlink(missing_ok=True)


def route_to_farmd(monkeypatch):
    """step_agent's farmd calls go to farmd's app in-process."""

    def post(url, json=None, timeout=None):
        assert url.endswith("/internal/rehearsal"), url
        res = client.post("/internal/rehearsal", json=json)
        return httpx.Response(res.status_code, content=res.content, headers={"content-type": "application/json"})

    monkeypatch.setattr(step_agent.httpx, "post", post)


# ==== the sandbox argv — guardrail 1 (sandbox only, no fallback) ====


def test_the_sandbox_has_no_network_a_read_only_image_and_only_tmp_writable(tmp_path, captured):
    repo = make_repo(tmp_path, {"day1.json": "{}\n", ".env": "LIVE_DB_URL=postgres://live\n", "sub/.env": "X=1\n"})
    block = plan(
        ["echo run", "echo 3"],
        env={"LIVE_DB_URL": "$LIVE_DB_URL"},
        proof=[{"line": 1, "command": 2}],
        rehearsal_block={"dry_run": "echo dry", "limit": 5, "ro_env": ["RO_DB_URL"], "samples": [{"command": 2, "expect": "3"}]},
    )
    result = rehearse(block, repo, ro_values={"RO_DB_URL": "ro-value-839", "LIVE_DB_URL": "postgres://live"}, pg_socket=str(tmp_path))
    assert result["clean"] is True, result
    (run,) = captured
    argv = run["argv"]
    assert argv[1:4] == ["run", "-d", "--rm"]
    assert "--network=none" in argv and "--read-only" in argv and "--read-only-tmpfs=false" in argv
    assert any(a.startswith("--timeout=") for a in argv)
    for refused in ("--privileged", "--network=host", "--env-file", "--cap-add"):
        assert not any(a.startswith(refused) for a in argv), refused
    assert [a for a in argv if a.startswith("--tmpfs")] == [f"--tmpfs={container_runner.REHEARSAL_TMPFS}"]
    # Every mount read-only: the checkout, each .env mask and the socket dir.
    assert mounts(argv) and all(m.endswith(":ro") for m in mounts(argv)), mounts(argv)
    assert f"{repo}:{repo}:ro" in mounts(argv)
    assert {m.split(":")[1] for m in mounts(argv) if m.split(":")[1].endswith(".env")} == {str(repo / ".env"), str(repo / "sub" / ".env")}
    assert f"{tmp_path}:{tmp_path}:ro" in mounts(argv)
    assert not any("podman.sock" in m or "/state" in m.split(":")[1] or "/logs" in m.split(":")[1] for m in mounts(argv))
    # Only the ro_env name, by name; never a live `env` name, never a value in argv.
    names = env_flags(argv)
    assert "RO_DB_URL" in names and "LIVE_DB_URL" not in names
    assert f"PGOPTIONS={container_runner.READ_ONLY_PGOPTIONS}" in names and "REHEARSAL_LIMIT=5" in names
    assert "postgres://live" not in " ".join(argv) and "ro-value-839" not in " ".join(argv)
    assert "LIVE_DB_URL" not in run["env"]
    assert argv[0] == container_runner.podman_bin() and argv[-3:] == [FAKE_IMAGE, "sleep", "infinity"]
    assert argv[argv.index("--name") + 1].startswith(container_runner.REHEARSAL_PREFIX)
    assert no_leftover_containers()


def test_a_host_plan_gets_the_host_tool_dirs_read_only_and_a_container_plan_none(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    block = plan(["echo 1"], proof=[{"line": 1, "command": 1}], rehearsal_block={"samples": [{"command": 1, "expect": "1"}]})
    assert rehearse(block, repo, venv_dir=str(venv))["clean"] is True
    assert rehearse({**block, "runner": "container"}, repo, runner="container")["clean"] is True
    host_mounts, container_mounts = mounts(captured[0]["argv"]), mounts(captured[1]["argv"])
    real_dirs = [d for d in container_runner.HOST_TOOL_DIRS if os.path.isdir(d) and not os.path.islink(d)]
    assert real_dirs and all(f"{d}:{d}:ro" in host_mounts for d in real_dirs)
    assert f"{venv}:{venv}:ro" in host_mounts
    assert not any(m.startswith(("/usr:", "/opt:")) for m in container_mounts)


def test_a_missing_podman_raises_and_runs_nothing_unsandboxed(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    marker = tmp_path / "ran"
    block = plan([f"touch {marker}"], proof=[{"line": 1, "command": 1}], rehearsal_block={"dry_run": f"touch {marker}", "samples": [{"command": 1, "expect": "x"}]})
    monkeypatch.setenv("FARM_PODMAN_BIN", str(tmp_path / "no-podman-here"))
    with pytest.raises(container_runner.Unavailable):
        rehearse(block, repo)
    assert not marker.exists()


def test_a_container_that_will_not_start_raises_and_the_step_fails_with_no_clean_result(tmp_path, monkeypatch, active_task):
    """R4: farmd answers 503 sandbox_unavailable; the Preflight step raises
    AgentError (a failed run) and never returns a rehearsal result."""
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(["echo 1"], proof=[{"line": 1, "command": 1}], rehearsal_block={"samples": [{"command": 1, "expect": "1"}]})
    task = active_task(preflight_task(repo, block, run_id=8391, container_image="localhost/broken:missing"))
    monkeypatch.setattr(preflight, "run", lambda task, deadline: {"passed": True, "runner": "host", "run_user": "farm", "plan_hash": task["plan_hash"], "unmet": []})
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", "localhost/broken:missing")
    route_to_farmd(monkeypatch)
    with pytest.raises(AgentError, match="the rehearsal sandbox could not start"):
        step_agent.execute(task)


# ==== the step-to-farmd linkage — metric line 1's farm half ====


def test_a_broken_proof_parser_reaches_the_step_result_as_not_clean(tmp_path, monkeypatch, active_task):
    """R4: the Preflight step, farmd's route and the rehearsal together — a
    jq path that fails comes back in artifacts.rehearsal, reason ids only."""
    if not shutil.which("jq"):
        pytest.skip("jq is not on this host")
    repo = make_repo(tmp_path, {"day1.json": '{"priced": [1, 2, 3]}\n'})
    block = plan(
        ["echo load", "jq -e '.priced.nope.length' day1.json"],
        proof=[{"line": 1, "command": 2}],
        rehearsal_block={"dry_run": "echo would load", "samples": [{"command": 2, "expect": "3"}]},
    )
    task = active_task(preflight_task(repo, block, run_id=8392))
    monkeypatch.setattr(preflight, "run", lambda task, deadline: {"passed": True, "runner": "host", "run_user": "farm", "plan_hash": task["plan_hash"], "unmet": []})
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", FAKE_IMAGE)
    route_to_farmd(monkeypatch)
    outcome = step_agent.execute(task)
    got = outcome["artifacts"]["rehearsal"]
    assert got["clean"] is False and got["reason"] == rehearsal.PARSER_FAILED, got
    assert got["failures"][0]["what"] == "proof command 2 (metric line 1)" and got["plan_hash"] == task["plan_hash"]
    assert "## Rehearsal" in outcome["artifacts"]["artifact_md"] and "rehearsal_parser_failed" in outcome["summary"]


def test_an_unmet_preflight_never_asks_for_a_rehearsal(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(["echo 1"])
    monkeypatch.setattr(preflight, "run", lambda task, deadline: {"passed": False, "runner": "host", "run_user": "farm", "plan_hash": task["plan_hash"], "unmet": [{"kind": "tool", "name": "jq", "reason": "missing"}]})
    monkeypatch.setattr(step_agent, "_rehearse", lambda task: pytest.fail("rehearsed after an unmet preflight"))
    outcome = step_agent.execute(preflight_task(repo, block))
    assert "rehearsal" not in outcome["artifacts"]


def test_farmd_rehearses_only_an_active_preflight_run_it_was_sent(tmp_path, active_task):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(["echo 1"])
    assert client.post("/internal/rehearsal", json={"run_id": 99999}).status_code == 404
    assert client.post("/internal/rehearsal", json={"run_id": "839"}).status_code == 404
    other = preflight_task(repo, block, run_id=8393)
    other["step"] = {**other["step"], "label": "Run plan"}
    active_task(other)
    assert client.post("/internal/rehearsal", json={"run_id": 8393}).status_code == 404
    tampered = active_task(preflight_task(repo, block, run_id=8394, plan_hash="0" * 64))
    res = client.post("/internal/rehearsal", json={"run_id": tampered["run_id"]})
    assert res.status_code == 400 and res.json()["error"] == "rehearsal_refused"


def test_a_plan_with_nothing_to_rehearse_is_not_clean(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    result = rehearse(plan(["echo 1"]), repo)
    assert result == {"clean": False, "reason": rehearsal.MISSING, "scope": "full", "seconds": 0, "plan_hash": "h-839", "failures": [{"what": "rehearsal", "reason": rehearsal.MISSING, "exit": None}]}
    assert captured == []


# ==== guardrail 2: the 210 s cap — a timeout blocks; the pull is outside it ====


def test_the_cap_is_210_seconds_and_running_past_it_is_a_timeout_never_clean(tmp_path):
    assert rehearsal.CAP_S == 210
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(["echo 1"], proof=[{"line": 1, "command": 1}], rehearsal_block={"dry_run": "sleep 30", "samples": [{"command": 1, "expect": "1"}]})
    started = time.monotonic()
    result = rehearse(block, repo, cap_s=1)
    assert time.monotonic() - started < 20
    assert result["clean"] is False and result["reason"] == rehearsal.TIMEOUT, result
    assert no_leftover_containers()


def test_a_slow_image_pull_does_not_count_toward_the_cap(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(["echo 1"], proof=[{"line": 1, "command": 1}], rehearsal_block={"dry_run": "true", "samples": [{"command": 1, "expect": "1"}]})
    monkeypatch.setenv("FAKE_PODMAN_PULL_DELAY", "3")
    started = time.monotonic()
    result = rehearse(block, repo, image="localhost/pull-me:839", cap_s=2)
    assert time.monotonic() - started >= 3
    assert result["clean"] is True, result
    assert result["seconds"] < 3


# ==== guardrail 4: names only — a value or output never leaves ====


def test_a_planted_secret_and_planted_output_appear_in_no_result_render_or_log(tmp_path, captured, active_task, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"a.txt": "x\n", ".env": f"RO_TOKEN={SECRET}\n"})
    block = plan(
        ["echo run", f"echo {STDERR_MARK} >&2; echo $RO_TOKEN; exit 4"],
        proof=[{"line": 1, "command": 2}],
        rehearsal_block={"dry_run": f"echo {STDERR_MARK}-dry >&2; echo $RO_TOKEN; exit 3", "ro_env": ["RO_TOKEN"], "samples": [{"command": 2, "expect": "x"}]},
    )
    task = active_task(preflight_task(repo, block, run_id=8395))
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", FAKE_IMAGE)
    res = client.post("/internal/rehearsal", json={"run_id": task["run_id"]})
    assert res.status_code == 200, res.text
    got = res.json()["rehearsal"]
    assert got["clean"] is False and {f["reason"] for f in got["failures"]} == {rehearsal.DRY_RUN_FAILED, rehearsal.PARSER_FAILED}
    # The value reached the sandbox by name only — it was resolved, then held in the client env.
    assert captured[0]["env"].get("RO_TOKEN") == SECRET and SECRET not in " ".join(captured[0]["argv"])
    surfaces = [json.dumps(got), rehearsal.render(got), rehearsal.summary(got), capsys.readouterr().out]
    for text in surfaces:
        assert SECRET not in text and STDERR_MARK not in text


# ==== R12: the pre-pull route ====


def test_images_pull_queues_once_then_says_in_progress_and_refuses_a_bad_image(monkeypatch):
    monkeypatch.setenv("FAKE_PODMAN_PULL_DELAY", "2")
    first = client.post("/images/pull", json={"image": "localhost/pull-me:hz839"})
    assert (first.status_code, first.json()) == (202, {"queued": True})
    again = client.post("/images/pull", json={"image": "localhost/pull-me:hz839"})
    assert (again.status_code, again.json()) == (200, {"queued": False, "reason": "pull_in_progress"})
    for bad in ("", "   ", "a b", "x" * 501, None, 7):
        res = client.post("/images/pull", json={"image": bad})
        assert (res.status_code, res.json()) == (400, {"error": "bad_image"}), bad
    for _ in range(100):
        if not farmd._PULLING:
            break
        time.sleep(0.1)
    assert not farmd._PULLING


# ==== the real sandbox: metric lines 1-5, tenant and host runners ====


def _need(reason: str | None):
    """Skip, or with FARM_REQUIRE_REAL_SANDBOX=1 fail: a skip is never a pass."""
    if reason is None:
        return
    if REQUIRE_REAL:
        pytest.fail(f"FARM_REQUIRE_REAL_SANDBOX=1 but {reason}")
    pytest.skip(reason)


def _image_ready(image: str) -> str | None:
    if not REAL_PODMAN:
        return "podman is not installed on this host — NOT verified"
    found = subprocess.run([REAL_PODMAN, "image", "exists", image], capture_output=True)
    if found.returncode != 0:
        try:
            found = subprocess.run([REAL_PODMAN, "pull", "--quiet", image], capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            return f"image {image} could not be pulled in 600s — NOT verified"
    return None if found.returncode == 0 else f"image {image} could not be pulled — NOT verified"


@pytest.fixture
def real(monkeypatch):
    _need(_image_ready(REAL_IMAGE))
    monkeypatch.setenv("FARM_PODMAN_BIN", REAL_PODMAN)
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", REAL_IMAGE)
    return REAL_PODMAN


@pytest.fixture
def pg(real):
    """A throwaway Postgres on a Unix socket only (no TCP), from PG_IMAGE:
    `owner` (a superuser) owns table `prices` with 3 rows; `ro` may only
    SELECT it. The socket dir is the same path on the host and in the
    sandbox, so one DSN works on both sides."""
    _need(_image_ready(PG_IMAGE))
    try:
        import psycopg  # noqa: F401
    except ImportError:
        _need("psycopg is not installed in the farm venv — NOT verified")
    sock = tempfile.mkdtemp(prefix="hz839pg-")
    os.chmod(sock, 0o777)
    name = f"hz839-pg-{os.getpid()}-{int(time.monotonic() * 1000) % 100000}"
    started = subprocess.run(
        [
            REAL_PODMAN, "run", "-d", "--rm", "--name", name, "--network=none", "--userns=keep-id", "--user", f"{os.getuid()}:{os.getgid()}",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=owner", "-e", "PGDATA=/tmp/pgdata", "--tmpfs", "/tmp",
            "-v", f"{sock}:/var/run/postgresql", PG_IMAGE, "-c", "listen_addresses=",
        ],
        capture_output=True,
        text=True,
    )
    if started.returncode != 0:
        shutil.rmtree(sock, ignore_errors=True)
        _need(f"the Postgres container did not start ({started.stderr.strip()[:200]}) — NOT verified")
    owner = f"host={sock} user=owner dbname=owner"
    ro = f"host={sock} user=ro dbname=owner"
    try:
        deadline = time.monotonic() + 90
        while True:
            logs = subprocess.run([REAL_PODMAN, "logs", name], capture_output=True, text=True)
            if "init process complete" in logs.stdout + logs.stderr and db_changes.role_can_write(owner) is not None:
                break
            if time.monotonic() > deadline:
                pytest.fail("the Postgres container never became ready")
            time.sleep(0.5)
        import psycopg

        with psycopg.connect(owner, autocommit=True) as conn:
            conn.execute("CREATE TABLE prices (cusip text)")
            conn.execute("INSERT INTO prices VALUES ('912810UT3'), ('912810US5'), ('91282CQK0')")
            conn.execute("CREATE ROLE ro LOGIN")
            conn.execute("GRANT SELECT ON prices TO ro")
        yield {"sock": sock, "owner": owner, "ro": ro, "image": PG_IMAGE}
    finally:
        subprocess.run([REAL_PODMAN, "rm", "-f", name], capture_output=True)
        shutil.rmtree(sock, ignore_errors=True)


def rows(conn_value) -> int:
    return db_changes.snapshot(conn_value, ["prices"])["tables"]["prices"]["rows"]


def test_real_metric_1_a_replay_plan_with_a_broken_jq_path_fails_rehearsal(tmp_path, real):
    doc = replay("replay-prices")
    repo = make_repo(tmp_path, doc["files"])
    good = rehearse(doc["plan"], repo, image=REAL_IMAGE)
    assert good["clean"] is True, good
    broken = json.loads(json.dumps(doc["plan"]))
    broken["commands"][1] = "jq -e '.priced.cusips | length' fixtures/day1.json"
    result = rehearse(broken, repo, image=REAL_IMAGE)
    assert result["clean"] is False and result["reason"] == rehearsal.PARSER_FAILED, result
    assert result["failures"] == [{"what": "proof command 2 (metric line 1)", "reason": rehearsal.PARSER_FAILED, "exit": 5}]


def test_real_metric_2_an_insert_is_refused_as_rehearsal_write_refused_and_no_row_changes(tmp_path, pg, monkeypatch):
    repo = make_repo(tmp_path, {"README": "x\n"})
    monkeypatch.setenv("RO_PRICES_URL", pg["ro"])
    block = plan(
        ["echo load", 'psql "$RO_PRICES_URL" -tAc "SELECT count(*) FROM prices"'],
        runner="container",
        proof=[{"line": 1, "command": 2}],
        db_changes={"connection": "$PRICES_URL", "tables": ["prices"]},
        env={"PRICES_URL": "$PRICES_URL"},
        rehearsal_block={"dry_run": "psql \"$RO_PRICES_URL\" -c \"INSERT INTO prices VALUES ('X')\"", "ro_env": ["RO_PRICES_URL"], "samples": [{"command": 2, "expect": "3"}]},
    )
    before = rows(pg["owner"])
    result = rehearse(block, repo, image=pg["image"], ro_values={"RO_PRICES_URL": pg["ro"]}, pg_socket=pg["sock"])
    assert result["clean"] is False and result["reason"] == rehearsal.WRITE_REFUSED, result
    assert result["failures"] == [{"what": "dry run", "reason": rehearsal.WRITE_REFUSED, "exit": 1}]
    assert rows(pg["owner"]) == before == 3


def test_real_metric_2_a_set_bypass_is_caught_and_a_writable_role_is_refused_before_any_command(tmp_path, pg):
    repo = make_repo(tmp_path, {"README": "x\n"})
    bypass = "psql \"$RO_PRICES_URL\" -c 'SET default_transaction_read_only = off' -c \"INSERT INTO prices VALUES ('X')\""
    block = plan(
        ["echo load", 'psql "$RO_PRICES_URL" -tAc "SELECT count(*) FROM prices"'],
        runner="container",
        proof=[{"line": 1, "command": 2}],
        rehearsal_block={"dry_run": bypass, "ro_env": ["RO_PRICES_URL"], "samples": [{"command": 2, "expect": "3"}]},
    )
    result = rehearse(block, repo, image=pg["image"], ro_values={"RO_PRICES_URL": pg["ro"]}, pg_socket=pg["sock"])
    assert result["clean"] is False, result
    assert rows(pg["owner"]) == 3
    # The superuser behind the same name is refused before the dry run runs.
    result = rehearse(block, repo, image=pg["image"], ro_values={"RO_PRICES_URL": pg["owner"]}, pg_socket=pg["sock"])
    assert result["failures"] == [{"what": "ro_env connection 1", "reason": rehearsal.WRITABLE_ROLE, "exit": None}], result
    assert rows(pg["owner"]) == 3


def test_real_metric_3_writes_to_the_checkout_and_git_are_refused_and_porcelain_stays_empty(tmp_path, real):
    doc = replay("replay-accounts")
    repo = make_repo(tmp_path, doc["files"])
    block = json.loads(json.dumps(doc["plan"]))
    block["rehearsal"]["dry_run"] = "echo x > fixtures/accounts.csv; touch .git/hz839; echo would update"
    result = rehearse(block, repo, image=REAL_IMAGE)
    assert result["clean"] is False and result["reason"] == rehearsal.CHECKOUT_WRITE_REFUSED, result
    assert result["failures"] == [{"what": "dry run", "reason": rehearsal.CHECKOUT_WRITE_REFUSED, "exit": 0}]
    assert git(repo, "status", "--porcelain") == ""
    assert not (repo / ".git" / "hz839").exists() and (repo / "fixtures" / "accounts.csv").read_text().startswith("id,name")


def _host_ip() -> tuple[int, str] | None:
    """(family, address) of a non-loopback address of this host — IPv4 if it
    has one, else IPv6. Nothing is sent: a UDP connect only picks a route."""
    for family, probe in ((socket.AF_INET, ("10.255.255.255", 1)), (socket.AF_INET6, ("2001:db8::1", 1))):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect(probe)
                ip = s.getsockname()[0]
        except OSError:
            continue
        if not ip.startswith("127.") and ip != "::1":
            return family, ip
    return None


def test_real_metric_4_the_probe_sees_every_ro_env_name_no_live_env_name_and_cannot_connect_out(tmp_path, real, monkeypatch):
    found = _host_ip()
    _need(None if found else "this host has no non-loopback address — NOT verified")
    family, ip = found
    listener = socket.socket(family, socket.SOCK_STREAM)
    listener.bind((ip, 0))
    listener.listen(8)
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    accepted = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except OSError:
                continue
            accepted.append(1)
            conn.close()

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        # Control: the host itself reaches the listener.
        socket.create_connection((ip, port), timeout=2).close()
        for _ in range(20):
            if accepted:
                break
            time.sleep(0.1)
        assert accepted == [1]
        # The live env name is set where the farm resolves from, so its absence means something.
        monkeypatch.setenv("LIVE_API_TOKEN", SECRET)
        repo = make_repo(tmp_path, {".env": f"LIVE_API_TOKEN={SECRET}\n"})
        probe_names = 'for n in RO_A RO_B; do printenv "$n" >/dev/null || exit 9; done; printenv LIVE_API_TOKEN >/dev/null && exit 8; echo names-ok'
        probe_net = f"python3 -c 'import socket; socket.create_connection((\"{ip}\", {port}), timeout=3)' 2>/dev/null && echo reached || echo blocked"
        block = plan(
            ["echo run", probe_names, probe_net],
            runner="container",
            env={"LIVE_API_TOKEN": "$LIVE_API_TOKEN"},
            proof=[{"line": 1, "command": 2}, {"line": 2, "command": 3}],
            rehearsal_block={"ro_env": ["RO_A", "RO_B"], "samples": [{"command": 2, "expect": "names-ok"}, {"command": 3, "expect": "blocked"}]},
        )
        result = rehearse(block, repo, image=REAL_IMAGE, runner="container", ro_values={"RO_A": "a-839", "RO_B": "b-839", "LIVE_API_TOKEN": SECRET})
        assert result["clean"] is True, result
        time.sleep(0.5)
        assert accepted == [1], "the sandbox reached the host's listener"
        assert SECRET not in json.dumps(result)
    finally:
        stop.set()
        thread.join(timeout=2)
        listener.close()


def test_real_metric_5_each_replay_plan_finishes_preflight_plus_rehearsal_in_300s(tmp_path, real, monkeypatch):
    assert REPLAYS == ["replay-accounts", "replay-prices", "replay-report"]
    for name in REPLAYS:
        doc = replay(name)
        repo = make_repo(tmp_path / name, doc["files"])
        block = doc["plan"]
        image = REAL_IMAGE if block["runner"] == "container" else None
        task = preflight_task(repo, block, container_image=image, job_env_names=sorted(os.environ))
        started = time.monotonic()
        checked = preflight.run(task, deadline=time.monotonic() + preflight.CAP_S)
        assert checked["passed"] is True, (name, checked)
        result = rehearse(block, repo, image=rehearsal.image_for(block["runner"], image))
        elapsed = time.monotonic() - started
        assert result["clean"] is True, (name, result)
        assert result["seconds"] <= rehearsal.CAP_S and elapsed <= 300, (name, elapsed)


def test_real_a_tenant_rehearsal_starts_a_sandbox_as_the_farm_user_with_nothing_of_the_tenant_mounted(tmp_path, real, captured, active_task):
    """R13: farmd rehearses a tenant Task itself (scope `samples`): the
    sandbox starts, no tenant path is mounted, and nothing runs — a proof
    that would fail if run (exit 7) passes, one that does not parse fails."""
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    block = plan(
        ["echo run", "jq -e '.priced' /nowhere/day1.json; exit 7", "if then fi ("],
        proof=[{"line": 1, "command": 2}, {"line": 2, "command": 3}],
        rehearsal_block={"dry_run": "touch /tmp/hz839", "samples": [{"command": 2, "expect": "3"}, {"command": 3, "expect": "x"}]},
    )
    project = {"id": 8, "name": "acme", "isolation": "tenant", "runUser": "hz-p8", "githubTokenRef": "env:ACME_TOKEN"}
    task = active_task(preflight_task(repo, block, run_id=8396, project=project))
    res = client.post("/internal/rehearsal", json={"run_id": task["run_id"]})
    assert res.status_code == 200, res.text
    got = res.json()["rehearsal"]
    assert got["scope"] == "samples"
    assert got["failures"] == [{"what": "proof command 3 (metric line 2)", "reason": rehearsal.PARSER_FAILED, "exit": 2}], got
    (run,) = captured
    assert mounts(run["argv"]) == [] and "--network=none" in run["argv"] and "--read-only" in run["argv"]
    assert str(repo) not in " ".join(run["argv"])


def test_real_a_host_plan_runs_a_host_tool_and_a_write_under_a_host_dir_is_denied(tmp_path, real):
    """R14: the rehearsal image has no jq; the host's, mounted read-only, runs."""
    no_jq = subprocess.run([REAL_PODMAN, "run", "--rm", "--network=none", REAL_IMAGE, "sh", "-c", "command -v jq"], capture_output=True)
    assert no_jq.returncode != 0, "the rehearsal image has its own jq, so this proves nothing"
    if not os.path.exists("/usr/bin/jq"):
        _need("this host has no /usr/bin/jq — NOT verified")
    doc = replay("replay-prices")
    repo = make_repo(tmp_path, doc["files"])
    assert rehearse(doc["plan"], repo, image=REAL_IMAGE)["clean"] is True
    block = json.loads(json.dumps(doc["plan"]))
    block["rehearsal"]["dry_run"] = "touch /usr/hz839 || exit 1"
    result = rehearse(block, repo, image=REAL_IMAGE)
    assert result["failures"] == [{"what": "dry run", "reason": rehearsal.CHECKOUT_WRITE_REFUSED, "exit": 1}], result
    assert not os.path.exists("/usr/hz839")
