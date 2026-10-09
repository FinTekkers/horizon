"""HZ-207: one farmd runs every enabled project's steps. Each task carries its
own project and repo; rules, workspace and PM context come from the task,
never from the farm's single state["project"]. The limits stay global."""

import json
import os
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import check_slots, farmd, pm_steps, step_agent, workspaces
from farm import config as farm_config
from farm.config import QUEUE_DIR
from farm.task_files import task_project

client = TestClient(farmd.app)

HORIZON = {"id": 1, "name": "Horizon"}
FINTEKKERS = {"id": 2, "name": "FinTekkers"}
HORIZON_RULES = "Horizon — project rules"
FINTEKKERS_RULES = "FinTekkers — project rules"
IMPLEMENT = 10  # runs lane
SUMMARIZE = 9  # PM lane


def make_task(run_id, project, repo, item_id, step_index=IMPLEMENT):
    task = {
        "run_id": run_id,
        "attempt": 1,
        "item": {"id": item_id, "title": "t", "repo": repo},
        "step": {"index": step_index, "label": "Summarize reviews & recommend"},
    }
    if project is not ...:
        task["project"] = project
    return task


@pytest.fixture
def farm(monkeypatch):
    """A running farm whose own state["project"] is Horizon — the global a
    FinTekkers task must never pick up. The background tick is a no-op; the
    test drives the real one. No hub is cloned unless a test asks."""
    real_tick = farmd._dispatch_tick
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    provisioned = []
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: provisioned.append(repo) or True)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project=dict(HORIZON))
    dirs = [QUEUE_DIR / "pm", QUEUE_DIR / "runs", QUEUE_DIR / "runs" / "active"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    try:
        yield type("Farm", (), {"tick": staticmethod(real_tick), "provisioned": provisioned})
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        farmd._PROVISIONING.clear()
        for d in dirs:
            for f in d.glob("*.json*"):
                f.unlink(missing_ok=True)


def queued(lane, run_id):
    return json.loads((QUEUE_DIR / lane / f"{run_id}.json").read_text())


# ---- metric 3: each task carries its own project, rules, workspace, repo ----


def test_concurrent_horizon_and_fintekkers_steps_each_get_their_own_rules_workspace_and_repo(farm, fake_tmux):
    h = client.post("/steps/run", json=make_task(201, HORIZON, "FinTekkers/horizon", "HZ-1"))
    f = client.post("/steps/run", json=make_task(202, FINTEKKERS, "FinTekkers/ui-service", "US-1"))
    assert h.status_code == 200 and f.status_code == 200

    farm.tick()
    active = QUEUE_DIR / "runs" / "active"
    horizon, fintekkers = (json.loads((active / f"{rid}.json").read_text()) for rid in (201, 202))
    launched = [c for c in fake_tmux.calls if c[0] == "new-session"]
    assert len(launched) == 2, "both projects' steps run at the same time"

    assert horizon["project"] == HORIZON and fintekkers["project"] == FINTEKKERS
    horizon_rules, fintekkers_rules = "\n".join(horizon["rules"]), "\n".join(fintekkers["rules"])
    assert HORIZON_RULES in horizon_rules and FINTEKKERS_RULES not in horizon_rules
    assert FINTEKKERS_RULES in fintekkers_rules and HORIZON_RULES not in fintekkers_rules
    assert "FinTekkers/ui-service — repo rules" in fintekkers_rules
    assert horizon["item"]["repo"] == "FinTekkers/horizon"
    assert fintekkers["item"]["repo"] == "FinTekkers/ui-service"
    horizon_ws = workspaces.workspace_path(horizon["item"]["repo"], horizon["item"]["id"])
    fintekkers_ws = workspaces.workspace_path(fintekkers["item"]["repo"], fintekkers["item"]["id"])
    assert horizon_ws.parent.name == "FinTekkers__horizon__items"
    assert fintekkers_ws.parent.name == "FinTekkers__ui-service__items"


def test_a_fintekkers_pm_step_gets_fintekkers_context_while_the_farm_project_is_horizon(farm):
    task = make_task(203, FINTEKKERS, "FinTekkers/ui-service", "US-2", step_index=SUMMARIZE)
    task["project_context"] = {"items": [{"id": "US-9", "title": "a FinTekkers sibling"}], "feedback": []}
    assert client.post("/steps/run", json=task).json() == {"ok": True, "queued": "pm"}

    prompt = pm_steps.build_prompt(queued("pm", 203))
    assert "Project: FinTekkers" in prompt
    assert FINTEKKERS_RULES in prompt and HORIZON_RULES not in prompt
    assert "US-9" in prompt


# ---- guardrail: no project or repo is rejected, never filled in ----


@pytest.mark.parametrize(
    "project, repo, error",
    [
        (..., "FinTekkers/horizon", "missing project"),
        (None, "FinTekkers/horizon", "missing project"),
        ("Horizon", "FinTekkers/horizon", "missing project"),
        ({"id": 1}, "FinTekkers/horizon", "missing project"),
        ({"name": "Horizon"}, "FinTekkers/horizon", "missing project"),
        ({"id": 1, "name": "  "}, "FinTekkers/horizon", "missing project"),
        (HORIZON, None, "missing item.repo"),
        (HORIZON, "", "missing item.repo"),
    ],
)
def test_steps_run_rejects_a_task_without_its_own_project_or_repo(farm, project, repo, error):
    task = make_task(204, project, repo, "HZ-2")
    if repo is None:
        del task["item"]["repo"]
    res = client.post("/steps/run", json=task)
    assert res.status_code == 400
    assert res.json() == {"error": error}
    assert list(QUEUE_DIR.glob("*/204.json")) == []
    assert farm.provisioned == []


# ---- guardrail exception: legacy queue files are Horizon ----


@pytest.mark.parametrize("legacy", [{"project": None}, {}], ids=["project-null", "no-project-key"])
def test_a_legacy_task_file_resolves_to_horizon_in_both_agents(farm, fake_tmux, legacy):
    # The exact shape an older farmd wrote: rules already stamped at enqueue.
    task = make_task(205, ..., "FinTekkers/horizon", "HZ-3", step_index=SUMMARIZE)
    task.update(legacy, rules=["legacy stamped rules"])
    (QUEUE_DIR / "pm" / "205.json").write_text(json.dumps(task))

    assert task_project(task) == {"name": "Horizon"}
    assert "Project: Horizon" in pm_steps.build_prompt(task)
    # step_agent reads no project of its own: it uses the rules stamped at
    # enqueue, verbatim, never the farm's state["project"].
    step_prompt = step_agent.build_prompt(task)
    assert "legacy stamped rules" in step_prompt and HORIZON_RULES not in step_prompt

    farm.tick()
    assert (QUEUE_DIR / "runs" / "active" / "205.json").exists(), "a legacy file is still dispatched"


# ---- metric 4: the limits are global across projects ----


def test_max_ephemeral_caps_the_combined_runs_of_both_projects_at_every_sample(farm, fake_tmux, monkeypatch):
    monkeypatch.setattr(farmd, "MAX_EPHEMERAL", 2)
    for n, (project, repo) in enumerate([(HORIZON, "FinTekkers/horizon")] * 3 + [(FINTEKKERS, "FinTekkers/ui-service")] * 2):
        res = client.post("/steps/run", json=make_task(700 + n, project, repo, f"IT-{n}"))
        assert res.status_code == 200
        time.sleep(0.01)  # distinct mtimes: the queue is oldest first

    launched_projects = []
    for _ in range(10):
        farm.tick()
        running = farmd._lane_busy(farmd._ephemeral_sessions())["runs"]
        assert running <= 2, f"{running} runs at once across both projects"
        for path in (QUEUE_DIR / "runs" / "active").glob("*.json"):
            launched_projects.append(json.loads(path.read_text())["project"]["name"])
            path.unlink()
        # One run finishes per tick.
        live = sorted(farmd._ephemeral_sessions())
        if live:
            fake_tmux.sessions.discard(live[0])
    assert sorted(launched_projects) == ["FinTekkers", "FinTekkers", "Horizon", "Horizon", "Horizon"]


def test_the_check_limiter_caps_the_combined_checks_of_both_projects(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    holders, peak, seen, guard = [0], [0], [], threading.Lock()

    def run_checks(run_id, item_id):
        with check_slots.check_slot(run_id=run_id, item_id=item_id, poll_s=0.01) as hold:
            with guard:
                assert hold.mode == "held"
                holders[0] += 1
                peak[0] = max(peak[0], holders[0])
                seen.append(item_id)
            time.sleep(0.1)
            with guard:
                holders[0] -= 1

    items = [(1, "HZ-1"), (2, "HZ-2"), (3, "HZ-3"), (4, "US-1"), (5, "US-2")]
    threads = [threading.Thread(target=run_checks, args=item) for item in items]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert peak[0] == 2
    assert sorted(seen) == sorted(item_id for _, item_id in items)


# ---- hub provisioning for a repo the farm project does not own ----


def test_a_task_for_an_unprovisioned_repo_waits_for_its_clone_and_the_token_never_leaks(
    monkeypatch, fake_tmux, capsys
):
    sentinel = "ghp_SENTINEL_HZ207_never_logged"
    monkeypatch.setenv("GITHUB_TOKEN", sentinel)
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project=dict(HORIZON))
    release, cloning, tokens = threading.Event(), threading.Event(), []

    def fake_ensure(repo, token):
        tokens.append(token)
        cloning.set()
        release.wait(10)
        # git can echo the authenticated URL in its error.
        raise RuntimeError(f"clone of {repo} failed: https://x-access-token:{token}@github.com/{repo}.git")

    monkeypatch.setattr(farmd.workspaces, "ensure", fake_ensure)
    try:
        first = client.post("/steps/run", json=make_task(401, FINTEKKERS, "FinTekkers/new-repo", "NR-1"))
        second = client.post("/steps/run", json=make_task(402, FINTEKKERS, "FinTekkers/new-repo", "NR-2"))
        assert first.status_code == 200 and second.status_code == 200
        assert cloning.wait(10)
        assert tokens == [sentinel], "one clone per repo, with the token"

        farmd._dispatch_runs_lane(QUEUE_DIR / "runs", Path("."))
        assert (QUEUE_DIR / "runs" / "401.json").exists(), "held queued while its hub clones"
        assert not [c for c in fake_tmux.calls if c[0] == "new-session"]

        release.set()
        deadline = time.monotonic() + 10
        while farmd._provisioning("FinTekkers/new-repo"):
            assert time.monotonic() < deadline
            time.sleep(0.01)
        farmd._dispatch_runs_lane(QUEUE_DIR / "runs", Path("."))
        assert (QUEUE_DIR / "runs" / "active" / "401.json").exists(), "a failed clone releases the task"

        out = capsys.readouterr().out
        assert "workspace for FinTekkers/new-repo failed" in out
        files = [*QUEUE_DIR.glob("**/*.json"), farmd.STATE_FILE]
        blobs = [p.read_text() for p in files if p.exists()]
        assert all(sentinel not in blob for blob in [out, *blobs])
    finally:
        release.set()
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        for d in ("pm", "runs", "runs/active"):
            for f in (QUEUE_DIR / d).glob("*.json*"):
                f.unlink(missing_ok=True)


# ---- HZ-209: exactly one concierge session, whatever the active project ----


@pytest.fixture
def concierge_pane(fake_tmux):
    """Adds a farm-concierge-* session to FakeTmux whose pane is a real
    process under `home`, so farmd's FARM_HOME ownership check reads a real
    /proc entry. Never the host's tmux."""
    procs = []

    def add(name, home=str(farm_config.FARM_HOME)):
        env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
        env["FARM_HOME"] = home
        proc = subprocess.Popen(["sleep", "120"], env=env)
        procs.append(proc)
        environ, deadline = Path(f"/proc/{proc.pid}/environ"), time.monotonic() + 10
        while not environ.read_bytes():  # mapped only once execve finishes
            assert time.monotonic() < deadline
            os.sched_yield()
        fake_tmux.sessions.add(name)
        fake_tmux.pane_pids[name] = [proc.pid]
        return name

    yield add
    for proc in procs:
        proc.kill()
        proc.wait()


def launched(fake_tmux):
    return {call[call.index("-s") + 1]: call[-1] for call in fake_tmux.calls if call[0] == "new-session"}


def test_the_concierge_session_name_does_not_follow_the_active_project(farm, monkeypatch):
    names = set()
    for project in (HORIZON, FINTEKKERS):
        monkeypatch.setitem(farmd.state, "project", dict(project))
        names.add(farmd._concierge_session_name())
    assert names == {farmd.CONCIERGE_SESSION} == {"farm-concierge-_shared"}


def test_a_launch_retires_this_farms_per_project_concierges_and_starts_the_shared_one(farm, fake_tmux, concierge_pane, monkeypatch):
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", True)
    concierge_pane("farm-concierge-horizon")
    concierge_pane("farm-concierge-fintekkers", home="/tmp/some-other-farm")

    assert farmd._maybe_launch_concierge() is True

    assert "farm-concierge-horizon" not in fake_tmux.sessions
    assert "farm-concierge-fintekkers" in fake_tmux.sessions  # another FARM_HOME's
    assert list(launched(fake_tmux)) == ["farm-concierge-_shared"]
    command = launched(fake_tmux)["farm-concierge-_shared"]
    assert "-m farm.concierge_agent --project 'Horizon' --legacy-slug horizon" in command


def test_retiring_never_kills_the_shared_concierge(farm, fake_tmux, concierge_pane):
    concierge_pane("farm-concierge-_shared")
    concierge_pane("farm-concierge-horizon")

    assert farmd._retire_legacy_concierge_sessions() == ["farm-concierge-horizon"]
    assert "farm-concierge-_shared" in fake_tmux.sessions


class _StopWatchdog(Exception):
    pass


def test_the_watchdog_revive_retires_a_per_project_concierge_too(farm, fake_tmux, concierge_pane, monkeypatch):
    """The active project changed under a running per-project concierge: the
    watchdog sees no farm-concierge-_shared and launches it — retiring the
    old one first, so two never poll at once."""
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", True)
    monkeypatch.setitem(farmd.state, "project", dict(FINTEKKERS))
    concierge_pane("farm-concierge-horizon")

    test_thread, real_sleep, slept = threading.current_thread(), time.sleep, []

    def one_pass(seconds):
        if threading.current_thread() is not test_thread:
            return real_sleep(seconds)
        if slept:
            raise _StopWatchdog
        slept.append(seconds)

    monkeypatch.setattr(farmd.time, "sleep", one_pass)
    with pytest.raises(_StopWatchdog):
        farmd._watchdog()

    assert "farm-concierge-horizon" not in fake_tmux.sessions
    assert list(launched(fake_tmux)) == ["farm-concierge-_shared"]
    assert {n for n in fake_tmux.sessions if n.startswith("farm-concierge-")} == {"farm-concierge-_shared"}


def test_internal_snapshot_asks_the_server_for_every_enabled_project(monkeypatch):
    seen = []

    class Res:
        status_code = 200

        @staticmethod
        def json():
            return {"items": [{"id": "HZ-12"}, {"id": "US-12"}]}

    def get(url, **kwargs):
        seen.append((url, kwargs.get("params")))
        return Res()

    monkeypatch.setattr(farmd.httpx, "get", get)
    res = client.get("/internal/snapshot")
    assert res.status_code == 200
    assert res.json() == {"items": [{"id": "HZ-12"}, {"id": "US-12"}]}
    assert seen == [(f"{farmd.HORIZON_URL}/api/farm/snapshot", {"scope": "enabled"})]
