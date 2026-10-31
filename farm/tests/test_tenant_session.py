"""HZ-663 part 1: a tenant session runs as its project's run_user, holding only
its own project's token and test-env file.

farmd builds the session env from empty (credentials.tenant_session_env),
spools it 0600, and launches `env -i … farm.tenant_launch` in tmux; that execs
`sudo -n -u <run_user> <TENANT_ENTRY>` with the spool on stdin, and
infra/host/tenant-entry execs step_agent with exactly that env. Until part 2
moves the workspace, _tenant_launch_refusal refuses every tenant launch, so
the launch tests below drive _launch_tenant_session directly."""

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
    """The tenant launch below the part 1 gate: spool + tmux, as
    _claim_and_launch will call it once the gate goes."""
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


# ---- metric 2: project A loads only A's test-env file ----

REFUSED_PATHS = {
    "project-b": lambda root: str(root / "8" / "e2e.env"),
    "internal": lambda root: "/etc/fintekkers/ui-e2e.env",
    "relative": lambda root: "tenants/7/e2e.env",
    "dotdot": lambda root: f"{root}/7/../8/e2e.env",
    "sibling-prefix": lambda root: str(root / "77" / "e2e.env"),
    "none": lambda root: None,
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
    if path is None:
        task.pop("test_env_file", None)

    if case == "project-a":
        assert farmd._tenant_launch_refusal(task) == farmd.TENANT_WORKSPACE_GATE, "the path check passed"
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
    assert farmd._tenant_launch_refusal(b) == farmd.TENANT_WORKSPACE_GATE
    with pytest.raises(login_env.LoginEnvError):
        login_env.tenant_env_path(str(root / "8" / "e2e.env"), 7)
    assert login_env.tenant_env_path(str(root / "8" / "e2e.env"), 8) == str(root / "8" / "e2e.env")


# ---- guardrail 3: fail closed — refused, nothing queued, launched or spooled ----

FAIL_CLOSED = {
    "missing-run-user": ({"run_user": None}, "isolation_refused", "tenant project needs run_user before the farm runs it"),
    "unset-ref": ({"ref": "$NOT_SET_ANYWHERE_TOKEN"}, "tenant_launch_refused", "tenant project needs a resolvable github_token_ref"),
    "empty-ref": ({"ref": "$EMPTY_TENANT_TOKEN"}, "tenant_launch_refused", "tenant project needs a resolvable github_token_ref"),
    "out-of-root-test-env": ({"test_env_file": "/etc/fintekkers/ui-e2e.env"}, "tenant_launch_refused", "tenant test_env_file must live under the project's own directory"),
    "complete-valid": ({}, "tenant_launch_refused", "tenant workspace not supported yet: the farm will not run tenant items until it is"),
}


@pytest.mark.parametrize("case", FAIL_CLOSED, ids=list(FAIL_CLOSED))
def test_a_tenant_launch_fails_closed(farm, root, fake_tmux, monkeypatch, case):
    monkeypatch.setenv("EMPTY_TENANT_TOKEN", "")
    overrides, error, reason = FAIL_CLOSED[case]
    task = make_task(66306, **{"test_env_file": a_file(root), **overrides})

    res = client.post("/steps/run", json=task)
    assert res.status_code == 400
    assert res.json() == {"error": error, "reason": reason}
    assert queued_files() == []
    assert new_sessions(fake_tmux) == []
    assert not list((QUEUE_DIR / "runs" / "active").glob("*.tenant.json*"))


def test_a_queued_tenant_task_is_refused_at_the_claim_too(farm, root, tmp_path, fake_tmux, monkeypatch):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: pytest.fail("a refused task must never report started"))
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = runs_dir / "66307.json"
    task_path.write_text(json.dumps(make_task(66307, test_env_file=a_file(root))))

    assert farmd._claim_and_launch(task_path, runs_dir, tmp_path) is None
    assert forwarded == [{"run_id": 66307, "ok": False, "error": f"the farm refused this tenant item: {farmd.TENANT_WORKSPACE_GATE}"}]
    assert new_sessions(fake_tmux) == []
    assert not (runs_dir / "active").exists()


# ---- guardrail 2: no token value in any outward channel ----


def test_no_token_in_any_outward_channel(farm, root, tmp_path, fake_tmux, monkeypatch, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    forwarded = []
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or 200)
    task = make_task(66308, test_env_file=a_file(root))

    res = client.post("/steps/run", json=task)
    assert res.status_code == 400

    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    (runs_dir / "66308.json").write_text(json.dumps(task))
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
        "400 body": res.text,
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
