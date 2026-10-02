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


def test_never_uses_ours_theirs_or_a_bare_force_push():
    """Guardrail, enforced structurally: resolving a conflict by taking
    --ours/--theirs would silently discard one side, and a bare forced push
    would overwrite a commit this run did not create. Checks only actual git
    argument literals, not the module's prose docstring (which names them to
    explain why they're avoided).

    HZ-154 narrowed the force rule rather than dropping it: the scoped path
    pushes a merge commit it built itself, so it uses --force-with-lease=<ref>:
    <the exact head it resolved>. Every --force literal must be part of that
    form — a bare --force added later fails here immediately, everywhere."""
    lines = [line for line in Path(conflict_resolver.__file__).read_text().splitlines() if "git(ws" in line]
    assert lines, "expected at least one git(ws, ...) call site to scan"
    joined = "\n".join(lines)
    assert "--ours" not in joined
    assert "--theirs" not in joined
    for line in lines:
        for fragment in line.split("--force")[1:]:
            assert fragment.startswith("-with-lease="), f"bare --force in a git call site: {line.strip()}"


def test_the_mechanical_path_pushes_with_no_force_flag_at_all(isolated_workspaces_dir, monkeypatch):
    """The behavioral half of the guardrail above: a text scan breaks silently
    on a rename, so record the real argv and assert on the push itself."""
    calls = []
    real_git = conflict_resolver.git

    def recording_git(ws, *args, **kwargs):
        calls.append(args)
        return real_git(ws, *args, **kwargs)

    monkeypatch.setattr(conflict_resolver, "git", recording_git)
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)

    push_new_branch(tmp_path, origin, "horizon/hz-1", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    assert conflict_resolver.resolve("acme/demo", "HZ-1", log=lambda *_: None)["resolved"] is True

    pushes = [args for args in calls if args and args[0] == "push"]
    assert pushes == [("push", "origin", "horizon/hz-1")]


# ---- escalation: real, incompatible conflicts ----


def test_incompatible_same_line_edits_escalate_and_leave_worktree_clean(isolated_workspaces_dir, monkeypatch):
    """HZ-92's behaviour, pinned with HZ-154's scoped path switched off — this
    is also the rollback proof: FARM_CONFLICT_SCOPED_ENABLED=0 restores the
    mechanical-only escalation exactly, with no code change. The same fixture
    going down the scoped path lives in test_conflict_scoped.py."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.setenv("FARM_CONFLICT_SCOPED_ENABLED", "0")

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


# ---- HZ-144: post-merge checks take a check slot, labelled as their own ----


def test_post_merge_checks_take_a_labelled_check_slot(isolated_workspaces_dir, monkeypatch):
    """conflict_resolver is a SECOND run_checks() caller, and it runs in
    farmd's own process rather than an agent session — so the real concurrent
    check population is agents plus farmd.

    Decided explicitly rather than left silent: it takes a slot, because it
    runs the same repo suite on the same 2 vCPUs as an agent's checks and
    exempting it would make the effective limit "the configured number plus
    one". It is labelled `conflict_resolver` so the measurement can keep it
    out of the 20-agent-run count (see
    farm/tools/report_check_metrics.py::summarise).
    """
    from farm import check_metrics, check_slots

    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    monkeypatch.setenv("FARM_CHECK_CMD", "true")

    push_new_branch(
        tmp_path, origin, "horizon/hz-7", lambda w: (w / "a.txt").write_text("branch\n"), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "b.txt").write_text("main\n"), "main-advance")

    assert conflict_resolver.resolve("acme/demo", "HZ-7", log=lambda *_: None)["resolved"] is True

    records, skipped = check_metrics.read_records(check_metrics.metrics_path())
    assert skipped == 0 and len(records) == 1
    assert records[0]["caller"] == "conflict_resolver"
    assert records[0]["item_id"] == "HZ-7"
    assert records[0]["slot_mode"] == "held"
    assert records[0]["outcome"] == "pass"
    # Released on the way out: the next resolve (or agent run) is not blocked.
    assert check_slots.busy_slots() == 0


def test_the_mechanical_path_runs_the_repos_configured_check_commands(isolated_workspaces_dir, monkeypatch):
    """HZ-245: a configured (red) command judges the merge, so it escalates
    in a repo where auto-detection would have found nothing to run."""
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    branch_sha = push_new_branch(
        tmp_path, origin, "horizon/hz-9", lambda w: (w / "a.txt").write_text("branch\n"), "branch"
    )
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "b.txt").write_text("main\n"), "main-advance")

    result = conflict_resolver.resolve(
        "acme/demo", "HZ-9", log=lambda *_: None, configured={"lint": "echo configured-lint-ran; exit 3"}
    )

    assert result["resolved"] is False and result["reason"] == "tests_failed"
    assert "configured-lint-ran" in result["detail"]
    assert origin_branch_sha(origin, "horizon/hz-9") == branch_sha


# ---- HZ-257: a resolution pushed behind green checks names that exact sha ----


def test_the_mechanical_path_reports_the_pushed_sha_its_checks_passed_on(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    push_new_branch(tmp_path, origin, "horizon/hz-7", lambda w: (w / "shared.txt").write_text("line1 (branch edit)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-7", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["checks_passed_sha"] == origin_branch_sha(origin, "horizon/hz-7")
    assert result["checks_finished_at"]


def test_the_scoped_path_reports_the_pushed_sha_its_checks_passed_on(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.delenv("FARM_CONFLICT_SCOPED_ENABLED", raising=False)
    push_new_branch(tmp_path, origin, "horizon/hz-8", lambda w: (w / "shared.txt").write_text("line1\nline2\nours-added\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "shared.txt").write_text("line1\nline2\ntheirs-added\nline3\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-8", log=lambda *_: None)

    assert result["resolved"] is True
    assert result["mode"] == "scoped"
    assert result["checks_passed_sha"] == origin_branch_sha(origin, "horizon/hz-8")
    assert result["checks_finished_at"]


def test_failing_checks_report_no_sha(isolated_workspaces_dir, monkeypatch):
    tmp_path = isolated_workspaces_dir
    _hub, origin = make_repo_hub(tmp_path)
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")
    push_new_branch(tmp_path, origin, "horizon/hz-9", lambda w: (w / "shared.txt").write_text("line1 (branch)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", lambda w: (w / "other.txt").write_text("new on main\n"), "main-advance")

    result = conflict_resolver.resolve("acme/demo", "HZ-9", log=lambda *_: None)

    assert result["resolved"] is False
    assert "checks_passed_sha" not in result
    assert "checks_finished_at" not in result
