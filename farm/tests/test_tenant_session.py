"""HZ-663 part 1: a tenant session runs as its project's run_user, holding only
its own project's token and test-env file.

farmd builds the session env from empty (credentials.tenant_session_env),
spools it 0600, and launches `env -i … farm.tenant_launch` in tmux; that execs
`sudo -n -u <run_user> <TENANT_ENTRY>` with the spool on stdin, and
infra/host/tenant-entry execs step_agent with exactly that env. HZ-758 (part
2) removed the gate that refused every tenant launch: a valid tenant task now
launches, on /steps/run and at the claim, and its test-env file is optional.
farm/tests/test_tenant_workspace.py covers the run user's own workspace."""

import importlib.machinery
import importlib.util
import io
import json
import logging
import os
import shlex
import stat
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import config, credentials, farmd, login_env, tenant_launch, tmux_mgr
from farm.config import QUEUE_DIR

client = TestClient(farmd.app)

REPO_ROOT = Path(__file__).resolve().parents[2]
IMPLEMENT = 10
REF = "$ACME_GITHUB_TOKEN"
A_TOKEN = "acme-own-token-value-0001"
B_TOKEN = "beta-other-token-value-0002"
SHARED_TOKEN = "shared-farm-github-token-0003"
WEBHOOK = "webhook-secret-value-0004"
WA_VALUE = "wa-bridge-value-0005"
CLAUDE_EXTRA = "claude-extra-value-0006"
FARM_SECRET = "farm-shared-secret-0007"
OAUTH = "claude-oauth-value-0008"

FARMD_ENV = {
    "ACME_GITHUB_TOKEN": A_TOKEN,
    "B_GITHUB_TOKEN": B_TOKEN,
    "GITHUB_TOKEN": SHARED_TOKEN,
    "GITHUB_WEBHOOK_SECRET": WEBHOOK,
    "WA_BRIDGE_URL": WA_VALUE,
    "CLAUDE_EXTRA_SETTING": CLAUDE_EXTRA,
    "FARM_SHARED_SECRET": FARM_SECRET,
    "FARM_MAX_EPHEMERAL": "9",
    "CLAUDE_CODE_OAUTH_TOKEN": OAUTH,
    "FARM_PORT": "4100",
    "HORIZON_URL": "http://localhost:3001",
    "PATH": "/usr/local/bin:/usr/bin:/bin",
}
NEVER_IN_SPOOL = (B_TOKEN, SHARED_TOKEN, WEBHOOK, WA_VALUE, CLAUDE_EXTRA, FARM_SECRET)


def make_task(run_id, *, project_id=7, run_user="acme_run", ref=REF, test_env_file=None, item_id="AC-1"):
    project = {"id": project_id, "name": "Acme", "isolation": "tenant", "githubTokenRef": ref, "runUser": run_user}
    task = {
        "run_id": run_id,
        "attempt": 1,
        "project": project,
        "item": {"id": item_id, "title": "t", "repo": "acme/site"},
        "step": {"index": IMPLEMENT, "label": "Implement"},
    }
    if test_env_file is not None:
        task["test_env_file"] = test_env_file
    return task


@pytest.fixture
def root(tmp_path, monkeypatch):
    """TENANT_ENV_ROOT for this test. Nothing is created under it: farmd
    checks the path as a string and must never open the file."""
    path = tmp_path / "tenants"
    monkeypatch.setattr(config, "TENANT_ENV_ROOT", path)
    return path


