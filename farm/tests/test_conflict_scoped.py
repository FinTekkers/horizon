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

from farm import agent_runner, checks, conflict_hunks, conflict_resolver, workspaces
from farm.agent_runner import TRAILING_COMMA_NOTE
from farm.tests.conflict_fixtures import (
    clone_and_read,
    git,
    make_repo_hub,
    origin_branch_sha,
    push_new_branch,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# The commits HZ-154's success metric names, and the vendored copies of the
# three sides of their conflict (farm/tests/fixtures/hz124/README.md explains
# why they are vendored rather than read out of this checkout's history).
HZ124_BASE_SHA = "4dc6aa0"
HZ124_OURS_SHA = "ce379a3"
HZ124_THEIRS_SHA = "85cf212"
HZ124_DIR = Path(__file__).resolve().parent / "fixtures" / "hz124"
HZ124_FILES = {"claude": "farm/providers/claude.py", "muse": "farm/providers/muse.py"}


def hz124_blob(name: str, side: str) -> str:
    return (HZ124_DIR / f"{name}.{side}.txt").read_text()


def build_hz124_origin(tmp_path: Path) -> Path:
    """A bare origin holding the real conflict: main at the merge base, then
    advanced with 85cf212's version of both files, and horizon/hz-124 branched
    off the same base with ce379a3's."""
    origin = tmp_path / "hz124-origin.git"
    subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(origin)], check=True)
    seed = tmp_path / "hz124-seed"
    subprocess.run(["git", "init", "--quiet", "-b", "main", str(seed)], check=True)
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")

    def write(side):
        for name, path in HZ124_FILES.items():
            target = seed / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(hz124_blob(name, side))

    for side, message in (("base", "merge base"), ("theirs", "main advances")):
        if side == "theirs":
            git(seed, "checkout", "-b", "horizon/hz-124")
            write("ours")
            git(seed, "add", "-A")
            git(seed, "commit", "-m", "the PR branch")
            git(seed, "checkout", "main")
        write(side)
        git(seed, "add", "-A")
        git(seed, "commit", "-m", message)
    git(seed, "push", "--quiet", str(origin), "main", "horizon/hz-124")
    subprocess.run(["git", "-C", str(origin), "symbolic-ref", "HEAD", "refs/heads/main"], check=True)

    hub = workspaces.hub_path("FinTekkers/horizon")
    hub.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", str(origin), str(hub)], check=True, capture_output=True)
    git(hub, "config", "user.email", "farm@example.com")
    git(hub, "config", "user.name", "Horizon Farm")
    return origin

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


def test_the_vendored_blobs_still_match_the_commits_the_metric_names():
    """Freshness check on the fixture, not on the resolver.

    The replay below runs off vendored copies so it works in a fresh or
    shallow clone, where ce379a3 (a PR-branch commit, unreachable from main)
    is simply absent. When the real commits ARE here, an edited fixture must
    fail loudly rather than quietly replay something the metric never named.
    """
    for sha in (HZ124_BASE_SHA, HZ124_OURS_SHA, HZ124_THEIRS_SHA):
        if subprocess.run(
            ["git", "-C", str(REPO_ROOT), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True
        ).returncode:
            pytest.skip(f"{sha} is not in this checkout — the vendored copies are what the replay uses")

    for name, path in HZ124_FILES.items():
        for side, sha in (("base", HZ124_BASE_SHA), ("ours", HZ124_OURS_SHA), ("theirs", HZ124_THEIRS_SHA)):
            from_git = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "show", f"{sha}:{path}"], capture_output=True, text=True, check=True
            ).stdout
            assert hz124_blob(name, side) == from_git, f"{name}.{side}.txt no longer matches {sha}:{path}"


