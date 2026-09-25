"""farmd contract tests: session names, /steps/cancel, /runs/{id}/log, the
HZ-5 subscription guardrail, and the rules stamp on /steps/run (HZ-9's
payload-visibility metric)."""

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import farmd, tmux_mgr, workspaces
from farm.config import LOGS_DIR, QUEUE_DIR
from farm.tests.conflict_fixtures import clone_and_read, make_repo_hub, push_new_branch

client = TestClient(farmd.app)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def make_task(run_id, item_id="hz-3", step_index=10, attempt=2):
    return {
        "run_id": run_id,
        "attempt": attempt,
        "item": {"id": item_id},
        "step": {"index": step_index, "label": "x"},
    }


def test_run_session_name_matches_dispatcher_format():
    name = farmd._run_session_name(make_task(9, item_id="HZ-3", step_index=10, attempt=2))
    assert name == "farm-run-hz-3-s10-a2"


def test_cancel_removes_a_queued_task():
    runs = QUEUE_DIR / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    task_path = runs / "41.json"
    task_path.write_text(json.dumps(make_task(41)))

    res = client.post("/steps/cancel", json={"run_id": 41})
    assert res.status_code == 200
    body = res.json()
    assert body["removed"] is True
    assert not task_path.exists()


def test_cancel_of_unknown_run_is_a_noop():
    res = client.post("/steps/cancel", json={"run_id": 999999})
    assert res.status_code == 200
    assert res.json()["removed"] is False


@pytest.fixture
def running_farm():
    """Flip farmd to running for one test; tasks go to the pm queue (step 9),
    which no background dispatcher consumes in tests."""
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield
    finally:
        farmd.state.update(saved)
        for f in (QUEUE_DIR / "pm").glob("*.json"):
            f.unlink(missing_ok=True)


def test_steps_run_stamps_the_repos_rules_into_the_task_payload(running_farm):
    task = make_task(101, item_id="HZ-9", step_index=9)
    task["item"]["repo"] = "FinTekkers/ui-service"
    res = client.post("/steps/run", json=task)
    assert res.status_code == 200

    queued = json.loads((QUEUE_DIR / "pm" / "101.json").read_text())
    # The success metric's payload check: the migrated ui-service rules are in
    # the queued task verbatim, alongside the project-level FinTekkers rules.
    assert "FinTekkers/ui-service — repo rules" in queued["rules"]
    assert "npm install --ignore-scripts" in queued["rules"]
    assert "FinTekkers — project rules" in queued["rules"]


def test_steps_run_without_matching_rules_stamps_an_empty_string(running_farm):
    farmd.state["project"] = {"id": 2, "name": "NoSuchProject"}
    task = make_task(102, item_id="X-1", step_index=9)
    task["item"]["repo"] = "acme/unmapped"
    res = client.post("/steps/run", json=task)
    assert res.status_code == 200
    assert json.loads((QUEUE_DIR / "pm" / "102.json").read_text())["rules"] == ""


# ---- /conflicts/resolve (HZ-92) ----
# No tmux session, no queue file, no agent — a direct call into
# conflict_resolver.resolve(), run off-thread. These tests only exercise the
# route's contract (status codes, request wiring, error handling); the real
# git merge/conflict/test-gate behavior is covered end-to-end in
# test_conflict_resolver.py.


def test_conflicts_resolve_requires_a_running_farm():
    res = client.post("/conflicts/resolve", json={"item": {"id": "HZ-1", "repo": "acme/demo"}})
    assert res.status_code == 409


def test_conflicts_resolve_requires_item_id_and_repo(running_farm):
    res = client.post("/conflicts/resolve", json={"item": {"id": "HZ-1"}})
    assert res.status_code == 400


def test_conflicts_resolve_returns_the_resolver_result(running_farm, monkeypatch):
    calls = []
    monkeypatch.setattr(
        farmd.conflict_resolver,
        "resolve",
        lambda repo, item_id, branch, base_branch: calls.append((repo, item_id, branch, base_branch))
        or {"resolved": True, "files": "1 file changed", "summary": "merged"},
    )

    res = client.post(
        "/conflicts/resolve",
        json={"item": {"id": "HZ-1", "repo": "acme/demo"}, "branch": "horizon/hz-1", "base_branch": "main"},
    )

    assert res.status_code == 200
    assert res.json() == {"ok": True, "resolved": True, "files": "1 file changed", "summary": "merged"}
    assert calls == [("acme/demo", "HZ-1", "horizon/hz-1", "main")]


