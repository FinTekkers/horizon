"""HZ-772: a tenant Task's Execute step runs as its project's run_user.

farmd no longer refuses a tenant job step. It spools the tenant session env
with `entry: job` and launches farm.tenant_launch in farm-job-<item>, exactly
as an agent step (HZ-663/758); tenant-entry execs farm.tenant_job as the run
user, which clones its own task clone, resolves the plan's env from its own
.env, test-env file and session env, and runs farm.task_job. State and log go
to TENANT_JOBS_DIR/<project id>, which farmd's reaper, views and log route
read instead of its own STATE_DIR and LOGS_DIR.

The journey runs every half in this process: /steps/run, tenant_launch,
tenant-entry and tenant_job (with os.environ swapped for the spool's env),
then farmd's reaper. Only `git clone https://github.com/…` is redirected to a
local bare origin."""

import importlib.machinery
import importlib.util
import io
import json
import os
import shlex
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from domain.py import reasons, run_plan, steps
from farm import config, credentials, farmd, task_job, tenant_job, tenant_launch, workspaces
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

client = TestClient(farmd.app)
loopback = TestClient(farmd.app, client=("127.0.0.1", 50000))

REPO_ROOT = Path(__file__).resolve().parents[2]
EXECUTE = steps.by_kind_label("task", "Execute")["index"]

A_TOKEN = "acme-job-token-sentinel-77201"
B_TOKEN = "beta-job-token-sentinel-77202"
SHARED_TOKEN = "shared-farm-token-sentinel-77203"
FARM_SECRET = "farm-shared-secret-sentinel-77204"
LOGIN_VALUE = "login-file-value-sentinel-77205"
NEVER_SEEN = (A_TOKEN, B_TOKEN, SHARED_TOKEN, FARM_SECRET, LOGIN_VALUE)

FARMD_ENV = {
    "ACME_GITHUB_TOKEN": A_TOKEN,
    "B_GITHUB_TOKEN": B_TOKEN,
    "GITHUB_TOKEN": SHARED_TOKEN,
    "FARM_SHARED_SECRET": FARM_SECRET,
    "PATH": "/usr/local/bin:/usr/bin:/bin",
}

# The plan prints what its env holds; the log must show none of it.
COMMANDS = [
    'echo "GT=$GITHUB_TOKEN LK=$SCREENSHOT_LOGIN_KEY SH=${FARM_SHARED_SECRET:-unset}"',
    "echo hi from $(pwd)",
]
ENV_BLOCK = {"GITHUB_TOKEN": "$GITHUB_TOKEN", "SCREENSHOT_LOGIN_KEY": "$SCREENSHOT_LOGIN_KEY", "FARM_SHARED_SECRET": "$FARM_SHARED_SECRET"}


def artifact(cwd=".", commands=COMMANDS):
    return "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(
        {"cwd": cwd, "commands": list(commands), "budget_minutes": 1, "env": ENV_BLOCK}
    ) + "\n"


def make_job(host, run_id, *, project_id=7, run_user="acme_run", ref="$ACME_GITHUB_TOKEN", item_id="AC-77", cwd=".", runner="host"):
    plan = artifact(cwd)
    return {
        "run_id": run_id,
        "project": {"id": project_id, "name": f"P{project_id}", "isolation": "tenant", "githubTokenRef": ref, "runUser": run_user},
        "item": {"id": item_id, "kind": "task", "title": "t", "repo": f"acme/site{project_id}"},
        "step": {"index": EXECUTE, "label": "Execute"},
        "plan_artifact": plan,
        "approved_hash": task_job.plan_hash_of(plan),
        "runner": runner,
        # What the server sends today: the farm user's checkout. Never used.
        "repo_dir": str(host.root / "farm-user-checkout"),
        "test_env_file": str(host.root / "tenants" / str(project_id) / "e2e.env"),
    }


def git(*args, cwd=None):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd, check=True, capture_output=True, timeout=60,
    )


