"""HZ-758 (HZ-663 part 2): a tenant step runs in a workspace its run user owns.

step_agent, running as the run user with FARM_HOME under that user's home,
clones its own hub (workspaces.ensure_tenant_hub) before the item worktree.
The clone URL holds no credential: git reads the session's own $GITHUB_TOKEN
through TENANT_CREDENTIAL_HELPER, set after an empty entry that drops any
other helper. farmd never clones, fetches or prunes a tenant repo as the farm
user. "https://github.com/" is a local bare repo here, through a
GIT_CONFIG_GLOBAL `insteadOf`; the run user is this test's own uid."""

import json
import os
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from farm import farmd, knowledge, step_agent, workspaces
from farm.step_agent import execute
from farm.tests.test_step_agent import NO_CHECKS, make_git_workspace, make_task

REPO = "acme/demo"
TOKEN = "github_pat_tenant-own-token-hz758-0001"
SHARED_TOKEN = "shared-farm-github-token-hz758-0002"
REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def run_user_home(tmp_path, monkeypatch):
    """The run user's FARM_HOME and workspaces, as tenant_session_env sets them."""
    farm_home = tmp_path / "home" / "hz-p9" / ".horizon-farm"
    monkeypatch.setattr(workspaces, "FARM_HOME", farm_home)
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", farm_home / "workspaces")
    return farm_home


@pytest.fixture
def github(tmp_path, monkeypatch, run_user_home):
    """A bare origin standing in for github.com/acme/demo, and a global
    gitconfig (the run user's ~/.gitconfig) that also names a credential
    helper which must never run."""
    _, origin = make_git_workspace(tmp_path)
    marker = tmp_path / "global-helper-ran"
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\temail = farm@example.com\n\tname = Horizon Farm\n"
        f'[url "file://{origin}"]\n\tinsteadOf = https://github.com/{REPO}.git\n'
        f"[credential]\n\thelper = \"!f() {{ touch '{marker}'; echo password=from-global-helper; }}; f\"\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GITHUB_TOKEN", TOKEN)
    monkeypatch.setenv("GH_TOKEN", TOKEN)
    return origin, marker


def tenant_task(**kwargs):
    task = make_task(11, step_agent.IMPLEMENT_LABEL, repo=REPO, checks_waiver=NO_CHECKS, **kwargs)
    task["project"] = {"id": 9, "name": "Acme", "isolation": "tenant", "githubTokenRef": "file:/etc/horizon/tenant-tokens/9", "runUser": "hz-p9"}
    return task


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def hub_helpers(hub: Path) -> list[str]:
    return subprocess.run(
        ["git", "-C", str(hub), "config", "--local", "--get-all", "credential.helper"], capture_output=True, text=True, check=True
    ).stdout.split("\n")[:-1]


def credential_fill(hub: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(hub), "credential", "fill"],
        input="protocol=https\nhost=github.com\npath=acme/demo.git\n\n",
        capture_output=True, text=True, env=env, timeout=20,
    )


# ---- R1: the tenant step journey ----


def test_a_tenant_implement_step_runs_in_its_run_users_own_workspace_and_pushes(github, run_user_home):
    origin, marker = github
    result = execute(tenant_task())

    workspaces_dir = run_user_home / "workspaces"
    hub = workspaces_dir / "acme__demo"
    worktree = workspaces_dir / "acme__demo__items" / "t-1"
    assert (hub / ".git").is_dir()
    assert worktree.is_dir()
    assert result["artifacts"]["branch"] == "horizon/t-1"
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:fake_implementation.txt"], capture_output=True, text=True, check=True
    ).stdout
    assert "fake implementation" in shown

    # Owned by the run user (this process's uid here), mode 0700.
    for directory in (run_user_home, workspaces_dir):
        assert directory.stat().st_uid == os.getuid()
        assert mode(directory) == 0o700
    # The hub's real config: the empty reset first, then the helper — no value.
    assert hub_helpers(hub) == ["", workspaces.TENANT_CREDENTIAL_HELPER]
    config_text = (hub / ".git" / "config").read_text()
    assert TOKEN not in config_text
    assert "x-access-token:" not in config_text
    assert "url = https://github.com/acme/demo.git" in config_text
    assert not marker.exists(), "the run user's global helper never ran"


