"""HZ-92: deterministic merge-conflict resolution.

Mirrors test_workspaces.py's local-bare-repo fixture (a real git remote, no
GitHub) so conflict_resolver.resolve() runs against real git merge/conflict
mechanics rather than mocks.
"""

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


@pytest.fixture
def isolated_workspaces_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    return tmp_path


# ---- the mechanical happy path ----


def test_clean_non_overlapping_merge_resolves_and_pushes(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    push_new_branch(tmp_path, origin, "horizon/hz-1", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-1", log=lambda *_: None)

    assert result["resolved"] is True
    assert set(result) == {"resolved", "files", "summary"}
    assert result["files"]  # non-empty diffstat
    assert result["summary"]
    merged = clone_and_read(tmp_path, origin, "horizon/hz-1", "shared.txt", "after")
    assert "branch edit" in merged
    assert (tmp_path / "read-after" / "other.txt").exists()  # main's independent change is present too


def test_never_dispatches_an_agent_for_the_mechanical_path(isolated_workspaces_dir, monkeypatch):
    """Behavioral proxy for the wall-clock success metric (not a source-text
    grep, which a rename or indirection would defeat silently): patch the
    one function any agent dispatch must go through to raise if called, then
    run a real mechanical resolution end to end and confirm it never fires."""

    def boom(*_a, **_k):
        raise AssertionError("conflict_resolver must never dispatch an agent")

    monkeypatch.setattr(agent_runner, "run_agent", boom)
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    push_new_branch(tmp_path, origin, "horizon/hz-1", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-1", log=lambda *_: None)

    assert result["resolved"] is True


def test_never_uses_ours_theirs_or_force_push():
    """Guardrail, enforced structurally: a clean merge is a fast-forward of
    the branch's own previous tip, so a plain push is always correct — using
    --ours/--theirs or a forced push would silently discard one side. Checks
    only actual git argument literals, not the module's prose docstring
    (which names them to explain why they're avoided)."""
    lines = [line for line in Path(conflict_resolver.__file__).read_text().splitlines() if "git(ws" in line]
    assert lines, "expected at least one git(ws, ...) call site to scan"
    joined = "\n".join(lines)
    assert "--ours" not in joined
    assert "--theirs" not in joined
    assert "--force" not in joined


# ---- escalation: real, incompatible conflicts ----


def test_incompatible_same_line_edits_escalate_and_leave_worktree_clean(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    branch_sha = push_new_branch(
        tmp_path, origin, "horizon/hz-2", lambda w: (w / "shared.txt").write_text("line1\nline2 (branch)\nline3\n"), "branch"
    )
    push_new_branch(
        tmp_path, origin, "main", lambda w: (w / "shared.txt").write_text("line1\nline2 (main)\nline3\n"), "main-advance"
    )

    result = conflict_resolver.resolve("acme/demo", "HZ-2", log=lambda *_: None)

    assert result["resolved"] is False
    assert result["reason"] == "merge_conflict"
    assert "shared.txt" in result["detail"]

    # Escalation must not leave anything pushed, and the item's own worktree
    # must be clean — the next attempt (a full implement cycle) cannot be
    # handed a dirty tree.
    assert origin_branch_sha(origin, "horizon/hz-2") == branch_sha
    ws = workspaces.workspace_path("acme/demo", "HZ-2")
    status = git(ws, "status", "--porcelain").stdout
    assert status == ""


def test_branch_missing_is_reported_not_raised(isolated_workspaces_dir):
    tmp_path = isolated_workspaces_dir
    make_repo_hub(tmp_path)

    result = conflict_resolver.resolve("acme/demo", "HZ-9", log=lambda *_: None)

    assert result == {"resolved": False, "reason": "branch_missing", "detail": "origin/horizon/hz-9 not found"}


# ---- escalation: gates on the suite, not on marker absence (metric 3) ----


def test_clean_merge_with_no_conflict_markers_but_failing_tests_still_escalates(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)

    branch_sha = push_new_branch(
        tmp_path, origin, "horizon/hz-3", lambda w: (w / "shared.txt").write_text("line1 (branch)\nline2\nline3\n"), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    # Forces run_checks() to fail regardless of repo contents — the merge
    # itself is clean (no conflict, no marker), only the suite is red.
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    result = conflict_resolver.resolve("acme/demo", "HZ-3", log=lambda *_: None)

    assert result["resolved"] is False
    assert result["reason"] == "tests_failed"

    ws = workspaces.workspace_path("acme/demo", "HZ-3")
    # No conflict markers anywhere — proves the escalation came from the test
    # gate, not from marker detection.
    for f in ws.rglob("*.txt"):
        assert "<<<<<<<" not in f.read_text()
    assert git(ws, "status", "--porcelain").stdout == ""
    assert origin_branch_sha(origin, "horizon/hz-3") == branch_sha  # nothing pushed


def test_a_file_containing_marker_shaped_text_is_not_mistaken_for_a_conflict(isolated_workspaces_dir, monkeypatch):
    """Detection must come from git's own unmerged-path state, never a text
    search — a file whose legitimate content looks like a conflict marker
    (e.g. a doc about git, or a diff fixture) must not trigger escalation."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    push_new_branch(
        tmp_path,
        origin,
        "horizon/hz-4",
        lambda w: (w / "docs.md").write_text("Conflict markers look like:\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n"),
        "branch",
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-4", log=lambda *_: None)

    assert result["resolved"] is True
