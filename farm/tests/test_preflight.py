"""HO-837: the Preflight step (farm/preflight.py) — a Task's run plan
prerequisites checked on the real runner, as the real run user, observe-only,
before Approve the run. The server half (the gate, the card, the stored
result) is server/test/preflight-gate.test.mjs.

Everything here runs for real — the requires probe is the real bash probe;
a held lock is a real flock a child process holds.
"""

import builtins
import fcntl
import json
import os
import subprocess
import sys
import time

import pytest

from domain.py import run_plan, steps
from farm import job_start, preflight, procfs, run_plan_requires, step_agent, task_job, workspaces
from farm.tests.test_task_steps import REPO_ROOT

FIXTURES = REPO_ROOT / "farm" / "tests" / "fixtures" / "run_plans"
SENTINEL = "hz837-sentinel-value-9c4d"
PF_BLOCKED = ["pf-lock-held", "pf-deploy-running", "pf-artifact-missing", "pf-tool-absent", "pf-runner-missing", "pf-cwd-refused"]


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    (path / "requirements.txt").write_text("grpcio\n")
    return path


@pytest.fixture
def config_root(monkeypatch, tmp_path):
    """A stand-in for /etc/horizon: the only allowed host root outside the checkout."""
    root = tmp_path / "etc-horizon"
    root.mkdir()
    monkeypatch.setattr(run_plan_requires, "ALLOWED_FILE_ROOTS", (str(root),))
    return root


def artifact_of(block: dict) -> str:
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def make_task(repo, block: dict, **overrides) -> dict:
    """A Preflight task as the server and farmd stamp it, for an internal
    Task on the host."""
    artifact = artifact_of(block)
    task = {
        "run_id": 837,
        "attempt": 1,
        "item": {"id": "T-837", "kind": "task", "repo": "acme/ledger"},
        "step": {"key": "task.preflight", "index": steps.step_index_of("task.preflight"), "label": preflight.PREFLIGHT_LABEL, "agent": "DevOps"},
        "plan_artifact": artifact,
        "plan_hash": task_job.plan_hash_of(artifact),
        "runner": "host",
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


def run(task, cap=preflight.CAP_S) -> dict:
    return preflight.run(task, deadline=time.monotonic() + cap)


def names(result: dict) -> set:
    return {u["name"] for u in result["unmet"]}


def tmp_text(value, tmp_path):
    """The fixture with `/__TMP__` pointed at this test's tmp dir."""
    return json.loads(json.dumps(value).replace("/__TMP__", str(tmp_path)))


def pf(name: str, tmp_path) -> dict:
    return tmp_text(json.loads((FIXTURES / f"{name}.json").read_text()), tmp_path)


@pytest.fixture
def held_lock(tmp_path):
    """A child process holding flock on tmp/pf.lock until the test ends."""
    path = tmp_path / "pf.lock"
    path.write_text("")
    child = subprocess.Popen(
        [sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(60)", str(path)],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert child.stdout.readline().strip() == "held"
    yield child
    child.kill()
    child.wait()


def stage_pf(name, tmp_path, *, artifact=False):
    """The host state a fixture is checked against."""
    (tmp_path / "pf.lock").touch()
    if artifact:
        (tmp_path / "upstream").mkdir(exist_ok=True)
        (tmp_path / "upstream" / "prices.csv").write_text("x\n")


# ==== metric 1: the stored plans' missing secrets and inputs, named ====


@pytest.mark.parametrize(
    ("name", "job_env_names", "expected"),
    [
        ("hz514", ["GITHUB_TOKEN"], {"HORIZON_API_TOKEN"}),
        ("hz532", [], {"RECORD_SITE_URL", "RECORD_ITEM"}),
        ("hz533", ["TASK_ITEM"], {"PLAN_ITEM"}),
    ],
)
def test_each_stored_plan_is_blocked_naming_every_missing_secret_or_input(monkeypatch, repo, name, job_env_names, expected):
    for var in expected:
        monkeypatch.delenv(var, raising=False)
    block = json.loads((FIXTURES / f"{name}.json").read_text())
    result = run(make_task(repo, block, job_env_names=job_env_names))
    assert result["passed"] is False
    env_unmet = {u["name"]: u["reason"] for u in result["unmet"] if u["kind"] == "env"}
    for var in expected:
        assert env_unmet.get(var) == "not set in the job's environment", result["unmet"]
    for var in job_env_names:
        assert var not in env_unmet


# ==== metric 2: each new fixture is blocked with its item named ====


@pytest.mark.parametrize("name", PF_BLOCKED)
def test_each_new_fixture_is_blocked_with_its_item_named(name, repo, tmp_path, held_lock):
    doc = pf(name, tmp_path)
    if name == "pf-deploy-running":
        stage_pf(name, tmp_path)
    result = run(make_task(repo, doc["plan"], **doc["task"]))
    assert result["passed"] is False
    assert {"kind": doc["expect"]["kind"], "name": doc["expect"]["name"]} in [{"kind": u["kind"], "name": u["name"]} for u in result["unmet"]], result
    assert not any("not checked" in u["reason"] for u in result["unmet"])


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"deploy_running": {"target": "horizon", "tag": "v9.9.9", "status": "deploying"}}, "a deploy of horizon v9.9.9 is deploying"),
        ({"deploy_state_key": "pf-target", "deploy_lock_held": True}, "the target's deploy.lock is held by a running deploy"),
        ({"deploy_state_key": "pf-target", "deploy_lock_held": None}, "the target's deploy.lock could not be read on the runner"),
    ],
    ids=["server-queue", "deploy-lock", "lock-unreadable"],
)
def test_each_deploy_source_alone_blocks(repo, tmp_path, overrides, reason):
    doc = pf("pf-deploy-running", tmp_path)
    task = make_task(repo, doc["plan"], **overrides)
    result = run(task)
    deploy = [u for u in result["unmet"] if u["kind"] == "deploy"]
    assert [u["reason"] for u in deploy] == [reason]
    # The declared no_deploy_running precondition is named too.
    assert {"kind": "precondition", "name": "no_deploy_running", "reason": reason} in result["unmet"]