def test_the_real_hz124_conflict_replays_through_the_scoped_path(isolated_workspaces_dir, monkeypatch):
    """The named replay from the success metric: ce379a3 merged with
    origin/main at 85cf212, whose two conflicting import hunks cost HZ-124 a
    full implement cycle and a re-review of its whole 3,000-line diff.

    Real files, real git, whole contents — not a miniature. The three sides
    come from farm/tests/fixtures/hz124/, vendored off those commits (see the
    freshness check above) so this runs in CI and in a fresh clone, where
    ce379a3 is unreachable and the commits themselves are not present.
    """
    tmp_path = isolated_workspaces_dir
    origin = build_hz124_origin(tmp_path)
    agents = install(monkeypatch, FakeAgents(review=PASSING_REVIEW))

    result = conflict_resolver.resolve("FinTekkers/horizon", "HZ-124", log=lambda *_: None)

    assert result["resolved"] is True, result
    assert result["mode"] == "scoped"
    # Metric 1: deterministic, so no resolution agent and no attempt of the
    # implement step — and the item is pushed, not sent back.
    assert result["resolution"]["strategy"] == "deterministic"
    assert result["resolution"]["paths"] == ["farm/providers/claude.py", "farm/providers/muse.py"]
    assert result["resolution"]["hunks"] == 2
    assert agents.of("resolution") == []

    for name, path in HZ124_FILES.items():
        merged = clone_and_read(tmp_path, origin, "horizon/hz-124", path, f"real-{name}")
        assert "from ..credentials import without_gate_credentials\n" in merged  # main's added import
        assert "decode_partial_output" in merged  # the PR's own change
        assert "<<<<<<<" not in merged
        # The conflict is confined to the import block, so everything below it
        # is still the PR's own body, byte-for-byte.
        assert merged.endswith(hz124_blob(name, "ours")[-500:])

    # Metric 2's integration half: the review saw the conflicted hunks and the
    # delta — not the rest of either file, and not main's own changes.
    prompt = agents.of("review")[0]["prompt"]
    assert "SUPPORTS_RESUME" not in prompt
    assert "def run_agent" not in prompt


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


def raises(exc):
    """A handler that blows up the way a real dispatch does — a timeout, a
    provider outage, an exhausted account."""

    def handler(_ws):
        raise exc

    return handler


def test_a_resolution_agent_that_errors_out_escalates_as_unsure(isolated_workspaces_dir, monkeypatch):
    """A timed-out or crashed dispatch is not "resolved" — it is the same
    "could not be sure" outcome as the agent saying so itself, and it must
    escalate rather than propagate out of the farmd route as a 500."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents(resolution=raises(agent_runner.AgentError("agent timed out after 600s"))))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-30")

    result = conflict_resolver.resolve("acme/demo", "HZ-30", log=lambda *_: None)

    assert result["reason"] == "resolution_unsure"
    assert "agent timed out after 600s" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-30", branch_sha)


def test_an_unparseable_resolution_reply_escalates_as_unsure(isolated_workspaces_dir, monkeypatch):
    """Prose where a verdict object belongs. The file on disk may even look
    resolved — without a parseable "resolved": true this path still refuses."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (both)\n", reply="I merged them, looks good to me!")),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-31")

    result = conflict_resolver.resolve("acme/demo", "HZ-31", log=lambda *_: None)

    assert result["reason"] == "resolution_unsure"
    assert_nothing_pushed_and_clean(origin, "HZ-31", branch_sha)


def test_a_scoped_review_that_errors_out_counts_as_a_reject(isolated_workspaces_dir, monkeypatch):
    """Fail closed on the review side too: no verdict is a reject, whether the
    reply was prose or the dispatch never produced one at all."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (both)\n"),
            review=raises(agent_runner.AgentError("review agent timed out after 480s")),
        ),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-32")

    result = conflict_resolver.resolve("acme/demo", "HZ-32", log=lambda *_: None)

    assert [c["kind"] for c in agents.calls] == ["resolution", "review"]
    assert result["reason"] == "scoped_review_rejected"
    assert "review agent timed out after 480s" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-32", branch_sha)


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


def test_a_detected_check_runner_that_is_missing_on_this_host_escalates(isolated_workspaces_dir, monkeypatch):
    """The subtler half of "no green, no push": commands ARE detected, but
    every one of their binaries is absent, so nothing actually ran. Today's
    callers accept that as "skipped"; this path must not, or a host with a
    broken toolchain would silently push every resolution unverified."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    branch_sha = additive_conflict(tmp_path, origin, "HZ-33")
    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")

    class NoRunners:
        TimeoutExpired = subprocess.TimeoutExpired
        PIPE = subprocess.PIPE

        @staticmethod
        def Popen(cmd, **_kwargs):
            raise FileNotFoundError(cmd[0])

    # The checks module's own reference only: conflict_resolver's git plumbing
    # goes through the same stdlib function, and a global patch would break the
    # merge instead of the check this test is aimed at.
    monkeypatch.setattr(checks, "subprocess", NoRunners)

    result = conflict_resolver.resolve("acme/demo", "HZ-33", log=lambda *_: None)

    assert result["reason"] == "scoped_checks_failed"
    assert "every detected check runner is missing" in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-33", branch_sha)


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