@pytest.fixture
def farm(monkeypatch, root):
    """A running farm holding FARMD_ENV; no hub is cloned, no account looked up."""
    for name, value in FARMD_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: True)
    monkeypatch.setattr(farmd, "_run_user_home", lambda run_user: f"/home/{run_user}")
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "Horizon"})
    dirs = [QUEUE_DIR / "pm", QUEUE_DIR / "runs", QUEUE_DIR / "runs" / "active", QUEUE_DIR / "jobs" / "active"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    try:
        yield
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        for d in dirs:
            for f in d.glob("663*"):
                f.unlink(missing_ok=True)


def queued_files():
    return sorted(p.name for d in ("pm", "runs", "runs/active", "jobs/active") for p in (QUEUE_DIR / d).glob("663*"))


def new_sessions(fake_tmux):
    return [c for c in fake_tmux.calls if c[0] == "new-session"]


def a_file(root):
    return str(root / "7" / "e2e.env")


def launch(task, tmp_path, fake_tmux):
    """The tenant launch itself: spool + tmux, as _claim_and_launch calls it."""
    farmd._launch_tenant_session("farm-run-ac-1-s10-a1", task, tmp_path)
    [call] = new_sessions(fake_tmux)
    return call


# ---- metric 1: runs as run_user, its env holds only its own token ----


def test_tenant_session_runs_as_run_user_with_only_its_token(farm, root, tmp_path, fake_tmux, monkeypatch):
    task = make_task(66301, test_env_file=a_file(root))
    call = launch(task, tmp_path, fake_tmux)

    line = call[-1]
    assert line.startswith("env -i PATH=/usr/bin:/bin ")
    words = shlex.split(line)
    assert words[:3] == ["env", "-i", "PATH=/usr/bin:/bin"]
    assert words[3:6] == [sys.executable, "-m", "farm.tenant_launch"]
    assert words[-2:] == ["--run-user", "acme_run"]
    spool = Path(words[words.index("--spool") + 1])
    assert spool == QUEUE_DIR / "runs" / "active" / "66301.tenant.json"

    assert stat.S_IMODE(spool.stat().st_mode) == 0o600
    text = spool.read_text()
    payload = json.loads(text)
    env = payload["env"]
    present = {name for name in credentials.TENANT_FORWARD if name in os.environ}
    assert set(env) == present | credentials.TENANT_SET
    assert env["GITHUB_TOKEN"] == env["GH_TOKEN"] == A_TOKEN
    assert env["HOME"] == "/home/acme_run"
    assert env["FARM_HOME"] == "/home/acme_run/.horizon-farm"
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    for value in NEVER_IN_SPOOL:
        assert value not in text
    assert payload["test_env_file"] == a_file(root)
    assert payload["task"]["run_id"] == 66301

    # The tmux line's process: hands the spool to sudo as the run user.
    order = []
    real_unlink = os.unlink
    monkeypatch.setattr(tenant_launch.os, "unlink", lambda p: (order.append("unlink"), real_unlink(p)))
    monkeypatch.setattr(tenant_launch.os, "dup2", lambda fd, target: order.append(("dup2", target)))
    execs = []
    monkeypatch.setattr(tenant_launch.os, "execvp", lambda file, argv: (order.append("execvp"), execs.append((file, argv))))
    tenant_launch.main(words[words.index("--spool") :])
    assert execs == [("sudo", ["sudo", "-n", "-u", "acme_run", config.TENANT_ENTRY])]
    assert order == ["unlink", ("dup2", 0), "execvp"], "the spool is gone before sudo runs"
    assert not spool.exists()


# ---- metric 1: tenant-entry execs step_agent with exactly its stdin env ----


def load_tenant_entry():
    path = REPO_ROOT / "infra" / "host" / "tenant-entry"
    loader = importlib.machinery.SourceFileLoader("tenant_entry", str(path))
    spec = importlib.util.spec_from_loader("tenant_entry", loader)
    module = importlib.util.module_from_spec(spec)
    # No .pyc beside a host script that part 3 installs root-owned.
    saved, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = saved
    return module


@pytest.fixture
def entry(tmp_path, monkeypatch):
    module = load_tenant_entry()
    monkeypatch.setenv("SUDO_UID", "1000")
    monkeypatch.setenv("FARM_SHARED_SECRET", FARM_SECRET)  # its own env must never merge in
    monkeypatch.setattr(module.os, "getuid", lambda: 1001)
    execs = []
    monkeypatch.setattr(module.os, "execve", lambda path, argv, env: execs.append((path, argv, env)))
    env_file = tmp_path / "tenants" / "7" / "e2e.env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("SCREENSHOT_LOGIN_KEY=abcdefghijkl\n")
    farm_home = tmp_path / "home" / "acme_run" / ".horizon-farm"
    env = {"PATH": "/usr/bin:/bin", "HOME": str(farm_home.parent), "FARM_HOME": str(farm_home), "GITHUB_TOKEN": A_TOKEN, "GH_TOKEN": A_TOKEN}
    payload = {"env": env, "task": make_task(66302), "test_env_file": str(env_file)}
    return module, execs, payload, farm_home


def test_tenant_entry_execs_step_agent_with_exactly_its_stdin_env(entry):
    module, execs, payload, farm_home = entry
    module.main(io.StringIO(json.dumps(payload)))

    [(path, argv, env)] = execs
    assert env == payload["env"], "exactly the stdin env, nothing from os.environ"
    assert FARM_SECRET not in json.dumps(env)
    task_file = farm_home / "runs" / "66302.json"
    assert argv == [sys.executable, "-m", "farm.step_agent", "--task", str(task_file)]
    for value in payload["env"].values():
        if value not in str(task_file):
            assert value not in " ".join(argv)
    assert A_TOKEN not in " ".join(argv)
    assert stat.S_IMODE(task_file.stat().st_mode) == 0o600
    assert json.loads(task_file.read_text())["test_env_file"] == payload["test_env_file"]


@pytest.mark.parametrize("uid", [1000, 0], ids=["farm-user", "root"])
def test_tenant_entry_refuses_the_farm_user_and_root(entry, monkeypatch, uid):
    module, execs, payload, farm_home = entry
    monkeypatch.setattr(module.os, "getuid", lambda: uid)
    with pytest.raises(SystemExit) as exc:
        module.main(io.StringIO(json.dumps(payload)))
    assert exc.value.code != 0
    assert execs == []
    assert not farm_home.exists()


def test_tenant_entry_refuses_a_missing_test_env_file(entry, capsys):
    module, execs, payload, farm_home = entry
    payload["test_env_file"] = payload["test_env_file"] + ".missing"
    with pytest.raises(SystemExit) as exc:
        module.main(io.StringIO(json.dumps(payload)))
    assert exc.value.code != 0
    assert execs == []
    assert not farm_home.exists()
    assert A_TOKEN not in capsys.readouterr().err


def test_tenant_entry_with_no_test_env_file_execs_step_agent_with_none(entry):
    """HZ-758: null names no file; the task then carries no test_env_file."""
    module, execs, payload, farm_home = entry
    payload["test_env_file"] = None
    payload["task"]["test_env_file"] = ""
    module.main(io.StringIO(json.dumps(payload)))

    [(path, argv, env)] = execs
    assert env == payload["env"]
    task_file = farm_home / "runs" / "66302.json"
    assert argv == [sys.executable, "-m", "farm.step_agent", "--task", str(task_file)]
    assert "test_env_file" not in json.loads(task_file.read_text())


@pytest.mark.parametrize("value", ["", "relative/e2e.env", 7], ids=["empty", "relative", "int"])
def test_tenant_entry_refuses_a_test_env_file_that_is_not_null_or_absolute(entry, value):
    module, execs, payload, farm_home = entry
    payload["test_env_file"] = value
    with pytest.raises(SystemExit) as exc:
        module.main(io.StringIO(json.dumps(payload)))
    assert exc.value.code != 0
    assert execs == []
    assert not farm_home.exists()


# ---- metric 2: project A loads only A's test-env file ----

REFUSED_PATHS = {
    "project-b": lambda root: str(root / "8" / "e2e.env"),
    "internal": lambda root: "/etc/fintekkers/ui-e2e.env",
    "relative": lambda root: "tenants/7/e2e.env",
    "dotdot": lambda root: f"{root}/7/../8/e2e.env",
    "sibling-prefix": lambda root: str(root / "77" / "e2e.env"),
}


@pytest.fixture
def open_spy(monkeypatch):
    """Every path farmd hands to open()/os.open(), as a string."""
    import builtins

    opened = []
    real_open, real_os_open = builtins.open, os.open
    monkeypatch.setattr(builtins, "open", lambda file, *a, **k: (opened.append(str(file)), real_open(file, *a, **k))[1])
    monkeypatch.setattr(os, "open", lambda file, *a, **k: (opened.append(str(file)), real_os_open(file, *a, **k))[1])
    return opened


@pytest.mark.parametrize("case", ["project-a", *REFUSED_PATHS], ids=["project-a", *REFUSED_PATHS])
def test_tenant_a_loads_only_its_own_test_env_file(farm, root, tmp_path, fake_tmux, open_spy, case):
    path = a_file(root) if case == "project-a" else REFUSED_PATHS[case](root)
    task = make_task(66303, test_env_file=path)

    if case == "project-a":
        assert farmd._tenant_launch_refusal(task) is None, "the path check passed"
        launch(task, tmp_path, fake_tmux)
        spool = json.loads((QUEUE_DIR / "runs" / "active" / "66303.tenant.json").read_text())
        assert spool["test_env_file"] == a_file(root)
    else:
        res = client.post("/steps/run", json=task)
        assert res.status_code == 400
        assert res.json() == {"error": "tenant_launch_refused", "reason": "tenant test_env_file must live under the project's own directory"}
        with pytest.raises(login_env.LoginEnvError):
            farmd._tenant_spool(task)
        assert queued_files() == []
        assert new_sessions(fake_tmux) == []

    candidates = [a_file(root)] + [p for p in (make(root) for make in REFUSED_PATHS.values()) if p]
    assert not [p for p in open_spy if any(c in p for c in candidates)], "farmd never opens a test-env file"


def test_projects_sharing_a_run_user_still_resolve_only_their_own_test_env_file(farm, root):
    a = make_task(66304, project_id=7, run_user="shared_run", test_env_file=str(root / "8" / "e2e.env"))
    b = make_task(66305, project_id=8, run_user="shared_run", test_env_file=str(root / "8" / "e2e.env"))
    assert farmd._tenant_launch_refusal(a) == "tenant test_env_file must live under the project's own directory"
    assert farmd._tenant_launch_refusal(b) is None
    with pytest.raises(login_env.LoginEnvError):
        login_env.tenant_env_path(str(root / "8" / "e2e.env"), 7)
    assert login_env.tenant_env_path(str(root / "8" / "e2e.env"), 8) == str(root / "8" / "e2e.env")


# ---- guardrail 3: fail closed — refused, nothing queued, launched or spooled ----

FAIL_CLOSED = {
    "missing-run-user": ({"run_user": None}, "isolation_refused", "tenant project needs run_user before the farm runs it"),
    "unset-ref": ({"ref": "$NOT_SET_ANYWHERE_TOKEN"}, "tenant_launch_refused", "tenant project needs a resolvable github_token_ref"),
    "empty-ref": ({"ref": "$EMPTY_TENANT_TOKEN"}, "tenant_launch_refused", "tenant project needs a resolvable github_token_ref"),
    "out-of-root-test-env": ({"test_env_file": "/etc/fintekkers/ui-e2e.env"}, "tenant_launch_refused", "tenant test_env_file must live under the project's own directory"),
}


@pytest.fixture
def provisions(monkeypatch):
    """Every repo farmd asked to clone as the farm user."""
    calls = []
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: calls.append(repo) or True)
    return calls