def test_no_deploy_source_means_no_deploy_item(repo, tmp_path):
    doc = pf("pf-deploy-running", tmp_path)
    result = run(make_task(repo, doc["plan"], deploy_state_key="pf-target", deploy_lock_held=False))
    assert result == {**result, "passed": True, "unmet": []}


def test_negative_controls_pass_a_released_lock_a_readable_artifact_a_tool_on_path_and_a_matching_tag(repo, tmp_path, held_lock):
    held_lock.kill()
    held_lock.wait()
    stage_pf("pf-all-hold", tmp_path, artifact=True)
    doc = pf("pf-all-hold", tmp_path)
    result = run(make_task(repo, doc["plan"], **doc["task"]))
    assert result["passed"] is True, result["unmet"]
    assert result["unmet"] == []


def test_a_service_tag_mismatch_is_unmet_and_a_non_target_host_must_resolve(repo, tmp_path, monkeypatch):
    # No real DNS: some resolvers answer for any name.
    monkeypatch.setattr(run_plan_requires, "_resolves", lambda host: host == "api.example.com")
    stage_pf("pf-all-hold", tmp_path, artifact=True)
    doc = pf("pf-all-hold", tmp_path)
    result = run(make_task(repo, doc["plan"], service_tags={"pf-target": "v1.2.2"}))
    assert result["unmet"] == [{"kind": "service", "name": "pf-target", "reason": "last-good tag is v1.2.2, and the plan expects v1.2.3"}]
    unresolvable = {"service": {"name": "hz837.invalid", "version_cmd": "curl -fsS https://hz837.invalid/v", "expect": "1"}}
    block = {**doc["plan"], "requires": [{"tool": "bash"}, unresolvable]}
    result = run(make_task(repo, block))
    assert result["unmet"] == [{"kind": "service", "name": "hz837.invalid", "reason": "does not resolve on the runner"}]
    resolvable = {"service": {"name": "api.example.com", "version_cmd": "curl -fsS https://api.example.com/v", "expect": "1"}}
    assert run(make_task(repo, {**block, "requires": [{"tool": "bash"}, resolvable]}))["passed"] is True


