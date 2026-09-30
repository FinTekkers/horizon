"""HZ-154: the scoped conflict path, end to end against real git.

Same real-bare-repo fixtures as test_conflict_resolver.py (no mocked git
plumbing) with only the two agent calls faked — so every guardrail these tests
claim to prove is proved against git's own merge mechanics:

  - the resolution is deterministic where it can be, and no agent is dispatched
  - nothing is pushed unless the repo's checks actually ran and passed
  - an edit outside a conflicted region, or a leftover marker, is rejected in
    code — the prompt is never the guardrail
  - the scoped review sees the resolution delta and nothing else
  - every escalation leaves origin untouched and the worktree clean

The agent fake asserts on its own dispatch, so a test that says "no agent ran"
fails loudly if one does. test_the_agent_fake_really_does_intercept below is
the positive control for that claim.
"""

import subprocess
from pathlib import Path

import pytest

from farm import agent_runner, conflict_resolver, workspaces
from farm.tests.conflict_fixtures import (
    clone_and_read,
    git,
    make_repo_hub,
    origin_branch_sha,
    push_new_branch,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# The exact three sides of HZ-124's real conflict in farm/providers/muse.py and
# farm/providers/claude.py (read off commits ce379a3 and 85cf212 with
# `git show :1:`/`:2:`/`:3:`): the PR rewrote one import into a parenthesised
# block, and main added a new import line above it. Embedded here so the replay
# does not depend on those two commits being present in the checkout — the
# test that uses the real commits is below, and skips when they are not.
BASE_FILE = """import json
import os

from .base import AgentError, AgentExhaustedError, assert_metered_billing_authorized, metered_billing_opted_in

SUPPORTS_RESUME = True
"""
OURS_FILE = """import json
import os

from .base import (
    AgentError,
    AgentExhaustedError,
    assert_metered_billing_authorized,
    decode_partial_output,
    metered_billing_opted_in,
)

SUPPORTS_RESUME = True
"""
THEIRS_FILE = """import json
import os

from ..credentials import without_gate_credentials
from .base import AgentError, AgentExhaustedError, assert_metered_billing_authorized, metered_billing_opted_in

SUPPORTS_RESUME = True
"""
RESOLVED_IMPORTS = """from ..credentials import without_gate_credentials
from .base import (
    AgentError,
    AgentExhaustedError,
    assert_metered_billing_authorized,
    decode_partial_output,
    metered_billing_opted_in,
)
"""

PASSING_REVIEW = '{"summary": "kept both imports", "verdict": "pass", "findings": []}'
FAILING_REVIEW = '{"summary": "one side was dropped", "verdict": "fail", "findings": [{"file": "a", "line": 1, "severity": "block", "detail": "lost the PR\'s own import"}]}'


@pytest.fixture
def isolated_workspaces_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    # A green, always-available check runner: the scoped path refuses to push
    # behind a suite that did not run, and the fixture repo has no runner of
    # its own. Tests for the red and the no-runner cases override this.
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.delenv("FARM_CONFLICT_SCOPED_ENABLED", raising=False)
    return tmp_path


class FakeAgents:
    """Stands in for agent_runner.run_agent for both scoped calls.

    Which call is which is read off the role prompt, exactly as production
    picks it. A call this test did not allow raises — so "no agent was
    dispatched" is an assertion, not an absence of evidence.
    """

    def __init__(self, *, resolution=None, review=None):
        self.resolution = resolution
        self.review = review
        self.calls = []

    def __call__(self, prompt, *, append_system=None, cwd=None, **kwargs):
        role = append_system or ""
        kind = "resolution" if "Conflict Resolver agent" in role else "review"
        self.calls.append({"kind": kind, "prompt": prompt, "cwd": cwd, "role": role, **kwargs})
        handler = self.resolution if kind == "resolution" else self.review
        assert handler is not None, f"the {kind} agent must not be dispatched in this test"
        return {"result": handler(Path(cwd)) if callable(handler) else handler}

    def of(self, kind):
        return [c for c in self.calls if c["kind"] == kind]


def install(monkeypatch, agents):
    monkeypatch.setattr(agent_runner, "run_agent", agents)
    return agents


def additive_conflict(tmp_path, origin, item_id, extra_ours=None, extra_theirs=None):
    """Both sides insert a different line at the same place — the smallest real
    overlapping conflict git refuses to merge."""

    def ours(work):
        (work / "shared.txt").write_text("line1\nline2\nours-added\nline3\n")
        if extra_ours:
            extra_ours(work)

    def theirs(work):
        (work / "shared.txt").write_text("line1\nline2\ntheirs-added\nline3\n")
        if extra_theirs:
            extra_theirs(work)

    branch_sha = push_new_branch(tmp_path, origin, f"horizon/{item_id.lower()}", ours, "branch")
    push_new_branch(tmp_path, origin, "main", theirs, "main-advance")
    return branch_sha


def same_line_conflict(tmp_path, origin, item_id, extra_ours=None, extra_theirs=None):
    """Both sides rewrote the same line — no deterministic answer exists, so
    this is the fixture for every test that needs the resolution agent.
    extra_ours/extra_theirs add the rest of the PR, and main's own work,
    around the conflict."""

    def ours(work):
        (work / "shared.txt").write_text("line1\nline2 (branch)\nline3\n")
        if extra_ours:
            extra_ours(work)

    def theirs(work):
        (work / "shared.txt").write_text("line1\nline2 (main)\nline3\n")
        if extra_theirs:
            extra_theirs(work)

    branch_sha = push_new_branch(tmp_path, origin, f"horizon/{item_id.lower()}", ours, "branch")
    push_new_branch(tmp_path, origin, "main", theirs, "main-advance")
    return branch_sha


def hz124_conflict(tmp_path, origin, item_id, files=("providers/claude.py", "providers/muse.py")):
    """HZ-124's real conflict shape, in as many files as asked for."""

    def write(text):
        def mutate(work):
            for name in files:
                target = work / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)

        return mutate

    push_new_branch(tmp_path, origin, "seed-files", write(BASE_FILE), "seed-files")
    # Fold the base version into main before either side edits it, so the
    # merge base really does hold BASE_FILE.
    push_new_branch(tmp_path, origin, "main", write(BASE_FILE), "main-base")
    branch_sha = push_new_branch(tmp_path, origin, f"horizon/{item_id.lower()}", write(OURS_FILE), "branch")
    push_new_branch(tmp_path, origin, "main", write(THEIRS_FILE), "main-advance")
    return branch_sha


