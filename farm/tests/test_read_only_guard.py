"""HZ-387: a read-only step that changed the worktree is rolled back and
fails, whichever provider ran it.

Every case runs a fake provider (run_agent monkeypatched) in a real git
worktree made with `git worktree add` from a hub checkout, the way farm
workspaces are laid out. The hub has its own dirty file, a second branch
and a stash entry, so the tests can prove the rollback touched nothing but
the item's own worktree.

fixtures/read_only/violation_message.txt is the message violation_message()
builds for a fixed change list; server/test/read-only-violation-pause.test.mjs
posts that same file to the /fail route, so the two sides cannot drift.
"""

import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from domain.py import reasons, steps
from farm import pause, read_only_guard, step_agent
from farm.agent_runner import AgentError
from farm.read_only_guard import HEADLINE_PREFIX, ReadOnlyViolation, SnapshotFailed

REPO_ROOT = Path(__file__).resolve().parents[2]
MESSAGE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "read_only" / "violation_message.txt"
ITEM_BRANCH = "horizon/t-1"
NO_CHECKS = "no_checks"

ENG_PLAN = step_agent.ENG_PLAN_LABEL
REVIEW = step_agent.REVIEW_LABEL
PLANNING_STEPS = [
    (4, step_agent.OPTIONS_LABEL),
    (6, step_agent.ENG_PLAN_LABEL),
    (7, step_agent.ARCH_REVIEW_LABEL),
    (8, step_agent.QA_PLAN_LABEL),
]
# The changes violation_message() lists for the shared fixture.
FIXTURE_CHANGES = ["commit 3f2a1c9e0 (discarded)", "README.md", "notes.txt", "src/app.js"]


def git(cwd, *args) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def make_task(step_index, label, *, provider=None):
    item = {
        "id": "T-1",
        "title": "Test item",
        "desc": "Deliver the thing",
        "metric": "It works",
        "guardrails": "",
        "priority": "Medium",
        "repo": "acme/demo",
        "issue": 42,
    }
    if provider:
        item["providerChoices"] = {str(step_index): provider}
    return {
        "run_id": 7,
        "attempt": 1,
        "item": item,
        "step": {"index": step_index, "label": label, "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
        "checks_waiver": NO_CHECKS,
    }


class Repo:
    def __init__(self, hub: Path, ws: Path, origin: Path):
        self.hub, self.ws, self.origin = hub, ws, origin

    def head(self) -> str:
        return git(self.ws, "rev-parse", "HEAD")

    def branch_sha(self) -> str:
        return git(self.ws, "rev-parse", f"refs/heads/{ITEM_BRANCH}")

    def outside_state(self) -> dict:
        """Everything outside the item's worktree the rollback must not touch."""
        return {
            "hub_status": git(self.hub, "status", "--porcelain"),
            "hub_readme": (self.hub / "README.md").read_text(),
            "refs": git(self.hub, "for-each-ref", "--format=%(refname) %(objectname)"),
            "stash": git(self.hub, "stash", "list", "--format=%H %gs"),
        }


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-b", "main")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "README.md").write_text("# demo\n")
    (seed / "src").mkdir()
    (seed / "src" / "app.js").write_text("console.log('hi')\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    hub = tmp_path / "hub"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    git(hub, "config", "user.email", "farm@example.com")
    git(hub, "config", "user.name", "Horizon Farm")
    ws = tmp_path / "items" / "t-1"
    git(hub, "worktree", "add", "-b", ITEM_BRANCH, str(ws), "origin/main")
    # The hub's own state: a second branch, a stash entry and a dirty file.
    git(hub, "branch", "other")
    (hub / "README.md").write_text("# hub stash\n")
    git(hub, "stash", "push", "-m", "hub-entry")
    (hub / "README.md").write_text("# hub dirty\n")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo_full, item_id: ws)
    return Repo(hub, ws, origin)


def reply(ran_on: str | None, **extra) -> dict:
    body = {"summary": "did the step", "artifact_md": "# out", "verdict": "pass", "findings": []}
    out = {"result": json.dumps(body)}
    if ran_on:
        out.update(provider=ran_on, command_id=f"{ran_on}-cmd-1", **extra)
    return out


def vandal(ws: Path, ran_on: str | None = "muse", calls: list | None = None):
    """Edits a tracked file, adds an untracked one and commits everything."""

    def _fake(prompt, **kwargs):
        if calls is not None:
            calls.append(kwargs)
        (ws / "README.md").write_text("# vandalised\n")
        (ws / "new.txt").write_text("not yours\n")
        git(ws, "add", "-A")
        git(ws, "commit", "-m", "agent commit")
        return reply(ran_on)

    return _fake


def run_main(task: dict, tmp_path: Path, monkeypatch) -> dict:
    """Runs step_agent.main() on `task`; returns what it posted, if anything."""
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted.update(json)

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)
    step_agent.main()
    return posted