def test_conflicts_resolve_surfaces_an_infrastructure_failure_as_500(running_farm, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("hub workspace not provisioned for acme/demo — restart the farm")

    monkeypatch.setattr(farmd.conflict_resolver, "resolve", boom)

    res = client.post("/conflicts/resolve", json={"item": {"id": "HZ-1", "repo": "acme/demo"}})

    assert res.status_code == 500
    assert "not provisioned" in res.json()["error"]


def test_conflicts_resolve_end_to_end_over_http_does_a_real_merge_and_push(running_farm, tmp_path, monkeypatch):
    """Unlike the contract tests above, nothing here is mocked: a real local
    git remote stands in for GitHub, and the request goes all the way through
    FastAPI routing into conflict_resolver.resolve()'s real git merge +
    checks + push, off the event-loop thread exactly as production does it.
    Proves the wiring itself works, not just each layer in isolation."""
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    _hub, origin = make_repo_hub(tmp_path)
    push_new_branch(
        tmp_path, origin, "horizon/hz-5", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    res = client.post("/conflicts/resolve", json={"item": {"id": "HZ-5", "repo": "acme/demo"}})

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["resolved"] is True

    merged = clone_and_read(tmp_path, origin, "horizon/hz-5", "shared.txt", "after")
    assert "branch edit" in merged
    assert (tmp_path / "read-after" / "other.txt").exists()  # main's independent change made it in too


# ---- /runs/status (HZ-54) ----
# Board/tracker guardrail: the farm reports a small {state, reason} vocabulary
# only — never a tmux session name — so a queued run can't be told apart from
# an executing one by string-matching a naming convention.


@pytest.fixture
def queue_dirs():
    for sub in ("pm", "runs", "runs/active"):
        (QUEUE_DIR / sub).mkdir(parents=True, exist_ok=True)
    yield
    for sub in ("pm", "runs", "runs/active"):
        for f in (QUEUE_DIR / sub).glob("*.json"):
            f.unlink(missing_ok=True)


def test_runs_status_reports_queued_for_a_pm_queued_task(queue_dirs):
    (QUEUE_DIR / "pm" / "201.json").write_text(json.dumps(make_task(201, step_index=9)))
    res = client.post("/runs/status", json={"run_ids": [201]})
    assert res.status_code == 200
    assert res.json() == {"states": {"201": {"state": "queued", "reason": "waiting for the PM agent"}}}


def test_runs_status_reports_queued_for_an_ephemeral_queued_task_with_the_busy_count(queue_dirs, monkeypatch):
    monkeypatch.setattr(farmd, "_ephemeral_sessions", lambda: ["farm-run-a-s11-a1", "farm-run-b-s11-a1"])
    (QUEUE_DIR / "runs" / "202.json").write_text(json.dumps(make_task(202)))
    res = client.post("/runs/status", json={"run_ids": ["202"]})
    assert res.json() == {
        "states": {"202": {"state": "queued", "reason": f"waiting for a free agent slot (2/{farmd.MAX_EPHEMERAL} in use)"}}
    }


def test_runs_status_reports_running_for_a_claimed_task_not_in_either_queue(queue_dirs):
    # Claimed tasks live in runs/active/, which /runs/status never globs —
    # they fall through to "running" without needing to know about tmux.
    (QUEUE_DIR / "runs" / "active" / "203.json").write_text(json.dumps(make_task(203)))
    res = client.post("/runs/status", json={"run_ids": [203]})
    assert res.json() == {"states": {"203": {"state": "running"}}}


def test_runs_status_reports_running_for_an_unknown_run_id(queue_dirs):
    # Defaults to "running" (today's behavior) rather than inventing a new
    # value — this is the fail-soft shape the Node poller relies on.
    res = client.post("/runs/status", json={"run_ids": [999999]})
    assert res.json() == {"states": {"999999": {"state": "running"}}}


def test_runs_status_never_leaks_a_tmux_session_name(queue_dirs):
    (QUEUE_DIR / "pm" / "204.json").write_text(json.dumps(make_task(204, item_id="HZ-54", step_index=9)))
    (QUEUE_DIR / "runs" / "205.json").write_text(json.dumps(make_task(205, item_id="HZ-54", step_index=11)))
    res = client.post("/runs/status", json={"run_ids": [204, 205]})
    body = json.dumps(res.json())
    assert "farm-run-" not in body
    assert "farm-pm-" not in body


# ---- /internal/steps/result forwarding (HZ-29) ----
# farmd is a dumb relay here: it must forward the agent's reported artifacts
# to the Node server byte-for-byte, with no re-slicing of its own — any cap
# on artifact size belongs to the agent (write side) and the server
# (dispatch-time budget), not this hop.


def test_steps_result_forwards_a_large_artifact_verbatim(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"], captured["json"] = url, json
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    big = "z" * 50000
    res = client.post(
        "/internal/steps/result",
        json={"run_id": 55, "ok": True, "summary": "done", "artifacts": {"artifact_md": big}},
    )
    assert res.status_code == 200
    assert captured["json"]["artifacts"]["artifact_md"] == big


# ---- HZ-76: reason forwarding on failure ----
# The server only auto-retries a small, explicit set of failure reasons
# (never_picked_up/timeout/unreachable/turn_cap) — farmd's job here is just
# to relay whatever step_agent.py reported, not decide retryability itself.


def test_steps_result_forwards_a_reason_on_failure(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"], captured["json"] = url, json
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    res = client.post(
        "/internal/steps/result",
        json={"run_id": 56, "ok": False, "error": "ran out of turns", "reason": "turn_cap"},
    )
    assert res.status_code == 200
    assert captured["url"].endswith("/api/farm/steps/56/fail")
    assert captured["json"] == {"error": "ran out of turns", "reason": "turn_cap"}


def test_steps_result_omits_reason_when_the_agent_did_not_report_one(monkeypatch):
    """A checks-failed (or any other unclassified) failure must not carry a
    reason field at all — that's what keeps the server pausing for a human
    instead of auto-retrying a real defect."""
    captured = {}

    class FakeResponse:
        status_code = 200

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["json"] = json
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    res = client.post(
        "/internal/steps/result",
        json={"run_id": 57, "ok": False, "error": "repo checks failed: eslint exited 1"},
    )
    assert res.status_code == 200
    assert "reason" not in captured["json"]


# ---- HZ-57: /started notify + claim-time launch gate ----
# The server's timeout used to start counting at dispatch, so time a step
# spent sitting in the farm's queue burned the same clock as its actual
# execution. The fix's farm-side half: tell the server the instant a task is
# actually claimed (flips its watchdog from queue-wait to execution), and
# refuse to launch a task the server has already given up on.


def test_notify_started_posts_to_the_server_and_returns_its_active_flag(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"active": False}

    def fake_post(url, headers=None, timeout=None):
        captured["url"], captured["headers"] = url, headers
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    assert farmd._notify_started(77) is False
    assert captured["url"] == f"{farmd.HORIZON_URL}/api/farm/steps/77/started"
    assert captured["headers"]["x-farm-secret"] == farmd.SHARED_SECRET


def test_notify_started_defaults_active_true_when_the_server_omits_the_flag(monkeypatch):
    class FakeResponse:
        status_code = 200

        def json(self):
            return {}

    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: FakeResponse())
    assert farmd._notify_started(78) is True


def test_notify_started_fails_open_when_the_server_is_unreachable(monkeypatch):
    """A network hiccup here must not strand a legitimate task in the queue
    forever — the server's own queue/execution timers are the real backstop,
    this call is only an optimization."""
    attempts = []
    monkeypatch.setattr(farmd.time, "sleep", lambda s: None)

    def raising_post(*a, **k):
        attempts.append(1)
        raise ConnectionError("farm can't reach horizon-server")

    monkeypatch.setattr(farmd.httpx, "post", raising_post)
    assert farmd._notify_started(79) is True
    assert len(attempts) == 2  # both retries used, matching /internal/steps/result's pattern


def test_notify_started_fails_open_on_a_non_2xx_reply(monkeypatch):
    class FakeResponse:
        status_code = 500

        def json(self):
            return {"active": False}  # must be ignored — status_code wasn't 200

    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: FakeResponse())
    assert farmd._notify_started(80) is True


def test_internal_steps_started_forwards_and_returns_the_active_flag(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"active": True}

    def fake_post(url, headers=None, timeout=None):
        captured["url"] = url
        return FakeResponse()

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    res = client.post("/internal/steps/started", json={"run_id": 81})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "active": True}
    assert captured["url"] == f"{farmd.HORIZON_URL}/api/farm/steps/81/started"


def test_claim_and_launch_launches_when_the_run_is_still_active(tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    farmd.RUN_SESSIONS.pop("201", None)

    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = _write_task(runs_dir / "201.json", 201, item_id="hz-20", step_index=4)

    name = farmd._claim_and_launch(task_path, runs_dir, tmp_path)
    assert name == "farm-run-hz-20-s4-a2"
    assert launched == [name]
    assert not task_path.exists()  # claimed: moved out of the plain queue dir
    assert (runs_dir / "active" / "201.json").exists()
    assert farmd.RUN_SESSIONS["201"] == name


def test_claim_and_launch_does_not_launch_a_run_the_server_already_gave_up_on(tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: False)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    farmd.RUN_SESSIONS.pop("202", None)

    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    task_path = _write_task(runs_dir / "202.json", 202, item_id="hz-20", step_index=4)

    name = farmd._claim_and_launch(task_path, runs_dir, tmp_path)
    assert name is None
    assert launched == []  # must not launch — the server already cancelled this run
    assert not task_path.exists()
    assert not (runs_dir / "active" / "202.json").exists()  # claimed copy dropped, not left behind
    assert "202" not in farmd.RUN_SESSIONS


def test_concierge_does_not_launch_when_the_flag_is_off(monkeypatch):
    launched = []
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", False)
    monkeypatch.setitem(farmd.state, "project", {"id": 1, "name": "My Proj"})
    assert farmd._maybe_launch_concierge() is False
    assert launched == []


def test_concierge_launches_when_the_flag_is_on(monkeypatch):
    launched = []
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: launched.append(name))
    monkeypatch.setattr(farmd.farm_config, "FARM_WA_ENABLED", True)
    monkeypatch.setitem(farmd.state, "project", {"id": 1, "name": "My Proj"})
    assert farmd._maybe_launch_concierge() is True
    assert launched == ["farm-concierge-my-proj"]


# ---- HZ-5 cost guardrail ----


def test_farm_start_refuses_with_api_key_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    res = client.post("/farm/start", json={"project": {"id": 1, "name": "P"}, "repos": []})
    assert res.status_code == 500
    assert "ANTHROPIC_API_KEY" in res.json()["error"]


def test_farmd_refuses_to_boot_with_api_key_set():
    """Module init runs the guardrail, so the adopt path (which never goes
    through /farm/start) can't bring up a farm on API billing either."""
    env = {**os.environ, "ANTHROPIC_API_KEY": "sk-ant-test"}
    proc = subprocess.run(
        [sys.executable, "-c", "import farm.farmd"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
        timeout=60,
    )
    assert proc.returncode != 0
    assert "ANTHROPIC_API_KEY" in proc.stderr


# ---- /runs/{run_id}/log (HZ-5 live activity tail) ----


def _seed_run_log(run_id, text, item_id="hz-5", step_index=11, attempt=1):
    task = make_task(run_id, item_id=item_id, step_index=step_index, attempt=attempt)
    name = farmd._run_session_name(task)
    farmd.RUN_SESSIONS[str(run_id)] = name
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / f"{name}.log").write_text(text)
    return name


def test_run_log_pages_by_offset(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    _seed_run_log(101, "hello\nworld\n")

    res = client.get("/runs/101/log")
    assert res.status_code == 200
    body = res.json()
    assert body == {"content": "hello\nworld\n", "next_offset": 12, "active": True}

    res = client.get("/runs/101/log", params={"offset": body["next_offset"]})
    assert res.json() == {"content": "", "next_offset": 12, "active": True}


def test_run_log_offset_past_eof_returns_empty_with_unchanged_offset(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    _seed_run_log(102, "short")
    res = client.get("/runs/102/log", params={"offset": 9999})
    assert res.json() == {"content": "", "next_offset": 9999, "active": False}


def test_run_log_caps_each_read_at_64k(monkeypatch):
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    _seed_run_log(103, "x" * (70 * 1024))
    res = client.get("/runs/103/log")
    body = res.json()
    assert len(body["content"]) == 64 * 1024
    assert body["next_offset"] == 64 * 1024
    # The remainder arrives on the next page.
    res = client.get("/runs/103/log", params={"offset": body["next_offset"]})
    assert len(res.json()["content"]) == 6 * 1024


def test_run_log_active_flips_false_when_the_session_dies(monkeypatch):
    _seed_run_log(104, "output\n")
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    res = client.get("/runs/104/log")
    assert res.json()["active"] is False


def test_run_log_resolves_a_claimed_task_file_after_restart(monkeypatch):
    """A farmd restart empties RUN_SESSIONS; the active task file rescan
    must still resolve the run (same seam _adopt_existing uses)."""
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)
    task = make_task(105, item_id="hz-5", step_index=11, attempt=1)
    name = farmd._run_session_name(task)
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / "105.json").write_text(json.dumps(task))
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / f"{name}.log").write_text("resumed\n")
    farmd.RUN_SESSIONS.pop("105", None)

    res = client.get("/runs/105/log")
    assert res.status_code == 200
    assert res.json()["content"] == "resumed\n"
    (active / "105.json").unlink()


