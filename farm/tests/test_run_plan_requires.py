"""HZ-502: a Task's run plan `requires` is checked on the runner the plan
will use, inside the Run plan step, before Impact review.

run_agent is stubbed (test_task_steps.stub_agent); the check itself runs for
real — bash on the host, conftest's fake_podman for a container.
"""

import json
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


# ==== HZ-769: env vars, host files and undeclared `$NAME`s ====

FIXTURES = REPO_ROOT / "farm" / "tests" / "fixtures" / "run_plans"
SENTINEL = "hz769-sentinel-value-5b1e"


def stamped(task, names=(), uid=None):
    """What farmd's _claim_and_launch adds to a Run plan task: the names its
    own env sets and its uid — Execute's env and user."""
    task.update(job_env_names=sorted(names), job_uid=os.geteuid() if uid is None else uid)
    return task


def fixture_plan(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


def fixture_task(repo, names=(), **kwargs):
    """A stamped Run plan task whose metric has the five lines the stored
    plans prove."""
    task = stamped(run_plan_task(repo, **kwargs), names=names)
    task["item"]["metric"] = "\n".join(f"{n}. line {n}" for n in range(1, 6))
    return task


def fixture_reply(name, **changes):
    return reply_for(step_agent.RUN_PLAN_LABEL, run_plan={**fixture_plan(name), **changes})


def rehearsal_for(name):
    """HO-835: one sample per `proof` command of a stored plan, which
    predates the rehearsal block. Sent beside it so the requires gaps these
    tests name are reached; the fixture file is never edited."""
    proved = sorted({entry["command"] for entry in fixture_plan(name)["proof"] if "command" in entry})
    return {"samples": [{"command": k, "expect": f"command {k} would pass"} for k in proved]}


def env_plan(*requires, env=None, **plan):
    return plan_reply(*requires, env=env or {}, **plan)


def gap_reason(monkeypatch, task, *replies):
    """Runs the Run plan step to its failure; returns (agent calls, reason)."""
    calls = stub_agent(monkeypatch, list(replies))
    with pytest.raises(AgentError) as err:
        step_agent.execute(task)
    reason = str(err.value)
    assert reason.startswith(step_agent.REQUIRES_GAP_PREFIX)
    return calls, reason


@pytest.fixture
def config_root(monkeypatch, tmp_path):
    """A stand-in for /etc/horizon: the only allowed root outside the checkout."""
    root = tmp_path / "etc-horizon"
    root.mkdir()
    monkeypatch.setattr(run_plan_requires, "ALLOWED_FILE_ROOTS", (str(root),))
    return root


# ---- metric 1: an unset or empty requires.env name goes back to the agent ----


@pytest.mark.parametrize("dotenv", [None, 'HZ769_UNSET=""\n'], ids=["no-source", "empty-in-dotenv"])
def test_an_unset_or_empty_env_var_is_sent_back_twice_then_fails_naming_it(monkeypatch, repo, dotenv):
    if dotenv:
        (repo / "sub" / ".env").write_text(dotenv)
    monkeypatch.delenv("HZ769_UNSET", raising=False)
    reply = env_plan({"tool": "bash"}, {"env": "HZ769_UNSET"}, env={"HZ769_UNSET": "$HZ769_UNSET"})
    calls, reason = gap_reason(monkeypatch, stamped(run_plan_task(repo)), reply)
    assert len(calls) == 1 + step_agent.REQUIRES_REPROMPTS
    for reprompt in calls[1:]:
        assert "env var `HZ769_UNSET` is not set in the job's environment" in reprompt["prompt"]
        assert '{"env": "NAME"}' in reprompt["prompt"]
    assert reason == step_agent.REQUIRES_GAP_PREFIX + "env var `HZ769_UNSET` is not set in the job's environment"


def test_an_env_gap_fixed_on_the_reprompt_completes_with_the_corrected_plan(monkeypatch, repo):
    first = env_plan({"env": "HZ769_UNSET"}, env={"HZ769_UNSET": "$HZ769_UNSET"})
    fixed = env_plan({"env": "HZ769_SET"}, env={"HZ769_SET": "$HZ769_SET"}, commands=['test -n "$HZ769_SET"'])
    calls = stub_agent(monkeypatch, [first, fixed])
    result = step_agent.execute(stamped(run_plan_task(repo), names=["HZ769_SET"]))
    assert len(calls) == 2
    assert "`HZ769_UNSET`" in calls[1]["prompt"]
    assert run_plan.extract(result["artifacts"]["artifact_md"]) == fixed["run_plan"]


# ---- metric 2 and guardrail 2: files ----


def test_an_unreadable_file_under_an_allowed_root_is_a_gap_naming_it(monkeypatch, repo, config_root):
    if os.geteuid() == 0:
        pytest.fail("runs as root, where test -r passes on a chmod 000 file: run the suite as a normal user")
    secret = config_root / "stripe.env"
    secret.write_text("x\n")
    secret.chmod(0o000)
    _, reason = gap_reason(monkeypatch, stamped(run_plan_task(repo)), env_plan({"file": str(secret)}))
    assert reason == step_agent.REQUIRES_GAP_PREFIX + f"file `{secret}` is not readable by the job user"


def test_a_file_outside_the_checkout_and_the_allowed_roots_is_a_gap_and_never_probed(monkeypatch, repo, probes):
    _, reason = gap_reason(monkeypatch, stamped(run_plan_task(repo)), env_plan({"file": "/etc/passwd"}, {"tool": "bash"}))
    assert reason == step_agent.REQUIRES_GAP_PREFIX + (
        "file `/etc/passwd` resolves outside the checkout and outside /etc/horizon and /etc/fintekkers (not checked)"
    )
    assert probes and not any("/etc/passwd" in arg for probe in probes for arg in probe["argv"])


def test_dotdot_and_a_symlink_out_of_an_allowed_root_are_gaps_and_never_probed(monkeypatch, repo, probes, config_root):
    (config_root / "root-link").symlink_to("/root")
    linked = str(config_root / "root-link" / ".bashrc")
    reply = env_plan({"file": "/etc/horizon/../shadow"}, {"file": linked})
    _, reason = gap_reason(monkeypatch, stamped(run_plan_task(repo)), reply)
    gaps = reason[len(step_agent.REQUIRES_GAP_PREFIX) :].split("; ")
    assert [gap.split("`")[1] for gap in gaps] == ["/etc/horizon/../shadow", linked]
    assert all("resolves outside the checkout" in gap for gap in gaps)
    assert probes == []


def test_a_file_is_never_probed_as_a_user_other_than_the_job_user(repo, probes, config_root):
    readable = config_root / "ok.env"
    readable.write_text("x\n")
    block = {**VALID_PLAN, "cwd": ".", "env": {}, "requires": [{"file": str(readable)}]}
    for uid in (None, os.geteuid() + 1):
        gaps = run_plan_requires.check(
            block, repo_dir=str(repo), venv_dir=None, runner="host", container_image=None, forbid=str(REPO_ROOT),
            job_env_names=[], job_uid=uid,
        )  # fmt: skip
        assert gaps == [f"file `{readable}` cannot be checked as the job user (not checked)"]
    assert probes == []


# ---- metric 3: an undeclared `$NAME` ----


def test_hz514_shape_no_requires_and_an_undeclared_name_fails_naming_it(monkeypatch, repo):
    reply = reply_for(
        step_agent.RUN_PLAN_LABEL,
        run_plan={"cwd": ".", "budget_minutes": 5, "commands": ['curl -H "Authorization: Bearer $HORIZON_API_TOKEN" x']},
    )
    _, reason = gap_reason(monkeypatch, run_plan_task(repo), reply)
    assert reason == step_agent.REQUIRES_GAP_PREFIX + (
        "command uses `$HORIZON_API_TOKEN`, which is not declared in requires.env or set by the plan"
    )


def test_hz533_plan_item_fails_as_stored_and_passes_once_declared(monkeypatch, repo):
    names = ["PLAN_ITEM", "TASK_ITEM"]
    _, reason = gap_reason(monkeypatch, fixture_task(repo, names), fixture_reply("hz533", rehearsal=rehearsal_for("hz533")))
    assert "command uses `$PLAN_ITEM`, which is not declared in requires.env or set by the plan" in reason

    # PLAN_ITEM declared (and set in farmd's env): no longer named.
    declared = fixture_plan("hz533")["requires"] + [{"env": "PLAN_ITEM"}]
    _, reason = gap_reason(
        monkeypatch, fixture_task(repo, names), fixture_reply("hz533", requires=declared, rehearsal=rehearsal_for("hz533"))
    )
    assert "PLAN_ITEM" not in reason
    assert "`$TASK_ITEM`" in reason

    # With TASK_ITEM declared too, and the plan's tools, paths and config
    # file present, the stored plan passes as is.
    for path in [e["path"] for e in fixture_plan("hz533")["requires"] if "path" in e]:
        (repo / path).mkdir(parents=True, exist_ok=True)  # test -e: a folder will do
    fake_bin = make_venv(repo, *[e["tool"] for e in fixture_plan("hz533")["requires"] if "tool" in e])
    monkeypatch.setattr(run_plan_requires, "_implied_files", lambda block: [])
    full = declared + [{"env": "TASK_ITEM"}]
    calls = stub_agent(monkeypatch, [fixture_reply("hz533", requires=full, rehearsal=rehearsal_for("hz533"))])
    result = step_agent.execute(fixture_task(repo, names, venv_dir=str(fake_bin)))
    assert len(calls) == 1
    assert run_plan.extract(result["artifacts"]["artifact_md"])["requires"] == full


def test_assigned_loop_quoted_and_standard_names_are_not_reported():
    block = {
        "commands": [
            'for f in a b; do echo "$f"; done; X=1; export Y=2; read -r Z; echo $X $Y $Z $HOME ${PATH} $1 $? $$ \\$NOPE',
            "echo '$NOT_SCANNED' $'$ALSO_NOT' \"$(printf '%s' \"$WANTED\")\" $((N + 1))",
            "cat <<'EOF'\n$QUOTED_HEREDOC\nEOF\ncat <<EOF\n$OPEN_HEREDOC\nEOF",
        ]
    }
    assert run_plan_requires.undeclared_names(block) == ["WANTED", "OPEN_HEREDOC"]
    assert run_plan_requires.undeclared_names({**block, "requires": [{"env": "WANTED"}]}) == ["OPEN_HEREDOC"]


# ---- metric 4: Execute's environment, in both modes ----


@pytest.mark.parametrize("runner", ["host", "container"])
def test_env_comes_from_farmds_names_never_the_step_process(monkeypatch, repo, runner):
    """A name farmd's env sets passes though this process lacks it; a name
    only this process sets is a gap."""
    monkeypatch.delenv("HZ769_FARMD_ONLY", raising=False)
    monkeypatch.setenv("HZ769_STEP_ONLY", SENTINEL)
    reply = env_plan(
        {"env": "HZ769_FARMD_ONLY"},
        {"env": "HZ769_STEP_ONLY"},
        env={"HZ769_FARMD_ONLY": "$HZ769_FARMD_ONLY", "HZ769_STEP_ONLY": "$HZ769_STEP_ONLY"},
    )
    task = stamped(run_plan_task(repo, runner=runner, image=FAKE_IMAGE), names=["HZ769_FARMD_ONLY"])
    _, reason = gap_reason(monkeypatch, task, reply)
    assert reason == step_agent.REQUIRES_GAP_PREFIX + "env var `HZ769_STEP_ONLY` is not set in the job's environment"


def test_an_image_only_variable_passes_in_a_container_and_is_a_gap_on_the_host(monkeypatch, repo):
    monkeypatch.setenv("FARM_FAKE_PODMAN_IMAGE_ENV", json.dumps({"HZ769_IMAGE_ONLY": "from-the-image"}))
    monkeypatch.setattr(container_runner, "CLIENT_ENV_KEYS", (*container_runner.CLIENT_ENV_KEYS, "FARM_FAKE_PODMAN_IMAGE_ENV"))
    reply = env_plan({"env": "HZ769_IMAGE_ONLY"})
    calls = stub_agent(monkeypatch, [reply])
    result = step_agent.execute(stamped(run_plan_task(repo, runner="container", image=FAKE_IMAGE)))
    assert len(calls) == 1
    assert run_plan.extract(result["artifacts"]["artifact_md"]) == reply["run_plan"]
    _, reason = gap_reason(monkeypatch, stamped(run_plan_task(repo, runner="host")), reply)
    assert reason == step_agent.REQUIRES_GAP_PREFIX + "env var `HZ769_IMAGE_ONLY` is not set in the job's environment"


@pytest.mark.parametrize("runner", ["host", "container"])
def test_no_value_or_file_content_reaches_the_gaps_the_feedback_the_log_or_the_probe(
    monkeypatch, repo, config_root, tmp_path, capfd, runner
):
    (repo / "sub" / ".env").write_text(f"HZ769_DOTENV={SENTINEL}\n")
    login = tmp_path / "login.env"
    login.write_text(f"HZ769_LOGIN={SENTINEL}\n")
    secret_file = config_root / "readable.env"
    secret_file.write_text(f"KEY={SENTINEL}\n")
    monkeypatch.setenv("HZ769_FARMD", SENTINEL)
    results, real = [], subprocess.run

    def spy(argv, **kwargs):
        done = real(argv, **kwargs)
        results.append((list(argv), kwargs.get("env") or {}, done.stdout, done.stderr))
        return done

    monkeypatch.setattr(run_plan_requires.subprocess, "run", spy)
    refs = {n: f"${n}" for n in ("HZ769_DOTENV", "HZ769_LOGIN", "HZ769_FARMD", "HZ769_MISSING")}
    reply = env_plan(*({"env": n} for n in refs), {"file": str(secret_file)}, {"tool": "bash"}, env=refs)
    task = stamped(run_plan_task(repo, runner=runner, image=FAKE_IMAGE), names=["HZ769_FARMD"])
    task["test_env_file"] = str(login)
    calls, reason = gap_reason(monkeypatch, task, reply)
    assert "env var `HZ769_MISSING` is not set" in reason
    # The dotenv, login and farmd names resolved without a probe; the file
    # is probed on the host and refused in a container.
    for name in ("HZ769_DOTENV", "HZ769_LOGIN", "HZ769_FARMD"):
        assert name not in reason
    assert (f"file `{secret_file}` is not available to a container run" in reason) is (runner == "container")
    gaps = reason[len(step_agent.REQUIRES_GAP_PREFIX) :].split("; ")
    out, err = capfd.readouterr()
    assert results
    for text in (reason, run_plan_requires.feedback(gaps), out, err, *(c["prompt"] for c in calls[1:])):
        assert SENTINEL not in text
    for argv, env, stdout, stderr in results:
        assert SENTINEL not in " ".join(argv) and SENTINEL not in stdout and SENTINEL not in stderr
        assert SENTINEL not in json.dumps(env)
    probe_outputs = [stdout for argv, _, stdout, _ in results if run_plan_requires.PROBE_ENV_FILES in argv]
    assert probe_outputs and all(out.split() and all(line.isdigit() for line in out.split()) for out in probe_outputs)


# ---- metric 5: the stored plans that failed in preflight ----


@pytest.mark.parametrize("name", ["hz514", "hz532", "hz533", "hz700-a5", "hz836-jq-psql"])
def test_each_committed_plan_fixture_holds_no_literal_secret(name):
    text = (FIXTURES / f"{name}.json").read_text()
    assert run_plan.literal_secrets(text) == []
    run_plan.validate(json.loads(text))


def test_the_stored_hz514_plan_stops_at_run_plan_naming_its_token(monkeypatch, repo):
    _, reason = gap_reason(monkeypatch, fixture_task(repo, ["GITHUB_TOKEN"]), fixture_reply("hz514"))
    assert "env var `HORIZON_API_TOKEN` is not set in the job's environment" in reason
    assert "`GITHUB_TOKEN`" not in reason


def test_the_stored_hz532_plan_stops_at_run_plan_naming_both_inputs(monkeypatch, repo):
    _, reason = gap_reason(monkeypatch, fixture_task(repo), fixture_reply("hz532", rehearsal=rehearsal_for("hz532")))
    for name in ("RECORD_SITE_URL", "RECORD_ITEM"):
        assert f"command uses `${name}`, which is not declared in requires.env or set by the plan" in reason
        assert f"env var `{name}` is not set in the job's environment" in reason


def test_the_stored_hz700_attempt5_plan_stops_at_run_plan_naming_the_stripe_file(monkeypatch, repo):
    stripe = "/etc/horizon/stripe.env"
    if os.access(stripe, os.R_OK):
        pytest.fail(f"{stripe} is readable by this user, so this test cannot show the gap: run as a non-root user")
    _, reason = gap_reason(monkeypatch, fixture_task(repo, ["HOME"]), fixture_reply("hz700-a5", rehearsal=rehearsal_for("hz700-a5")))
    assert f"file `{stripe}` is not readable by the job user" in reason
    # Read through `sudo -n cat`, the recorder file is not the job user's to open.
    assert "recorder.env" not in reason


# ---- guardrails 1, 3 and 4 ----


def test_env_and_file_checks_run_no_plan_command_and_write_nothing(monkeypatch, repo, tmp_path, config_root):
    readable = config_root / "ok.env"
    readable.write_text("x\n")
    before_repo, before_root = _snapshot(repo), _snapshot(config_root)
    before_tmp = sorted(os.listdir(tmp_path))
    reply = env_plan(
        {"env": "HZ769_SET"},
        {"file": str(readable)},
        env={"HZ769_SET": "$HZ769_SET"},
        cwd=".",
        commands=['touch hz769-marker "$HZ769_SET"', f"cat {readable} > hz769-copy"],
    )
    stub_agent(monkeypatch, [reply])
    result = step_agent.execute(stamped(run_plan_task(repo), names=["HZ769_SET"]))
    assert result["summary"]
    assert not (repo / "hz769-marker").exists() and not (repo / "hz769-copy").exists()
    assert _snapshot(repo) == before_repo and _snapshot(config_root) == before_root
    assert sorted(os.listdir(tmp_path)) == before_tmp


def test_standard_vars_is_one_frozen_literal_list_defined_only_here():
    assert isinstance(run_plan_requires.STANDARD_VARS, frozenset)
    assert run_plan_requires.STANDARD_VARS == {
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR",
        "VIRTUAL_ENV",
        "PWD", "OLDPWD", "IFS", "PPID", "RANDOM", "LINENO", "SECONDS", "UID", "EUID", "HOSTNAME",
        "REPLY", "OPTARG", "OPTIND",
    }  # fmt: skip
    # No second list: OPTIND and OLDPWD together mark one anywhere else.
    others = [
        str(path.relative_to(REPO_ROOT))
        for top in ("farm", "domain", "server/src")
        for path in (REPO_ROOT / top).rglob("*")
        if path.suffix in (".py", ".js", ".mjs", ".json")
        and ".venv" not in path.parts
        and "tests" not in path.parts
        and path.name != "run_plan_requires.py"
        and "OPTIND" in (text := path.read_text(errors="ignore"))
        and "OLDPWD" in text
    ]
    assert others == []


def test_a_tool_and_path_plan_gets_todays_probe_argv_and_feedback_text(monkeypatch, repo, probes):
    stub_agent(monkeypatch, [plan_reply({"tool": "bash"}, {"path": "requirements.txt"})])
    step_agent.execute(stamped(run_plan_task(repo), names=["GITHUB_TOKEN"]))
    (probe,) = probes
    assert probe["argv"] == [
        "bash",
        "-c",
        'i=0; mode=tool; for a in "$@"; do '
        'if [ "$mode" = tool ] && [ "$a" = --paths ]; then mode=path; continue; fi; '
        "i=$((i+1)); "
        'if [ "$mode" = tool ]; then command -v -- "$a" >/dev/null 2>&1 || echo "$i"; '
        'else test -e "$a" || echo "$i"; fi; '
        "done",
        "_",
        "bash",
        "--paths",
        os.path.realpath(repo / "requirements.txt"),
    ]
    assert run_plan_requires.feedback(["tool `gh` is not on the runner's PATH"]) == (
        "Your run plan's `requires` was checked on the runner the plan will use, and the runner lacks:\n"
        "- tool `gh` is not on the runner's PATH\n\n"
        "Change the plan so every tool and file it needs is there before the run starts: use a tool the "
        "runner has, fix the path, or set `runner` to one that has them. Keep `requires` listing every tool "
        "and file the commands need. Respond with ONLY the full JSON object described in your role instructions."
    )


def test_farmd_stamps_a_run_plan_task_with_its_env_names_and_uid_only(tmp_path, monkeypatch):
    from farm import farmd

    monkeypatch.setenv("HZ769_FARMD_NAME", SENTINEL)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda *a, **k: None)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    assert run_plan_requires.RUN_PLAN_LABEL == step_agent.RUN_PLAN_LABEL
    for label, run_id in ((step_agent.RUN_PLAN_LABEL, 76901), ("Assess", 76902)):
        task = {**make_task(label), "run_id": run_id}
        (runs_dir / f"{run_id}.json").write_text(json.dumps(task))
        farmd._claim_and_launch(runs_dir / f"{run_id}.json", runs_dir, tmp_path)
        farmd.RUN_SESSIONS.pop(str(run_id), None)
        claimed = (runs_dir / "active" / f"{run_id}.json").read_text()
        assert SENTINEL not in claimed
        written = json.loads(claimed)
        if label == step_agent.RUN_PLAN_LABEL:
            assert "HZ769_FARMD_NAME" in written["job_env_names"] and written["job_uid"] == os.geteuid()
        else:
            assert "job_env_names" not in written and "job_uid" not in written