@pytest.fixture(autouse=True)
def restore_pause_state():
    """main() installs a SIGTERM handler and sets pause's module state; put
    both back so no later test inherits them."""
    old_handler = signal.getsignal(signal.SIGTERM)
    old_state = dict(pause._state)
    yield
    signal.signal(signal.SIGTERM, old_handler)
    pause._state.clear()
    pause._state.update(old_state)


@pytest.fixture
def git_spy(monkeypatch) -> list[tuple[str, ...]]:
    seen: list[tuple[str, ...]] = []
    real = read_only_guard._git

    def spy(ws, *args, **kwargs):
        seen.append(args)
        return real(ws, *args, **kwargs)

    monkeypatch.setattr(read_only_guard, "_git", spy)
    return seen


# ---- metric 1: rolled back, and the step fails read-only-violated ----


def test_violation_rolls_back_and_fails(repo, tmp_path, monkeypatch, git_spy):
    recorded_head = repo.head()
    recorded_readme = (repo.ws / "README.md").read_text()
    outside = repo.outside_state()
    made = []

    def _fake(prompt, **kwargs):
        result = vandal(repo.ws)(prompt, **kwargs)
        made.append(repo.head())
        return result

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    posted = run_main(make_task(6, ENG_PLAN), tmp_path, monkeypatch)

    assert posted["ok"] is False
    assert posted["reason"] == reasons.REASON["READ_ONLY_VIOLATED"]
    assert repo.head() == recorded_head
    assert repo.branch_sha() == recorded_head
    assert git(repo.ws, "symbolic-ref", "HEAD") == f"refs/heads/{ITEM_BRANCH}"
    unreachable = subprocess.run(["git", "-C", str(repo.ws), "merge-base", "--is-ancestor", made[0], ITEM_BRANCH])
    assert made[0] != recorded_head and unreachable.returncode == 1
    assert (repo.ws / "README.md").read_text() == recorded_readme
    assert not (repo.ws / "new.txt").exists()
    assert git(repo.ws, "status", "--porcelain") == ""
    # Guardrail 1: the hub checkout, every ref and the stash stack are as
    # they were — the item branch included, since it is back where it began.
    assert repo.outside_state() == outside
    # Guardrail 4: local git only.
    for args in git_spy:
        assert args[0] not in ("push", "clean", "branch", "reset"), args
        assert args[:2] not in (("stash", "drop"), ("stash", "push"), ("stash", "pop"), ("stash", "clear")), args


@pytest.mark.parametrize("which", ["code", "qa"])
def test_review_pass_violation(repo, monkeypatch, which):
    """Both of step 12's passes are guarded, each on its own."""
    (repo.ws / "app.py").write_text("print('hi')\n")
    git(repo.ws, "add", "-A")
    git(repo.ws, "commit", "-m", "add app.py")
    git(repo.ws, "push", "-u", "origin", f"HEAD:{ITEM_BRANCH}")
    pushed = repo.head()
    calls = []

    def _fake(prompt, **kwargs):
        is_qa = "QA Reviewer agent" in kwargs.get("append_system", "")
        calls.append("qa" if is_qa else "code")
        if calls[-1] == which:
            return vandal(repo.ws)(prompt, **kwargs)
        return reply("muse")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(ReadOnlyViolation) as err:
        step_agent.execute(make_task(12, REVIEW, provider="muse"))

    assert err.value.rolled_back is True
    assert "(provider: muse)" in str(err.value).splitlines()[0]
    # The code pass's verdict never lets the step through, and a failed code
    # pass stops the QA pass from running at all.
    assert calls == (["code"] if which == "code" else ["code", "qa"])
    assert repo.head() == pushed == repo.branch_sha()
    assert (repo.ws / "README.md").read_text() == "# demo\n"
    assert not (repo.ws / "new.txt").exists()