@pytest.fixture
def host(tmp_path, monkeypatch, fake_tmux):
    """A running farm holding FARMD_ENV, and a host: per-project test-env
    files and results dirs, run-user homes and one bare origin per repo."""
    for name, value in FARMD_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(config, "TENANT_ENV_ROOT", tmp_path / "tenants")
    jobs = tmp_path / "tenant-jobs"
    for project_id in (7, 8):
        (jobs / str(project_id)).mkdir(parents=True)
        env_file = tmp_path / "tenants" / str(project_id) / "e2e.env"
        env_file.parent.mkdir(parents=True)
        env_file.write_text(f"SCREENSHOT_LOGIN_KEY={LOGIN_VALUE}\n")
        work = tmp_path / f"seed{project_id}"
        git("init", "-q", "-b", "main", str(work))
        (work / "README").write_text("seed\n")
        git("add", "README", cwd=work)
        git("commit", "-q", "-m", "seed", cwd=work)
        git("clone", "-q", "--bare", str(work), str(tmp_path / "origin" / "acme" / f"site{project_id}.git"))
    monkeypatch.setattr(config, "TENANT_JOBS_DIR", jobs)
    homes = tmp_path / "home"
    monkeypatch.setattr(farmd, "_run_user_home", lambda run_user: str(homes / run_user))
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: pytest.fail("farmd never clones for a tenant"))
    monkeypatch.setattr(farmd, "_jobs_enabled", lambda: True)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd, "launch_job", lambda task: pytest.fail("a tenant job never runs as the farm user"))
    monkeypatch.setattr(task_job, "_notify_progress", lambda run_id: None)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "Horizon"})
    for sub in ("runs/active", "jobs/active"):
        (QUEUE_DIR / sub).mkdir(parents=True, exist_ok=True)
    try:
        yield SimpleNamespace(root=tmp_path, jobs=jobs, homes=homes, fake_tmux=fake_tmux)
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        for sub in ("runs/active", "jobs/active"):
            for f in (QUEUE_DIR / sub).glob("772*"):
                f.unlink(missing_ok=True)
        for run_id in list(farmd.JOB_SESSIONS):
            if run_id.startswith("772"):
                farmd.JOB_SESSIONS.pop(run_id)


@pytest.fixture
def git_spy(host, monkeypatch):
    """Every subprocess.run argv and env. A clone of github.com/<repo> is
    redirected to the local bare origin; set `fail_clone` to make it fail."""
    calls = SimpleNamespace(argv=[], envs=[], fail_clone=False)
    real_run = subprocess.run

    def spy(argv, *args, **kwargs):
        argv = list(argv)
        calls.argv.append(list(argv))
        calls.envs.append(dict(kwargs.get("env") or {}))
        if "clone" in argv and any(str(a).startswith("https://github.com/") for a in argv):
            if calls.fail_clone:
                raise subprocess.CalledProcessError(128, argv)
            argv = [str(host.root / "origin" / a.removeprefix("https://github.com/")) if str(a).startswith("https://github.com/") else a for a in argv]
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    return calls


def load_tenant_entry():
    path = REPO_ROOT / "infra" / "host" / "tenant-entry"
    loader = importlib.machinery.SourceFileLoader("tenant_entry_772", str(path))
    spec = importlib.util.spec_from_loader("tenant_entry_772", loader)
    module = importlib.util.module_from_spec(spec)
    saved, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = saved
    return module


@pytest.fixture
def entry(host, monkeypatch):
    """tenant-entry, run as a run user (this test's uid) invoked by another
    uid, with execve and umask recorded instead of applied."""
    module = load_tenant_entry()
    monkeypatch.setattr(module, "TENANT_JOBS_DIR", str(host.jobs))
    monkeypatch.setenv("SUDO_UID", str(os.getuid() + 1))
    execs, umasks = [], []
    monkeypatch.setattr(module.os, "execve", lambda path, argv, env: execs.append((path, argv, env)))
    monkeypatch.setattr(module.os, "umask", lambda mask: umasks.append(mask) or 0o022)
    return SimpleNamespace(module=module, execs=execs, umasks=umasks)


def new_sessions(fake_tmux):
    return [c for c in fake_tmux.calls if c[0] == "new-session"]