def test_farmd_stamps_a_tenant_run_plan_task_with_its_session_env_names_and_run_user_uid(tmp_path, monkeypatch):
    """A tenant Execute resolves from the tenant session env (built from
    empty) and runs as the run user: a name only farmd's env sets is not
    stamped, and the uid is the run user's."""
    from farm import farmd

    monkeypatch.setenv("HZ769_FARMD_NAME", SENTINEL)
    monkeypatch.setenv("HZ769_TENANT_TOKEN", SENTINEL)
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd, "_launch_tenant_session", lambda *a, **k: None)
    monkeypatch.setattr(farmd, "_run_user_home", lambda run_user: f"/home/{run_user}")
    monkeypatch.setattr(farmd, "_run_user_uid", lambda run_user: 76999)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    project = {"id": 7, "isolation": "tenant", "githubTokenRef": "$HZ769_TENANT_TOKEN", "runUser": "acme_run"}
    task = {**make_task(step_agent.RUN_PLAN_LABEL), "run_id": 76903, "project": project}
    (runs_dir / "76903.json").write_text(json.dumps(task))
    farmd._claim_and_launch(runs_dir / "76903.json", runs_dir, tmp_path)
    farmd.RUN_SESSIONS.pop("76903", None)
    claimed = (runs_dir / "active" / "76903.json").read_text()
    assert SENTINEL not in claimed
    written = json.loads(claimed)
    assert "HZ769_FARMD_NAME" not in written["job_env_names"]
    assert {"GITHUB_TOKEN", "HOME"} <= set(written["job_env_names"])
    assert written["job_uid"] == 76999