@pytest.mark.parametrize("case", FAIL_CLOSED, ids=list(FAIL_CLOSED))
def test_a_tenant_launch_fails_closed(farm, root, fake_tmux, monkeypatch, provisions, case):
    monkeypatch.setenv("EMPTY_TENANT_TOKEN", "")
    overrides, error, reason = FAIL_CLOSED[case]
    task = make_task(66306, **{"test_env_file": a_file(root), **overrides})

    res = client.post("/steps/run", json=task)
    assert res.status_code == 400
    assert res.json() == {"error": error, "reason": reason}
    assert queued_files() == []
    assert new_sessions(fake_tmux) == []
    assert not list((QUEUE_DIR / "runs" / "active").glob("*.tenant.json*"))
    # $GITHUB_TOKEN is set in farmd's env (FARMD_ENV): still no farm-user clone.
    assert provisions == []


def assert_launched_as_run_user(call, run_id):
    words = shlex.split(call[-1])
    assert words[3:6] == [sys.executable, "-m", "farm.tenant_launch"]
    assert words[-2:] == ["--run-user", "acme_run"]
    assert "farm.step_agent" not in call[-1], "never as the farm user"
    assert Path(words[words.index("--spool") + 1]) == farmd._tenant_spool_path(run_id)


# ---- HZ-758 metric 1: a valid tenant task launches, as its run_user ----