def enqueue(host, job) -> dict:
    """POST /steps/run; returns the spool farmd wrote, read before
    tenant_launch unlinks it, and the tmux call."""
    res = client.post("/steps/run", json=job)
    assert res.status_code == 200, res.text
    call = [c for c in new_sessions(host.fake_tmux) if c[c.index("-s") + 1] == farmd._job_session_name(job["item"]["id"])][-1]
    spool_path = farmd._tenant_spool_path(job["run_id"])
    return {"res": res, "call": call, "spool_path": spool_path, "payload": json.loads(spool_path.read_text())}


def run_as_run_user(monkeypatch, entry, payload) -> int:
    """tenant-entry with the spool on stdin, then the process it execs —
    farm.tenant_job with exactly that env — in this process."""
    entry.module.main(io.StringIO(json.dumps(payload)))
    [(_path, argv, env)] = entry.execs[-1:]
    for name in list(os.environ):
        monkeypatch.delenv(name)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    Path(env["HOME"]).mkdir(parents=True, exist_ok=True)
    farm_home = Path(env["FARM_HOME"])
    monkeypatch.setattr(workspaces, "FARM_HOME", farm_home)
    monkeypatch.setattr(workspaces, "TENANT_TASK_CLONES_DIR", farm_home / "task-clones")
    assert argv[1:4] == ["-m", "farm.tenant_job", "--task"]
    return tenant_job.main(argv[3:])