def test_a_precondition_preflight_cannot_observe_blocks_and_says_so(repo):
    block = {
        "cwd": ".",
        "commands": ["bash -c 'echo run'"],
        "budget_minutes": 5,
        "requires": [{"precondition": {"kind": "row_exists", "check": "psql \"$RO_DB_URL\" -tAc 'SELECT 1'"}}],
    }
    result = run(make_task(repo, block))
    assert result["unmet"] == [
        {"kind": "precondition", "name": "row_exists", "reason": "preflight cannot observe it without running its check, which it never runs"}
    ]


# ---- the moved Execute refusals refuse in Execute too (drift) ----


def _execute(tmp_path, repo, block, runner):
    artifact = artifact_of(block)
    return task_job.run_job(
        run_id=8,
        item_id="T-837",
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        runner=runner,
        state_path=tmp_path / "job.json",
        log_path=tmp_path / "job.log",
        repo_dir=str(repo),
        env_values={},
    )


def test_pf_cwd_refused_is_refused_by_execute_too(repo, tmp_path):
    doc = pf("pf-cwd-refused", tmp_path)
    summary = _execute(tmp_path, repo, doc["plan"], "host")
    assert summary["run"] == 0
    assert json.loads((tmp_path / "job.json").read_text())["status"] == "cwd_refused"
    assert any(u["kind"] == "cwd" for u in run(make_task(repo, doc["plan"]))["unmet"])


def test_pf_runner_missing_is_refused_by_execute_too(repo, tmp_path):
    doc = pf("pf-runner-missing", tmp_path)
    with pytest.raises(ValueError, match="job runner must be one of host, container"):
        _execute(tmp_path, repo, doc["plan"], None)
    assert any(u["kind"] == "runner" for u in run(make_task(repo, doc["plan"], runner=None))["unmet"])


def test_execute_and_preflight_ask_the_same_start_up_questions():
    """The moved refusals are one function each, called from both sides."""
    for module, name in ((task_job, "job_start_checks"), (preflight, "job_start")):
        source = open(module.__file__).read()
        assert f"{name}.resolve_dirs(" in source
        assert f"{name}.runner_refusal(" in source
    tenant = open(REPO_ROOT / "farm" / "tenant_job.py").read()
    assert "job_start.resolve_dirs(" in tenant and "job_start.tenant_login(" in tenant and "job_start.tenant_runner_refusal(" in tenant
    assert task_job.RUNNERS is job_start.RUNNERS


@pytest.mark.parametrize(
    ("overrides", "kind"),
    [({"jobs_enabled": False}, "jobs"), ({"jobs_enabled": None}, "jobs"), ({"test_env_file": "relative/login.env"}, "login_env")],
    ids=["jobs-off", "jobs-unknown", "login-env"],
)
def test_the_jobs_switch_and_login_env_refusals_move_before_approval(repo, overrides, kind):
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5}
    result = run(make_task(repo, block, **overrides))
    assert [u["kind"] for u in result["unmet"]] == [kind]


def test_a_container_plan_whose_image_is_not_here_is_unmet_and_never_pulled(repo, monkeypatch):
    calls = []
    real = subprocess.run
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: calls.append(list(argv)) or real(argv, **kw))
    monkeypatch.setattr(preflight.container_runner, "available", lambda: True)
    monkeypatch.setattr(preflight.container_runner, "image_present", lambda image: False)
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5, "requires": [{"tool": "bash"}]}
    result = run(make_task(repo, block, runner="container", container_image="localhost/hz837:missing"))
    kinds = {u["kind"] for u in result["unmet"]}
    assert "container" in kinds and result["passed"] is False
    assert not any("pull" in argv for argv in calls)