# ---- metric 2: a one-line headline naming the provider; every file below ----


def test_violation_headline_and_details(repo, monkeypatch):
    (repo.ws / "src" / "app.js").unlink()
    git(repo.ws, "commit", "-am", "earlier step removed app.js")

    def _fake(prompt, **kwargs):
        (repo.ws / "README.md").write_text("# vandalised\n")
        (repo.ws / "deep" / "nested").mkdir(parents=True)
        (repo.ws / "deep" / "nested" / "made.txt").write_text("x\n")
        (repo.ws / "staged.txt").write_text("y\n")
        git(repo.ws, "add", "staged.txt")
        return reply("muse")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(ReadOnlyViolation) as err:
        step_agent.execute(make_task(8, step_agent.QA_PLAN_LABEL, provider="muse"))

    lines = str(err.value).split("\n")
    assert lines[0] == f"{HEADLINE_PREFIX} (provider: muse) — rolled back"
    assert sorted(lines[1:]) == ["README.md", "deep/nested/made.txt", "staged.txt"]
    assert git(repo.ws, "status", "--porcelain") == ""


def test_a_body_that_raised_names_the_selected_provider(repo, monkeypatch):
    """No reply means no provenance: the headline falls back to the provider
    run_agent would have used, and the violation wins over the body's error."""
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    def _fake(prompt, **kwargs):
        (repo.ws / "README.md").write_text("# vandalised\n")
        raise AgentError("muse exited 1")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(ReadOnlyViolation) as err:
        step_agent.execute(make_task(7, step_agent.ARCH_REVIEW_LABEL))

    assert str(err.value).splitlines() == [f"{HEADLINE_PREFIX} (provider: muse) — rolled back", "README.md"]
    assert isinstance(err.value.__cause__, AgentError)
    assert (repo.ws / "README.md").read_text() == "# demo\n"


def test_shared_message_fixture_is_what_the_farm_builds():
    """The file the server's /fail-route test posts."""
    assert read_only_guard.violation_message("muse", FIXTURE_CHANGES) == MESSAGE_FIXTURE.read_text()


def test_a_long_change_list_fits_the_route_limit_and_says_how_many_more():
    changes = [f"src/generated/file_{i:04d}.js" for i in range(400)]

    message = read_only_guard.violation_message("claude", changes)

    assert len(message) <= read_only_guard.MESSAGE_MAX_CHARS == step_agent.ERROR_MAX_CHARS
    lines = message.split("\n")
    assert lines[0] == f"{HEADLINE_PREFIX} (provider: claude) — rolled back"
    shown = lines[1:-1]
    assert shown == changes[: len(shown)]
    assert lines[-1] == f"+{len(changes) - len(shown)} more"
    # A short list is never cut.
    assert read_only_guard.violation_message("claude", changes[:3]).split("\n")[1:] == changes[:3]


def test_headline_prefix_matches_the_server():
    js = (REPO_ROOT / "server" / "src" / "checkHeadline.js").read_text()
    match = re.search(r"export const READ_ONLY_HEADLINE_PREFIX = '([^']*)'", js)
    assert match, "server/src/checkHeadline.js no longer declares READ_ONLY_HEADLINE_PREFIX"
    assert match.group(1) == HEADLINE_PREFIX


# ---- metric 3: earlier work survives the rollback ----


def test_rollback_keeps_earlier_work(repo, monkeypatch):
    (repo.ws / "earlier.py").write_text("x = 1\n")
    git(repo.ws, "add", "-A")
    git(repo.ws, "commit", "-m", "earlier step's commit")
    earlier = repo.head()
    (repo.ws / "src" / "app.js").write_text("console.log('dirty')\n")  # unstaged edit
    (repo.ws / "staged.md").write_text("staged\n")
    git(repo.ws, "add", "staged.md")
    (repo.ws / "notes").mkdir()
    (repo.ws / "notes" / "todo.txt").write_text("before the step\n")
    (repo.ws / "run.sh").write_text("#!/bin/sh\n")
    os.chmod(repo.ws / "run.sh", 0o755)
    status_before = git(repo.ws, "status", "--porcelain")

    def _fake(prompt, **kwargs):
        (repo.ws / "notes" / "todo.txt").write_text("rewritten by the agent\n")
        os.chmod(repo.ws / "run.sh", 0o644)
        return vandal(repo.ws)(prompt, **kwargs)  # commits all of the above

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(ReadOnlyViolation):
        step_agent.execute(make_task(6, ENG_PLAN))

    assert repo.head() == earlier == repo.branch_sha()
    assert (repo.ws / "earlier.py").read_text() == "x = 1\n"
    assert (repo.ws / "src" / "app.js").read_text() == "console.log('dirty')\n"
    assert (repo.ws / "staged.md").read_text() == "staged\n"
    assert (repo.ws / "notes" / "todo.txt").read_text() == "before the step\n"
    assert os.stat(repo.ws / "run.sh").st_mode & 0o777 == 0o755
    assert git(repo.ws, "status", "--porcelain") == status_before