@pytest.fixture
def journey(host, entry, git_spy, monkeypatch, capsys):
    """One tenant Execute from /steps/run to farmd's reaper. Decoy state and
    log files sit where an internal job's would."""
    started = []
    real_run_job = task_job.run_job

    def spy_run_job(**kwargs):
        started.append({"kwargs": kwargs, "env_file_left": list((Path(os.environ["FARM_HOME"]) / "jobs").glob("*.env.json"))})
        return real_run_job(**kwargs)

    monkeypatch.setattr(task_job, "run_job", spy_run_job)
    (STATE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    decoy_state = STATE_DIR / "jobs" / "AC-77.json"
    decoy_log = LOGS_DIR / "farm-job-ac-77.log"
    decoy_state.write_text(json.dumps({"run_id": 77201, "status": "finished", "commands": [{"command": "DECOY-STATE"}]}))
    decoy_log.write_text("DECOY-LOG\n")
    job = make_job(host, 77201)
    try:
        queued = enqueue(host, job)
        # The tmux line's process: hands the spool to sudo as the run user.
        sudo = []
        monkeypatch.setattr(tenant_launch.os, "dup2", lambda fd, target: None)
        monkeypatch.setattr(tenant_launch.os, "execvp", lambda file, argv: sudo.append(argv))
        words = shlex.split(queued["call"][-1])
        tenant_launch.main(words[words.index("--spool"):])
        env = queued["payload"]["env"]
        rc = run_as_run_user(monkeypatch, entry, queued["payload"])
        claimed_path = QUEUE_DIR / "jobs" / "active" / "77201.json"
        claimed = json.loads(claimed_path.read_text())
        view = farmd._job_view("77201", claimed)
        log_res = loopback.get("/jobs/77201/log")
        forwarded = []
        monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
        host.fake_tmux.sessions.discard("farm-job-ac-77")
        farmd._poll_jobs()
        out = capsys.readouterr()
        yield SimpleNamespace(
            job=job, queued=queued, sudo=sudo, env=env, rc=rc, started=started, claimed=claimed, view=view,
            log_res=log_res, forwarded=forwarded, out=out, claimed_path=claimed_path,
            state_path=host.jobs / "7" / "AC-77.json", log_path=host.jobs / "7" / "farm-job-ac-77.log",
            decoys=(decoy_state, decoy_log), tmux_calls=list(host.fake_tmux.calls),
        )
    finally:
        decoy_state.unlink(missing_ok=True)
        decoy_log.unlink(missing_ok=True)


# ---- metric 1: the job runs as the run user, in its own clone, with only its own env ----


def test_a_tenant_execute_runs_to_the_end_as_its_run_user(journey, host):
    j = journey
    assert j.queued["res"].json() == {"ok": True, "queued": "job", "session": "farm-job-ac-77"}
    words = shlex.split(j.queued["call"][-1])
    assert words[:3] == ["env", "-i", "PATH=/usr/bin:/bin"]
    assert words[3:6] == [sys.executable, "-m", "farm.tenant_launch"]
    assert words[-2:] == ["--run-user", "acme_run"]
    assert j.queued["payload"]["entry"] == "job"
    assert "task" not in j.queued["payload"], "an old tenant-entry finds no agent task in a job spool"
    assert j.sudo == [["sudo", "-n", "-u", "acme_run", config.TENANT_ENTRY]]

    assert j.rc == 0
    [run] = j.started
    kwargs = run["kwargs"]
    clone = host.homes / "acme_run" / ".horizon-farm" / "task-clones" / "acme__site7"
    assert kwargs["repo_dir"] == str(clone), "the run user's own clone, never the server's repo_dir"
    assert kwargs["task_clone"] is True
    assert kwargs["env_values"] == {"GITHUB_TOKEN": A_TOKEN, "SCREENSHOT_LOGIN_KEY": LOGIN_VALUE}
    assert run["env_file_left"] == [], "the 0600 env file is gone before the first command"
    assert kwargs["state_path"] == j.state_path and kwargs["log_path"] == j.log_path

    state = json.loads(j.state_path.read_text())
    assert state["status"] == "finished"
    assert [c["status"] for c in state["commands"]] == ["done", "done"]
    assert all(c["cwd"] == os.path.realpath(clone) for c in state["commands"])
    assert stat.S_IMODE(j.state_path.stat().st_mode) == 0o640

    log = j.log_path.read_text()
    assert log.splitlines()[0] == task_job.running_as_line(), "metric 5's evidence line"
    assert "SH=unset" in log, "the farm's own env never reaches the job"
    assert f"hi from {os.path.realpath(clone)}" in log

    assert j.view["status"] == "finished"
    assert [c["status"] for c in j.view["commands"]] == ["done", "done"]
    assert j.log_res.status_code == 200 and j.log_res.json()["content"] == log
    [body] = j.forwarded
    assert body["ok"] is True and body["summary"] == "2 command(s) run, 2 passed, 0 failed"
    assert "running as" in body["artifacts"]["artifact_md"]
    assert not j.claimed_path.exists(), "the reaper released the job"
    for channel in (json.dumps(j.view), j.log_res.text, json.dumps(j.forwarded)):
        assert "DECOY" not in channel, "nothing is read from STATE_DIR/jobs or LOGS_DIR"


def test_tenant_entry_execs_tenant_job_with_exactly_the_spool_env(journey, entry):
    [(path, argv, env)] = entry.execs
    assert env == journey.queued["payload"]["env"]
    assert argv[:3] == [sys.executable, "-m", "farm.tenant_job"]
    assert entry.umasks == [0o027]
    assert FARM_SECRET not in json.dumps(env) and SHARED_TOKEN not in json.dumps(env)
    assert env["GITHUB_TOKEN"] == A_TOKEN


# ---- metric 3: no token value in any argv, tmux line, URL or log ----


def test_a_sentinel_token_reaches_no_argv_tmux_line_url_or_log(journey, git_spy):
    j = journey
    payload = j.queued["payload"]
    channels = {
        "tmux calls (argv and cwd)": json.dumps(j.queued["call"]),
        "every tmux call": json.dumps(j.tmux_calls),
        "spool path": str(j.queued["spool_path"]),
        "spool entry, task and test_env_file": json.dumps({k: v for k, v in payload.items() if k != "env"}),
        "sudo argv": json.dumps(j.sudo),
        "subprocess argv": json.dumps(git_spy.argv),
        "claimed task file": json.dumps(j.claimed),
        "job log": j.log_path.read_text(),
        "state file": j.state_path.read_text(),
        "job view": json.dumps(j.view),
        "/jobs/<run_id>/log": j.log_res.text,
        "forwarded result": json.dumps(j.forwarded),
        "stdout/stderr": j.out.out + j.out.err,
        "/steps/run body": j.queued["res"].text,
    }
    clone_urls = [a for argv in git_spy.argv for a in argv if "github.com" in str(a)]
    assert clone_urls == ["https://github.com/acme/site7.git"], "the URL holds no credential"
    assert "GT=[redacted]" in j.log_path.read_text()
    for name, text in channels.items():
        for secret in NEVER_SEEN:
            assert secret not in text, f"a secret value reached the {name}"


def test_the_running_as_line_is_redacted_like_every_line(tmp_path):
    secret = "running-as-secret-value-77206"
    task_job.run_job(
        run_id=1, item_id="AC-1", plan_artifact=artifact(commands=["true"]), approved_hash=task_job.plan_hash_of(artifact(commands=["true"])),
        runner="host", state_path=tmp_path / "s.json", log_path=tmp_path / "l.log", repo_dir=str(tmp_path),
        redact_values={"K": secret}, first_line=f"running as hz-p7 (uid 1) {secret}",
    )
    assert (tmp_path / "l.log").read_text().splitlines()[0] == "running as hz-p7 (uid 1) [redacted]"


# ---- metric 2: a tenant job that cannot run as its run user is refused before anything starts ----

REAL_RUN_USER_HOME = farmd._run_user_home
ENQUEUE_REFUSALS = {
    "missing-run-user": ({"run_user": None}, "isolation_refused", "tenant project needs run_user before the farm runs it"),
    "unresolvable-ref": ({"ref": "$NOT_SET_ANYWHERE_772"}, "tenant_launch_refused", "tenant project needs a resolvable github_token_ref"),
    "no-host-account": ({"run_user": "hz_nobody_772"}, "tenant_launch_refused", "run_user has no account on this host"),
    "container-runner": ({"runner": "container"}, "tenant_launch_refused", farmd.TENANT_JOB_HOST_ONLY),
}


@pytest.mark.parametrize("case", ENQUEUE_REFUSALS, ids=list(ENQUEUE_REFUSALS))
def test_a_tenant_job_that_cannot_run_as_its_run_user_launches_nothing(host, monkeypatch, case):
    overrides, error, reason = ENQUEUE_REFUSALS[case]
    if case == "no-host-account":
        monkeypatch.setattr(farmd, "_run_user_home", REAL_RUN_USER_HOME)
    started = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: started.append(run_id) or True)
    res = client.post("/steps/run", json=make_job(host, 77210, **overrides))
    assert res.status_code == 400
    assert res.json() == {"error": error, "reason": reason}
    assert started == [], "the server never hears started"
    assert new_sessions(host.fake_tmux) == [], "no process starts, as the farm user or any other"
    assert not list((QUEUE_DIR / "runs" / "active").glob("77210*")), "no spool"
    assert not list((QUEUE_DIR / "jobs" / "active").glob("77210*")), "no task or env file"
    assert farmd.JOB_SESSIONS.get("77210") is None