def test_an_undeclared_reason_is_reported_as_the_generic_one_and_still_cleans_up(monkeypatch):
    """The other half of the parity guard. A reason with no message on the Node
    side would surface to the human as a raw detail string; a typo must degrade
    to the generic message and say so in the log — never crash the escalation,
    and never skip the cleanup that hands the next cycle a clean worktree."""
    calls, logged = [], []
    monkeypatch.setattr(conflict_resolver, "git", lambda ws, *args, **kw: calls.append(args))

    result = conflict_resolver._escalate(Path("/nowhere"), "abc1234", "reason_i_mistyped", "why", logged.append)

    assert result == {"resolved": False, "reason": "merge_conflict", "detail": "reason_i_mistyped: why"}
    assert any("BUG" in line for line in logged)
    assert [a[0] for a in calls] == ["merge", "reset", "clean"]


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


# ---- HZ-157: conflict_resolver is a caller of the shared reply parser too ----
# Both of its agent replies go through agent_runner.parse_agent_reply, so both
# can be byte-repaired — and a repair with no note in the run output is the
# exact HZ-124 attempt-9 failure mode this item forbids. Every branch that
# consumes a parsed reply is covered below, including the ORDINARY ones:
# `resolved: false` and a rejecting review are normal outcomes, not edge cases,
# and they were where the note first went missing.

# The same two replies as above with one trailing comma added — the shape the
# unambiguous rung repairs without spending an agent run. conflict_resolver
# passes no `retry` callable, so this is the only shape it can ever repair; a
# single-quoted reply raises there and escalates, which is correct.
REPAIRED_RESOLUTION = '{"resolved": true, "summary": "kept both sides",}'
REPAIRED_UNSURE = '{"resolved": false, "unsure_reason": "both sides rewrote the guard",}'
REPAIRED_REVIEW = '{"summary": "kept both imports", "verdict": "pass", "findings": [],}'
REPAIRED_FAILING_REVIEW = (
    '{"summary": "one side was dropped", "verdict": "fail", "findings": '
    '[{"file": "a", "line": 1, "severity": "block", "detail": "lost the PR\'s own import"}],}'
)


# The counter is repointed into tmp_path for every test in the suite by the
# autouse `repair_counter` fixture in farm/tests/conftest.py, so the count
# assertions below read this test's own ticks. Tests still name the fixture
# where they assert on counts, so the dependency is visible in the signature.


