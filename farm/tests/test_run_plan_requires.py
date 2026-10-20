"""HZ-502: a Task's run plan `requires` is checked on the runner the plan
will use, inside the Run plan step, before Impact review.

run_agent is stubbed (test_task_steps.stub_agent); the check itself runs for
real — bash on the host, conftest's fake_podman for a container.
"""

import os
import subprocess

import pytest

from domain.py import run_plan
from farm import container_runner, run_plan_requires, step_agent, task_job
from farm.agent_runner import AgentError
from farm.tests.test_task_steps import REPO_ROOT, VALID_PLAN, make_task, reply_for, stub_agent

MISSING_TOOL = {"tool": "hz502-missing"}
MISSING_PATH = {"path": "nope/requirements.txt"}
FAKE_IMAGE = "localhost/horizon-task:fake"


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    (path / "sub").mkdir(parents=True)
    (path / "requirements.txt").write_text("grpcio\n")
    return path


def run_plan_task(repo, *, runner="host", image=None, venv_dir=None):
    task = make_task(step_agent.RUN_PLAN_LABEL)
    task.update(repo_dir=str(repo), runner=runner, container_image=image, venv_dir=venv_dir)
    return task


def plan_reply(*requires, **plan):
    block = {**VALID_PLAN, "cwd": "sub", **plan}
    if requires:
        block["requires"] = list(requires)
    return reply_for(step_agent.RUN_PLAN_LABEL, run_plan=block)


def make_venv(repo, *tools):
    bin_dir = repo / ".venv" / "bin"
    bin_dir.mkdir(parents=True)
    for name in ("python", *tools):
        exe = bin_dir / name
        exe.write_text("#!/bin/sh\nexit 0\n")
        exe.chmod(0o755)
    return repo / ".venv"


@pytest.fixture
def probes(monkeypatch):
    """Every subprocess.run the check makes, then the real call."""
    calls, real = [], subprocess.run

    def spy(argv, **kwargs):
        calls.append({"argv": list(argv), **kwargs})
        return real(argv, **kwargs)

    monkeypatch.setattr(run_plan_requires.subprocess, "run", spy)
    return calls


# ---- metric 2: a gap goes back to Run plan, never on to Impact review ----


def test_a_persistent_gap_is_sent_back_twice_then_fails_the_step_naming_both(monkeypatch, repo):
    calls = stub_agent(monkeypatch, [plan_reply(MISSING_TOOL, MISSING_PATH, {"tool": "bash"})])
    with pytest.raises(AgentError) as err:
        step_agent.execute(run_plan_task(repo))
    assert len(calls) == 1 + step_agent.REQUIRES_REPROMPTS
    for reprompt in calls[1:]:
        assert reprompt["session_id"] == "s"
        assert "`hz502-missing`" in reprompt["prompt"]
        assert "`nope/requirements.txt`" in reprompt["prompt"]
        assert "`bash`" not in reprompt["prompt"]
    reason = str(err.value)
    assert reason.startswith(step_agent.REQUIRES_GAP_PREFIX)
    assert "tool `hz502-missing` is not on the runner's PATH" in reason
    assert "path `nope/requirements.txt` does not exist in the checkout" in reason


def test_a_gap_fixed_on_the_reprompt_completes_with_the_corrected_plan(monkeypatch, repo):
    first = plan_reply(MISSING_TOOL, {"path": "requirements.txt"})
    fixed = plan_reply({"tool": "bash"}, {"path": "requirements.txt"}, commands=["bash -c true"])
    calls = stub_agent(monkeypatch, [first, fixed])
    result = step_agent.execute(run_plan_task(repo))
    assert len(calls) == 2
    assert "`hz502-missing`" in calls[1]["prompt"]
    assert "`requirements.txt`" not in calls[1]["prompt"]
    assert run_plan.extract(result["artifacts"]["artifact_md"]) == fixed["run_plan"]


def test_a_check_that_cannot_run_fails_closed_with_no_reprompt(monkeypatch, repo):
    calls = stub_agent(monkeypatch, [plan_reply({"tool": "sh"})])
    with pytest.raises(AgentError, match="the container image could not be pulled"):
        step_agent.execute(run_plan_task(repo, runner="container", image="localhost/missing:1"))
    assert len(calls) == 1


# ---- guardrail 4: a plan without `requires` takes today's path ----


def test_a_plan_without_requires_runs_no_probe_and_one_agent_call(monkeypatch, repo, probes):
    calls = stub_agent(monkeypatch, [plan_reply()])
    result = step_agent.execute(run_plan_task(repo))
    assert len(calls) == 1
    assert probes == []
    assert "requires" not in run_plan.extract(result["artifacts"]["artifact_md"])


# ---- metric 3: the same PATH and cwd as Execute ----