# ==== metric 3: a host fix, then Re-run preflight, passes ====


def test_a_gap_fixed_on_the_host_passes_on_re_run(repo, tmp_path, monkeypatch):
    doc = pf("pf-tool-absent", tmp_path)
    first = run(make_task(repo, doc["plan"]))
    assert {"kind": "tool", "name": "hz837-absent-tool", "reason": "not on the runner's PATH"} in first["unmet"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    tool = bin_dir / "hz837-absent-tool"
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    second = run(make_task(repo, doc["plan"]))
    assert second["passed"] is True, second["unmet"]


def test_a_fixture_whose_prerequisites_all_hold_passes_on_the_first_run(repo, tmp_path):
    stage_pf("pf-all-hold", tmp_path, artifact=True)
    doc = pf("pf-all-hold", tmp_path)
    assert run(make_task(repo, doc["plan"], **doc["task"]))["passed"] is True


def test_a_plan_that_is_not_the_dispatched_one_is_unmet(repo):
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5}
    result = run(make_task(repo, block, plan_hash="0" * 64))
    assert [u["kind"] for u in result["unmet"]] == ["plan"]


# ==== metric 4: the hz700-a5 file, checked as run_user ====


def _tenant_task(repo_full, block, tmp_path, monkeypatch, **overrides):
    clones = tmp_path / "task-clones"
    monkeypatch.setattr(workspaces, "TENANT_TASK_CLONES_DIR", clones)
    clone = workspaces.tenant_task_clone_path(repo_full)
    (clone / ".git").mkdir(parents=True)
    import pwd

    project = {"id": 7, "isolation": "tenant", "githubTokenRef": "$HZ837_TOKEN", "runUser": pwd.getpwuid(os.geteuid()).pw_name}
    task = make_task(clone, block, project=project, item={"id": "T-837", "kind": "task", "repo": repo_full}, repo_dir=None, **overrides)
    return task, clone


def test_hz700_a5_file_is_checked_as_the_run_user_and_reported_unreadable(repo, tmp_path, config_root, monkeypatch):
    if os.geteuid() == 0:
        pytest.fail("running as root reads a mode-000 file, so this test cannot show the gap: run as a non-root user")
    text = (FIXTURES / "hz700-a5.json").read_text().replace("/etc/horizon", str(config_root))
    block = json.loads(text)
    for name in ("stripe.env", "recorder.env"):
        (config_root / name).write_text(f"KEY={SENTINEL}\n")
        (config_root / name).chmod(0o000)
    try:
        task, _ = _tenant_task("acme/parvati", block, tmp_path, monkeypatch, job_env_names=["HOME", "GITHUB_TOKEN"])
        result = run(task)
    finally:
        for name in ("stripe.env", "recorder.env"):
            (config_root / name).chmod(0o600)
    stripe = str(config_root / "stripe.env")
    files = [u for u in result["unmet"] if u["kind"] == "file"]
    assert {"kind": "file", "name": stripe, "reason": "not readable by the job user"} in files
    # Read through `sudo -n cat`, the recorder file is never the run user's to open.
    assert not any("recorder.env" in u["name"] for u in files)
    for u in result["unmet"]:
        assert "not checked" not in u["reason"] and "cannot be checked" not in u["reason"]
    assert result["run_user"] == task["project"]["runUser"]
    assert SENTINEL not in json.dumps(result)


def test_a_tenant_task_with_no_stamped_uid_is_unmet_run_user(repo, tmp_path, monkeypatch):
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5}
    task, _ = _tenant_task("acme/parvati", block, tmp_path, monkeypatch)
    del task["job_uid"]
    result = run(task)
    assert "run_user" in {u["kind"] for u in result["unmet"]}
    assert result["passed"] is False


