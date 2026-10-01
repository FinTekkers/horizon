"""HZ-212 (HZ-204 stage 2/3): every PM step runs as its own per-task session.

farmd's dispatcher claims queue/pm tasks into queue/runs/active and launches
`python -m farm.pm_agent --task <file>` as farm-run-<item>-s<step>-a<attempt>,
with its own log — the same launch path as every other step. The long-lived
farm-pm-<project> session is retired at boot and never launched again.

Every test runs against conftest's throwaway FARM_HOME and FakeTmux. The
background dispatcher thread is paused (see `farm` below), so a test drives
each tick itself.
"""

import json
import os
import statistics
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from domain.py import reasons
from farm import farmd, pm_agent
from farm import config as farm_config
from farm.config import LOGS_DIR, PM_MALFORMED_GRACE_S, QUEUE_DIR, STATE_DIR

client = TestClient(farmd.app)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EVIDENCE = REPO_ROOT / "docs" / "pm-step-ephemeral-evidence" / "pm-spawn-overhead-20.md"
UNREACHABLE = reasons.REASON["UNREACHABLE"]


def make_task(run_id, item_id="hz-1", step_index=9, attempt=1, label="Summarize reviews & recommend"):
    """The shape /steps/run enqueues, verbatim — no claimed_at."""
    return {
        "run_id": run_id,
        "attempt": attempt,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": item_id, "title": "Per-task PM", "desc": "d", "metric": "m", "guardrails": "g"},
        "step": {"index": step_index, "label": label},
        "artifacts": [],
        "rules": [],
    }


def write_json(path: Path, body) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))
    return path


def age(path: Path, seconds: float) -> None:
    when = time.time() - seconds
    os.utime(path, (when, when))


def patch_sleep_on_this_thread(monkeypatch, fake):
    """time.sleep is shared with farmd's live background threads: only this
    test's thread gets `fake`; every other caller really sleeps."""
    test_thread, real_sleep = threading.current_thread(), time.sleep

    def sleep(seconds):
        if threading.current_thread() is not test_thread:
            return real_sleep(seconds)
        return fake(seconds)

    monkeypatch.setattr(farmd.time, "sleep", sleep)


def new_sessions(fake_tmux) -> dict[str, str]:
    return {call[call.index("-s") + 1]: call[-1] for call in fake_tmux.calls if call[0] == "new-session"}


def pipe_targets(fake_tmux) -> dict[str, str]:
    return {call[call.index("-t") + 1]: call[-1] for call in fake_tmux.calls if call[0] == "pipe-pane"}