# ==== HO-835: `service`, `precondition` and `access` are never run here ====

V2_SERVICE = {"service": {"name": "postgresql", "version_cmd": "psql --version", "expect": "psql (PostgreSQL) 16"}}
V2_PRECONDITIONS = [
    {"precondition": {"kind": "lock_free", "check": "flock -n /tmp/hz835.lock true"}},
    {"precondition": {"kind": "no_deploy_running", "check": "pgrep -f deploy-horizon.sh 2>/dev/null"}},
    {"precondition": {"kind": "row_exists", "check": "psql \"$RO_DB_URL\" -tAc 'SELECT 1 FROM accounts WHERE n > 0'"}},
    {"precondition": {"kind": "account_exists", "check": "psql \"$RO_DB_URL\" -tAc 'SELECT 1 FROM accounts WHERE id = 42'"}},
    {"precondition": {"kind": "artifact_exists", "check": "test -e /tmp/hz835-prices.csv"}},
]


def test_service_and_precondition_entries_alone_run_nothing(monkeypatch, repo):
    """Guardrail 4: they never reach the probe, and nothing else runs either."""

    def refuse(*args, **kwargs):
        raise AssertionError("the requires check ran a subprocess")

    monkeypatch.setattr(run_plan_requires.subprocess, "run", refuse)
    block = run_plan.validate({**VALID_PLAN, "cwd": "sub", "env": {}, "requires": [V2_SERVICE, *V2_PRECONDITIONS]})
    gaps = run_plan_requires.check(
        block, repo_dir=str(repo), venv_dir=None, runner="host", container_image=None, forbid=str(REPO_ROOT),
        job_env_names=[], job_uid=os.geteuid(),
    )  # fmt: skip
    assert gaps == []


