"""HZ-256: farmd's POST /conflicts/cancel stops one item's running resolver.

Two kinds of resolver run here:

  - a stub, patched in for conflict_resolver.resolve(), that registers like
    the real one (conflict_resolver.cancel_scope) and spawns real processes in
    the item's worktree: an "agent" in farmd's own process group, and a
    "check" in a session of its own whose grandchild leaves the worktree.
  - the real resolve(), against a local bare repo standing in for GitHub,
    with only the agent or the checks faked.

Every wait polls against a deadline, and every test kills and reaps what it
started.
"""

import ast
import inspect
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import agent_runner, check_slots, conflict_cancel, conflict_resolver, farmd, workspaces
from farm.checks import CheckFailure
from farm.tests.conflict_fixtures import make_repo_hub, origin_branch_sha, push_new_branch

REPO = "acme/demo"
client = TestClient(farmd.app)  # host "testclient" — fine for /conflicts/resolve
loopback = TestClient(farmd.app, client=("127.0.0.1", 50000))


def wait_until(predicate, timeout=10.0, what="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def gone(pid: int) -> bool:
    return not Path(f"/proc/{pid}").exists() or not conflict_cancel._alive(pid)


def cancel(item_id: str, repo: str = REPO):
    return loopback.post("/conflicts/cancel", json={"item": item_id, "repo": repo})


@pytest.fixture
def farm(tmp_path, monkeypatch):
    """A running farmd over a throwaway workspaces dir. Yields a helper that
    starts /conflicts/resolve on a thread; teardown kills anything a test's
    processes left behind and joins every thread."""
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    saved = dict(farmd.state)
    farmd.state.update(status="running")
    threads: list[threading.Thread] = []
    pids: list[int] = []

    def start(item_id: str) -> dict:
        out: dict = {}

        def run():
            out["res"] = client.post("/conflicts/resolve", json={"item": {"id": item_id, "repo": REPO}})

        t = threading.Thread(target=run, daemon=True)
        t.start()
        threads.append(t)
        out["thread"] = t
        return out

    start.pids = pids
    start.tmp_path = tmp_path
    try:
        yield start
    finally:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        for t in threads:
            t.join(timeout=30)
        farmd.state.clear()
        farmd.state.update(saved)


class StubResolver:
    """Stands in for conflict_resolver.resolve(): an "agent" (farmd's process
    group, cwd = worktree) and a "check" (own session) whose grandchild `cd`s
    out of the worktree, waited on the way subprocess.run would. `respawn`
    starts one more agent half a second after the first dies — the race where
    a process starts after the cancel's first sweep."""

    def __init__(self, farm, *, respawn=False, env=None, agent_argv=("sleep", "300")):
        self.farm = farm
        self.respawn = respawn
        self.env = env
        self.agent_argv = list(agent_argv)
        self.pids: dict[str, list[int]] = {}
        self.started: dict[str, threading.Event] = {}

    def _spawn(self, item_id, argv, ws, **kw):
        proc = subprocess.Popen(argv, cwd=ws, env=self.env, **kw)
        self.pids[item_id].append(proc.pid)
        self.farm.pids.append(proc.pid)
        return proc

    def __call__(self, repo, item_id, branch=None, base_branch=None, **_kw):
        self.pids.setdefault(item_id, [])
        ready = self.started.setdefault(item_id, threading.Event())
        with conflict_resolver.cancel_scope(repo, item_id):
            ws = workspaces.workspace_path(repo, item_id)
            ws.mkdir(parents=True, exist_ok=True)
            agent = self._spawn(item_id, self.agent_argv, ws)
            check = self._spawn(
                item_id,
                ["sh", "-c", "(cd / && exec sleep 300) & echo $! > grandchild.pid; wait"],
                ws,
                start_new_session=True,
            )
            pid_file = ws / "grandchild.pid"
            wait_until(lambda: pid_file.exists() and pid_file.read_text().strip(), what="the check's grandchild")
            grandchild = int(pid_file.read_text())
            self.pids[item_id].append(grandchild)
            self.farm.pids.append(grandchild)
            ready.set()
            agent.wait()
            if self.respawn:
                time.sleep(0.5)
                self._spawn(item_id, ["sleep", "300"], ws).wait()
            check.wait()
            conflict_resolver._check_cancelled()
            return {"resolved": True, "summary": "stub finished"}


def start_stub(farm, monkeypatch, item_ids, **kw) -> tuple[StubResolver, dict]:
    stub = StubResolver(farm, **kw)
    monkeypatch.setattr(farmd.conflict_resolver, "resolve", stub)
    runs = {}
    for item_id in item_ids:
        stub.started[item_id] = threading.Event()
        runs[item_id] = farm(item_id)
        assert stub.started[item_id].wait(10), f"stub resolver for {item_id} never started"
    return stub, runs


# ---- metric line 1: the whole tree ends and the lock is released ----


def test_cancel_kills_agent_check_and_grandchild_and_releases_the_lock(farm, monkeypatch):
    stub, runs = start_stub(farm, monkeypatch, ["HZ-1"])
    pids = list(stub.pids["HZ-1"])
    assert len(pids) == 3 and not any(gone(p) for p in pids)
    assert workspaces.item_lock_held(REPO, "HZ-1")

    res = cancel("HZ-1")

    assert res.status_code == 200
    body = res.json()
    assert body == {"ok": True, "cancelled": True, "killed": 3, "lock_released": True}
    wait_until(lambda: all(gone(p) for p in pids), timeout=5, what="every stub pid to leave /proc")
    with workspaces.item_lock(REPO, "HZ-1", wait_s=0):
        pass
    assert not conflict_resolver.is_active(REPO, "HZ-1")
    runs["HZ-1"]["thread"].join(10)
    assert runs["HZ-1"]["res"].status_code == 409
    assert runs["HZ-1"]["res"].json() == {"error": "cancelled"}


def test_a_process_started_after_the_first_sweep_is_killed_and_counted(farm, monkeypatch):
    stub, runs = start_stub(farm, monkeypatch, ["HZ-2"], respawn=True)

    body = cancel("HZ-2").json()

    pids = stub.pids["HZ-2"]
    assert len(pids) == 4, "the late agent was spawned"
    assert body["killed"] == 4
    assert body["lock_released"] is True
    wait_until(lambda: all(gone(p) for p in pids), timeout=5, what="every pid, the late one too")
    runs["HZ-2"]["thread"].join(10)
    assert runs["HZ-2"]["res"].json() == {"error": "cancelled"}


# ---- metric line 4: nothing running for the item changes nothing ----


def test_cancel_with_no_resolver_changes_nothing(farm, tmp_path):
    ws = workspaces.workspace_path(REPO, "HZ-4")
    ws.mkdir(parents=True)
    # A step agent working in the same worktree, holding the item's lock.
    step = subprocess.Popen(["sleep", "300"], cwd=ws)
    farm.pids.append(step.pid)
    try:
        with workspaces.item_lock(REPO, "HZ-4", wait_s=0):
            res = cancel("HZ-4")
            assert res.status_code == 200
            assert res.json() == {"ok": True, "cancelled": False, "killed": 0, "lock_released": False}
            assert workspaces.item_lock_held(REPO, "HZ-4")
            assert step.poll() is None
        assert not conflict_resolver.is_active(REPO, "HZ-4")
    finally:
        step.kill()
        step.wait()

    res = cancel("HZ-404")
    assert res.json() == {"ok": True, "cancelled": False, "killed": 0, "lock_released": True}


# ---- metric line 5: only the named item ----


def test_cancelling_one_item_leaves_the_other_items_resolver_running(farm, monkeypatch):
    # hz-25 is a path prefix of hz-256: the sweep must match on a path boundary.
    stub, runs = start_stub(farm, monkeypatch, ["HZ-25", "HZ-256"])

    body = cancel("HZ-25").json()

    assert body["cancelled"] is True and body["lock_released"] is True
    assert body["killed"] == 3
    wait_until(lambda: all(gone(p) for p in stub.pids["HZ-25"]), timeout=5, what="HZ-25's pids")
    assert not any(gone(p) for p in stub.pids["HZ-256"])
    assert conflict_resolver.is_active(REPO, "HZ-256")
    assert workspaces.item_lock_held(REPO, "HZ-256")
    assert runs["HZ-256"]["thread"].is_alive()

    assert cancel("HZ-256").json()["lock_released"] is True


# ---- metric line 6: loopback only ----


def test_a_non_loopback_caller_gets_403_and_nothing_is_cancelled(farm, monkeypatch):
    stub, runs = start_stub(farm, monkeypatch, ["HZ-6"])
    remote = TestClient(farmd.app, client=("10.0.0.5", 1234))

    res = remote.post("/conflicts/cancel", json={"item": "HZ-6", "repo": REPO})

    assert res.status_code == 403
    assert res.json() == {"error": "loopback only"}
    assert conflict_resolver.is_active(REPO, "HZ-6")
    assert not any(gone(p) for p in stub.pids["HZ-6"])
    assert workspaces.item_lock_held(REPO, "HZ-6")
    assert runs["HZ-6"]["thread"].is_alive()
    assert cancel("HZ-6").json()["cancelled"] is True


def test_cancel_requires_item_and_repo(farm):
    assert cancel("", REPO).status_code == 400
    assert loopback.post("/conflicts/cancel", json={"item": "HZ-1"}).status_code == 400


# ---- guardrail 7: no secret in the cancel's log lines ----


def test_cancel_logs_no_secret_from_the_processes_it_kills(farm, monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp-SENTINEL-HZ256")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "whsec-SENTINEL-HZ256")
    env = {**os.environ}
    stub, _runs = start_stub(
        farm, monkeypatch, ["HZ-7"], env=env, agent_argv=("sh", "-c", "sleep 300; :", "ghp-SENTINEL-HZ256")
    )

    assert cancel("HZ-7").json()["cancelled"] is True

    out = capsys.readouterr()
    logged = out.out + out.err
    assert "farmd: cancelled conflict resolution for HZ-7" in logged
    assert "SENTINEL" not in logged


# ---- metric line 3: the real resolve() never pushes once cancelled ----


def _mechanical_fixture(tmp_path, item="hz-30"):
    _hub, origin = make_repo_hub(tmp_path)
    before = push_new_branch(
        tmp_path, origin, f"horizon/{item}", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")
    return origin, before


def _scoped_fixture(tmp_path, item="hz-31", *, needs_agent=False):
    _hub, origin = make_repo_hub(tmp_path)
    ours = "line1\nline2 ours\nline3\n" if needs_agent else "line1\nline2\nours-added\nline3\n"
    theirs = "line1\nline2 theirs\nline3\n" if needs_agent else "line1\nline2\ntheirs-added\nline3\n"
    before = push_new_branch(tmp_path, origin, f"horizon/{item}", lambda w: (w / "shared.txt").write_text(ours), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "shared.txt").write_text(theirs), "main-advance")
    return origin, before


@pytest.fixture
def git_spy(monkeypatch):
    calls = []
    real = conflict_resolver.git

    def spy(ws, *args, **kw):
        calls.append(args)
        return real(ws, *args, **kw)

    monkeypatch.setattr(conflict_resolver, "git", spy)
    return calls


def _pushes(calls):
    return [c for c in calls if c and c[0] == "push"]


@pytest.mark.parametrize("path", ["mechanical", "scoped"])
def test_a_cancel_just_before_the_push_never_pushes(farm, monkeypatch, git_spy, path):
    tmp_path = farm.tmp_path
    item = "HZ-30" if path == "mechanical" else "HZ-31"
    if path == "mechanical":
        origin, before = _mechanical_fixture(tmp_path, item.lower())
    else:
        monkeypatch.delenv("FARM_CONFLICT_SCOPED_ENABLED", raising=False)
        origin, before = _scoped_fixture(tmp_path, item.lower())

    def checks_pass_then_cancel(ws, log, **_kw):
        assert conflict_resolver.request_cancel(REPO, item)
        return "checks passed"

    monkeypatch.setattr(conflict_resolver, "run_checks", checks_pass_then_cancel)

    with pytest.raises(conflict_resolver.Cancelled):
        conflict_resolver.resolve(REPO, item, log=lambda *_: None)

    assert _pushes(git_spy) == []
    assert origin_branch_sha(origin, f"horizon/{item.lower()}") == before
    ws = workspaces.workspace_path(REPO, item)
    assert subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() == before
    assert not conflict_resolver.is_active(REPO, item)


def _cancel_requested(item_id):
    ev = conflict_resolver._ACTIVE.get((REPO, item_id.lower()))
    return ev is not None and ev.is_set()


@pytest.mark.parametrize("path", ["mechanical", "scoped"])
def test_a_push_waiting_on_hub_lock_when_the_cancel_lands_never_pushes(farm, monkeypatch, git_spy, path):
    """The push-fence race: the resolver is at the push, blocked on hub_lock,
    when the cancel arrives. Releasing the lock must not let it push."""
    tmp_path = farm.tmp_path
    item = "HZ-32" if path == "mechanical" else "HZ-33"
    monkeypatch.setenv("FARM_CONFLICT_CANCEL_WAIT_S", "10")
    if path == "mechanical":
        origin, before = _mechanical_fixture(tmp_path, item.lower())
    else:
        monkeypatch.delenv("FARM_CONFLICT_SCOPED_ENABLED", raising=False)
        origin, before = _scoped_fixture(tmp_path, item.lower())

    checks_done = threading.Event()
    lock_taken = threading.Event()

    def checks_pass(ws, log, **_kw):
        checks_done.set()
        assert lock_taken.wait(10)
        return "checks passed"

    monkeypatch.setattr(conflict_resolver, "run_checks", checks_pass)
    run = farm(item)
    assert checks_done.wait(20)

    reply = {}
    with workspaces.hub_lock(REPO):
        lock_taken.set()
        t = threading.Thread(target=lambda: reply.setdefault("res", cancel(item)), daemon=True)
        t.start()
        wait_until(lambda: _cancel_requested(item), what="the cancel event")
    t.join(20)

    assert reply["res"].json()["lock_released"] is True
    run["thread"].join(20)
    assert run["res"].json() == {"error": "cancelled"}
    assert _pushes(git_spy) == []
    assert origin_branch_sha(origin, f"horizon/{item.lower()}") == before


def test_a_killed_resolution_agent_is_a_cancel_not_resolution_unsure(farm, monkeypatch, git_spy):
    tmp_path = farm.tmp_path
    monkeypatch.delenv("FARM_CONFLICT_SCOPED_ENABLED", raising=False)
    origin, before = _scoped_fixture(tmp_path, "hz-34", needs_agent=True)
    started = threading.Event()

    def agent_killed_by_the_sweep(prompt, **kw):
        proc = subprocess.Popen(["sleep", "300"], cwd=kw["cwd"])
        farm.pids.append(proc.pid)
        started.set()
        if proc.wait() != 0:
            raise agent_runner.AgentError(f"agent exited {proc.returncode}")
        return {"result": '{"resolved": true, "summary": "x"}'}

    monkeypatch.setattr(agent_runner, "run_agent", agent_killed_by_the_sweep)
    run = farm("HZ-34")
    assert started.wait(20)

    body = cancel("HZ-34").json()

    assert body["cancelled"] is True and body["killed"] == 1 and body["lock_released"] is True
    run["thread"].join(20)
    assert run["res"].status_code == 409
    assert run["res"].json() == {"error": "cancelled"}
    assert _pushes(git_spy) == []
    assert origin_branch_sha(origin, "horizon/hz-34") == before


def test_a_failed_check_after_a_cancel_is_a_cancel_not_tests_failed(farm, monkeypatch, git_spy):
    origin, before = _mechanical_fixture(farm.tmp_path, "hz-35")

    def check_killed(ws, log, **_kw):
        assert conflict_resolver.request_cancel(REPO, "HZ-35")
        raise CheckFailure("repo checks failed (npm test):\nKilled")

    monkeypatch.setattr(conflict_resolver, "run_checks", check_killed)

    with pytest.raises(conflict_resolver.Cancelled):
        conflict_resolver.resolve(REPO, "HZ-35", log=lambda *_: None)

    assert _pushes(git_spy) == []
    assert origin_branch_sha(origin, "horizon/hz-35") == before


def test_a_cancel_during_a_check_slot_wait_releases_the_lock_in_bounded_time(farm, monkeypatch, git_spy):
    origin, before = _mechanical_fixture(farm.tmp_path, "hz-36")
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.setenv("FARM_CHECK_SLOT_WAIT_MAX_S", "0")  # wait forever: only the cancel ends it
    monkeypatch.setenv("FARM_CONFLICT_CANCEL_WAIT_S", "1")

    with check_slots.check_slot():  # the only slot, busy
        run = farm("HZ-36")
        wait_until(lambda: check_slots.waiting_runs(), timeout=20, what="the resolver to queue for a slot")
        started = time.monotonic()
        body = cancel("HZ-36").json()
        took = time.monotonic() - started

    assert body["cancelled"] is True
    assert body["lock_released"] is True
    assert took < 5
    with workspaces.item_lock(REPO, "HZ-36", wait_s=0):
        pass
    run["thread"].join(20)
    assert run["res"].json() == {"error": "cancelled"}
    assert _pushes(git_spy) == []
    assert origin_branch_sha(origin, "horizon/hz-36") == before


# ---- guardrail 6, structurally: one push site, and it is guarded ----


def test_git_push_is_only_ever_called_from_push_guarded():
    tree = ast.parse(inspect.getsource(conflict_resolver))
    owners = []
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef):
            continue
        for node in ast.walk(fn):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "git"
                and any(isinstance(a, ast.Constant) and a.value == "push" for a in node.args)
            ):
                owners.append(fn.name)
    assert owners == ["_push_guarded"]
    guarded = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_push_guarded")
    first = guarded.body[1] if isinstance(guarded.body[0].value, ast.Constant) else guarded.body[0]
    assert isinstance(first.value, ast.Call) and first.value.func.id == "_check_cancelled"