def test_the_real_run_user_lookup_refuses_a_missing_account():
    with pytest.raises(credentials.TenantEnvError, match="^run_user has no account on this host$"):
        farmd._run_user_home("hz_nobody_772")


RUNNER_REFUSALS = ("clone-fails", "cwd-missing", "test-env-elsewhere")


@pytest.mark.parametrize("case", RUNNER_REFUSALS)
def test_a_runner_side_failure_ends_the_job_refused_with_zero_commands(host, entry, git_spy, monkeypatch, case):
    job = make_job(host, 77220, cwd="no-such-dir" if case == "cwd-missing" else ".")
    queued = enqueue(host, job)
    payload = queued["payload"]
    if case == "clone-fails":
        git_spy.fail_clone = True
    if case == "test-env-elsewhere":
        elsewhere = host.root / "elsewhere" / "e2e.env"
        elsewhere.parent.mkdir()
        elsewhere.write_text(f"SCREENSHOT_LOGIN_KEY={LOGIN_VALUE}\n")
        payload["test_env_file"] = str(elsewhere)
    monkeypatch.setattr(task_job, "run_job", lambda **kwargs: pytest.fail("no command runs"))

    assert run_as_run_user(monkeypatch, entry, payload) == 2

    claimed = json.loads((QUEUE_DIR / "jobs" / "active" / "77220.json").read_text())
    view = farmd._job_view("77220", claimed)
    state = json.loads((host.jobs / "7" / "AC-77.json").read_text())
    expected = {
        "clone-fails": "the run user's task clone could not be prepared",
        "cwd-missing": "cwd is not a directory in the repo",
        "test-env-elsewhere": "tenant test_env_file could not be used",
    }[case]
    assert state["refusal"] == expected
    assert view["status"] == state["status"] == "cwd_refused"
    assert [c["status"] for c in view["commands"]] == ["pending", "pending"]
    assert not list((host.homes / "acme_run" / ".horizon-farm" / "jobs").glob("*.env.json"))
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    host.fake_tmux.sessions.discard("farm-job-ac-77")
    farmd._poll_jobs()
    [body] = forwarded
    assert body["ok"] is False and body["reason"] == reasons.REASON["JOB_CWD_REFUSED"]
    assert body["error"] == f"Execute refused: {expected}"
    for text in (json.dumps(body), json.dumps(state), (host.jobs / "7" / "farm-job-ac-77.log").read_text()):
        for secret in NEVER_SEEN:
            assert secret not in text
    for env in git_spy.envs:
        assert SHARED_TOKEN not in env.values() and FARM_SECRET not in env.values(), "nothing ran with the farm user's env"