def test_a_mixed_plan_probes_its_tool_and_written_file_and_never_a_check_or_version_cmd(repo, probes, config_root):
    written = config_root / "app.env"
    written.write_text("x\n")
    requires = [{"tool": "bash"}, V2_SERVICE, V2_PRECONDITIONS[2], {"file": str(written), "access": "w"}]
    block = run_plan.validate({**VALID_PLAN, "cwd": "sub", "env": {}, "requires": requires})
    gaps = run_plan_requires.check(
        block, repo_dir=str(repo), venv_dir=None, runner="host", container_image=None, forbid=str(REPO_ROOT),
        job_env_names=[], job_uid=os.geteuid(),
    )  # fmt: skip
    assert gaps == []
    (probe,) = probes
    argv = probe["argv"]
    assert argv[2] == run_plan_requires.PROBE_ENV_FILES
    assert argv[argv.index(run_plan_requires.FILES_MARKER) + 1 :] == [os.path.realpath(written)]
    assert "bash" in argv[: argv.index(run_plan_requires.PATHS_MARKER)]
    joined = " ".join(argv)
    for text in ("psql", "SELECT", "postgresql", "16"):
        assert text not in joined


def test_a_full_v2_plan_finishes_run_plan_and_the_card_reads_it(monkeypatch, repo, config_root):
    """Metrics 1-3 as one journey: the Run plan step passes a plan with a
    service, all five preconditions, a written file and a rehearsal; a
    `$RO_DB_URL` inside a check is no undeclared-name gap; and the server's
    reader (domain/js/runPlan.js) shows the same artifact."""
    written = config_root / "app.env"
    written.write_text("x\n")
    plan = {
        "cwd": "sub",
        "commands": ["bash -c 'echo backfill --limit 50'", "bash -c 'echo count'"],
        "budget_minutes": 5,
        "env": {},
        "requires": [{"tool": "bash"}, V2_SERVICE, *V2_PRECONDITIONS, {"file": str(written), "access": "w"}],
        "proof": [{"line": 1, "command": 1}, {"line": 2, "command": 2}] + [{"line": n, "manual": f"the owner checks line {n}"} for n in (3, 4, 5)],
        "rehearsal": {
            "dry_run": "bash -c 'echo backfill --dry-run'",
            "limit": 50,
            "ro_env": ["RO_DB_URL"],
            "samples": [{"command": 1, "expect": "would update 50 rows in accounts"}, {"command": 2, "expect": "accounts: 50"}],
        },
    }
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, run_plan=plan)])
    result = step_agent.execute(fixture_task(repo))
    assert len(calls) == 1
    artifact = result["artifacts"]["artifact_md"]
    assert run_plan.extract(artifact) == plan
    script = (
        "import { extractRunPlan } from './domain/js/runPlan.js';"
        "import { readFileSync } from 'node:fs';"
        "console.log(JSON.stringify(extractRunPlan(readFileSync(0, 'utf8'))));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=REPO_ROOT, input=artifact, capture_output=True, text=True, check=True
    )
    assert json.loads(out.stdout) == plan