def test_run_log_unknown_run_is_404():
    """Covers PM-queue runs too (steps 0/1/2/9 share the PM session's log and
    never enter RUN_SESSIONS): the endpoint 404s and the UI panel stays away."""
    (QUEUE_DIR / "pm").mkdir(parents=True, exist_ok=True)
    (QUEUE_DIR / "pm" / "106.json").write_text(json.dumps(make_task(106, step_index=1)))
    res = client.get("/runs/106/log")
    assert res.status_code == 404
    assert res.json() == {"error": "unknown run"}


def test_run_log_404s_after_the_run_leaves_run_sessions():
    _seed_run_log(107, "gone\n")
    farmd.RUN_SESSIONS.pop("107")
    res = client.get("/runs/107/log")
    assert res.status_code == 404


def test_cancel_of_active_run_removes_task_and_reports_kill_state():
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    task_path = active / "42.json"
    task_path.write_text(json.dumps(make_task(42)))

    res = client.post("/steps/cancel", json={"run_id": 42})
    assert res.status_code == 200
    body = res.json()
    assert body["removed"] is True
    assert not task_path.exists()
    # No such tmux session exists in tests; the endpoint reports killed=None
    # rather than failing — the kill is best-effort by design.
    assert body["killed"] is None


# ---- HZ-50: concurrency cap + per-item workspace-mutating mutex ----
# workspace_path(repo) used to be shared by every item in a repo, so ANY
# second implement (11) session was blocked globally — the only thing
# stopping two runs from fighting over one working tree. Per-item git
# worktrees (workspaces.py) remove that shared tree, so the dispatcher only
# needs to serialize step 11/12 runs against the SAME item; different items
# must be free to run fully concurrently, which is the entire point of
# raising FARM_MAX_EPHEMERAL.