# ---- metric 1: token only through the helper; no argv, no URL ----


def test_the_tenant_clone_puts_no_token_on_any_argv_or_url(github, run_user_home, monkeypatch):
    argvs = []
    real_run = subprocess.run

    def recording_run(argv, *args, **kwargs):
        argvs.append(list(argv))
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(workspaces.subprocess, "run", recording_run)
    workspaces.ensure_tenant_hub(REPO)
    workspaces.ensure_item_worktree(REPO, "T-1")

    clone = next(a for a in argvs if "clone" in a)
    assert clone[:5] == ["git", "-c", "credential.helper=", "-c", f"credential.helper={workspaces.TENANT_CREDENTIAL_HELPER}"]
    assert f"https://github.com/{REPO}.git" in clone
    for argv in argvs:
        text = " ".join(argv)
        assert TOKEN not in text and SHARED_TOKEN not in text
        assert "x-access-token:" not in text and "@github.com" not in text


# ---- R3: the helper answers with the session's own token, nothing else ----


def test_the_hub_helper_returns_only_the_session_token_and_never_a_global_helper(github, run_user_home):
    _, marker = github
    hub = workspaces.ensure_tenant_hub(REPO)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    filled = credential_fill(hub, {**env, "GITHUB_TOKEN": TOKEN})
    assert filled.returncode == 0, filled.stderr
    assert f"password={TOKEN}" in filled.stdout.splitlines()
    assert "username=x-access-token" in filled.stdout.splitlines()
    assert "from-global-helper" not in filled.stdout
    assert not marker.exists()

    # A rotated token is read fresh on the next call: nothing is cached.
    rotated = credential_fill(hub, {**env, "GITHUB_TOKEN": TOKEN + "-rotated"})
    assert f"password={TOKEN}-rotated" in rotated.stdout.splitlines()

    for unset in ({k: v for k, v in env.items() if k != "GITHUB_TOKEN"}, {**env, "GITHUB_TOKEN": ""}):
        empty = credential_fill(hub, unset)
        assert empty.returncode != 0, "no token: git fails fast, no prompt"
        assert "password=" not in empty.stdout
        assert "from-global-helper" not in empty.stdout
    assert not marker.exists()


# ---- R2: a failed clone fails the step, names the repo only, and retries ----