@pytest.fixture
def farm(monkeypatch):
    """A running farm with clean queues. The background dispatcher's tick is
    swapped for a no-op (it looks the name up every tick), and the real tick
    is handed to the test to drive."""
    real_tick = farmd._dispatch_tick
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    dirs = [QUEUE_DIR / "pm", QUEUE_DIR / "runs", QUEUE_DIR / "runs" / "active"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    try:
        yield SimpleNamespace(tick=real_tick)
    finally:
        farmd.state.clear()
        farmd.state.update(saved)
        farmd.RUN_SESSIONS.clear()
        farmd.STATE_FILE.unlink(missing_ok=True)
        for d in dirs:
            for f in d.glob("*.json*"):
                f.unlink(missing_ok=True)


@pytest.fixture
def legacy_pm(fake_tmux):
    """Adds a legacy farm-pm-* session to FakeTmux whose pane is a real
    process, so farmd's FARM_HOME ownership check reads a real /proc entry.
    `home=None` runs it with no FARM_HOME at all — the real farm's shape."""
    procs = []

    def add(name="farm-pm-fintekkers", home=str(farm_config.FARM_HOME)):
        env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
        if home is not None:
            env["FARM_HOME"] = home
        proc = subprocess.Popen(["sleep", "120"], env=env)
        procs.append(proc)
        fake_tmux.sessions.add(name)
        fake_tmux.pane_pids[name] = [proc.pid]
        return name

    yield add
    for proc in procs:
        proc.kill()
        # No timeout: a test may still have time.sleep patched (Popen polls
        # with it), and a SIGKILLed sleep is reaped at once.
        proc.wait()


@pytest.fixture
def posts(monkeypatch):
    """Every POST farmd makes to the Node server, answered with `status`."""
    lane = SimpleNamespace(calls=[], status=200)

    def fake_post(url, json=None, headers=None, timeout=None):
        lane.calls.append({"url": url, "json": json})
        return SimpleNamespace(status_code=lane.status, text="", json=lambda: {})

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    patch_sleep_on_this_thread(monkeypatch, lambda seconds: None)
    return lane


@pytest.fixture
def pm_run(monkeypatch, tmp_path):
    """The real pm_agent.process()/run_task() with run_agent and the farmd
    result post faked. session_file is repointed into tmp_path."""
    lane = SimpleNamespace(replies=[], calls=[], posted=[], post=None)

    def fake_run_agent(prompt, **kw):
        lane.calls.append({"prompt": prompt, **kw})
        return {"result": lane.replies.pop(0), "session_id": "fresh-sid"}

    def fake_post(url, json=None, timeout=None):
        lane.posted.append(json)
        if lane.post is not None:
            return lane.post()
        return SimpleNamespace(status_code=200, json=lambda: {"ok": True, "forwarded": 200})

    monkeypatch.setattr(pm_agent, "run_agent", fake_run_agent)
    # A shim, not httpx.post patched: farmd and pm_agent share the httpx
    # module, and `posts` fakes farmd's side of the same call.
    monkeypatch.setattr(pm_agent, "httpx", SimpleNamespace(post=fake_post))
    monkeypatch.setattr(pm_agent, "session_file", lambda slug: tmp_path / f"pm-session-{slug}.txt")
    return lane


# ---- metric 1: no PM call resumes a stored session id ----


def test_a_stale_session_file_is_never_resumed_by_either_call(pm_run, tmp_path):
    (tmp_path / "pm-session-proj.txt").write_text("old-sid")
    pm_run.replies = ["plain prose, no json", json.dumps({"summary": "done"})]

    assert pm_agent.process(make_task(701), "proj") is True

    assert len(pm_run.calls) == 2, "the invalid first reply must take the retry_once call too"
    assert [call["session_id"] for call in pm_run.calls] == [None, None]
    # With nothing resumed, the retry must carry the task itself.
    first, retry = pm_run.calls[0]["prompt"], pm_run.calls[1]["prompt"]
    assert retry.startswith(first) and "Your previous reply was invalid" in retry
    assert pm_run.posted[-1]["ok"] is True


# ---- metric 2: no long-lived PM session; each step its own farm-run-* ----


def test_adopt_kills_a_legacy_pm_session_and_the_watchdog_launches_none(farm, fake_tmux, legacy_pm, monkeypatch):
    legacy_pm()
    farmd.STATE_FILE.write_text(json.dumps({"project": {"id": 1, "name": "FinTekkers"}, "repos": []}))

    farmd._adopt_existing()
    assert "farm-pm-fintekkers" not in fake_tmux.sessions

    sleeps = []

    def one_pass(seconds):
        if sleeps:
            raise StopIteration
        sleeps.append(seconds)

    patch_sleep_on_this_thread(monkeypatch, one_pass)
    with pytest.raises(StopIteration):
        farmd._watchdog()
    assert not [n for n in new_sessions(fake_tmux) if n.startswith("farm-pm-")]


@pytest.mark.parametrize("state_text", [None, "{not json", json.dumps({"project": None})])
def test_a_legacy_pm_session_is_killed_on_every_boot_path(farm, fake_tmux, legacy_pm, state_text):
    """QA R1: _adopt_existing's early returns (no state file, bad JSON, no
    project) must not leave an orphaned farm-pm-* polling queue/pm."""
    farmd.STATE_FILE.unlink(missing_ok=True)
    if state_text is not None:
        farmd.STATE_FILE.write_text(state_text)
    legacy_pm()
    fake_tmux.sessions.add("farm-concierge-fintekkers")

    farmd._adopt_existing()

    assert "farm-pm-fintekkers" not in fake_tmux.sessions
    assert "farm-concierge-fintekkers" in fake_tmux.sessions  # the concierge stays long-lived


@pytest.mark.parametrize("pane", ["default_home", "other_home", "unreadable"])
def test_a_legacy_pm_session_of_another_farm_home_is_left_alone(farm, fake_tmux, legacy_pm, capsys, pane):
    """Every farm on the host shares one tmux server. A farmd booted on a
    temp FARM_HOME (a test, a server-suite farmd) must not retire the real
    farm's farm-pm-<slug>, which runs with no FARM_HOME set."""
    if pane == "unreadable":
        fake_tmux.sessions.add("farm-pm-horizon")
        fake_tmux.pane_pids["farm-pm-horizon"] = [2**22 + 1]  # above pid_max: no /proc entry
    else:
        legacy_pm("farm-pm-horizon", home=None if pane == "default_home" else "/tmp/some-other-farm")

    assert farmd._retire_legacy_pm_sessions() == []

    assert "farm-pm-horizon" in fake_tmux.sessions
    assert "leaving legacy PM session farm-pm-horizon alone" in capsys.readouterr().out


def test_a_step9_task_launches_its_own_farm_run_session_and_log(farm, fake_tmux):
    write_json(QUEUE_DIR / "pm" / "702.json", make_task(702))

    farm.tick()

    claimed = QUEUE_DIR / "runs" / "active" / "702.json"
    assert set(new_sessions(fake_tmux)) == {"farm-run-hz-1-s9-a1"}
    command = new_sessions(fake_tmux)["farm-run-hz-1-s9-a1"]
    assert command.endswith(f" -m farm.pm_agent --task {claimed}")
    assert pipe_targets(fake_tmux) == {"farm-run-hz-1-s9-a1": f"cat >> '{LOGS_DIR / 'farm-run-hz-1-s9-a1.log'}'"}
    assert claimed.exists()


# ---- metric 3: each PM step runs the code and env present at dispatch ----


def test_each_pm_dispatch_is_a_fresh_process_with_the_env_at_dispatch(farm, fake_tmux, monkeypatch):
    monkeypatch.setenv("FARM_PM_MALFORMED_GRACE_S", "30")
    write_json(QUEUE_DIR / "pm" / "703.json", make_task(703, item_id="hz-2"))
    farm.tick()
    fake_tmux.sessions.clear()  # the first step finished

    monkeypatch.setenv("FARM_PM_MALFORMED_GRACE_S", "31")
    write_json(QUEUE_DIR / "pm" / "704.json", make_task(704, item_id="hz-3"))
    farm.tick()

    launched = new_sessions(fake_tmux)
    first, second = launched["farm-run-hz-2-s9-a1"], launched["farm-run-hz-3-s9-a1"]
    for command in (first, second):
        assert " -m farm.pm_agent --task " in command
    assert "FARM_PM_MALFORMED_GRACE_S=30 " in first
    assert "FARM_PM_MALFORMED_GRACE_S=31 " in second


# ---- metric 4: the prompt reflects the current farm/roles/pm.md ----


def test_replaying_step9_through_run_task_carries_the_test_contract(pm_run, farm):
    pm_md = (REPO_ROOT / "farm" / "roles" / "pm.md").read_text()
    assert "## Test contract" in pm_md
    path = write_json(QUEUE_DIR / "runs" / "active" / "705.json", make_task(705))
    pm_run.replies = [json.dumps({"summary": "recommend", "artifact_md": "## Test contract\n- kept"})]

    assert pm_agent.run_task(path) == 0

    system = pm_run.calls[0]["append_system"]
    assert "## Test contract" in system
    assert system == pm_agent.render_role_prompt(pm_md, pm_agent.PATCH_FIELDS)
    assert not path.exists()  # released only after farmd accepted the result


# ---- metric 5: a claimed PM task is never lost and reported exactly once ----


def _claimed(run_id, **kw) -> Path:
    task = make_task(run_id, **kw)
    task["claimed_at"] = time.time() - farmd.farm_config.RECONCILE_GRACE_S - 1
    return write_json(QUEUE_DIR / "runs" / "active" / f"{run_id}.json", task)


def test_a_pm_run_whose_session_is_gone_is_failed_once_as_unreachable(farm, posts):
    path = _claimed(706)

    farmd._reconcile_claimed_runs()
    farmd._reconcile_claimed_runs()

    assert [(c["url"], c["json"]["reason"]) for c in posts.calls] == [
        (f"{farmd.HORIZON_URL}/api/farm/steps/706/fail", UNREACHABLE)
    ]
    assert not path.exists()


def test_a_farmd_restart_kills_only_the_legacy_pm_and_leaves_a_live_pm_run_alone(farm, fake_tmux, legacy_pm, posts):
    """QA R2: killing farmd never kills a live per-task PM session."""
    path = _claimed(707)
    fake_tmux.sessions.add("farm-run-hz-1-s9-a1")
    legacy_pm()
    farmd.STATE_FILE.write_text(json.dumps({"project": {"id": 1, "name": "FinTekkers"}, "repos": []}))

    farmd._adopt_existing()
    farmd._reconcile_claimed_runs()

    assert fake_tmux.sessions == {"farm-run-hz-1-s9-a1"}
    assert posts.calls == []
    assert path.exists()
    assert farmd.RUN_SESSIONS["707"] == "farm-run-hz-1-s9-a1"


@pytest.mark.parametrize("failure", ["connect_error", "farmd_502"])
def test_an_undelivered_result_keeps_the_task_and_reconcile_fails_it_once(pm_run, farm, posts, failure):
    """QA R3: the result post fails while farmd is down. run_task keeps the
    claimed file and exits non-zero; reconcile then posts exactly one /fail."""
    path = _claimed(708)

    def broken_post():
        if failure == "connect_error":
            raise httpx.ConnectError("farmd is down")
        return SimpleNamespace(status_code=502, json=lambda: {"error": "could not reach horizon server"})

    pm_run.post = broken_post
    pm_run.replies = [json.dumps({"summary": "done"})]

    assert pm_agent.run_task(path) != 0
    assert path.exists()

    farmd._reconcile_claimed_runs()  # the session has exited
    farmd._reconcile_claimed_runs()
    assert [(c["url"], c["json"]["reason"]) for c in posts.calls] == [
        (f"{farmd.HORIZON_URL}/api/farm/steps/708/fail", UNREACHABLE)
    ]


# ---- metric 6: per-step launch overhead ----


def test_the_committed_spawn_overhead_evidence_has_20_samples_with_median_under_half_a_second():
    """QA R8: recompute the median from the raw samples, not the table."""
    text = EVIDENCE.read_text()
    assert "Raw per-sample totals (seconds):" in text
    block = text.split("Raw per-sample totals (seconds):", 1)[1].split("```")[1]
    samples = [float(line) for line in block.split()]
    assert len(samples) == 20
    assert statistics.median(samples) <= 0.5


def test_farmd_side_claim_overhead_over_20_pm_dispatches(farm, fake_tmux, capsys):
    """QA R8b: farmd-side claim overhead (claim, stamp, launch call) — not
    spawn time, which FakeTmux cannot measure."""
    runs_dir = QUEUE_DIR / "runs"
    timings = []
    for i in range(20):
        path = write_json(QUEUE_DIR / "pm" / f"{800 + i}.json", make_task(800 + i, item_id=f"hz-{i}"))
        start = time.perf_counter()
        farmd._claim_and_launch(path, runs_dir, REPO_ROOT)
        timings.append(time.perf_counter() - start)
    median = statistics.median(timings)
    with capsys.disabled():
        print(f"\nHZ-212 farmd-side PM claim overhead: median {median * 1000:.2f} ms over {len(timings)} dispatches")
    assert median <= 0.5
    assert len([n for n in new_sessions(fake_tmux) if "-s9-" in n]) == 20


# ---- guardrail: /farm/status keeps its keys; pm_agents is additive ----


def test_farm_status_counts_the_pm_lane_separately(farm, fake_tmux, monkeypatch, tmp_path):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    fake_tmux.sessions.update({"farm-run-hz-1-s9-a1", "farm-run-hz-2-s4-a1", "farm-run-hz-3-s4-a1"})

    body = client.get("/farm/status").json()

    assert body["status"] == "running" and "error" in body and "checks" in body
    assert sorted(body["sessions"]) == sorted(fake_tmux.sessions)
    assert body["agents"] == {"limit": farmd.MAX_EPHEMERAL, "busy": 2}
    assert body["pm_agents"] == {"limit": 1, "busy": 1}


# ---- guardrail: rejected PM inputs at the farmd boundary (QA R4) ----

REJECTED = {"601": "[]", "602": "{}", "603": '{"run_id":"1"}', "604": '{"run_id":"1","step":{}}'}


def test_unusable_pm_files_are_never_launched_and_are_reported_once_past_the_grace(farm, posts, monkeypatch):
    launched = []
    monkeypatch.setattr(farmd, "_claim_and_launch", lambda path, *a: launched.append(path))
    forwarded = []
    real_forward = farmd._forward_result
    monkeypatch.setattr(farmd, "_forward_result", lambda body: forwarded.append(body) or real_forward(body))
    paths = {stem: QUEUE_DIR / "pm" / f"{stem}.json" for stem in REJECTED}
    for stem, text in REJECTED.items():
        paths[stem].write_text(text)

    farm.tick()  # inside the grace: kept, not reported, not launched
    assert launched == [] and posts.calls == []
    assert all(p.exists() for p in paths.values())

    for p in paths.values():
        age(p, PM_MALFORMED_GRACE_S + 1)
    posts.status = 503
    farm.tick()  # not accepted: kept for the next tick
    assert all(p.exists() for p in paths.values())

    posts.calls.clear()
    forwarded.clear()
    posts.status = 200
    for _ in range(len(REJECTED) + 2):  # one report per tick, then nothing left
        farm.tick()

    assert launched == []
    assert not any(p.exists() for p in paths.values())
    assert sorted(body["run_id"] for body in forwarded) == sorted(REJECTED)
    for body in forwarded:
        assert body["ok"] is False and body["reason"] == UNREACHABLE
    assert sorted(c["url"] for c in posts.calls) == sorted(
        f"{farmd.HORIZON_URL}/api/farm/steps/{stem}/fail" for stem in REJECTED
    )
    assert all(c["json"]["reason"] == UNREACHABLE for c in posts.calls)


# ---- guardrail: the PM lane keeps its limit of 1 ----


def test_lane_busy_splits_live_sessions_by_lane():
    sessions = ["farm-run-hz-1-s9-a1", "farm-run-hz-s1-s0-a2", "farm-run-hz-2-s11-a1", "farm-weird"]
    assert farmd._lane_busy(sessions) == {"pm": 2, "runs": 2}


def test_a_live_pm_session_blocks_a_second_pm_launch(tmp_path):
    a = write_json(tmp_path / "a.json", make_task(1, item_id="hz-a"))
    b = write_json(tmp_path / "b.json", make_task(2, item_id="hz-b"))
    assert farmd._select_pm_dispatchable([a, b], []) == ([a], [])
    assert farmd._select_pm_dispatchable([a, b], ["farm-run-hz-9-s1-a1"]) == ([], [])


def test_runs_sessions_do_not_block_a_pm_launch(tmp_path):
    a = write_json(tmp_path / "a.json", make_task(1))
    runs = [f"farm-run-hz-{i}-s11-a1" for i in range(4)]
    assert farmd._select_pm_dispatchable([a], runs) == ([a], [])


def test_a_pm_session_does_not_use_a_runs_slot(farm, fake_tmux, monkeypatch):
    monkeypatch.setattr(farmd, "MAX_EPHEMERAL", 1)
    fake_tmux.sessions.add("farm-run-hz-1-s9-a1")
    write_json(QUEUE_DIR / "runs" / "710.json", make_task(710, item_id="hz-7", step_index=4, label="x"))

    farm.tick()

    assert new_sessions(fake_tmux)["farm-run-hz-7-s4-a1"].endswith("-m farm.step_agent --task " + str(QUEUE_DIR / "runs" / "active" / "710.json"))


# ---- guardrail: an error in one lane never starves the other (QA R5) ----


def test_a_pm_lane_error_does_not_stop_the_runs_lane_in_the_same_tick(farm, fake_tmux, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("pm lane exploded")

    monkeypatch.setattr(farmd, "_select_pm_dispatchable", boom)
    write_json(QUEUE_DIR / "pm" / "711.json", make_task(711))
    write_json(QUEUE_DIR / "runs" / "712.json", make_task(712, item_id="hz-8", step_index=4, label="x"))

    farm.tick()

    assert set(new_sessions(fake_tmux)) == {"farm-run-hz-8-s4-a1"}


def test_a_runs_lane_error_does_not_stop_the_pm_lane_in_the_same_tick(farm, fake_tmux, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("runs lane exploded")

    monkeypatch.setattr(farmd, "_select_dispatchable", boom)
    write_json(QUEUE_DIR / "pm" / "713.json", make_task(713))
    write_json(QUEUE_DIR / "runs" / "714.json", make_task(714, item_id="hz-8", step_index=4, label="x"))

    farm.tick()

    assert set(new_sessions(fake_tmux)) == {"farm-run-hz-1-s9-a1"}


# ---- guardrail: safe cutover ----


def test_cutover_reports_the_killed_legacy_run_dead_and_keeps_the_queued_backlog(farm, fake_tmux, legacy_pm):
    """The legacy PM had unlinked its claimed task (claim-before-work), so
    once it is killed /runs/alive is false for that run and the server fails
    it once with a retryable reason. Queued queue/pm files survive."""
    legacy_pm()
    queued = write_json(QUEUE_DIR / "pm" / "716.json", make_task(716))
    farmd.STATE_FILE.write_text(json.dumps({"project": {"id": 1, "name": "FinTekkers"}, "repos": []}))

    farmd._adopt_existing()

    assert "farm-pm-fintekkers" not in fake_tmux.sessions
    assert client.post("/runs/alive", json={"run_ids": [715]}).json() == {"alive": {"715": False}}
    assert queued.exists()
    assert client.post("/runs/alive", json={"run_ids": [716]}).json() == {"alive": {"716": True}}


def test_an_old_shape_queued_pm_task_is_claimed_stamped_and_launched_exactly_once(farm, fake_tmux):
    """QA R10: the exact file an older /steps/run wrote, no claimed_at."""
    path = write_json(QUEUE_DIR / "pm" / "717.json", make_task(717))
    assert client.post("/runs/status", json={"run_ids": [717]}).json() == {
        "states": {"717": {"state": "queued", "reason": "waiting for the PM agent"}}
    }

    farm.tick()
    farm.tick()

    claimed = QUEUE_DIR / "runs" / "active" / "717.json"
    assert not path.exists()
    assert isinstance(json.loads(claimed.read_text())["claimed_at"], float)
    launches = [c for c in fake_tmux.calls if c[0] == "new-session" and "farm.pm_agent --task" in c[-1]]
    assert len(launches) == 1


# ---- guardrail: production state is ignored and listed, never deleted (QA R6) ----


def test_stale_pm_files_survive_boot_unchanged_and_are_listed_once(farm, capsys):
    session_file = STATE_DIR / "pm-session-fintekkers.txt"
    log_file = LOGS_DIR / "pm-fintekkers.log"
    session_file.write_bytes(b"legacy-sid\n")
    log_file.write_bytes(b"[10:00:00] PM agent up\n")
    try:
        farmd._adopt_existing()
        out = capsys.readouterr().out
        assert session_file.read_bytes() == b"legacy-sid\n"
        assert log_file.read_bytes() == b"[10:00:00] PM agent up\n"
        assert out.count(str(session_file)) == 1
        assert out.count(str(log_file)) == 1
    finally:
        session_file.unlink(missing_ok=True)
        log_file.unlink(missing_ok=True)


# ---- guardrail: no farm.env value or secret reaches a step log ----


def test_no_secret_reaches_the_pm_steps_output_or_its_log_target(pm_run, farm, fake_tmux, monkeypatch, capsys):
    sentinel = "hz212-sentinel-secret"
    monkeypatch.setenv("FARM_SHARED_SECRET", sentinel)
    write_json(QUEUE_DIR / "pm" / "718.json", make_task(718))
    farm.tick()
    path = QUEUE_DIR / "runs" / "active" / "718.json"
    pm_run.replies = [json.dumps({"summary": "done"})]

    assert pm_agent.run_task(path) == 0

    out = capsys.readouterr()
    assert sentinel not in out.out and sentinel not in out.err
    assert sentinel not in new_sessions(fake_tmux)["farm-run-hz-1-s9-a1"]  # env -u, never forwarded
    assert pipe_targets(fake_tmux) == {"farm-run-hz-1-s9-a1": f"cat >> '{LOGS_DIR / 'farm-run-hz-1-s9-a1.log'}'"}
