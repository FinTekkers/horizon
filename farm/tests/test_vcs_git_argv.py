"""HO-874: the git calls moved into farm/vcs/git.py run exactly as before.

Each case drives the real caller (no mocked git plumbing, except the tenant
clone, which never reaches a network) and records the spawn at the stdlib
level with farm/tests/vcs_spy.py. Two tests per case:

  - `..._argv_unchanged` pins argv, the full subprocess kwargs (env, cwd,
    timeout, decoding, check) and, where there is more than one call, their
    order. It names no farm.vcs module, so it also passes on the tree before
    the move — that is what makes it a "same as today" check rather than the
    code agreeing with itself.
  - `..._issued_from_vcs_git` asserts the same spawns now come from
    farm/vcs/git.py.
"""

import os

import pytest

from farm import conflict_resolver, premerge, step_agent, workspaces
from farm.tests.conflict_fixtures import git, make_repo_hub, origin_branch_sha, push_new_branch
from farm.tests.vcs_spy import GitRecorder

REPO = "acme/demo"
VCS_GIT = "farm.vcs.git"
TEXT = {"capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace"}


@pytest.fixture
def ws_root(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root)
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    return tmp_path


def _write(path, text):
    return lambda work: (work / path).write_text(text)


# ---- step_agent._push_with_lease: the implement step's --force-with-lease ----