def test_a_valid_tenant_task_is_queued_and_launches_as_its_run_user(farm, root, fake_tmux, monkeypatch, provisions):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd, "_refresh_rules", lambda task: False)
    res = client.post("/steps/run", json=make_task(66314, test_env_file=a_file(root)))
    assert res.status_code == 200
    assert res.json() == {"ok": True, "queued": "runs"}
    assert provisions == [], "the run user clones its own hub — farmd never does"
    assert A_TOKEN not in (QUEUE_DIR / "runs" / "66314.json").read_text()

    name = farmd._claim_and_launch(QUEUE_DIR / "runs" / "66314.json", QUEUE_DIR / "runs", REPO_ROOT)
    assert name is not None
    [call] = new_sessions(fake_tmux)
    assert_launched_as_run_user(call, 66314)
    assert A_TOKEN not in call[-1]


def test_a_queued_tenant_task_launches_as_its_run_user_at_the_claim(farm, root, tmp_path, fake_tmux, monkeypatch):
    started = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: started.append(run_id) or True)
    monkeypatch.setattr(farmd, "_refresh_rules", lambda task: False)
    monkeypatch.setattr(farmd, "_forward_result", lambda body: pytest.fail(f"a valid tenant task is never refused: {body}"))
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = runs_dir / "66307.json"
    task_path.write_text(json.dumps(make_task(66307, test_env_file=a_file(root))))

    assert farmd._claim_and_launch(task_path, runs_dir, tmp_path) == "farm-run-ac-1-s10-a1"
    assert started == [66307]
    [call] = new_sessions(fake_tmux)
    assert_launched_as_run_user(call, 66307)
    assert (runs_dir / "active" / "66307.json").exists()


