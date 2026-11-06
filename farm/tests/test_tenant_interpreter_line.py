"""HZ-787: Run plan's interpreter line for a tenant project names the run
user's own task clone — the one tenant_job.prepare runs in — and never says
`refused` because the server's repo_dir is a farm-user path. Internal
projects keep today's line, byte for byte."""

import builtins
import os
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import step_agent, workspaces
from farm.step_agent import REPO_ROOT, build_prompt

TENANT = {"isolation": "tenant"}


def _task(repo_dir, project=None, repo="acme/demo"):
    task = {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "T-1",
            "title": "Test item",
            "desc": "Deliver the thing",
            "metric": "It works",
            "guardrails": "",
            "priority": "Medium",
            "repo": repo,
            "issue": 42,
        },
        "step": {"index": 3, "label": "Run plan", "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
        "repo_dir": repo_dir,
        "venv_dir": None,
    }
    if project is not None:
        task["project"] = project
    return task


def _interpreter(prompt: str) -> str:
    lines = [line for line in prompt.splitlines() if line.startswith("  interpreter:")]
    assert len(lines) == 1, lines
    return lines[0]


@pytest.fixture
def run_home(tmp_path, monkeypatch):
    """A fake run user's home; the tenant task clones live under it, as
    credentials.tenant_session_env's FARM_HOME puts them."""
    home = tmp_path / "runhome"
    monkeypatch.setattr(workspaces, "TENANT_TASK_CLONES_DIR", home / ".horizon-farm" / "task-clones")
    return home


def _clone_line(repo="acme/demo"):
    venv = workspaces.tenant_task_clone_path(repo) / ".venv"
    return (
        f"  interpreter: {venv}/bin/python if that venv exists at Execute, else system python3 "
        f"(env: the run user's task clone {venv.parent}; the clone and venv are checked at Execute)"
    )


def test_a_tenant_line_names_the_run_users_task_clone_venv(tmp_path, run_home):
    """Metric 1 and guardrail 4: a farm-user repo_dir is ignored; the line
    names the task clone's venv and that Execute decides. No URL or token."""
    farm_dir = tmp_path / "farm" / "workspaces" / "x"
    farm_dir.mkdir(parents=True)
    line = _interpreter(build_prompt(_task(str(farm_dir), TENANT)))
    clone = run_home / ".horizon-farm" / "task-clones" / "acme__demo"
    assert line == _clone_line()
    assert f"{clone}/.venv/bin/python" in line
    assert "at Execute" in line
    assert str(farm_dir) not in line
    for leak in ("https://", "@", "x-access-token"):
        assert leak not in line


def test_a_tenant_line_with_a_missing_farm_user_repo_dir_is_not_refused(tmp_path, run_home):
    """Metric 2: the farm-user path a tenant run user cannot read is the
    refusal resolve_cwd gives on a real host; the tenant line ignores it."""
    missing = str(tmp_path / "farm" / "missing")
    with pytest.raises(run_plan.CwdRefused, match="missing or unreadable"):
        run_plan.resolve_cwd(missing, ".", forbid=str(REPO_ROOT))
    line = _interpreter(build_prompt(_task(missing, TENANT)))
    assert "refused" not in line
    assert line == _clone_line()


def test_a_tenant_line_with_no_repo_dir_is_not_refused(run_home):
    """Metric 2: the server sends repo_dir null with no deploy target; a
    tenant task with a repo still gets the clone line."""
    line = _interpreter(build_prompt(_task(None, TENANT)))
    assert "refused" not in line
    assert line == _clone_line()


@pytest.mark.parametrize("project", [None, {"isolation": "internal"}], ids=["no-project", "internal"])
@pytest.mark.parametrize("case", ["venv", "system", "refused"])
def test_internal_lines_are_todays_exact_strings(tmp_path, project, case):
    """Metric 3 and guardrail 3: a non-tenant task's line is exactly today's."""
    repo = tmp_path / "repo"
    repo.mkdir()
    if case == "venv":
        (repo / ".venv" / "bin").mkdir(parents=True)
        (repo / ".venv" / "bin" / "python").write_text("#!/bin/sh\n")
        (repo / ".venv" / "bin" / "python").chmod(0o755)
        venv = os.path.realpath(repo / ".venv")
        expected = f"  interpreter: {venv}/bin/python (env: {venv})"
    elif case == "system":
        expected = "  interpreter: system python3 (env: system)"
    else:
        (repo / ".venv").symlink_to(tmp_path)
        expected = (
            "  interpreter: refused — venv resolves outside the repo directory. "
            "Execute will refuse until the deploy target is fixed"
        )
    assert _interpreter(build_prompt(_task(str(repo), project))) == expected


def test_the_tenant_line_touches_nothing_under_the_run_users_home(tmp_path, run_home, monkeypatch):
    """Metric 4 and guardrail 1: every filesystem call under the run user's
    home raises, and so do the repo_dir checks; the line still builds."""
    home = str(run_home)

    def under_home(path) -> bool:
        if not isinstance(path, (str, bytes, os.PathLike)):
            return False
        path = os.fsdecode(os.fspath(path))
        return path == home or path.startswith(home + os.sep)

    def guarded(fn):
        def wrapper(path, *args, **kwargs):
            if under_home(path):
                raise AssertionError(f"touched the run user's home: {path}")
            return fn(path, *args, **kwargs)

        return wrapper

    def refuse(*_args, **_kwargs):
        raise AssertionError("the tenant line ran a repo_dir check")

    task = _task(str(tmp_path / "farm" / "workspaces" / "x"), TENANT)
    with monkeypatch.context() as m:
        for module, name in (
            (os, "stat"),
            (os, "lstat"),
            (os, "access"),
            (os, "listdir"),
            (os, "scandir"),
            (os.path, "realpath"),
            (os.path, "exists"),
            (os.path, "lexists"),
            (os.path, "isdir"),
            (os.path, "isfile"),
            (Path, "exists"),
            (Path, "is_dir"),
            (builtins, "open"),
        ):
            m.setattr(module, name, guarded(getattr(module, name)))
        m.setattr(run_plan, "resolve_cwd", refuse)
        m.setattr(run_plan, "resolve_venv", refuse)
        # The patches fire: a call under the home raises before the line is built.
        with pytest.raises(AssertionError, match="run user's home"):
            os.stat(os.path.join(home, "x"))
        with pytest.raises(AssertionError, match="run user's home"):
            (run_home / "x").exists()
        line = step_agent._interpreter_line(task)
    assert line == _clone_line()