def test_an_edit_to_an_already_modified_file_is_caught_and_undone(repo, monkeypatch):
    """Porcelain says ` M` before and after; only the content differs."""
    (repo.ws / "README.md").write_text("# earlier edit\n")
    assert git(repo.ws, "status", "--porcelain") == "M README.md"

    def _fake(prompt, **kwargs):
        (repo.ws / "README.md").write_text("# earlier edit, then the agent's\n")
        return reply("claude")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(ReadOnlyViolation) as err:
        step_agent.execute(make_task(4, step_agent.OPTIONS_LABEL))

    assert str(err.value).splitlines()[1:] == ["README.md"]
    assert (repo.ws / "README.md").read_text() == "# earlier edit\n"
    assert git(repo.ws, "status", "--porcelain") == "M README.md"


# ---- metric 4: a clean read-only step passes exactly as before ----


def _passthrough_guard(ws, provider):
    from contextlib import contextmanager

    @contextmanager
    def _guard():
        yield read_only_guard.Watch(provider)

    return _guard()


def _clean_fake(ran_on):
    def _fake(prompt, **kwargs):
        return reply(ran_on)

    return _fake


@pytest.mark.parametrize("ran_on", ["claude", "muse"])
@pytest.mark.parametrize("step_index, label", [*PLANNING_STEPS, (12, REVIEW)])
def test_clean_step_unchanged(repo, monkeypatch, git_spy, ran_on, step_index, label):
    if label == REVIEW:
        git(repo.ws, "push", "-u", "origin", f"HEAD:{ITEM_BRANCH}")
    (repo.ws / "untracked.txt").write_text("left alone\n")
    (repo.ws / "README.md").write_text("# dirty but untouched\n")
    provider = ran_on if steps.provider_override_eligible(steps.STEPS, label) else None
    monkeypatch.setattr(step_agent, "run_agent", _clean_fake(ran_on))

    with monkeypatch.context() as unguarded:
        unguarded.setattr(step_agent.read_only_guard, "guard", _passthrough_guard)
        expected = step_agent.execute(make_task(step_index, label, provider=provider))
    if label == REVIEW:  # the review's own scrub ran; put the same state back
        (repo.ws / "untracked.txt").write_text("left alone\n")
        (repo.ws / "README.md").write_text("# dirty but untouched\n")
    git_spy.clear()

    result = step_agent.execute(make_task(step_index, label, provider=provider))

    assert result == expected
    assert git_spy, "the guard never ran"
    for args in git_spy:
        assert args[0] not in ("checkout", "read-tree", "cat-file"), args


# ---- metric 5: workspaceMutating steps are not checked ----


def test_implement_not_guarded(repo, monkeypatch):
    git(repo.ws, "push", "-u", "origin", f"HEAD:{ITEM_BRANCH}")
    snapshots = []
    monkeypatch.setattr(read_only_guard, "snapshot", lambda *a, **k: snapshots.append(a) or pytest.fail("guarded"))

    def _fake(prompt, **kwargs):
        (repo.ws / "feature.py").write_text("built\n")
        git(repo.ws, "add", "-A")
        git(repo.ws, "commit", "-m", "agent's own commit")
        return {"result": json.dumps({"summary": "implemented"})}

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    result = step_agent.execute(make_task(11, step_agent.IMPLEMENT_LABEL))

    assert result["artifacts"]["branch"] == ITEM_BRANCH
    assert snapshots == []
    shown = git(repo.origin, "show", f"{ITEM_BRANCH}:feature.py")
    assert shown == "built"