# ---- guardrail 2: tenant-entry runs a job only for its own project's results dir ----


def entry_payload(host, **task_overrides):
    task = {**make_job(host, 77230), "results_dir": str(host.jobs / "7"), **task_overrides}
    farm_home = host.homes / "acme_run" / ".horizon-farm"
    env = {"PATH": "/usr/bin:/bin", "HOME": str(farm_home.parent), "FARM_HOME": str(farm_home), "GITHUB_TOKEN": A_TOKEN}
    return {"entry": "job", "env": env, "job": task, "test_env_file": None}


def test_tenant_entry_refuses_a_bad_entry_or_results_dir(host, entry, monkeypatch, capsys):
    other = entry_payload(host, results_dir=str(host.jobs / "8"))
    shell = {**entry_payload(host), "entry": "shell"}
    traversal = entry_payload(host, results_dir=f"{host.jobs}/7/../8")
    # A tenant-entry from before HZ-772 ignores `entry` and reads "task": a
    # job spool has none, so it is refused, never run as an agent step.
    as_old_entry = {k: v for k, v in entry_payload(host).items() if k != "entry"}
    assert "task" not in as_old_entry
    for payload in (shell, other, traversal, as_old_entry):
        with pytest.raises(SystemExit) as exc:
            entry.module.main(io.StringIO(json.dumps(payload)))
        assert exc.value.code != 0
    assert entry.execs == [] and entry.umasks == []
    assert A_TOKEN not in capsys.readouterr().err


@pytest.mark.parametrize("case", ["symlink", "foreign-owner", "missing"])
def test_tenant_entry_refuses_a_results_dir_that_is_not_its_own(host, entry, monkeypatch, case):
    own = host.jobs / "7"
    if case == "symlink":
        own.rmdir()
        own.symlink_to(host.jobs / "8")
    elif case == "missing":
        own.rmdir()
    else:
        foreign_uid = os.stat(own).st_uid + 7
        monkeypatch.setattr(entry.module.os, "getuid", lambda: foreign_uid)
    with pytest.raises(SystemExit) as exc:
        entry.module.main(io.StringIO(json.dumps(entry_payload(host))))
    assert exc.value.code != 0
    assert entry.execs == []


def test_a_spool_with_no_entry_still_execs_the_step_agent(host, entry):
    payload = entry_payload(host)
    del payload["entry"]
    payload["task"] = payload.pop("job")
    entry.module.main(io.StringIO(json.dumps(payload)))
    [(_path, argv, _env)] = entry.execs
    assert argv[1:3] == ["-m", "farm.step_agent"]
    assert entry.umasks == [], "an agent step's umask is unchanged"