@pytest.fixture
def failing_git(tmp_path, monkeypatch):
    """A `git` that, for clone only, leaves a partial target and prints the
    token and a credentialed URL to stderr before failing."""
    bin_dir = tmp_path / "failing-bin"
    bin_dir.mkdir()
    real_git = subprocess.run(["which", "git"], capture_output=True, text=True, check=True).stdout.strip()
    script = bin_dir / "git"
    script.write_text(
        "#!/bin/sh\n"
        'for a in "$@"; do last="$a"; done\n'
        'case " $* " in *" clone "*)\n'
        '  mkdir -p "$last/.git" && touch "$last/.git/partial"\n'
        f'  echo "fatal: could not read from https://x-access-token:$GITHUB_TOKEN@github.com/{REPO}.git" >&2\n'
        "  exit 128;;\n"
        "esac\n"
        f'exec {real_git} "$@"\n'
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    return bin_dir


def test_a_failed_tenant_clone_fails_the_step_with_the_repo_named_only(github, run_user_home, failing_git, monkeypatch):
    monkeypatch.setattr(step_agent, "run_agent", lambda *a, **k: pytest.fail("no agent runs without a workspace"))
    hub = run_user_home / "workspaces" / "acme__demo"
    with pytest.raises(RuntimeError) as exc:
        execute(tenant_task())
    message = str(exc.value)
    assert message == "tenant hub clone of acme/demo failed (CalledProcessError)"
    assert TOKEN not in message and "fatal" not in message and "x-access-token" not in message
    assert exc.value.__cause__ is None and exc.value.__suppress_context__
    assert not hub.exists(), "the partial hub is removed"

    # The next step retries the clone, and it succeeds.
    monkeypatch.setenv("PATH", os.environ["PATH"].replace(f"{failing_git}{os.pathsep}", "", 1))
    assert workspaces.ensure_tenant_hub(REPO) == hub
    assert (hub / ".git" / "HEAD").exists()


def test_a_tenant_clone_that_times_out_is_removed_and_named(github, run_user_home, monkeypatch):
    def timeout(argv, *args, **kwargs):
        Path(argv[-1], ".git").mkdir(parents=True)
        raise subprocess.TimeoutExpired(argv, workspaces.TENANT_CLONE_TIMEOUT_S)

    monkeypatch.setattr(workspaces.subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match=r"^tenant hub clone of acme/demo failed \(TimeoutExpired\)$"):
        workspaces.ensure_tenant_hub(REPO)
    assert not (run_user_home / "workspaces" / "acme__demo").exists()


# ---- R6: FARM_HOME and workspaces end at 0700, new or pre-existing ----


def test_pre_existing_open_dirs_are_tightened_to_0700(github, run_user_home):
    (run_user_home / "workspaces").mkdir(parents=True)
    os.chmod(run_user_home, 0o755)
    os.chmod(run_user_home / "workspaces", 0o755)
    workspaces.ensure_tenant_hub(REPO)
    assert mode(run_user_home) == 0o700
    assert mode(run_user_home / "workspaces") == 0o700

    # An existing hub returns at once, and the modes are fixed again.
    os.chmod(run_user_home / "workspaces", 0o755)
    workspaces.ensure_tenant_hub(REPO)
    assert mode(run_user_home / "workspaces") == 0o700


def test_two_first_steps_clone_the_hub_once(github, run_user_home, monkeypatch):
    clones = []
    real_run = subprocess.run
    monkeypatch.setattr(
        workspaces.subprocess, "run", lambda argv, *a, **k: (clones.append(argv) if "clone" in argv else None, real_run(argv, *a, **k))[1]
    )
    results, errors = [], []

    def provision():
        try:
            results.append(workspaces.ensure_tenant_hub(REPO))
        except Exception as exc:  # noqa: BLE001 — surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=provision) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert errors == []
    assert len(results) == 2 and len(clones) == 1


# ---- metric 1: the session's locks and state are its own ----


def test_a_tenant_sessions_lock_and_state_paths_sit_under_its_own_farm_home(tmp_path):
    farm_home = tmp_path / "hz-p9" / ".horizon-farm"
    code = (
        "import json\n"
        "from farm import config, workspaces\n"
        "print(json.dumps([\n"
        "  str(workspaces.hub_path('acme/demo') / '.git' / 'horizon-hub.lock'),\n"
        "  str(workspaces._item_lock_path('acme/demo', 'AC-1')),\n"
        "  str(workspaces._tenant_provision_lock_path('acme/demo')),\n"
        "  str(workspaces.workspace_path('acme/demo', 'AC-1')),\n"
        "  str(config.STATE_DIR), str(config.QUEUE_DIR), str(config.LOGS_DIR), str(config.WORKSPACES_DIR),\n"
        "]))\n"
    )
    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    env["FARM_HOME"] = str(farm_home)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=REPO_ROOT, env=env, timeout=60, check=True)
    paths = [Path(p) for p in json.loads(out.stdout)]
    assert len(paths) == 8
    for path in paths:
        assert path.is_relative_to(farm_home), path


# ---- guardrail 2: farmd never clones a tenant repo as the farm user ----