def worktree(item_id):
    return workspaces.workspace_path("acme/demo", item_id)


def assert_nothing_pushed_and_clean(origin, item_id, branch_sha):
    assert origin_branch_sha(origin, f"horizon/{item_id.lower()}") == branch_sha
    assert git(worktree(item_id), "status", "--porcelain").stdout == ""


# ---- metric 1: the replay, with no agent and no re-review ----


def test_an_additive_conflict_resolves_deterministically_with_no_agent(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(monkeypatch, FakeAgents())  # every dispatch raises
    additive_conflict(tmp_path, origin, "HZ-1")

    result = conflict_resolver.resolve("acme/demo", "HZ-1", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["mode"] == "scoped"
    assert result["resolution"] == {
        "strategy": "deterministic",
        "hunks": 1,
        "paths": ["shared.txt"],
        "hunk_labels": ["shared.txt hunk 1"],
    }
    # No novel and no dropped line, so there is nothing for a reviewer to read
    # — and the event log says that instead of claiming a verdict.
    assert result["review"]["verdict"] == "pass"
    assert result["review"]["reviewed"] is False
    assert agents.calls == []

    merged = clone_and_read(tmp_path, origin, "horizon/hz-1", "shared.txt", "after")
    assert merged == "line1\nline2\nours-added\ntheirs-added\nline3\n"
    assert "<<<<<<<" not in merged


def test_the_hz124_shape_keeps_both_imports_and_only_the_review_is_an_agent(isolated_workspaces_dir, monkeypatch):
    """Metric 1's replay: the PR's rewritten import block AND main's added
    import both survive. The resolution itself is deterministic — the only
    agent in the path is the scoped review, and it only sees the delta."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(monkeypatch, FakeAgents(review=PASSING_REVIEW))
    hz124_conflict(tmp_path, origin, "HZ-124")

    result = conflict_resolver.resolve("acme/demo", "HZ-124", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["resolution"]["strategy"] == "deterministic"
    assert result["resolution"]["paths"] == ["providers/claude.py", "providers/muse.py"]
    assert result["resolution"]["hunks"] == 2
    assert result["review"] == {
        "verdict": "pass",
        "reviewed": True,
        "summary": "kept both imports",
        "findings": [],
    }
    assert agents.of("resolution") == []

    for name in ("providers/claude.py", "providers/muse.py"):
        merged = clone_and_read(tmp_path, origin, "horizon/hz-124", name, f"after-{Path(name).stem}")
        assert RESOLVED_IMPORTS in merged
        assert "<<<<<<<" not in merged


def test_the_real_hz124_commits_replay_through_the_scoped_path(isolated_workspaces_dir, monkeypatch):
    """The named replay from the success metric: commit ce379a3 merged with
    origin/main at 85cf212.

    ce379a3 is a PR-branch commit, so it is NOT reachable from main and a fresh
    clone will not have it. Skipped rather than faked when it is absent; the
    test above pins the identical conflict from embedded blobs so coverage
    never depends on this one running.
    """
    for sha in ("ce379a3", "85cf212"):
        if subprocess.run(["git", "-C", str(REPO_ROOT), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True).returncode:
            pytest.skip(f"{sha} is not in this checkout (PR-branch commit, unreachable from main)")
    shallow = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--is-shallow-repository"], capture_output=True, text=True
    ).stdout.strip()
    if shallow == "true":
        pytest.skip("a shallow clone cannot push the history these two commits need")

    tmp_path = isolated_workspaces_dir
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--quiet", "--bare", str(origin)], check=True)
    subprocess.run(
        [
            "git", "-C", str(REPO_ROOT), "push", "--quiet", str(origin),
            "ce379a3:refs/heads/horizon/hz-124", "85cf212:refs/heads/main",
        ],
        check=True, capture_output=True,
    )
    subprocess.run(["git", "-C", str(origin), "symbolic-ref", "HEAD", "refs/heads/main"], check=True)
    hub = workspaces.hub_path("FinTekkers/horizon")
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    git(hub, "config", "user.email", "farm@example.com")
    git(hub, "config", "user.name", "Horizon Farm")
    agents = install(monkeypatch, FakeAgents(review=PASSING_REVIEW))

    result = conflict_resolver.resolve("FinTekkers/horizon", "HZ-124", log=lambda *_: None)

    assert result["resolved"] is True, result
    assert result["mode"] == "scoped"
    assert result["resolution"]["strategy"] == "deterministic"
    assert result["resolution"]["paths"] == ["farm/providers/claude.py", "farm/providers/muse.py"]
    assert agents.of("resolution") == []

    for name in ("farm/providers/claude.py", "farm/providers/muse.py"):
        merged = clone_and_read(tmp_path, origin, "horizon/hz-124", name, f"real-{Path(name).stem}")
        assert "from ..credentials import without_gate_credentials\n" in merged  # main's added import
        assert "decode_partial_output" in merged  # the PR's own change
        assert "<<<<<<<" not in merged

    # Metric 2's integration half: the review saw the conflicted hunks and the
    # delta — not the other 94 files this PR touched.
    prompt = agents.of("review")[0]["prompt"]
    assert "step_agent" not in prompt
    assert "test_step_agent" not in prompt


# ---- the positive control for every "no agent was dispatched" claim ----


def test_the_agent_fake_really_does_intercept(isolated_workspaces_dir, monkeypatch):
    """Without this, "no agent ran" tests could pass because the patch missed.
    conflict_resolver calls agent_runner.run_agent through the module for
    exactly this reason — a `from ... import run_agent` binding would sail
    past the patch."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(monkeypatch, FakeAgents(resolution=lambda ws: '{"resolved": false, "unsure_reason": "no"}'))
    # A same-line rewrite on both sides: deterministic resolution is impossible,
    # so the resolution agent MUST be dispatched.
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-5")

    result = conflict_resolver.resolve("acme/demo", "HZ-5", log=lambda *_: None)

    assert [c["kind"] for c in agents.calls] == ["resolution"]
    assert result["reason"] == "resolution_unsure"
    assert_nothing_pushed_and_clean(origin, "HZ-5", branch_sha)


def test_the_resolution_agent_is_provider_locked_and_cannot_write_or_shell_out(
    isolated_workspaces_dir, monkeypatch
):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(monkeypatch, FakeAgents(resolution=lambda ws: '{"resolved": false, "unsure_reason": "no"}'))
    same_line_conflict(tmp_path, origin, "HZ-6")

    conflict_resolver.resolve("acme/demo", "HZ-6", log=lambda *_: None)

    call = agents.of("resolution")[0]
    assert call["provider_locked"] is True
    assert call["allowed_tools"] == "Read,Glob,Grep,Edit"
    assert "Write" not in call["allowed_tools"]
    assert "Bash" not in call["allowed_tools"]
    assert call["cwd"] == str(worktree("HZ-6"))


# ---- the agent path: a resolution it can make, in scope ----


def resolve_markers(replacement, *, path="shared.txt", reply='{"resolved": true, "summary": "merged both"}'):
    """An agent that replaces the whole marked region with `replacement`."""

    def agent(ws):
        text = (ws / path).read_text()
        start = text.index("<<<<<<<")
        end = text.index(">>>>>>>")
        end = text.index("\n", end) + 1
        (ws / path).write_text(text[:start] + replacement + text[end:])
        return reply

    return agent


def test_a_non_additive_conflict_the_agent_resolves_in_scope_is_pushed(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (branch and main)\n"), review=PASSING_REVIEW),
    )
    same_line_conflict(tmp_path, origin, "HZ-7")

    result = conflict_resolver.resolve("acme/demo", "HZ-7", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["resolution"]["strategy"] == "agent"
    assert result["review"]["verdict"] == "pass"
    assert [c["kind"] for c in agents.calls] == ["resolution", "review"]
    assert clone_and_read(tmp_path, origin, "horizon/hz-7", "shared.txt", "agent") == (
        "line1\nline2 (branch and main)\nline3\n"
    )


def test_the_scoped_review_sees_only_the_delta_not_the_rest_of_the_pr(isolated_workspaces_dir, monkeypatch):
    """Metric 2: the review input excludes the rest of the PR diff AND main's
    own changes. Both are sentinel strings in files this run never shows it."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (both, plus a new thought)\n"), review=PASSING_REVIEW),
    )
    same_line_conflict(
        tmp_path,
        origin,
        "HZ-8",
        extra_ours=lambda w: (w / "elsewhere_in_the_pr.txt").write_text("SENTINEL_REST_OF_THE_PR\n"),
        extra_theirs=lambda w: (w / "mains_own_work.txt").write_text("SENTINEL_MAINS_OWN_CHANGE\n"),
    )

    conflict_resolver.resolve("acme/demo", "HZ-8", log=lambda *_: None)

    prompt = agents.of("review")[0]["prompt"]
    assert "SENTINEL_REST_OF_THE_PR" not in prompt
    assert "SENTINEL_MAINS_OWN_CHANGE" not in prompt
    # What it DOES see: the hunk's three sides and the line the resolution
    # invented.
    assert "line2 (branch)" in prompt
    assert "line2 (main)" in prompt
    assert "line2 (both, plus a new thought)" in prompt


# ---- escalations. every one: nothing pushed, worktree clean ----


def test_an_unsure_agent_escalates_with_its_own_reason(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=lambda ws: '{"resolved": false, "unsure_reason": "both sides rewrote the guard"}'),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-10")

    result = conflict_resolver.resolve("acme/demo", "HZ-10", log=lambda *_: None)

    assert result["reason"] == "resolution_unsure"
    assert "both sides rewrote the guard" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-10", branch_sha)


def test_a_rejecting_scoped_review_escalates_and_pushes_nothing(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (a guess)\n"), review=FAILING_REVIEW),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-11")

    result = conflict_resolver.resolve("acme/demo", "HZ-11", log=lambda *_: None)

    assert result["reason"] == "scoped_review_rejected"
    assert "lost the PR's own import" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-11", branch_sha)


def test_an_unparseable_review_reply_counts_as_a_reject(isolated_workspaces_dir, monkeypatch):
    """Fail closed: prose instead of a verdict is a rejection, never a pass."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (a guess)\n"),
            review="Looks fine to me, I would ship it.",
        ),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-12")

    result = conflict_resolver.resolve("acme/demo", "HZ-12", log=lambda *_: None)

    assert result["reason"] == "scoped_review_rejected"
    assert_nothing_pushed_and_clean(origin, "HZ-12", branch_sha)


def test_a_review_with_no_verdict_field_counts_as_a_reject(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (a guess)\n"), review='{"summary": "did some thinking"}'),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-13")

    result = conflict_resolver.resolve("acme/demo", "HZ-13", log=lambda *_: None)

    assert result["reason"] == "scoped_review_rejected"
    assert_nothing_pushed_and_clean(origin, "HZ-13", branch_sha)


def test_an_edit_to_a_file_outside_the_conflict_is_rejected(isolated_workspaces_dir, monkeypatch):
    """Guardrail, in code: the agent may edit only the conflicted files."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    def wanders(ws):
        resolve_markers("line2 (both)\n")(ws)
        (ws / "other.txt").write_text("while I was here I fixed this too\n")
        return '{"resolved": true, "summary": "merged both"}'

    install(monkeypatch, FakeAgents(resolution=wanders))
    branch_sha = same_line_conflict(
        tmp_path, origin, "HZ-14", extra_ours=lambda w: (w / "other.txt").write_text("untouched\n")
    )

    result = conflict_resolver.resolve("acme/demo", "HZ-14", log=lambda *_: None)

    assert result["reason"] == "resolution_out_of_scope"
    assert "other.txt" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-14", branch_sha)


def test_a_new_file_the_agent_creates_is_rejected(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    def creates(ws):
        resolve_markers("line2 (both)\n")(ws)
        (ws / "helper.txt").write_text("a new file nobody asked for\n")
        return '{"resolved": true, "summary": "merged both"}'

    install(monkeypatch, FakeAgents(resolution=creates))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-15")

    result = conflict_resolver.resolve("acme/demo", "HZ-15", log=lambda *_: None)

    assert result["reason"] == "resolution_out_of_scope"
    assert "helper.txt" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-15", branch_sha)


def test_an_edit_outside_the_marked_region_of_a_conflicted_file_is_rejected(isolated_workspaces_dir, monkeypatch):
    """The comparison, not the prompt, is the guardrail: the file IS one of the
    conflicted ones, but the change is outside its marked region."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    def tidies(ws):
        resolve_markers("line2 (both)\n")(ws)
        text = (ws / "shared.txt").read_text()
        (ws / "shared.txt").write_text(text.replace("line3\n", "line3 (tidied)\n"))
        return '{"resolved": true, "summary": "merged both"}'

    install(monkeypatch, FakeAgents(resolution=tidies))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-16")

    result = conflict_resolver.resolve("acme/demo", "HZ-16", log=lambda *_: None)

    assert result["reason"] == "resolution_out_of_scope"
    assert_nothing_pushed_and_clean(origin, "HZ-16", branch_sha)


def test_a_leftover_conflict_marker_is_rejected(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    # Claims success while leaving the region exactly as it found it.
    install(monkeypatch, FakeAgents(resolution=lambda ws: '{"resolved": true, "summary": "all done"}'))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-17")

    result = conflict_resolver.resolve("acme/demo", "HZ-17", log=lambda *_: None)

    assert result["reason"] == "markers_remaining"
    assert_nothing_pushed_and_clean(origin, "HZ-17", branch_sha)


def test_keeping_only_one_side_never_takes_the_no_review_shortcut(isolated_workspaces_dir, monkeypatch):
    """A resolution that discards one side invents no line, so a novel-lines-only
    delta would call it a deterministic pass and push it. It must go to the
    review instead — which here rejects it, so nothing is pushed."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (branch)\n"), review=FAILING_REVIEW),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-18")

    result = conflict_resolver.resolve("acme/demo", "HZ-18", log=lambda *_: None)

    assert [c["kind"] for c in agents.calls] == ["resolution", "review"]
    assert "line2 (main)" in agents.of("review")[0]["prompt"]
    assert result["reason"] == "scoped_review_rejected"
    assert_nothing_pushed_and_clean(origin, "HZ-18", branch_sha)


def test_discarding_the_prs_own_work_never_takes_the_shortcut_either(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (main)\n"), review=FAILING_REVIEW),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-19")

    result = conflict_resolver.resolve("acme/demo", "HZ-19", log=lambda *_: None)

    assert [c["kind"] for c in agents.calls] == ["resolution", "review"]
    assert result["reason"] == "scoped_review_rejected"
    assert_nothing_pushed_and_clean(origin, "HZ-19", branch_sha)


# ---- the caps, the checks gate, the lease, the kill switch ----


def test_too_many_conflicted_lines_escalates_before_any_dispatch(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())  # any dispatch raises
    big_ours = "".join(f"ours {i}\n" for i in range(40))
    big_theirs = "".join(f"theirs {i}\n" for i in range(40))
    branch_sha = push_new_branch(
        tmp_path, origin, "horizon/hz-20", lambda w: (w / "shared.txt").write_text(big_ours), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "shared.txt").write_text(big_theirs), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-20", log=lambda *_: None)

    assert result["reason"] == "conflict_too_large"
    assert "exceeds the cap" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-20", branch_sha)


def test_a_red_check_suite_escalates_and_pushes_nothing(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    branch_sha = additive_conflict(tmp_path, origin, "HZ-21")
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    result = conflict_resolver.resolve("acme/demo", "HZ-21", log=lambda *_: None)

    assert result["reason"] == "scoped_checks_failed"
    assert_nothing_pushed_and_clean(origin, "HZ-21", branch_sha)


def test_a_repo_with_no_check_runner_at_all_escalates(isolated_workspaces_dir, monkeypatch):
    """No green, no push — and "no suite ran" is not green. The mechanical
    path keeps its own behaviour here (a repo need not have tests to take a
    plain fast-forward merge); this path is pushing a resolution instead."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    branch_sha = additive_conflict(tmp_path, origin, "HZ-22")
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    result = conflict_resolver.resolve("acme/demo", "HZ-22", log=lambda *_: None)

    assert result["reason"] == "scoped_checks_failed"
    assert "no repo checks detected" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-22", branch_sha)


def test_a_branch_that_moved_while_resolving_is_never_overwritten(isolated_workspaces_dir, monkeypatch):
    """The lease, actually firing: a third party pushes to the PR branch after
    the head being resolved was captured. The only test that tells
    --force-with-lease apart from --force; an argv assertion cannot."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    def third_party_pushes(ws):
        resolve_markers("line2 (both)\n")(ws)
        work = tmp_path / "third-party"
        subprocess.run(
            ["git", "clone", "--quiet", "-b", "horizon/hz-23", str(origin), str(work)],
            check=True, capture_output=True,
        )
        git(work, "config", "user.email", "other@example.com")
        git(work, "config", "user.name", "Someone Else")
        (work / "shared.txt").write_text("line1\nsomeone else got here first\nline3\n")
        git(work, "commit", "-am", "third party")
        git(work, "push", "origin", "horizon/hz-23")
        intruder.append(git(work, "rev-parse", "HEAD").stdout.strip())
        return '{"resolved": true, "summary": "merged both"}'

    intruder = []

    install(monkeypatch, FakeAgents(resolution=third_party_pushes, review=PASSING_REVIEW))
    same_line_conflict(tmp_path, origin, "HZ-23")
    result = conflict_resolver.resolve("acme/demo", "HZ-23", log=lambda *_: None)

    assert result["reason"] == "push_rejected"
    # The third party's commit is still the branch tip: the resolution did not
    # overwrite work this run never saw.
    assert origin_branch_sha(origin, "horizon/hz-23") == intruder[0]
    assert git(worktree("HZ-23"), "status", "--porcelain").stdout == ""


def test_the_scoped_push_uses_a_lease_naming_the_head_it_resolved(isolated_workspaces_dir, monkeypatch):
    calls = []
    real_git = conflict_resolver.git

    def recording_git(ws, *args, **kwargs):
        calls.append(args)
        return real_git(ws, *args, **kwargs)

    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    branch_sha = additive_conflict(tmp_path, origin, "HZ-24")
    monkeypatch.setattr(conflict_resolver, "git", recording_git)

    assert conflict_resolver.resolve("acme/demo", "HZ-24", log=lambda *_: None)["resolved"] is True

    pushes = [args for args in calls if args and args[0] == "push"]
    assert pushes == [("push", f"--force-with-lease=refs/heads/horizon/hz-24:{branch_sha}", "origin", "horizon/hz-24")]


def test_the_kill_switch_restores_the_mechanical_only_escalation(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())  # any dispatch raises
    monkeypatch.setenv("FARM_CONFLICT_SCOPED_ENABLED", "0")
    branch_sha = additive_conflict(tmp_path, origin, "HZ-25")

    result = conflict_resolver.resolve("acme/demo", "HZ-25", log=lambda *_: None)

    assert result == {
        "resolved": False,
        "reason": "merge_conflict",
        "detail": "conflicts in: shared.txt",
    }
    assert_nothing_pushed_and_clean(origin, "HZ-25", branch_sha)


def test_a_gitattributes_merge_driver_escalates_before_any_dispatch(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    branch_sha = same_line_conflict(
        tmp_path,
        origin,
        "HZ-26",
        extra_ours=lambda w: (w / ".gitattributes").write_text("shared.txt merge=custom\n"),
    )

    result = conflict_resolver.resolve("acme/demo", "HZ-26", log=lambda *_: None)

    assert result["reason"] == "conflict_unsupported"
    assert_nothing_pushed_and_clean(origin, "HZ-26", branch_sha)


def test_every_reason_the_resolver_reports_is_declared(isolated_workspaces_dir, monkeypatch):
    """The Python half of the reason parity check — the Node half
    (orchestrator-conflict-reason-parity.test.mjs) proves each one has a
    human-readable message."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    additive_conflict(tmp_path, origin, "HZ-27")
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    result = conflict_resolver.resolve("acme/demo", "HZ-27", log=lambda *_: None)

    assert result["reason"] in conflict_resolver.ESCALATION_REASONS
    assert len(set(conflict_resolver.ESCALATION_REASONS)) == len(conflict_resolver.ESCALATION_REASONS)