# ---- HO-836: the contract audit — undeclared tools and hosts ----

SHARED_GAPS = json.loads((REPO_ROOT / "domain" / "fixtures" / "contract-gaps-cases.json").read_text())
API_SERVICE = {"service": {"name": "api.example.com", "version_cmd": "curl -fsS https://api.example.com/health", "expect": "ok"}}
REDACTED_URL = "curl -H 'Authorization: Bearer x' https://u:p@api.example.com/x?token=abc"


def gaps_of(*commands, requires=()):
    """contract_gaps() of a plan with these commands, as (kind, name, command)."""
    block = run_plan.validate({**VALID_PLAN, "commands": list(commands), "requires": list(requires)})
    return [(gap["kind"], gap["name"], gap["command"]) for gap in run_plan_requires.contract_gaps(block)]


def test_a_stored_plan_calling_jq_or_psql_flags_each_until_declared():
    """Metric 1. No stored Run plan calls `jq` or `psql`, so
    hz836-jq-psql.json is the stored hz532 plan, unchanged, with two
    commands added: `jq` at 13 and `psql` at 14. It is read back the way
    Impact review reads it: rendered into an artifact, then run_plan.extract()."""
    plan = fixture_plan("hz836-jq-psql")
    assert plan["commands"][:12] == fixture_plan("hz532")["commands"]

    def replay(requires):
        artifact = f"## Run plan\n\n## Run plan block\n{run_plan.render({**plan, 'requires': requires})}"
        gaps = run_plan_requires.contract_gaps(run_plan.extract(artifact))
        return [(gap["kind"], gap["name"], gap["command"]) for gap in gaps]

    stored = plan["requires"]
    hosts = [("service", "www.fintekkers.org", 1), ("service", "www.fintekkers.org", 11)]
    assert replay(stored) == [*hosts, ("tool", "jq", 13), ("tool", "psql", 14)]
    assert replay([*stored, {"tool": "jq"}]) == [*hosts, ("tool", "psql", 14)]
    assert replay([*stored, {"tool": "jq"}, {"tool": "psql"}]) == hosts
    site = {"service": {"name": "www.fintekkers.org", "version_cmd": "curl -sI https://www.fintekkers.org/", "expect": "HTTP/2 200"}}
    assert replay([*stored, {"tool": "jq"}, {"tool": "psql"}, site]) == []


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("cat f | jq .", [("tool", "cat", 1), ("tool", "jq", 1)]),
        ("cd x && psql", [("tool", "psql", 1)]),
        ("true; jq .", [("tool", "jq", 1)]),
        ("ls | xargs psql", [("tool", "ls", 1), ("tool", "xargs", 1), ("tool", "psql", 1)]),
    ],
)
def test_tools_after_each_separator_are_flagged_and_builtins_never_are(command, expected):
    """Metric 2: the full list, with the command's index — never a word
    after the tool (`.`, `f`, `x`), never a builtin."""
    assert gaps_of("./prepare.sh", command) == [(kind, name, 2) for kind, name, _ in expected]