def test_a_repaired_resolution_reply_is_pushed_with_its_parser_note(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """The success path, which is where the note was dropped hardest: this
    branch discards the resolution agent's `detail` entirely and reports its
    own summary, so a note that only rode in `detail` would vanish on every
    resolution that actually worked."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (branch and main)\n", reply=REPAIRED_RESOLUTION),
            review=PASSING_REVIEW,
        ),
    )
    same_line_conflict(tmp_path, origin, "HZ-30")

    result = conflict_resolver.resolve("acme/demo", "HZ-30", log=lambda *_: None)

    assert result["resolved"] is True
    assert TRAILING_COMMA_NOTE in result["summary"], "a repaired reply was accepted silently"
    assert agent_runner.repair_counts() == {"trailing_comma": 1}
    # The resolution itself is unaffected — a repair recovers the reply, it does
    # not change what the agent asked for.
    assert clone_and_read(tmp_path, origin, "horizon/hz-30", "shared.txt", "repaired") == (
        "line1\nline2 (branch and main)\nline3\n"
    )


def test_a_repaired_unsure_reply_escalates_with_its_parser_note(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """`resolved: false` is an ordinary outcome, not an edge case — and it is
    the branch the code review caught dropping the note."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents(resolution=lambda ws: REPAIRED_UNSURE))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-31")

    result = conflict_resolver.resolve("acme/demo", "HZ-31", log=lambda *_: None)

    assert result["reason"] == "resolution_unsure"
    assert "both sides rewrote the guard" in result["detail"]
    assert TRAILING_COMMA_NOTE in result["detail"], "a repaired reply escalated silently"
    assert agent_runner.repair_counts() == {"trailing_comma": 1}
    assert_nothing_pushed_and_clean(origin, "HZ-31", branch_sha)


def test_a_repaired_scoped_review_reply_carries_its_parser_note(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (both)\n"), review=REPAIRED_REVIEW),
    )
    same_line_conflict(tmp_path, origin, "HZ-32")

    result = conflict_resolver.resolve("acme/demo", "HZ-32", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["review"]["verdict"] == "pass"
    assert TRAILING_COMMA_NOTE in result["review"]["summary"]
    assert agent_runner.repair_counts() == {"trailing_comma": 1}


def test_a_repaired_rejecting_review_escalates_with_its_parser_note(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """A reject carries BOTH facts: why it was rejected, and that the reply
    had to be repaired to be read at all."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (a guess)\n"), review=REPAIRED_FAILING_REVIEW
        ),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-33")

    result = conflict_resolver.resolve("acme/demo", "HZ-33", log=lambda *_: None)

    assert result["reason"] == "scoped_review_rejected"
    assert "lost the PR's own import" in result["detail"]
    assert TRAILING_COMMA_NOTE in result["detail"]
    assert_nothing_pushed_and_clean(origin, "HZ-33", branch_sha)


def test_both_repairable_replies_in_one_run_are_both_reported(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """Two call sites, two repairs, two surfaces — neither note is lost to the
    other, and the counter sees both."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (both)\n", reply=REPAIRED_RESOLUTION),
            review=REPAIRED_REVIEW,
        ),
    )
    same_line_conflict(tmp_path, origin, "HZ-34")

    result = conflict_resolver.resolve("acme/demo", "HZ-34", log=lambda *_: None)

    assert result["resolved"] is True
    assert TRAILING_COMMA_NOTE in result["summary"]
    assert TRAILING_COMMA_NOTE in result["review"]["summary"]
    assert agent_runner.repair_counts() == {"trailing_comma": 2}