# ---- guardrail 2: two tenants at once each hold only their own ----


def test_two_tenants_jobs_each_get_only_their_own_token_test_env_and_results_dir(host):
    a = enqueue(host, make_job(host, 77240))
    b = enqueue(host, make_job(host, 77241, project_id=8, run_user="beta_run", ref="$B_GITHUB_TOKEN", item_id="BE-88"))
    for queued, own, other, project_id, run_user in ((a, A_TOKEN, B_TOKEN, 7, "acme_run"), (b, B_TOKEN, A_TOKEN, 8, "beta_run")):
        payload = queued["payload"]
        text = queued["spool_path"].read_text()
        assert payload["env"]["GITHUB_TOKEN"] == payload["env"]["GH_TOKEN"] == own
        for value in (other, SHARED_TOKEN, FARM_SECRET):
            assert value not in text
        assert payload["test_env_file"] == str(host.root / "tenants" / str(project_id) / "e2e.env")
        assert payload["job"]["results_dir"] == str(host.jobs / str(project_id))
        assert shlex.split(queued["call"][-1])[-1] == run_user
        claimed = json.loads((QUEUE_DIR / "jobs" / "active" / f"{payload['job']['run_id']}.json").read_text())
        secrets = farmd._job_secrets(claimed)
        assert own in secrets.values() and other not in secrets.values()
        assert farmd._job_paths(payload["job"]["run_id"], claimed)[0].parent == host.jobs / str(project_id)


# ---- Stop: farmd kills the session; the runner records the stop itself ----


def test_stop_of_a_tenant_job_leaves_its_processes_and_state_to_the_runner(host, monkeypatch):
    enqueue(host, make_job(host, 77250))
    state_path = host.jobs / "7" / "AC-77.json"
    state_path.write_text(json.dumps({"run_id": 77250, "status": "running", "commands": [{"command": "x", "status": "running", "pgid": 4242}]}))
    before = state_path.read_bytes()
    monkeypatch.setattr(farmd.os, "killpg", lambda *a: pytest.fail("farmd never signals the run user's processes"))
    monkeypatch.setattr(farmd, "TENANT_STOP_WAIT_S", 0.2)
    res = loopback.post("/jobs/stop", json={"run_id": 77250})
    assert res.status_code == 200
    assert ("kill-session", "-t", "=farm-job-ac-77") in host.fake_tmux.calls
    assert state_path.read_bytes() == before, "farmd never writes the run user's state"
    assert not (QUEUE_DIR / "jobs" / "active" / "77250.json").exists(), "the job is released"