def _write_task(path, run_id, item_id, step_index):
    path.write_text(json.dumps(make_task(run_id, item_id=item_id, step_index=step_index)))
    return path


def test_max_ephemeral_default_is_four():
    """The cap-raise itself (farmd.py:54): 2 -> 4, still env-overridable."""
    assert farmd.MAX_EPHEMERAL == 4


def test_max_ephemeral_stays_env_overridable(monkeypatch):
    """Guardrail: the target must remain a variable, not a hardcoded
    constant — a smaller host must be able to lower it without a code
    change."""
    env = {**os.environ, "FARM_MAX_EPHEMERAL": "1"}
    proc = subprocess.run(
        [sys.executable, "-c", "from farm import farmd; print(farmd.MAX_EPHEMERAL)"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "1"


def test_item_worktree_busy_matches_only_s11_and_s12_sessions_for_that_item():
    sessions = ["farm-run-hz-3-s11-a1", "farm-run-hz-9-s4-a1", "farm-run-hz-3-s12-a2"]
    assert farmd._item_worktree_busy("hz-3", sessions) is True
    assert farmd._item_worktree_busy("hz-9", sessions) is False  # s4 isn't workspace-mutating
    assert farmd._item_worktree_busy("hz-1", sessions) is False  # no sessions for this item at all


def test_select_dispatchable_respects_the_free_slot_count(tmp_path):
    paths = [_write_task(tmp_path / f"{i}.json", i, item_id=f"hz-{i}", step_index=4) for i in range(3)]
    selected = farmd._select_dispatchable(paths, sessions=[], slots=2)
    assert selected == paths[:2]


def test_select_dispatchable_serializes_step11_and_step12_for_the_same_item(tmp_path):
    a = _write_task(tmp_path / "a.json", 1, item_id="hz-3", step_index=11)
    b = _write_task(tmp_path / "b.json", 2, item_id="hz-3", step_index=12)

    selected = farmd._select_dispatchable([a, b], sessions=[], slots=4)

    # Only the first is launched this tick — the second would prepare_branch
    # against the SAME item's worktree while the first is still using it.
    assert selected == [a]


def test_select_dispatchable_runs_different_items_step11_fully_concurrently(tmp_path):
    """This is the raised-concurrency case the old global s11-vs-s11 lock
    would have blocked: two different items' implement steps, same repo,
    same tick — both must be dispatchable since HZ-50 gives them separate
    worktrees."""
    a = _write_task(tmp_path / "a.json", 1, item_id="hz-3", step_index=11)
    b = _write_task(tmp_path / "b.json", 2, item_id="hz-9", step_index=11)

    selected = farmd._select_dispatchable([a, b], sessions=[], slots=4)

    assert selected == [a, b]


def test_select_dispatchable_treats_an_existing_live_session_as_busy(tmp_path):
    task = _write_task(tmp_path / "a.json", 1, item_id="hz-3", step_index=12)
    live_sessions = ["farm-run-hz-3-s11-a1"]  # e.g. this item's implement step is mid-run

    selected = farmd._select_dispatchable([task], sessions=live_sessions, slots=4)

    assert selected == []


def test_select_dispatchable_backfills_past_a_busy_item_within_the_slot_budget(tmp_path):
    """Item hz-3 is mid-run and gets deferred; a later-queued task for a
    different item still fills the free slot instead of the tick going idle."""
    busy = _write_task(tmp_path / "busy.json", 1, item_id="hz-3", step_index=12)
    free = _write_task(tmp_path / "free.json", 2, item_id="hz-9", step_index=11)
    live_sessions = ["farm-run-hz-3-s11-a1"]

    selected = farmd._select_dispatchable([busy, free], sessions=live_sessions, slots=1)

    assert selected == [free]


def test_a_crashed_sessions_slot_is_freed_by_recounting_live_tmux_sessions(monkeypatch):
    """The cap is enforced by counting live farm-run-* tmux sessions
    (_ephemeral_sessions -> tmux_mgr.list_farm_sessions), never an in-memory
    counter — so a session that dies without reporting still frees its slot
    on the very next dispatcher tick."""
    live = ["farm-run-hz-3-s11-a1", "farm-run-hz-9-s11-a1"]
    monkeypatch.setattr(farmd.tmux_mgr, "list_farm_sessions", lambda: live)
    assert farmd.MAX_EPHEMERAL - len(farmd._ephemeral_sessions()) == farmd.MAX_EPHEMERAL - 2

    live.pop()  # simulate one session crashing out from under farmd
    assert farmd.MAX_EPHEMERAL - len(farmd._ephemeral_sessions()) == farmd.MAX_EPHEMERAL - 1


# ---- HZ-101: reconcile claimed runs against live tmux sessions ----
# farmd is the side that holds the truth about whether an agent is alive; it
# must report a dead claimed run itself (POST /steps/{run_id}/fail) instead
# of waiting for the server's execution timer (up to STEP_TIMEOUT_S) to
# expire. Proof of death is the absence of a session, nothing weaker — a live
# session must never be touched, reported, or have its task file removed.


class _FakeFailResponse:
    def __init__(self, status_code=200):
        self.status_code = status_code


def _write_claimed_task(run_id, claimed_at, item_id="hz-3", step_index=11, attempt=1):
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    task = make_task(run_id, item_id=item_id, step_index=step_index, attempt=attempt)
    task["claimed_at"] = claimed_at
    path = active / f"{run_id}.json"
    path.write_text(json.dumps(task))
    return path


def _old_enough(seconds_past_grace=1):
    return farmd.time.time() - farmd.farm_config.RECONCILE_GRACE_S - seconds_past_grace


def test_reconcile_reports_and_removes_a_dead_claimed_run(queue_dirs, monkeypatch):
    task_path = _write_claimed_task(301, claimed_at=_old_enough())
    farmd.RUN_SESSIONS["301"] = "farm-run-hz-3-s11-a1"
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"], captured["json"], captured["headers"] = url, json, headers
        return _FakeFailResponse(200)

    monkeypatch.setattr(farmd.httpx, "post", fake_post)

    farmd._reconcile_claimed_runs()

    assert not task_path.exists()
    assert "301" not in farmd.RUN_SESSIONS
    assert captured["url"] == f"{farmd.HORIZON_URL}/api/farm/steps/301/fail"
    assert captured["headers"]["x-farm-secret"] == farmd.SHARED_SECRET
    assert captured["json"]["reason"] == "unreachable"  # already in AUTO_RETRY_REASONS
    assert "301" in captured["json"]["error"]


def test_reconcile_never_touches_or_reports_a_run_whose_session_is_alive(queue_dirs, monkeypatch):
    task_path = _write_claimed_task(302, claimed_at=_old_enough())
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: True)

    def must_not_be_called(*_a, **_k):
        raise AssertionError("a live session must never be checked with the server or reported")

    monkeypatch.setattr(farmd, "_notify_started", must_not_be_called)
    monkeypatch.setattr(farmd.httpx, "post", must_not_be_called)

    farmd._reconcile_claimed_runs()

    assert task_path.exists()  # untouched: a false positive here kills live work


def test_reconcile_skips_a_run_still_inside_the_grace_period(queue_dirs, tmp_path, monkeypatch):
    """Drives the real claim path (_claim_and_launch) instead of hand-patching
    a timestamp: proves the grace period is measured from an honest
    claimed_at stamp, not stat().st_mtime (which rename() never updates)."""
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda *a, **k: None)
    farmd.RUN_SESSIONS.pop("303", None)

    runs_dir = QUEUE_DIR / "runs"
    task_path = _write_task(runs_dir / "303.json", 303, item_id="hz-3", step_index=11)
    name = farmd._claim_and_launch(task_path, runs_dir, tmp_path)
    claimed_path = runs_dir / "active" / "303.json"
    assert claimed_path.exists()  # genuinely claimed just now

    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda n: False)  # session not up yet

    def must_not_be_called(*_a, **_k):
        raise AssertionError("a run still inside the grace period must not be judged dead")

    monkeypatch.setattr(farmd, "_notify_started", must_not_be_called)
    monkeypatch.setattr(farmd.httpx, "post", must_not_be_called)

    farmd._reconcile_claimed_runs()

    assert claimed_path.exists()
    claimed_path.unlink()
    farmd.RUN_SESSIONS.pop("303", None)