def test_every_listed_builtin_is_never_a_gap():
    """Metric 2: cd, echo, export, set, test, [ and true."""
    for name in ("cd", "echo", "export", "set", "test", "[", "true"):
        assert name in run_plan_requires.SHELL_BUILTINS
    assert gaps_of("echo hi; export A=1; set -e; test -f x; [ -f x ]; true; cd x") == []


def test_a_url_host_is_flagged_until_a_service_entry_declares_it():
    """Metric 3."""
    command = "curl https://api.example.com/x"
    assert gaps_of("./prepare.sh", command, requires=[{"tool": "curl"}]) == [("service", "api.example.com", 2)]
    assert gaps_of("./prepare.sh", command, requires=[{"tool": "curl"}, API_SERVICE]) == []


def test_a_declared_service_passes_validate_and_check_and_is_never_probed(repo, probes):
    """Metric 3: a plan whose host is declared reaches Impact review — Run
    plan's check skips the `service` entry and never probes it."""
    block = run_plan.validate({**VALID_PLAN, "cwd": "sub", "env": {}, "commands": ["curl https://api.example.com/x"], "requires": [API_SERVICE]})
    kwargs = dict(repo_dir=str(repo), venv_dir=None, runner="host", container_image=None, forbid=str(REPO_ROOT))
    assert run_plan_requires.check(block, **kwargs) == []
    assert probes == []
    assert [gap for gap in run_plan_requires.contract_gaps(block) if gap["kind"] == "service"] == []

    block["requires"] = [{"tool": "curl"}, API_SERVICE]
    assert run_plan_requires.check(block, **kwargs) == []
    assert run_plan_requires.contract_gaps(block) == []
    (probe,) = probes
    assert "curl" in probe["argv"] and not any("example.com" in arg for arg in probe["argv"])