def test_a_tenant_task_whose_clone_does_not_exist_is_unmet_run_user_and_none_is_created(tmp_path, monkeypatch, repo):
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5}
    task, clone = _tenant_task("acme/parvati", block, tmp_path, monkeypatch)
    (clone / ".git").rmdir()
    clone.rmdir()
    result = run(task)
    assert [(u["kind"], u["reason"]) for u in result["unmet"]] == [("run_user", "the run user's task clone does not exist yet")]
    assert not clone.exists()


def test_farmd_stamps_a_tenant_preflight_with_the_run_users_uid_and_launches_it_as_the_run_user(tmp_path, monkeypatch):
    from farm import farmd

    monkeypatch.setenv("HZ837_TENANT_TOKEN", SENTINEL)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    launched = []
    monkeypatch.setattr(farmd, "_launch_tenant_session", lambda name, task, root, **kw: launched.append(task))
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda *a, **k: pytest.fail("a tenant Preflight launched as farmd's own user"))
    monkeypatch.setattr(farmd, "_run_user_home", lambda run_user: f"/home/{run_user}")
    monkeypatch.setattr(farmd, "_run_user_uid", lambda run_user: 76999)
    monkeypatch.setattr(preflight, "deploy_lock_held", lambda key: key == "pf-target")
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    project = {"id": 7, "isolation": "tenant", "githubTokenRef": "$HZ837_TENANT_TOKEN", "runUser": "acme_run"}
    task = make_task(tmp_path, {"cwd": ".", "commands": ["echo"], "budget_minutes": 1}, run_id=83701, project=project, deploy_state_key="pf-target")
    for key in ("jobs_enabled", "job_env_names", "job_uid"):
        task.pop(key)
    (runs_dir / "83701.json").write_text(json.dumps(task))
    farmd._claim_and_launch(runs_dir / "83701.json", runs_dir, tmp_path)
    farmd.RUN_SESSIONS.pop("83701", None)
    claimed = (runs_dir / "active" / "83701.json").read_text()
    assert SENTINEL not in claimed
    written = json.loads(claimed)
    assert written["job_uid"] == 76999
    assert written["jobs_enabled"] is True
    assert written["deploy_lock_held"] is True
    assert [t["run_id"] for t in launched] == [83701]


def test_farmd_does_not_stamp_preflight_fields_on_another_step(tmp_path, monkeypatch):
    from farm import farmd
    from farm.tests.test_task_steps import make_task as make_step_task

    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda *a, **k: None)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task = {**make_step_task("Assess"), "run_id": 83702}
    (runs_dir / "83702.json").write_text(json.dumps(task))
    farmd._claim_and_launch(runs_dir / "83702.json", runs_dir, tmp_path)
    farmd.RUN_SESSIONS.pop("83702", None)
    written = json.loads((runs_dir / "active" / "83702.json").read_text())
    assert "jobs_enabled" not in written and "deploy_lock_held" not in written


# ==== guardrail 1: observe-only ====