def test_reconcile_releases_without_reporting_when_the_server_no_longer_considers_the_run_active(queue_dirs, monkeypatch):
    """The dropped-cancel case: the server already gave up on this run (its
    own /steps/cancel callback to farmd was lost). Once the session is
    confirmed dead, farmd must release its own bookkeeping without sending a
    redundant /fail — that would double-report a run the server already
    resolved."""
    task_path = _write_claimed_task(304, claimed_at=_old_enough())
    farmd.RUN_SESSIONS["304"] = "farm-run-hz-3-s11-a1"
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: False)

    def must_not_be_called(*_a, **_k):
        raise AssertionError("must not /fail a run the server no longer considers active")

    monkeypatch.setattr(farmd.httpx, "post", must_not_be_called)

    farmd._reconcile_claimed_runs()

    assert not task_path.exists()
    assert "304" not in farmd.RUN_SESSIONS


def test_reconcile_makes_no_destructive_change_when_the_server_is_unreachable(queue_dirs, monkeypatch):
    task_path = _write_claimed_task(305, claimed_at=_old_enough())
    farmd.RUN_SESSIONS["305"] = "farm-run-hz-3-s11-a1"
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)

    def raising_post(*a, **k):
        raise ConnectionError("farm can't reach horizon-server")

    monkeypatch.setattr(farmd.httpx, "post", raising_post)

    farmd._reconcile_claimed_runs()

    assert task_path.exists()  # unreachable server is not evidence the run is dead
    assert "305" in farmd.RUN_SESSIONS