def test_a_clean_run_reports_no_parser_note_anywhere(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """The other direction of the guardrail, and the control for every
    assertion above: no byte change means no note, so these tests cannot be
    passing on a note this module stamps unconditionally."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (both)\n"), review=PASSING_REVIEW),
    )
    same_line_conflict(tmp_path, origin, "HZ-35")

    result = conflict_resolver.resolve("acme/demo", "HZ-35", log=lambda *_: None)

    assert result["resolved"] is True
    assert "parser notes" not in result["summary"]
    assert "parser notes" not in result["review"]["summary"]
    assert agent_runner.repair_counts() == {}


def test_the_deterministic_path_parses_no_reply_and_reports_no_note(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """Stage zero dispatches no agent, so there is no reply to repair and
    nothing to report — the empty-notes default is not an accident of the
    agent branch leaking into it."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents())
    additive_conflict(tmp_path, origin, "HZ-36")

    result = conflict_resolver.resolve("acme/demo", "HZ-36", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["resolution"]["strategy"] == "deterministic"
    assert "parser notes" not in result["summary"]
    assert agent_runner.repair_counts() == {}


@pytest.mark.parametrize(
    "runner,surface",
    [
        pytest.param(
            lambda ws, files, delta, log: conflict_resolver._run_resolution_agent(ws, files, log),
            # `notes`, not `detail`: _run_resolution_agent returns a RAW detail
            # and _escalate() is what stamps the note onto it, for every branch
            # alike. That the stamp then reaches the run output is proved
            # through resolve() above.
            "notes",
            id="resolution",
        ),
        pytest.param(conflict_resolver._run_scoped_review, "summary", id="review"),
    ],
)
def test_a_reply_that_parses_to_a_non_object_still_reports_its_note(monkeypatch, runner, surface):
    """The no-verdict-object / not-a-dict branches, driven at the function
    rather than through resolve().

    Deliberate: no byte sequence reaches these branches through a repair today,
    because a rung only ever edits the reply's `{`…`}` span and a span that
    parses yields a dict. The branch still has to carry the note — part 3 adds
    rungs that can produce other shapes, and "unreachable so untested" is how
    this hole got in on the `resolved: false` branch in the first place.
    """
    monkeypatch.setattr(
        agent_runner, "parse_agent_reply", lambda text: ([1, 2], [TRAILING_COMMA_NOTE])
    )
    monkeypatch.setattr(agent_runner, "run_agent", lambda *a, **kw: {"result": "whatever"})
    empty_delta = conflict_hunks.Delta(novel=(), dropped=())

    result = runner(Path("/nowhere"), [], empty_delta, lambda *_: None)

    assert TRAILING_COMMA_NOTE in result[surface], "a non-object reply was repaired silently"


# ---- every escalation AFTER a parsed reply reports that reply's repair ----
# The first cut of this item stamped the note on three branches of eleven. The
# eight that dropped it escalate for reasons the reply itself had nothing to do
# with — the checks went red, a marker was left behind, the branch moved — and
# that is exactly what made them easy to miss: the detail string reads complete
# without the note. The counter had already recorded a repair, so no surface
# said which reply it happened to.


def out_of_scope_resolution(reply):
    """Resolves the markers and then wanders into another file — the stray-path
    escalation, which never looks at the agent's own `detail`."""

    resolve = resolve_markers("line2 (both)\n", reply=reply)

    def agent(ws):
        resolve(ws)
        (ws / "other.txt").write_text("while I was here I fixed this too\n")
        return reply

    return agent


POST_RESOLUTION_ESCALATIONS = [
    pytest.param(
        "scoped_checks_failed",
        lambda mp: mp.setenv("FARM_CHECK_CMD", "exit 1"),
        lambda reply: resolve_markers("line2 (both)\n", reply=reply),
        None,
        id="scoped_checks_failed",
    ),
    pytest.param(
        "resolution_out_of_scope",
        None,
        out_of_scope_resolution,
        lambda w: (w / "other.txt").write_text("untouched\n"),
        id="resolution_out_of_scope",
    ),
    pytest.param(
        # Claims success while leaving the marked region exactly as it found it.
        "markers_remaining",
        None,
        lambda reply: (lambda ws: reply),
        None,
        id="markers_remaining",
    ),
]


@pytest.mark.parametrize("reason,prepare,resolution,extra_ours", POST_RESOLUTION_ESCALATIONS)
def test_an_escalation_after_a_repaired_resolution_reply_still_reports_the_repair(
    isolated_workspaces_dir, monkeypatch, repair_counter, reason, prepare, resolution, extra_ours
):
    """The gate action's run output has to name the repair even when the reason
    it escalated for is unrelated to the reply.

    The counter is the tell: it ticks on every one of these, so a detail with no
    note means the totals record a repair that no surface can be traced back to.
    """
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents(resolution=resolution(REPAIRED_RESOLUTION), review=PASSING_REVIEW))
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-40", extra_ours=extra_ours)
    if prepare:
        prepare(monkeypatch)

    result = conflict_resolver.resolve("acme/demo", "HZ-40", log=lambda *_: None)

    assert result["reason"] == reason
    assert agent_runner.repair_counts() == {"trailing_comma": 1}
    assert TRAILING_COMMA_NOTE in result["detail"], "a repaired reply escalated silently"
    assert_nothing_pushed_and_clean(origin, "HZ-40", branch_sha)


def test_a_repaired_resolution_rejected_by_the_review_reports_both_repairs(
    isolated_workspaces_dir, monkeypatch, repair_counter
):
    """Two replies repaired, one escalation detail. Both groups survive WHOLE,
    and they are labelled apart so the detail does not read as one note printed
    twice.

    The review summary runs to the cap on purpose: the detail then has to be
    cut to fit both groups, and a cut that lands in the review's note would
    still leave two "parser notes" headings — so the note text itself is
    counted, not the heading."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    long_summary = "one side was dropped " + "x" * (conflict_resolver.DETAIL_LIMIT - 30)
    long_failing_review = REPAIRED_FAILING_REVIEW.replace("one side was dropped", long_summary)
    install(
        monkeypatch,
        FakeAgents(
            resolution=resolve_markers("line2 (a guess)\n", reply=REPAIRED_RESOLUTION),
            review=long_failing_review,
        ),
    )
    branch_sha = same_line_conflict(tmp_path, origin, "HZ-41")
    logged: list[str] = []

    result = conflict_resolver.resolve("acme/demo", "HZ-41", log=logged.append)

    assert result["reason"] == "scoped_review_rejected"
    assert agent_runner.repair_counts() == {"trailing_comma": 2}
    assert result["detail"].startswith("one side was dropped")
    assert len(result["detail"]) <= conflict_resolver.DETAIL_LIMIT
    assert conflict_resolver.RESOLUTION_NOTE_LABEL in result["detail"]
    assert result["detail"].count(TRAILING_COMMA_NOTE) == 2, "a repaired reply's note was cut by the cap"
    # Each reply's repair also has an unsliced log line of its own.
    assert any("scoped review reply was repaired" in line and TRAILING_COMMA_NOTE in line for line in logged)
    assert any("resolution reply was repaired" in line and TRAILING_COMMA_NOTE in line for line in logged)
    assert_nothing_pushed_and_clean(origin, "HZ-41", branch_sha)


def test_the_repair_also_gets_a_log_line_of_its_own(isolated_workspaces_dir, monkeypatch, repair_counter):
    """The escalation log line is sliced to 200 chars. A note that only rode
    inside it would be the first thing a long detail dropped, so the notes get
    their own unsliced line."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    install(monkeypatch, FakeAgents(resolution=lambda ws: REPAIRED_UNSURE))
    same_line_conflict(tmp_path, origin, "HZ-42")
    logged: list[str] = []

    conflict_resolver.resolve("acme/demo", "HZ-42", log=logged.append)

    assert any(TRAILING_COMMA_NOTE in line and "escalating" not in line for line in logged)


def test_every_escalation_in_the_scoped_path_passes_its_notes():
    """Structural, because per-branch review is what missed eight of them.

    _scoped_resolve() declares `resolution_notes` before its first escalation
    precisely so this rule has no exemptions: a new escalation added without
    `notes=` fails here rather than quietly joining the eight. resolve()'s own
    mechanical-path escalation is out of scope — no reply is ever parsed on it.
    """
    import ast

    source = Path(conflict_resolver.__file__).read_text()
    scoped = next(
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.FunctionDef) and node.name == "_scoped_resolve"
    )
    calls = [
        node
        for node in ast.walk(scoped)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_escalate"
    ]
    assert len(calls) >= 11, "the scoped path's escalations are not all going through _escalate()"
    missing = [call.lineno for call in calls if "notes" not in {kw.arg for kw in call.keywords}]
    assert missing == [], f"_escalate() called without notes= at line(s) {missing}"