def test_read_only_labels_are_exactly_the_four_planning_steps():
    assert step_agent.READ_ONLY_LABELS == {label for _, label in PLANNING_STEPS}
    assert step_agent.IMPLEMENT_LABEL not in step_agent.READ_ONLY_LABELS
    assert REVIEW not in step_agent.READ_ONLY_LABELS
    for label in step_agent.READ_ONLY_LABELS:
        entry = steps.by_label(label)
        assert entry["workspaceMutating"] is False, label
        assert step_agent.STEP_CONFIG[label][2] == step_agent.PLANNER_TOOLS, label
    # Every workspaceMutating step is outside the set.
    for entry in steps.STEPS:
        if entry.get("workspaceMutating"):
            assert entry["label"] not in step_agent.READ_ONLY_LABELS


# ---- guardrail 3: a failed rollback, a pause, a failed snapshot ----


def test_rollback_failure_still_fails(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(step_agent, "run_agent", vandal(repo.ws))

    def _broken(ws, before):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(read_only_guard, "restore", _broken)

    posted = run_main(make_task(6, ENG_PLAN), tmp_path, monkeypatch)

    assert posted["ok"] is False
    assert posted["reason"] == reasons.REASON["READ_ONLY_VIOLATED"]
    headline = posted["error"].split("\n")[0]
    assert headline.startswith(f"{HEADLINE_PREFIX} (provider: muse) — rollback FAILED: RuntimeError: disk on fire")


@pytest.mark.parametrize("restore_ok", [True, False], ids=["restore_ok", "restore_failed"])
def test_pause_during_read_only_step(repo, tmp_path, monkeypatch, restore_ok):
    """A real SIGTERM mid-call, as farmd sends one: the guard stops the agent,
    restores the tree and lets the pause through — or, if it cannot restore,
    reports the violation so the item never resumes on a dirty tree."""
    killed = []
    monkeypatch.setattr(pause, "kill_descendants", lambda: killed.append(True) or 0)
    if not restore_ok:
        monkeypatch.setattr(read_only_guard, "restore", lambda ws, before: (_ for _ in ()).throw(OSError("no space")))
    recorded_head = repo.head()

    def _fake(prompt, **kwargs):
        vandal(repo.ws)(prompt, **kwargs)
        os.kill(os.getpid(), signal.SIGTERM)
        pytest.fail("the pause did not interrupt the call")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    posted = run_main(make_task(6, ENG_PLAN), tmp_path, monkeypatch)

    outcome = pause.read_outcome(tmp_path / "task.paused")
    assert killed == [True]
    if restore_ok:
        assert posted == {}, "a clean pause reports no result"
        assert outcome["outcome"] == pause.NOTHING
        assert repo.head() == recorded_head
        assert not (repo.ws / "new.txt").exists()
    else:
        assert posted["reason"] == reasons.REASON["READ_ONLY_VIOLATED"]
        assert "rollback FAILED" in posted["error"].split("\n")[0]
        assert outcome["outcome"] == pause.FAILED
        assert "rollback FAILED" in outcome["detail"]


def test_snapshot_failure_fails_closed(repo, monkeypatch):
    """Unmerged index entries: the worktree cannot be recorded, so the agent
    is never called and the step fails."""
    git(repo.ws, "checkout", "-q", "-b", "side")
    (repo.ws / "README.md").write_text("# side\n")
    git(repo.ws, "commit", "-qam", "side")
    git(repo.ws, "checkout", "-q", ITEM_BRANCH)
    (repo.ws / "README.md").write_text("# item\n")
    git(repo.ws, "commit", "-qam", "item")
    subprocess.run(["git", "-C", str(repo.ws), "merge", "side"], capture_output=True)
    assert "UU README.md" in git(repo.ws, "status", "--porcelain")
    called = []
    monkeypatch.setattr(step_agent, "run_agent", lambda prompt, **kw: called.append(kw) or reply("claude"))

    with pytest.raises(SnapshotFailed, match="could not record the worktree"):
        step_agent.execute(make_task(6, ENG_PLAN))

    assert called == []


def test_a_read_only_step_holds_the_item_lock(repo, monkeypatch):
    """The rollback writes to the worktree, so it never races a conflict
    resolver that owns the item."""
    from farm import workspaces

    held = []

    def _fake(prompt, **kwargs):
        held.append(workspaces.item_lock_held("acme/demo", "T-1"))
        return reply("claude")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    step_agent.execute(make_task(6, ENG_PLAN))

    assert held == [True]