def _push_with_lease(tmp_path, monkeypatch):
    make_repo_hub(tmp_path)
    ws = workspaces.ensure_item_worktree(REPO, "HO-1")
    branch = "horizon/ho-1"
    git(ws, "checkout", "-B", branch, "origin/main")
    (ws / "new.txt").write_text("work\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "work")
    recorder = GitRecorder(monkeypatch)
    step_agent._push_with_lease(ws, {"repo": REPO}, branch, "")
    return recorder, ws, branch


def test_push_with_lease_argv_unchanged(ws_root, monkeypatch):
    recorder, ws, branch = _push_with_lease(ws_root, monkeypatch)
    assert [(s.argv, s.kwargs) for s in recorder.spawns] == [
        (
            ["git", "-C", str(ws), "push", f"--force-with-lease=refs/heads/{branch}:", "-u", "origin", f"{branch}:refs/heads/{branch}"],
            {**TEXT, "timeout": 300, "env": None},
        )
    ]
    assert origin_branch_sha(ws_root / "origin.git", branch) == git(ws, "rev-parse", "HEAD").stdout.strip()


def test_push_with_lease_issued_from_vcs_git(ws_root, monkeypatch):
    recorder, _ws, _branch = _push_with_lease(ws_root, monkeypatch)
    assert [s.module for s in recorder.matching("push")] == [VCS_GIT]


# ---- conflict_resolver._push_guarded: the scoped path's --force-with-lease ----


def _push_guarded(tmp_path, monkeypatch):
    _hub, origin = make_repo_hub(tmp_path)
    branch = "horizon/ho-2"
    lease = push_new_branch(tmp_path, origin, branch, _write("b.txt", "branch\n"), "branch")
    ws = workspaces.ensure_item_worktree(REPO, "HO-2")
    git(ws, "fetch", "origin")
    git(ws, "checkout", "-B", branch, f"origin/{branch}")
    (ws / "merged.txt").write_text("resolved\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "resolved")
    recorder = GitRecorder(monkeypatch)
    conflict_resolver._push_guarded(ws, lease, f"--force-with-lease=refs/heads/{branch}:{lease}", "origin", branch)
    return recorder, ws, branch, lease, origin


def test_push_guarded_argv_unchanged(ws_root, monkeypatch):
    recorder, ws, branch, lease, origin = _push_guarded(ws_root, monkeypatch)
    assert [(s.argv, s.kwargs) for s in recorder.spawns] == [
        (
            ["git", "-C", str(ws), "push", f"--force-with-lease=refs/heads/{branch}:{lease}", "origin", branch],
            {**TEXT, "timeout": conflict_resolver.GIT_TIMEOUT_S},
        )
    ]
    assert origin_branch_sha(origin, branch) == git(ws, "rev-parse", "HEAD").stdout.strip()


def test_push_guarded_issued_from_vcs_git(ws_root, monkeypatch):
    recorder, *_ = _push_guarded(ws_root, monkeypatch)
    assert [s.module for s in recorder.matching("push")] == [VCS_GIT]


# ---- premerge: the pre-merge test-merge (merge --no-ff) ----


def _premerge_merge(tmp_path, monkeypatch):
    _hub, origin = make_repo_hub(tmp_path)
    head = push_new_branch(tmp_path, origin, "horizon/ho-3", _write("shared.txt", "branch\n"), "branch")
    base = push_new_branch(tmp_path, origin, "main", _write("shared.txt", "main\n"), "main")
    recorder = GitRecorder(monkeypatch)
    result = premerge.premerge_check(REPO, "HO-3", head, base, timeout_s=600, log=lambda *_: None)
    # A same-line conflict: the result comes straight from the merge, so no
    # check runs behind it.
    assert result["reason"] == "merge_conflict", result
    return recorder, head


def test_premerge_merge_argv_unchanged(ws_root, monkeypatch):
    recorder, head = _premerge_merge(ws_root, monkeypatch)
    ws = premerge.premerge_path(REPO, "HO-3")
    merges = recorder.matching("merge", "--no-ff")
    assert [s.argv for s in merges] == [
        [
            "git", "-C", str(ws),
            "-c", "user.name=Horizon pre-merge",
            "-c", "user.email=horizon-premerge@localhost",
            "merge", "--no-ff", "--no-edit", head,
        ]
    ]
    kwargs = dict(merges[0].kwargs)
    timeout = kwargs.pop("timeout")
    # Computed from the queue deadline at call time, floored at 1 s.
    assert isinstance(timeout, float) and timeout >= 1
    assert kwargs == TEXT


def test_premerge_merge_issued_from_vcs_git(ws_root, monkeypatch):
    recorder, _head = _premerge_merge(ws_root, monkeypatch)
    assert [s.module for s in recorder.matching("merge", "--no-ff")] == [VCS_GIT]


# ---- conflict_resolver: the test-merge of origin/<default> ----


def _conflict_test_merge(tmp_path, monkeypatch):
    _hub, origin = make_repo_hub(tmp_path)
    push_new_branch(tmp_path, origin, "horizon/ho-4", _write("shared.txt", "line1 (branch edit)\nline2\nline3\n"), "branch")
    push_new_branch(tmp_path, origin, "main", _write("other.txt", "new on main\n"), "main-advance")
    recorder = GitRecorder(monkeypatch)
    result = conflict_resolver.resolve(REPO, "HO-4", log=lambda *_: None, checks_waiver="no_checks")
    assert result["resolved"] is True, result
    return recorder


def test_conflict_test_merge_argv_unchanged(ws_root, monkeypatch):
    recorder = _conflict_test_merge(ws_root, monkeypatch)
    ws = workspaces.workspace_path(REPO, "HO-4")
    assert [(s.argv, s.kwargs) for s in recorder.matching("merge", "--no-edit")] == [
        (["git", "-C", str(ws), "merge", "--no-edit", "origin/main"], {**TEXT, "timeout": conflict_resolver.GIT_TIMEOUT_S})
    ]


def test_conflict_test_merge_issued_from_vcs_git(ws_root, monkeypatch):
    recorder = _conflict_test_merge(ws_root, monkeypatch)
    assert [s.module for s in recorder.matching("merge", "--no-edit")] == [VCS_GIT]


# ---- workspaces.ensure() on an existing hub: argv, env, cwd and order ----


def _ensure_existing_hub(tmp_path, monkeypatch):
    hub, _origin = make_repo_hub(tmp_path)
    recorder = GitRecorder(monkeypatch)
    assert workspaces.ensure(REPO, None) == hub
    return recorder, hub


def test_ensure_existing_hub_argv_unchanged(ws_root, monkeypatch):
    recorder, hub = _ensure_existing_hub(ws_root, monkeypatch)
    h = str(hub)
    # Every kwarg is pinned, so a call that gained cwd= or env= fails here.
    assert [(s.argv, s.kwargs) for s in recorder.spawns] == [
        (["git", "-C", h, "fetch", "--all", "--prune"], {**TEXT, "timeout": 300}),
        (["git", "-C", h, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {**TEXT, "timeout": 300}),
        (["git", "-C", h, "checkout", "-f", "main"], {**TEXT, "timeout": 300}),
        (["git", "-C", h, "reset", "--hard", "origin/main"], {**TEXT, "timeout": 300}),
        (["git", "-C", h, "clean", "-fd"], {**TEXT, "timeout": 300}),
    ]


def test_ensure_existing_hub_issued_from_vcs_git(ws_root, monkeypatch):
    recorder, _hub = _ensure_existing_hub(ws_root, monkeypatch)
    assert recorder.spawns and {s.module for s in recorder.spawns} == {VCS_GIT}


# ---- workspaces._tenant_clone: the credential-helper clone ----


def _tenant_clone(tmp_path, monkeypatch):
    farm_home = tmp_path / "run-user" / ".horizon-farm"
    monkeypatch.setattr(workspaces, "FARM_HOME", farm_home)
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", farm_home / "workspaces")
    # Stubbed: the clone URL is the real github.com one.
    recorder = GitRecorder(monkeypatch, stub=True)
    hub = workspaces.ensure_tenant_hub(REPO)
    return recorder, hub


def test_tenant_clone_argv_unchanged(tmp_path, monkeypatch):
    recorder, hub = _tenant_clone(tmp_path, monkeypatch)
    helper = workspaces.TENANT_CREDENTIAL_HELPER
    assert [s.argv for s in recorder.spawns] == [
        [
            "git", "-c", "credential.helper=", "-c", f"credential.helper={helper}",
            "clone", f"https://github.com/{REPO}.git", str(hub),
        ],
        ["git", "-C", str(hub), "config", "--replace-all", "credential.helper", ""],
        ["git", "-C", str(hub), "config", "--add", "credential.helper", helper],
    ]
    clone, reset, add = (s.kwargs for s in recorder.spawns)
    env = clone.pop("env")
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env == {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    assert clone == {**TEXT, "timeout": workspaces.TENANT_CLONE_TIMEOUT_S, "check": True}
    assert reset == add == {**TEXT, "timeout": 300}


def test_tenant_clone_issued_from_vcs_git(tmp_path, monkeypatch):
    recorder, _hub = _tenant_clone(tmp_path, monkeypatch)
    assert len(recorder.spawns) == 3 and {s.module for s in recorder.spawns} == {VCS_GIT}
