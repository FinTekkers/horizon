"""HZ-257: farm/check_record.py names the exact commit a passing check run
tested — or nothing, on any doubt. Real git in a temp repo, no mocks except
where a git failure or timeout is the point."""

import subprocess

import pytest

from farm import check_record
from farm.checks import CHECKS_WAIVERS, run_checks


def git(ws, *args):
    return subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def repo(tmp_path):
    ws = tmp_path / "repo"
    ws.mkdir()
    git(ws, "init", "-q", "-b", "main")
    git(ws, "config", "user.email", "t@example.com")
    git(ws, "config", "user.name", "T")
    (ws / ".gitignore").write_text("ignored/\n")
    (ws / "a.txt").write_text("one\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-qm", "initial")
    return ws


def commit_all(ws):
    git(ws, "add", "-A")
    git(ws, "commit", "-qm", "work")
    return git(ws, "rev-parse", "HEAD").strip()


def quiet(*_):
    pass


def test_the_commit_of_exactly_the_snapshot_tree_is_the_passed_sha(repo):
    (repo / "a.txt").write_text("two\n")
    (repo / "new.txt").write_text("added\n")
    (repo / "ignored").mkdir()
    (repo / "ignored" / "build.out").write_text("artifact\n")  # ignored: not part of the tree either way
    tree = check_record.snapshot_tree(repo, quiet)
    sha = commit_all(repo)
    assert check_record.passed_sha(repo, tree, quiet) == sha


def test_a_tracked_edit_after_the_snapshot_reports_nothing(repo):
    (repo / "a.txt").write_text("two\n")
    tree = check_record.snapshot_tree(repo, quiet)
    (repo / "a.txt").write_text("rewritten by a formatter during the checks\n")
    commit_all(repo)
    assert check_record.passed_sha(repo, tree, quiet) is None


def test_a_new_untracked_file_after_the_snapshot_reports_nothing(repo):
    (repo / "a.txt").write_text("two\n")
    tree = check_record.snapshot_tree(repo, quiet)
    (repo / "left-behind.log").write_text("a check wrote this\n")
    commit_all(repo)
    assert check_record.passed_sha(repo, tree, quiet) is None


def test_the_snapshot_leaves_the_real_index_and_status_byte_identical(repo):
    (repo / "a.txt").write_text("staged change\n")
    git(repo, "add", "a.txt")
    (repo / "a.txt").write_text("staged change\nplus an unstaged one\n")
    (repo / "untracked.txt").write_text("untracked\n")
    status_before = git(repo, "status", "--porcelain")
    cached_before = git(repo, "diff", "--cached")
    assert check_record.snapshot_tree(repo, quiet)
    assert git(repo, "status", "--porcelain") == status_before
    assert git(repo, "diff", "--cached") == cached_before


def test_a_git_error_means_no_snapshot_and_no_sha(tmp_path):
    not_a_repo = tmp_path / "plain"
    not_a_repo.mkdir()
    assert check_record.snapshot_tree(not_a_repo, quiet) is None
    assert check_record.passed_sha(not_a_repo, "f" * 40, quiet) is None
    assert check_record.passed_sha(not_a_repo, None, quiet) is None


def test_a_git_timeout_means_no_snapshot_and_the_bound_is_at_most_10s(repo, monkeypatch):
    seen = []

    def hung(cmd, *, timeout=None, **_kwargs):
        seen.extend([timeout])
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(check_record.subprocess, "run", hung)
    assert check_record.snapshot_tree(repo, quiet) is None
    assert check_record.SNAPSHOT_TIMEOUT_S <= 10
    assert seen and all(t <= 10 for t in seen)


def test_the_snapshot_temp_index_is_removed(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(check_record.tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    check_record.snapshot_tree(repo, quiet)
    assert list((tmp_path / "tmp").iterdir()) == []


# ---- only a run where checks actually ran counts ----


def test_checks_ran_only_for_a_run_that_ran_at_least_one_check():
    assert check_record.checks_ran("1 repo check(s) passed")
    assert check_record.checks_ran("12 repo check(s) passed")
    assert not check_record.checks_ran("0 repo check(s) passed")
    assert not check_record.checks_ran("no repo checks detected")
    assert not check_record.checks_ran("check runners unavailable — skipped")
    assert not check_record.checks_ran(None)


def test_checks_ran_matches_run_checks_own_notes(repo, tmp_path, monkeypatch):
    """Pins the coupling to run_checks()'s note text: a real green run is
    recognised, a waived run with nothing to run (either waiver) is not."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    passed = run_checks(repo, log=quiet)
    assert passed == "1 repo check(s) passed"
    assert check_record.checks_ran(passed)
    monkeypatch.delenv("FARM_CHECK_CMD")
    for waiver in CHECKS_WAIVERS:
        waived = run_checks(repo, log=quiet, checks_waiver=waiver)
        assert waived.startswith("checks waived for ")
        assert not check_record.checks_ran(waived)


def test_report_fields_carries_both_keys_only_when_checks_ran_and_the_tree_matches(repo):
    (repo / "a.txt").write_text("two\n")
    tree = check_record.snapshot_tree(repo, quiet)
    sha = commit_all(repo)
    assert check_record.report_fields(repo, tree, "2 repo check(s) passed", "2026-10-02T10:00:00Z", quiet) == {
        "checks_passed_sha": sha,
        "checks_finished_at": "2026-10-02T10:00:00Z",
    }
    assert check_record.report_fields(repo, tree, "no repo checks detected", "2026-10-02T10:00:00Z", quiet) == {}
    assert check_record.report_fields(repo, None, "2 repo check(s) passed", "2026-10-02T10:00:00Z", quiet) == {}