def test_the_shared_case_is_exactly_what_the_scan_reports():
    """Metrics 4-5: the farm half of domain/fixtures/contract-gaps-cases.json;
    the server test posts the same `gaps` for the same plan."""
    block = run_plan.validate(SHARED_GAPS["plan"])
    assert run_plan_requires.contract_gaps(block) == SHARED_GAPS["gaps"]
    declared = run_plan.validate({**block, "requires": block["requires"] + SHARED_GAPS["declared"]})
    assert run_plan_requires.contract_gaps(declared) == []


def test_contract_gaps_runs_resolves_and_fetches_nothing(monkeypatch):
    """Guardrail 1: with every way to run, resolve or fetch refused, every
    committed plan still scans."""
    import socket
    import urllib.request

    def refuse(*args, **kwargs):
        raise AssertionError("the contract audit ran, resolved or fetched something")

    for target, name in [
        (subprocess, "run"), (subprocess, "Popen"), (os, "system"),
        (socket, "getaddrinfo"), (socket, "create_connection"), (urllib.request, "urlopen"),
    ]:  # fmt: skip
        monkeypatch.setattr(target, name, refuse)
    plans = [json.loads(path.read_text()) for path in sorted(FIXTURES.glob("*.json"))] + [SHARED_GAPS["plan"]]
    assert len(plans) >= 6
    for plan in plans:
        run_plan_requires.contract_gaps(plan)