def test_reconcile_does_not_report_the_same_run_twice_on_a_second_pass(queue_dirs, monkeypatch):
    _write_claimed_task(306, claimed_at=_old_enough())
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    posts = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append(url)
        return _FakeFailResponse(200)

    monkeypatch.setattr(farmd.httpx, "post", fake_post)

    farmd._reconcile_claimed_runs()
    farmd._reconcile_claimed_runs()

    assert len(posts) == 1  # the task file was gone by the second pass


def test_reconcile_survives_a_crash_between_reporting_and_removing_the_task_file(queue_dirs, monkeypatch):
    """Report first, then remove — but if the process dies (or the unlink
    itself errors) in between, the next pass must not double-report: by then
    the server already resolved the run, so _notify_started returns False and
    the second pass only releases."""
    task_path = _write_claimed_task(307, claimed_at=_old_enough())
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    posts = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append(url)
        return _FakeFailResponse(200)

    monkeypatch.setattr(farmd.httpx, "post", fake_post)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)

    real_unlink = Path.unlink

    def flaky_unlink(self, missing_ok=False):
        if self == task_path:
            raise OSError("disk full")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", flaky_unlink)
    farmd._reconcile_claimed_runs()  # reports successfully, then "crashes" removing the file
    assert len(posts) == 1
    assert task_path.exists()

    monkeypatch.setattr(Path, "unlink", real_unlink)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: False)  # server already resolved it
    farmd._reconcile_claimed_runs()

    assert len(posts) == 1  # no second /fail call
    assert not task_path.exists()


def test_reconcile_isolates_a_corrupt_task_file_from_the_rest_of_the_batch(queue_dirs, monkeypatch):
    (QUEUE_DIR / "runs" / "active").mkdir(parents=True, exist_ok=True)
    (QUEUE_DIR / "runs" / "active" / "not-json.json").write_text("{not valid json")
    good_path = _write_claimed_task(308, claimed_at=_old_enough())
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: _FakeFailResponse(200))

    farmd._reconcile_claimed_runs()

    assert not good_path.exists()  # the corrupt sibling didn't abort the batch


def test_reconcile_at_boot_reports_a_dead_run_left_over_from_a_prior_farmd_crash(queue_dirs, monkeypatch):
    """The success metric's boot scenario, driven the same way _adopt_existing
    is exercised elsewhere in this file — no live process, no tmux session,
    just a claimed task file left behind."""
    task_path = _write_claimed_task(309, claimed_at=_old_enough())
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: _FakeFailResponse(200))

    farmd._reconcile_claimed_runs()  # what farmd calls once at boot, right after _adopt_existing()

    assert not task_path.exists()