def test_a_tenant_runner_records_its_own_stop_on_sighup(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    results = tmp_path / "results"
    results.mkdir()
    plan = artifact(commands=["sleep 60"])
    task_path = tmp_path / "task.json"
    task_path.write_text(json.dumps({
        "run_id": 77260, "item": {"id": "AC-9"}, "plan_artifact": plan, "approved_hash": task_job.plan_hash_of(plan),
        "runner": "host", "repo_dir": str(repo), "results_dir": str(results),
    }))
    env = {**os.environ, "FARM_HOME": str(tmp_path / "fh"), "FARM_PORT": "9", "PYTHONPATH": str(REPO_ROOT)}
    proc = subprocess.Popen([sys.executable, "-m", "farm.task_job", "--task", str(task_path)], cwd=str(REPO_ROOT), env=env)
    state_path, log_path = task_job.tenant_result_paths(results, "AC-9")
    pgid = None
    try:
        deadline = time.monotonic() + 30
        while pgid is None and time.monotonic() < deadline:
            state = task_job.load_state(state_path) or {}
            pgid = next((c.get("pgid") for c in state.get("commands", []) if c.get("status") == "running"), None)
            time.sleep(0.05)
        assert pgid, "the command started"
        proc.send_signal(signal.SIGHUP)
        assert proc.wait(timeout=30) != 0
    finally:
        if proc.poll() is None:
            proc.kill()
    state = task_job.load_state(state_path)
    assert state["status"] == "stopped"
    assert [c["status"] for c in state["commands"]] == ["stopped"]
    assert log_path.read_text().endswith("stopped by the owner\n")
    with pytest.raises(ProcessLookupError):
        os.killpg(pgid, 0)


# ---- HO-838: the tenant job re-checks the prerequisites as its run user ----


API_VALUE = "acme-api-key-sentinel-77290"


@pytest.mark.parametrize("drifted", [False, True], ids=["clean-host-runs", "removed-var-refused"])
def test_a_tenant_job_re_checks_prerequisites_as_its_run_user(host, entry, git_spy, monkeypatch, drifted):
    """HO-838 test contract (tenant): the run user's own job runs the
    Preflight checks on its own clone and test-env file before any command.
    A declared secret the file holds lets the plan run; the same secret gone
    from the file after approval ends the job `prereq_refused`, zero
    commands run, the var named and its value nowhere."""
    real_run_job = task_job.run_job
    monkeypatch.setattr(task_job, "run_job", lambda **kwargs: real_run_job(**kwargs))
    plan = "## Commands\nplan\n\n## Run plan block\n" + run_plan.render(
        {
            "cwd": ".",
            "commands": ["echo ran >> ran.txt"],
            "budget_minutes": 1,
            "env": {"ACME_API_KEY": "$ACME_API_KEY"},
            "requires": [{"env": "ACME_API_KEY"}],
        }
    ) + "\n"
    job = {**make_job(host, 77290, item_id="AC-90"), "plan_artifact": plan, "approved_hash": task_job.plan_hash_of(plan)}
    env_file = host.root / "tenants" / "7" / "e2e.env"
    env_file.write_text(f"SCREENSHOT_LOGIN_KEY={LOGIN_VALUE}\nACME_API_KEY={API_VALUE}\n")
    queued = enqueue(host, job)
    if drifted:
        env_file.write_text(f"SCREENSHOT_LOGIN_KEY={LOGIN_VALUE}\n")
    try:
        assert run_as_run_user(monkeypatch, entry, queued["payload"]) == 0
        state_path, log_path = host.jobs / "7" / "AC-90.json", host.jobs / "7" / "farm-job-ac-90.log"
        state = json.loads(state_path.read_text())
        clone = host.homes / "acme_run" / ".horizon-farm" / "task-clones" / "acme__site7"
        log = log_path.read_text()
        if drifted:
            assert state["status"] == "prereq_refused"
            assert state["refusal"] == "prerequisites changed since approval — failed: ACME_API_KEY"
            assert [c["status"] for c in state["commands"]] == ["pending"]
            assert not (clone / "ran.txt").exists(), "no command ran"
            assert "zero commands run" in log
        else:
            assert state["status"] == "finished"
            assert [c["status"] for c in state["commands"]] == ["done"]
            assert (clone / "ran.txt").read_text() == "ran\n"
        for channel in (json.dumps(state), log):
            assert A_TOKEN not in channel and LOGIN_VALUE not in channel and API_VALUE not in channel
    finally:
        (QUEUE_DIR / "jobs" / "active" / "77290.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("77290", None)


# ---- guardrail 4: the sudoers file is unchanged in shape ----


def test_the_tenant_sudoers_file_has_exactly_two_rules_and_no_wildcard():
    """No sudoers change: tenant-entry still takes no arguments, and the only
    `*` is the quantifier inside the helper's anchored id regex — no glob."""
    text = (REPO_ROOT / "infra" / "host" / "horizon-tenant.sudoers").read_text()
    rules = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    assert len(rules) == 2
    [entry_rule] = [r for r in rules if "tenant-entry" in r]
    [helper_rule] = [r for r in rules if "horizon-provision-run-user" in r]
    assert entry_rule == 'ubuntu ALL=(%hz-tenants) NOPASSWD: /usr/local/libexec/horizon/tenant-entry ""'
    assert helper_rule == "ubuntu ALL=(root) NOPASSWD: /usr/local/libexec/horizon/horizon-provision-run-user ^[1-9][0-9]*$"
    assert "*" not in entry_rule and "*" not in helper_rule.replace("^[1-9][0-9]*$", "")