def test_an_escalation_with_no_notes_is_byte_identical_to_before(monkeypatch):
    """The control: the notes channel adds nothing to a run that repaired
    nothing, so the assertions above cannot be passing on an unconditional
    stamp."""
    calls, logged = [], []
    monkeypatch.setattr(conflict_resolver, "git", lambda ws, *args, **kw: calls.append(args))

    result = conflict_resolver._escalate(
        Path("/nowhere"), "abc1234", "markers_remaining", "a marker was left behind", logged.append, notes=[]
    )

    assert result == {
        "resolved": False,
        "reason": "markers_remaining",
        "detail": "a marker was left behind",
    }
    assert not any("parser notes" in line for line in logged)
    assert [a[0] for a in calls] == ["merge", "reset", "clean"]


def test_a_pathological_note_is_kept_at_the_cost_of_the_detail(monkeypatch):
    """The reserve-room rule, at the one place it bites: a detail already at the
    cap must lose its tail rather than the note. The note is the fact nothing
    else in the system records."""
    monkeypatch.setattr(conflict_resolver, "git", lambda ws, *args, **kw: None)

    result = conflict_resolver._escalate(
        Path("/nowhere"),
        "abc1234",
        "scoped_checks_failed",
        "x" * conflict_resolver.DETAIL_LIMIT,
        lambda *_: None,
        notes=[TRAILING_COMMA_NOTE],
    )

    assert len(result["detail"]) == conflict_resolver.DETAIL_LIMIT
    assert result["detail"].endswith(f"{TRAILING_COMMA_NOTE})")