def test_reconcile_guardrail_skips_a_claimed_task_with_no_claimed_at_stamp(queue_dirs, monkeypatch):
    """The item's own guardrail: 'proof of death is the absence of a session
    for a claimed run, nothing weaker; when the check itself cannot be
    performed, do nothing.' A task file claimed by a pre-HZ-101 farmd (or one
    edited/corrupted after claim) has no claimed_at, so reconcile cannot tell
    'still launching' from 'dead' and must leave it untouched rather than
    guess via mtime or any other proxy."""
    active = QUEUE_DIR / "runs" / "active"
    active.mkdir(parents=True, exist_ok=True)
    task_path = active / "310.json"
    task_path.write_text(json.dumps(make_task(310, item_id="hz-3", step_index=11)))  # no claimed_at

    def must_not_be_called(*_a, **_k):
        raise AssertionError("without claimed_at the check cannot be performed — must do nothing")

    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", must_not_be_called)
    monkeypatch.setattr(farmd, "_notify_started", must_not_be_called)
    monkeypatch.setattr(farmd.httpx, "post", must_not_be_called)

    farmd._reconcile_claimed_runs()

    assert task_path.exists()


def test_report_run_dead_returns_false_on_a_non_2xx_response(monkeypatch):
    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: _FakeFailResponse(500))
    assert farmd._report_run_dead(999, "farm-run-hz-3-s11-a1") is False


def test_reconcile_leaves_the_file_in_place_on_a_non_2xx_fail_response(queue_dirs, monkeypatch):
    """A non-2xx reply (server up but rejected/errored the report) must be
    treated the same as unreachable: not confirmation the server actually
    recorded the failure, so the file stays for the next pass to retry."""
    task_path = _write_claimed_task(311, claimed_at=_old_enough())
    farmd.RUN_SESSIONS["311"] = "farm-run-hz-3-s11-a1"
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.httpx, "post", lambda *a, **k: _FakeFailResponse(500))

    farmd._reconcile_claimed_runs()

    assert task_path.exists()
    assert "311" in farmd.RUN_SESSIONS


# ---- HZ-101 end-to-end: real tmux sessions, real HTTP round trip ----
# Every test above monkeypatches tmux_mgr.session_exists and httpx.post, so
# none of them exercises the real `tmux has-session` subprocess call or an
# actual HTTP request/response over a socket — exactly the two boundaries
# this item is about (farmd's own proof of liveness, and the wire format the
# server actually receives). These drive _reconcile_claimed_runs() unmodified
# against a real tmux session (or the deliberate absence of one) and a
# throwaway local HTTP server standing in for the horizon server, mirroring
# test_step_agent.py's run_smoke_check e2e tests.


class _FakeHorizonHandler(BaseHTTPRequestHandler):
    requests: list = []
    fail_status = 200

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        self.__class__.requests.append(
            {
                "path": self.path,
                "headers": dict(self.headers),
                "body": json.loads(body) if body else None,
            }
        )
        if self.path.endswith("/started"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"active": True}).encode())
        else:
            self.send_response(self.__class__.fail_status)
            self.end_headers()

    def log_message(self, *args):
        pass  # keep test output quiet


def _serve_fake_horizon(fail_status: int = 200):
    requests: list = []
    handler = type("Handler", (_FakeHorizonHandler,), {"requests": requests, "fail_status": fail_status})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}", requests


def test_reconcile_end_to_end_over_real_tmux_and_http_reports_a_dead_run(queue_dirs, monkeypatch):
    """No mocks on tmux_mgr or httpx: the tmux session named by the task file
    is genuinely never created (a real `tmux has-session` lookup proves it's
    gone), and a real local HTTP server stands in for the horizon server —
    this proves the whole reconcile path wires together end to end, not just
    each layer in isolation under a monkeypatch."""
    server, url, requests = _serve_fake_horizon(fail_status=200)
    monkeypatch.setattr(farmd, "HORIZON_URL", url)
    name = "farm-run-hz-e2e-s11-a1"
    assert not tmux_mgr.session_exists(name)  # real tmux lookup: genuinely dead
    task_path = _write_claimed_task(9001, claimed_at=_old_enough(), item_id="hz-e2e", step_index=11)
    try:
        farmd._reconcile_claimed_runs()
    finally:
        server.shutdown()

    assert not task_path.exists()
    started_reqs = [r for r in requests if r["path"].endswith("/api/farm/steps/9001/started")]
    assert len(started_reqs) == 1
    fail_reqs = [r for r in requests if r["path"].endswith("/api/farm/steps/9001/fail")]
    assert len(fail_reqs) == 1
    assert fail_reqs[0]["headers"]["x-farm-secret"] == farmd.SHARED_SECRET
    assert fail_reqs[0]["body"]["reason"] == "unreachable"  # already in AUTO_RETRY_REASONS


def test_reconcile_end_to_end_over_real_tmux_never_touches_a_real_live_session(queue_dirs, monkeypatch):
    """The other half of the same wiring, with a genuinely live tmux session
    this time — proves the real `tmux has-session` short-circuits before any
    HTTP call is ever made, matching the guardrail that a live session must
    never be reported or removed."""
    server, url, requests = _serve_fake_horizon(fail_status=200)
    monkeypatch.setattr(farmd, "HORIZON_URL", url)
    name = "farm-run-hz-e2e2-s11-a1"
    tmux_mgr.new_session(name, "sleep 30", cwd="/tmp")
    task_path = _write_claimed_task(9002, claimed_at=_old_enough(), item_id="hz-e2e2", step_index=11)
    try:
        assert tmux_mgr.session_exists(name)  # real tmux lookup: genuinely alive
        farmd._reconcile_claimed_runs()
    finally:
        tmux_mgr.kill_session(name)
        server.shutdown()

    assert task_path.exists()  # a false positive here would kill live work
    assert requests == []  # never even asked the server about a live session