def test_the_part_1_gate_is_gone_from_the_farm():
    farm_dir = REPO_ROOT / "farm"
    hits = [
        p.relative_to(REPO_ROOT)
        for p in farm_dir.rglob("*.py")
        if "tests" not in p.parts and "TENANT_WORKSPACE_GATE" in p.read_text()
    ]
    assert hits == []
    assert not hasattr(farmd, "TENANT_WORKSPACE_GATE")


# ---- HZ-758 metric 2: no test-env file is no file ----


@pytest.mark.parametrize("value", [None, ""], ids=["null", "empty"])
def test_a_tenant_task_with_no_test_env_file_launches_with_none(farm, root, tmp_path, fake_tmux, monkeypatch, value):
    task = make_task(66315)
    task["test_env_file"] = value
    assert farmd._tenant_launch_refusal(task) is None
    assert login_env.tenant_env_path(value, 7) is None
    res = client.post("/steps/run", json=task)
    assert res.status_code == 200
    launch(task, tmp_path, fake_tmux)
    spool = json.loads((QUEUE_DIR / "runs" / "active" / "66315.tenant.json").read_text())
    assert spool["test_env_file"] is None


def test_a_tenant_task_with_no_test_env_key_launches_with_none(farm, root, tmp_path, fake_tmux):
    task = make_task(66316)
    assert "test_env_file" not in task
    assert farmd._tenant_launch_refusal(task) is None
    launch(task, tmp_path, fake_tmux)
    assert json.loads((QUEUE_DIR / "runs" / "active" / "66316.tenant.json").read_text())["test_env_file"] is None


@pytest.mark.parametrize("value", [7, ["/x"], {"p": 1}], ids=["int", "list", "dict"])
def test_a_test_env_file_that_is_not_a_string_is_still_refused(farm, root, value):
    task = make_task(66317)
    task["test_env_file"] = value
    assert farmd._tenant_launch_refusal(task) == "tenant test_env_file must live under the project's own directory"