def test_a_tool_only_in_the_venv_counts_as_present_under_executes_cwd_and_env(monkeypatch, repo, probes):
    venv = make_venv(repo, "hz502tool")
    calls = stub_agent(monkeypatch, [plan_reply({"tool": "hz502tool"}, {"path": "requirements.txt"})])
    step_agent.execute(run_plan_task(repo))
    assert len(calls) == 1
    (probe,) = probes
    expected_venv = run_plan.resolve_venv(str(repo), None, forbid=str(REPO_ROOT))
    assert expected_venv == os.path.realpath(venv)
    assert probe["cwd"] == run_plan.resolve_cwd(str(repo), "sub", forbid=str(REPO_ROOT))
    assert probe["env"] == task_job._child_env({}, expected_venv)
    # Guardrail 2: entries are argv items after the fixed script, never in it.
    assert probe["shell"] is False
    assert probe["argv"][:4] == ["bash", "-c", run_plan_requires.PROBE, "_"]
    assert probe["argv"][4:] == ["hz502tool", "--paths", os.path.realpath(repo / "requirements.txt")]


def test_a_symlink_out_of_the_checkout_is_rejected_and_never_probed(repo, probes):
    (repo / "out").symlink_to("/etc")
    block = {**VALID_PLAN, "cwd": ".", "requires": [{"path": "out/passwd"}, {"tool": "bash"}]}
    gaps = run_plan_requires.check(
        block, repo_dir=str(repo), venv_dir=None, runner="host", container_image=None, forbid=str(REPO_ROOT)
    )
    assert gaps == ["path `out/passwd` resolves outside the checkout (not checked)"]
    (probe,) = probes
    assert not any("passwd" in arg or arg.startswith("/etc") for arg in probe["argv"])


def test_probe_argv_shares_executes_user_mount_and_workdir_and_adds_no_network():
    repo_dir, workdir = "/srv/checkout", "/srv/checkout/pipelines"
    run = container_runner.build_run_argv(
        image=FAKE_IMAGE,
        name="farm-job-hz-502",
        repo_dir=repo_dir,
        workdir=workdir,
        scratch_dir="/state/s",
        tmp_dir="/state/t",
        state_dir="/state/st",
        logs_dir="/logs/l",
        env_names=[],
    )
    probe = container_runner.probe_argv(
        image=FAKE_IMAGE, repo_dir=repo_dir, workdir=workdir, script=run_plan_requires.PROBE, args=["gh", "--paths"]
    )

    def value(argv, flag):
        return argv[argv.index(flag) + 1]

    assert probe[1:3] == ["run", "--rm"]
    assert "exec" not in probe and "-d" not in probe
    assert "--network=none" in probe and "--network=host" not in probe
    assert "--userns=keep-id" in probe and "--userns=keep-id" in run
    assert value(probe, "--user") == value(run, "--user")
    assert value(probe, "-w") == value(run, "-w") == workdir
    assert f"{repo_dir}:{repo_dir}:ro" in probe and f"{repo_dir}:{repo_dir}:ro" in run
    # Nothing else is mounted, so nothing is writable.
    assert [a for a, prev in zip(probe[1:], probe) if prev == "-v"] == [f"{repo_dir}:{repo_dir}:ro"]
    assert "--read-only" in probe
    # PATH is the image's, as a job's `podman exec` sees it: a container run
    # ignores the host venv (HZ-416), so neither sets PATH.
    assert not any(a.startswith("PATH=") for a in probe + run)
    assert probe[probe.index(FAKE_IMAGE) :] == [FAKE_IMAGE, "sh", "-c", run_plan_requires.PROBE, "_", "gh", "--paths"]


def test_a_container_plan_is_checked_in_the_image_not_the_host_venv(repo):
    make_venv(repo, "hz502tool")
    block = {
        **VALID_PLAN,
        "cwd": "sub",
        "runner": "container",
        "requires": [{"tool": "sh"}, {"tool": "hz502tool"}, {"path": "requirements.txt"}, MISSING_PATH],
    }
    gaps = run_plan_requires.check(
        block, repo_dir=str(repo), venv_dir=None, runner="host", container_image=FAKE_IMAGE, forbid=str(REPO_ROOT)
    )
    assert gaps == [
        "tool `hz502tool` is not on the runner's PATH",
        "path `nope/requirements.txt` does not exist in the checkout",
    ]


# ---- guardrail 1: read-only ----


def _snapshot(root):
    return {
        str(p.relative_to(root)): (p.is_dir(), p.lstat().st_size, p.lstat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
    }


def test_the_check_runs_no_plan_command_and_writes_nothing(monkeypatch, repo, tmp_path):
    make_venv(repo, "hz502tool")
    before_repo, before_tmp = _snapshot(repo), sorted(os.listdir(tmp_path))
    stub_agent(
        monkeypatch,
        [plan_reply({"tool": "hz502tool"}, {"path": "requirements.txt"}, cwd=".", commands=["touch hz502-marker"])],
    )
    result = step_agent.execute(run_plan_task(repo))
    assert result["summary"]  # the step completed
    assert not (repo / "hz502-marker").exists()
    assert _snapshot(repo) == before_repo
    assert sorted(os.listdir(tmp_path)) == before_tmp