# ---- conflict models (HZ-192) ----
# Both conflict calls run as models.conflictAgent under the reserved step key
# "conflict". These keep the REAL run_agent() — its provider lock and model
# resolution — and fake only the provider underneath it.


def install_providers(monkeypatch, agents):
    import types

    def provider(name):
        def run(prompt, **kwargs):
            return {**agents(prompt, provider_name=name, **kwargs), "session_id": "s"}

        return types.SimpleNamespace(SUPPORTS_RESUME=True, assert_subscription_auth=lambda: None, run=run)

    for name in ("claude", "muse"):
        monkeypatch.setitem(agent_runner._PROVIDERS, name, provider(name))
    return agents


def test_both_conflict_call_sites_hand_the_conflict_model_to_claude(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    agents = install_providers(
        monkeypatch,
        FakeAgents(resolution=resolve_markers("line2 (branch and main)\n"), review=PASSING_REVIEW),
    )
    same_line_conflict(tmp_path, origin, "HZ-192")
    monkeypatch.delenv("FARM_PROVIDER", raising=False)

    conflict_resolver.resolve("acme/demo", "HZ-192", log=lambda *_: None)

    resolution, review = agents.of("resolution"), agents.of("review")
    assert [(c["provider_name"], c["model"]) for c in resolution] == [("claude", "claude-opus-5-5")], (
        "conflict_resolver._run_resolution_agent: run_agent call"
    )
    assert [(c["provider_name"], c["model"]) for c in review] == [("claude", "claude-opus-5-5")], (
        "conflict_resolver._run_scoped_review: run_agent call"
    )


@pytest.mark.parametrize("override", [None, "claude-test-emergency"])
def test_the_unlocked_scoped_review_sends_muse_no_model(tmp_path, monkeypatch, override):
    """The resolution agent is provider-locked, so FARM_PROVIDER=muse never
    reaches it; the scoped review is not locked, so it does reach Muse — and
    must arrive with no model, emergency override or not."""
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", override)
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    monkeypatch.setattr(conflict_resolver, "_review_prompt", lambda files, delta: "review this")
    agents = install_providers(monkeypatch, FakeAgents(review=PASSING_REVIEW))

    result = conflict_resolver._run_scoped_review(tmp_path, [], "", lambda *_: None)

    assert result["verdict"] == "pass"
    assert [(c["provider_name"], c["model"]) for c in agents.of("review")] == [("muse", None)]


def test_the_locked_resolution_agent_is_never_dispatched_to_muse(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    monkeypatch.setattr(conflict_resolver, "_resolution_prompt", lambda files: "resolve this")
    agents = install_providers(monkeypatch, FakeAgents())  # any dispatch would raise

    result = conflict_resolver._run_resolution_agent(tmp_path, [], lambda *_: None)

    assert result["resolved"] is False and "provider-locked" in result["detail"]
    assert agents.calls == []