# ---- /runs/alive (HZ-100) ----
# The Node reconciliation sweep's proof-of-life check — deliberately NOT
# /runs/status: that endpoint defaults an unrecognized run_id to "running"
# (a fail-soft default for the UI, pinned by test_runs_status_reports_running
# _for_an_unknown_run_id above), which would make it useless for deciding
# whether to fail a stranded run. /runs/alive defaults to False instead.


def test_runs_alive_true_for_a_claimed_run_with_a_live_session(queue_dirs, monkeypatch):
    (QUEUE_DIR / "runs" / "active" / "401.json").write_text(
        json.dumps(make_task(401, item_id="hz-1", step_index=11, attempt=1))
    )
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: name == "farm-run-hz-1-s11-a1")
    res = client.post("/runs/alive", json={"run_ids": [401]})
    assert res.json() == {"alive": {"401": True}}


def test_runs_alive_false_for_a_claimed_run_whose_session_is_gone(queue_dirs, monkeypatch):
    # This is exactly the HZ-93 shape at the farmd layer: a claimed task file
    # with nothing left running it.
    (QUEUE_DIR / "runs" / "active" / "402.json").write_text(json.dumps(make_task(402, item_id="hz-1", step_index=11)))
    monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
    res = client.post("/runs/alive", json={"run_ids": [402]})
    assert res.json() == {"alive": {"402": False}}


def test_runs_alive_true_for_a_task_still_queued_in_pm_or_runs(queue_dirs):
    (QUEUE_DIR / "pm" / "403.json").write_text(json.dumps(make_task(403, step_index=9)))
    (QUEUE_DIR / "runs" / "404.json").write_text(json.dumps(make_task(404, step_index=11)))
    res = client.post("/runs/alive", json={"run_ids": [403, 404]})
    assert res.json() == {"alive": {"403": True, "404": True}}


def test_runs_alive_false_for_a_run_the_farm_has_no_record_of(queue_dirs):
    # No task file anywhere, no session, no PM/ephemeral tracking — the farm
    # genuinely does not know about this run.
    res = client.post("/runs/alive", json={"run_ids": [999999]})
    assert res.json() == {"alive": {"999999": False}}


def test_runs_alive_true_for_an_in_flight_pm_claimed_run(queue_dirs, monkeypatch):
    """A PM-claimed run has no per-run task file (claim-before-work unlinks
    it) and no per-run tmux session — its only proof of life is
    PM_ACTIVE_RUNS plus the shared PM session still being up."""
    farmd.state["project"] = {"id": 1, "name": "Test Project"}
    farmd.PM_ACTIVE_RUNS.add("405")
    try:
        monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: name == farmd._pm_session_name())
        res = client.post("/runs/alive", json={"run_ids": [405]})
        assert res.json() == {"alive": {"405": True}}
    finally:
        farmd.PM_ACTIVE_RUNS.discard("405")
        farmd.state["project"] = None


def test_runs_alive_false_for_a_pm_claimed_run_whose_pm_session_died(queue_dirs, monkeypatch):
    farmd.state["project"] = {"id": 1, "name": "Test Project"}
    farmd.PM_ACTIVE_RUNS.add("406")
    try:
        monkeypatch.setattr(farmd.tmux_mgr, "session_exists", lambda name: False)
        res = client.post("/runs/alive", json={"run_ids": [406]})
        assert res.json() == {"alive": {"406": False}}
    finally:
        farmd.PM_ACTIVE_RUNS.discard("406")
        farmd.state["project"] = None


def test_runs_alive_never_leaks_a_tmux_session_name(queue_dirs):
    (QUEUE_DIR / "runs" / "active" / "407.json").write_text(json.dumps(make_task(407, item_id="HZ-100", step_index=11)))
    res = client.post("/runs/alive", json={"run_ids": [407]})
    assert "farm-run-" not in json.dumps(res.json())


def test_internal_steps_started_tracks_pm_active_runs_until_the_result_lands():
    """The lifecycle that backs the PM-alive check above: started adds to
    PM_ACTIVE_RUNS, the result callback (ok or not) always removes it."""
    farmd.PM_ACTIVE_RUNS.discard("408")
    try:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(farmd, "_notify_started", lambda run_id: True)
            res = client.post("/internal/steps/started", json={"run_id": 408})
            assert res.json()["active"] is True
        assert "408" in farmd.PM_ACTIVE_RUNS

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(farmd.httpx, "post", lambda *a, **k: _FakeFailResponse(200))
            client.post("/internal/steps/result", json={"run_id": 408, "ok": False, "error": "boom"})
        assert "408" not in farmd.PM_ACTIVE_RUNS
    finally:
        farmd.PM_ACTIVE_RUNS.discard("408")


def test_internal_steps_started_does_not_track_a_run_the_server_no_longer_considers_active():
    farmd.PM_ACTIVE_RUNS.discard("409")
    try:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(farmd, "_notify_started", lambda run_id: False)
            res = client.post("/internal/steps/started", json={"run_id": 409})
            assert res.json()["active"] is False
        assert "409" not in farmd.PM_ACTIVE_RUNS
    finally:
        farmd.PM_ACTIVE_RUNS.discard("409")