def test_a_tenant_job_step_launches_as_its_run_user_never_the_farm_user(farm, root, tmp_path, fake_tmux, monkeypatch):
    """HZ-772 metric 1: the job step is no longer refused. farmd launches it
    through farm.tenant_launch as the run user — never launch_job's farm-user
    runner — and tenant-entry execs farm.tenant_job with exactly the spool env."""
    from domain.py import run_plan, steps

    monkeypatch.setattr(farmd, "_jobs_enabled", lambda: True)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd, "launch_job", lambda task: pytest.fail("a tenant job never runs as the farm user"))
    monkeypatch.setattr(config, "TENANT_JOBS_DIR", tmp_path / "tenant-jobs")
    job = make_task(66318, test_env_file=a_file(root), item_id="AC-2")
    job["item"]["kind"] = "task"
    job["step"] = {"index": steps.by_kind_label("task", "Execute")["index"], "label": "Execute"}
    artifact = run_plan.render({"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1})
    job.update(plan_artifact=artifact, approved_hash="h", runner="host", repo_dir="/srv/farm-user/acme")
    try:
        res = client.post("/steps/run", json=job)
        assert res.status_code == 200
        assert res.json() == {"ok": True, "queued": "job", "session": "farm-job-ac-2"}
        [call] = new_sessions(fake_tmux)
        assert_launched_as_run_user(call, 66318)
        assert "farm.task_job" not in call[-1]
        assert call[call.index("-c") + 1] == str(farmd.task_job.HORIZON_ROOT)
        assert "pipe-pane" not in [c[0] for c in fake_tmux.calls], "the runner owns the only log"
        payload = json.loads(farmd._tenant_spool_path(66318).read_text())
        assert payload["entry"] == "job"
        assert payload["job"]["results_dir"] == str(tmp_path / "tenant-jobs" / "7")
        assert "repo_dir" not in payload["job"], "the farm user's checkout is never handed over"
        assert "task" not in payload, "a tenant-entry from before HZ-772 refuses it"
        assert payload["env"]["GITHUB_TOKEN"] == A_TOKEN
        assert not list((QUEUE_DIR / "jobs" / "active").glob("66318.env.json*")), "farmd writes no env file"
    finally:
        (QUEUE_DIR / "jobs" / "active" / "66318.json").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop("66318", None)



# ---- guardrail 2: no token value in any outward channel ----


def test_no_token_in_any_outward_channel(farm, root, tmp_path, fake_tmux, monkeypatch, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd, "_refresh_rules", lambda task: False)
    task = make_task(66308, test_env_file=a_file(root))

    res = client.post("/steps/run", json=task)
    assert res.status_code == 200
    queued = (QUEUE_DIR / "runs" / "66308.json").read_text()
    (QUEUE_DIR / "runs" / "66308.json").unlink()

    # A refused claim (its ref no longer resolves) reaches the forwarded error.
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    (runs_dir / "66308.json").write_text(json.dumps(make_task(66308, ref="$NOT_SET_ANYWHERE_TOKEN", test_env_file=a_file(root))))
    farmd._claim_and_launch(runs_dir / "66308.json", runs_dir, tmp_path)

    errors = []
    for ref, environ in (("$ACME_GITHUB_TOKEN", {}), ("$ACME_GITHUB_TOKEN", {"ACME_GITHUB_TOKEN": ""}), ("ghp_" + A_TOKEN, FARMD_ENV)):
        with pytest.raises(credentials.TenantEnvError) as exc:
            credentials.resolve_token_ref(ref, environ)
        errors.append(str(exc.value))

    call = launch(task, tmp_path, fake_tmux)
    execs = []
    monkeypatch.setattr(tenant_launch.os, "dup2", lambda fd, target: None)
    monkeypatch.setattr(tenant_launch.os, "execvp", lambda file, argv: execs.append(argv))
    words = shlex.split(call[-1])
    tenant_launch.main(words[words.index("--spool") :])

    out = capsys.readouterr()
    channels = {
        "/steps/run body": res.text,
        "queued task file": queued,
        "forwarded error": json.dumps(forwarded),
        "stdout/stderr": out.out + out.err,
        "log records": caplog.text,
        "TenantEnvError": " ".join(errors),
        "tmux argv": json.dumps(fake_tmux.calls),
        "execvp argv": json.dumps(execs),
    }
    assert forwarded and execs and fake_tmux.calls
    for name, text in channels.items():
        for secret in (A_TOKEN, OAUTH, SHARED_TOKEN):
            assert secret not in text, f"a token value reached the {name}"


# ---- guardrail 2: the spool's lifetime ----


def test_a_missing_spool_exits_non_zero_and_never_runs_sudo(tmp_path, monkeypatch):
    monkeypatch.setattr(tenant_launch.os, "execvp", lambda file, argv: pytest.fail("sudo must never run"))
    with pytest.raises(SystemExit) as exc:
        tenant_launch.main(["--spool", str(tmp_path / "66309.tenant.json"), "--run-user", "acme_run"])
    assert exc.value.code != 0


def test_a_failed_tmux_launch_removes_the_spool(farm, root, tmp_path, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("tmux new-session failed")

    monkeypatch.setattr(farmd.tmux_mgr, "new_session", broken)
    with pytest.raises(RuntimeError):
        farmd._launch_tenant_session("farm-run-ac-1-s10-a1", make_task(66310, test_env_file=a_file(root)), tmp_path)
    assert not farmd._tenant_spool_path(66310).exists()


def plant(run_id, root, *, task_file=True):
    """A claimed task file past its grace period plus the 0600 spool a launch
    that never ran left behind."""
    spool = farmd._tenant_spool(make_task(run_id, test_env_file=a_file(root)))
    if task_file:
        task = make_task(run_id, test_env_file=a_file(root))
        task["claimed_at"] = time.time() - 3600
        (QUEUE_DIR / "runs" / "active" / f"{run_id}.json").write_text(json.dumps(task))
    return spool


def test_unlaunched_tenant_spool_is_removed_by_the_reconciler(farm, root, fake_tmux, monkeypatch):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: False)
    released = plant(66311, root)
    orphan = plant(66312, root, task_file=False)
    farmd._reconcile_claimed_runs()
    assert not released.exists()
    assert not orphan.exists()
    assert not (QUEUE_DIR / "runs" / "active" / "66311.json").exists()


@pytest.mark.parametrize("reason", [None, "pause"], ids=["cancel", "pause"])
def test_unlaunched_tenant_spool_is_removed_by_cancel_and_pause(farm, root, fake_tmux, reason):
    spool = plant(66313, root)
    res = client.post("/steps/cancel", json={"run_id": 66313, "reason": reason})
    assert res.json()["removed"] is True
    assert not spool.exists()


# ---- HZ-697: a tenant's own `file:` token ref ----

FILE_TOKEN = "github_pat_tenant-file-token-value-0009"


def tenant_token_file(root, project_id, *, mode=0o600, text=FILE_TOKEN):
    path = root / str(project_id)
    path.write_text(text + "\n")
    os.chmod(path, mode)
    return path


def file_ref(project_id):
    return f"{credentials.FILE_REF_PREFIX}{project_id}"


def test_a_file_ref_resolves_to_its_own_projects_0600_file(tmp_path):
    tenant_token_file(tmp_path, 42)
    assert credentials.resolve_token_ref(file_ref(42), {}, project_id=42, token_root=str(tmp_path)) == FILE_TOKEN
    env = credentials.tenant_session_env(
        {"id": 42, "githubTokenRef": file_ref(42), "runUser": "hz-p42"}, home="/home/hz-p42", environ={}, token_root=str(tmp_path)
    )
    assert env["GITHUB_TOKEN"] == env["GH_TOKEN"] == FILE_TOKEN


def refused(ref, project_id, root):
    with pytest.raises(credentials.TenantEnvError) as exc:
        credentials.resolve_token_ref(ref, {"GITHUB_TOKEN": SHARED_TOKEN}, project_id=project_id, token_root=str(root))
    assert FILE_TOKEN not in str(exc.value) and SHARED_TOKEN not in str(exc.value)
    return str(exc.value)


def test_a_file_ref_naming_another_projects_id_is_refused(tmp_path):
    tenant_token_file(tmp_path, 42)
    tenant_token_file(tmp_path, 43)
    assert "this project's" in refused(file_ref(42), 43, tmp_path)
    assert "this project's" in refused(file_ref(42), None, tmp_path)


@pytest.mark.parametrize("ref", ["file:/etc/horizon/server.env", "file:/etc/horizon/tenant-tokens/../42", "file:/etc/horizon/tenant-tokens/042"])
def test_a_file_ref_outside_the_tenant_token_path_is_refused(tmp_path, ref):
    tenant_token_file(tmp_path, 42)
    refused(ref, 42, tmp_path)


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o400, 0o660])
def test_a_token_file_not_mode_0600_is_refused(tmp_path, mode):
    tenant_token_file(tmp_path, 42, mode=mode)
    assert "0600" in refused(file_ref(42), 42, tmp_path)


def test_a_token_file_owned_by_another_uid_is_refused(tmp_path, monkeypatch):
    tenant_token_file(tmp_path, 42)
    other_uid = os.getuid() + 1
    monkeypatch.setattr(credentials.os, "getuid", lambda: other_uid)
    assert "farm user" in refused(file_ref(42), 42, tmp_path)


def test_a_symlinked_or_missing_token_file_is_refused(tmp_path):
    real = tenant_token_file(tmp_path, 7)
    (tmp_path / "42").symlink_to(real)
    refused(file_ref(42), 42, tmp_path)
    refused(file_ref(43), 43, tmp_path)


def test_an_empty_token_file_is_refused(tmp_path):
    tenant_token_file(tmp_path, 42, text="  ")
    refused(file_ref(42), 42, tmp_path)