@pytest.fixture
def farm_clones(monkeypatch):
    """Every workspaces.ensure and _hub_token farmd makes; $GITHUB_TOKEN set."""
    monkeypatch.setenv("GITHUB_TOKEN", SHARED_TOKEN)
    calls = {"ensure": [], "hub_token": 0, "prune": []}
    monkeypatch.setattr(farmd.workspaces, "ensure", lambda repo, token: calls["ensure"].append((repo, token)))
    monkeypatch.setattr(farmd.workspaces, "prune_worktrees", lambda repo: calls["prune"].append(repo))
    real_hub_token = farmd._hub_token

    def hub_token():
        calls["hub_token"] += 1
        return real_hub_token()

    monkeypatch.setattr(farmd, "_hub_token", hub_token)
    return calls


class _Sources:
    def __init__(self, sources):
        self.sources = sources

    def raise_for_status(self):
        return None

    def json(self):
        return {"sources": self.sources}


def source(isolation, repo="acme/never-cloned"):
    entry = {"projectId": 9, "slug": "acme-never-cloned__spec-0123456789", "repo": repo, "path": "spec.pdf", "lastSha": None, "status": None}
    if isolation is not None:
        entry["isolation"] = isolation
    return entry


def test_a_fresh_farmd_knowledge_tick_never_clones_a_tenant_source(farm_clones, monkeypatch, tmp_path):
    """No in-memory history: the server's own `isolation` on each source
    decides, so a just-restarted farmd skips a tenant's source too."""
    monkeypatch.setattr(farmd, "_PROVISIONING", set())
    listed = [source("tenant"), source(None, repo="acme/no-isolation"), source("TENANT", repo="acme/odd")]
    monkeypatch.setattr(farmd.httpx, "get", lambda *a, **k: _Sources(listed))
    asked = []
    provision = lambda repo: asked.append(repo) or farmd._provision_hub(repo)  # noqa: E731
    reported = knowledge.sync_once(farmd._knowledge_sources, lambda *a: pytest.fail("nothing to report"), provision=provision)
    assert reported == []
    assert asked == []
    assert farm_clones["ensure"] == []
    assert farm_clones["hub_token"] == 0
    assert farmd._PROVISIONING == set()


def test_farmd_still_provisions_an_internal_knowledge_source(monkeypatch):
    listed = [source("tenant"), source("internal", repo="acme/internal-docs")]
    monkeypatch.setattr(farmd.httpx, "get", lambda *a, **k: _Sources(listed))
    assert [s["repo"] for s in farmd._knowledge_sources()] == ["acme/internal-docs"]


@pytest.fixture
def farm_state(monkeypatch):
    saved = dict(farmd.state)
    monkeypatch.setattr(farmd, "_maybe_launch_concierge", lambda: False)
    monkeypatch.setattr(farmd, "_persist_state", lambda: None)
    try:
        yield
    finally:
        farmd.state.clear()
        farmd.state.update(saved)


def test_farm_start_for_a_tenant_project_clones_and_prunes_nothing(farm_clones, farm_state):
    project = {"id": 9, "name": "Acme", "isolation": "tenant"}
    farmd._start_async(project, [{"repo": "acme/site", "prefix": "AC"}], None)
    assert farm_clones["ensure"] == [] and farm_clones["prune"] == []
    assert farm_clones["hub_token"] == 0
    assert farmd.state["status"] == "running"


@pytest.mark.parametrize("project", [{"id": 1, "name": "Horizon", "isolation": "internal"}, {"id": 1, "name": "Horizon"}], ids=["internal", "no-key"])
def test_farm_start_for_an_internal_project_clones_as_before(farm_clones, farm_state, project):
    farmd._start_async(project, [{"repo": "FinTekkers/horizon", "prefix": "HZ"}], "start-token")
    assert farm_clones["ensure"] == [("FinTekkers/horizon", "start-token")]
    assert farm_clones["prune"] == ["FinTekkers/horizon"]