def test_a_gap_carries_only_the_host_never_userinfo_query_or_a_header():
    """Guardrail 4."""
    gaps = run_plan_requires.contract_gaps({"commands": [REDACTED_URL], "requires": [{"tool": "curl"}]})
    assert gaps == [{"kind": "service", "name": "api.example.com", "command": 1}]
    text = json.dumps(gaps) + run_plan_requires.describe_gaps(gaps)
    for secret in ("u:p", "token=", "Bearer", "curl -H"):
        assert secret not in text


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("curl http://API.Example.COM./x", [("tool", "curl"), ("service", "api.example.com")]),
        ("curl http://127.0.0.1:3001/api/health", [("tool", "curl"), ("service", "127.0.0.1")]),
        ('curl "$BASE/x" ${API}/y file:///tmp/x', [("tool", "curl")]),
        ("psql -h db.internal; ls -h; df -h", [("tool", "psql"), ("service", "db.internal"), ("tool", "ls"), ("tool", "df")]),
        ("command -v jq; type jq; which jq", [("tool", "which")]),
        ("check() { ls; }; check a", [("tool", "ls")]),
        ("bash -c 'jq .'; python3 -c 'import yq'", [("tool", "bash"), ("tool", "jq"), ("tool", "python3")]),
        ("echo 'jq .' \"yq\"; cat <<'EOF'\nzq .\nGET https://h.example.com/x\nEOF", [("tool", "cat"), ("service", "h.example.com")]),
        ("xargs -I {} -n 1 psql; sudo -u postgres psql", [("tool", "xargs"), ("tool", "psql"), ("tool", "sudo")]),
        ("X=1 stdbuf -oL env -u A B=2 nice -n 5 make", [("tool", "stdbuf"), ("tool", "env"), ("tool", "nice"), ("tool", "make")]),
        ('case "$X" in a|b) jq .;; esac; for f in a b; do wc "$f"; done', [("tool", "jq"), ("tool", "wc")]),
        ('v=$(yq x) && echo "$(zq y)" `gq z` <(hq)', [("tool", "yq"), ("tool", "zq"), ("tool", "gq"), ("tool", "hq")]),
        ("./run.sh 2>&1 | /usr/bin/tee log > out.txt", []),
        ("(( i++ )); [[ x == y && z ]] && bash --norc -c 'jq .'", [("tool", "bash"), ("tool", "jq")]),
        ("function f { wc; }; f", [("tool", "wc")]),
    ],
)
def test_scanner_edges(command, expected):
    assert [(kind, name) for kind, name, _ in gaps_of(command)] == expected


def test_a_wrapper_with_a_positional_word_reads_past_it():
    """`timeout -k 5 60 make`: past the option, its value and the duration."""
    command = "timeout -k 5 60 make"
    assert [name for _, name, _ in gaps_of(command)] == [command.split()[0], "make"]


def test_a_sudo_read_config_file_is_still_not_implied():
    """The `sudo` rule _implied_files shares with the scan: a path a sudo
    command reads — directly, in `<(...)` or in a `bash -c` script — is not
    the job user's to open; one the job's own shell reads is."""
    block = {"commands": [
        "source <(sudo -n cat /etc/horizon/a.env); . /etc/horizon/b.env",
        "sudo -u root bash -c 'cat /etc/horizon/c.env' && bash -c \"sudo cat /etc/horizon/d.env\"",
        "cat /etc/horizon/e.env",
    ]}  # fmt: skip
    assert run_plan_requires._implied_files(block) == ["/etc/horizon/b.env", "/etc/horizon/e.env"]