def _snapshot(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            st = os.lstat(path)
            out[path] = (st.st_mode, st.st_size, st.st_mtime_ns)
    return out


def _own_locks():
    pid = str(os.getpid())
    return sorted(line.split(None, 1)[1] for line in open("/proc/locks").read().splitlines() if line.split()[4:5] == [pid])


def test_preflight_writes_nothing_takes_no_lock_and_runs_no_plan_command(repo, tmp_path, monkeypatch, held_lock):
    home = tmp_path / "home"
    (home / ".horizon").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    stage_pf("pf-all-hold", tmp_path, artifact=True)
    before = (_snapshot(repo), _snapshot(tmp_path), _own_locks())

    argvs = []
    real_run = subprocess.run

    def spy_run(argv, **kwargs):
        argvs.append(list(argv))
        return real_run(argv, **kwargs)

    def refuse(name):
        def fail(*args, **kwargs):
            raise AssertionError(f"preflight called {name}")

        return fail

    real_open = builtins.open

    def read_only_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in "wax+"):
            raise AssertionError(f"preflight opened {file} for writing")
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy_run)
    monkeypatch.setattr(fcntl, "flock", refuse("fcntl.flock"))
    monkeypatch.setattr(fcntl, "lockf", refuse("fcntl.lockf"))
    monkeypatch.setattr(os, "makedirs", refuse("os.makedirs"))
    monkeypatch.setattr(os, "mkdir", refuse("os.mkdir"))
    monkeypatch.setattr(builtins, "open", read_only_open)
    # No model, persona, provider or worktree: each would raise.
    monkeypatch.setattr(step_agent, "run_agent", refuse("run_agent"))
    monkeypatch.setattr(step_agent, "model_persona", refuse("model_persona"))
    monkeypatch.setattr(step_agent, "ensure_item_worktree", refuse("ensure_item_worktree"))
    # HO-839: a passing preflight then asks farmd for the plan's rehearsal,
    # which runs in farmd's sandbox, not here (farm/tests/test_rehearsal.py).
    monkeypatch.setattr(step_agent, "_rehearse", lambda task: {"clean": True, "reason": None, "scope": "full", "seconds": 0, "plan_hash": task["plan_hash"], "failures": []})

    results = []
    for name in ("pf-lock-held", "pf-all-hold"):
        doc = pf(name, tmp_path)
        outcome = step_agent.execute(make_task(repo, doc["plan"], **doc["task"]))
        results.append(outcome["artifacts"]["preflight"])
        held_lock.kill()
        held_lock.wait()
    monkeypatch.undo()

    assert results[0]["passed"] is False and results[1]["passed"] is True, results
    assert (_snapshot(repo), _snapshot(tmp_path), _own_locks()) == before
    for argv in argvs:
        joined = " ".join(argv)
        assert argv[:2] == ["bash", "-c"], argv
        for word in ("flock", "pgrep", "podman", "git", "echo run", "cat VERSION", "test -s"):
            assert word not in joined.replace(run_plan_requires.PROBE_ENV_FILES, "").replace(run_plan_requires.PROBE, ""), argv


def test_import_step_agent_holds_with_preflight_in_the_table_and_it_is_a_code_run_step():
    assert steps.is_code_run("task", preflight.PREFLIGHT_LABEL) is True
    assert steps.is_code_run("task", step_agent.RUN_PLAN_LABEL) is False
    assert steps.is_code_run("change", preflight.PREFLIGHT_LABEL) is False
    assert preflight.PREFLIGHT_LABEL not in step_agent.TASK_STEP_CONFIG


# ==== guardrail 2: the 90 s cap — a timeout or a probe error blocks ====


def test_a_hung_probe_returns_on_time_as_unmet_probe_timed_out(repo, monkeypatch):
    monkeypatch.setattr(run_plan_requires, "check_entries", lambda *a, **k: time.sleep(5))
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5, "requires": [{"tool": "bash"}]}
    started = time.monotonic()
    result = run(make_task(repo, block), cap=0.5)
    assert time.monotonic() - started < 1.5
    assert result["passed"] is False
    assert {"kind": "probe", "name": "requires", "reason": f"timed out: preflight has {preflight.CAP_S}s"} in result["unmet"]


def test_a_probe_error_is_unmet_never_a_pass_and_nothing_says_not_checked(repo, monkeypatch, tmp_path):
    monkeypatch.setattr(run_plan_requires, "check_entries", lambda *a, **k: (_ for _ in ()).throw(run_plan_requires.Unavailable("the requires check failed on the runner")))
    block = {"cwd": ".", "commands": ["bash -c 'echo run'"], "budget_minutes": 5, "requires": [{"tool": "bash"}]}
    result = run(make_task(repo, block))
    assert result["unmet"] == [{"kind": "probe", "name": "requires", "reason": "the requires check failed on the runner"}]
    for name in PF_BLOCKED + ["hz514", "hz532", "hz533"]:
        path = FIXTURES / f"{name}.json"
        doc = tmp_text(json.loads(path.read_text()), tmp_path)
        block = doc.get("plan", doc)
        assert "not checked" not in json.dumps(run(make_task(repo, block, **doc.get("task", {}))))


def test_the_step_table_caps_preflight_at_90_seconds_and_scopes_it_to_tasks():
    (row,) = [s for s in steps.steps_for("task") if s.get("key") == "task.preflight"]
    assert row["timeoutS"] <= preflight.CAP_S == 90
    assert row["itemKind"] == "task" and row["codeRun"] is True and "maxTurns" not in row
    assert all(s.get("key") != "task.preflight" for kind in ("change", "plan") for s in steps.steps_for(kind))
    labels = [s["label"] for s in steps.steps_for("task")]
    assert labels.index(preflight.PREFLIGHT_LABEL) == labels.index("Approve the run") - 1


# ==== guardrail 4: names only — never a value ====


def test_no_secret_value_reaches_the_result_the_artifact_the_log_or_a_probe_argv(repo, tmp_path, config_root, monkeypatch, capsys):
    monkeypatch.setenv("HZ837_SET", SENTINEL)
    readable = config_root / "ok.env"
    readable.write_text(f"TOKEN={SENTINEL}\n")
    block = {
        "cwd": ".",
        "commands": [f"cat {readable}", 'echo "$HZ837_SET"'],
        "budget_minutes": 5,
        "env": {"HZ837_SET": "$HZ837_SET", "HZ837_UNSET": "$HZ837_UNSET"},
        "requires": [{"env": "HZ837_SET"}, {"env": "HZ837_UNSET"}, {"file": str(readable)}],
    }
    argvs = []
    real_run = subprocess.run
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: argvs.append(list(argv)) or real_run(argv, **kw))
    monkeypatch.setattr(preflight, "_deploy_busy", lambda task: (_ for _ in ()).throw(RuntimeError(f"boom {SENTINEL}")))
    outcome = step_agent.execute(make_task(repo, block, job_env_names=["HZ837_SET"]))
    result = outcome["artifacts"]["preflight"]
    assert {"kind": "env", "name": "HZ837_UNSET", "reason": "not set in the job's environment"} in result["unmet"]
    assert {"kind": "probe", "name": "deploy", "reason": "failed (RuntimeError)"} in result["unmet"]
    out, err = capsys.readouterr()
    for text in (json.dumps(result), outcome["artifacts"]["artifact_md"], outcome["summary"], out, err, json.dumps(argvs)):
        assert SENTINEL not in text


def test_render_lists_each_unmet_item_and_summary_counts_them():
    result = {"passed": False, "runner": "host", "run_user": "ubuntu", "unmet": [{"kind": "tool", "name": "jq|x", "reason": "not on the runner's PATH"}]}
    md = preflight.render(result)
    assert "| tool | `jq\\|x` | not on the runner's PATH |" in md
    assert preflight.summary(result) == "preflight found 1 unmet prerequisite on host as ubuntu"
    assert preflight.summary({**result, "passed": True, "unmet": []}) == "preflight passed on host as ubuntu"


def test_held_locks_reads_proc_locks_and_lock_held_never_opens_the_file(tmp_path, held_lock, monkeypatch):
    assert procfs.lock_held(str(tmp_path / "pf.lock")) is True
    assert procfs.lock_held(str(tmp_path / "missing.lock")) is False
    free = tmp_path / "free.lock"
    free.write_text("")
    assert procfs.lock_held(str(free)) is False
    assert preflight.deploy_lock_held("../etc") is False and preflight.deploy_lock_held("") is False
