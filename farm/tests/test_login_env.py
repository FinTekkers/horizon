"""HZ-494: a repo's test-login env file reaches its test/e2e checks and its
deploy smoke check, read at run time, and every value is redacted.

The file sits on the host (here: a directory outside the workspace and
FARM_HOME). The server sends its PATH; farm/login_env.py reads it each run.
Values reach the check command's environment only — never os.environ, never
the agent — and every output (log, note, CheckFailure, digest, test_runs,
step result, premerge report, smoke line) shows [redacted] instead.
"""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

from farm import checks, config, login_env, premerge, step_agent, workspaces
from farm.checks import REDACTED, CheckFailure, run_checks
from farm.providers import claude as claude_provider
from farm.tests.test_premerge import REPO as PREMERGE_REPO
from farm.tests.test_premerge import crossing_fixture
from farm.tests.test_step_agent import make_git_workspace, make_task

PASSWORD = "Hz494-pa55word-value"
USER = "e2e-user@example.test"
NAMES = ("FT_E2E_PASSWORD", "FT_E2E_USER")
IMPLEMENT = step_agent.IMPLEMENT_LABEL
DEPLOY = "Deploy the changes"

# A check that passes only when it got the file's password, then prints it —
# on stdout, and on its own command line.
PASSING_CHECK = f'test "$FT_E2E_PASSWORD" = {shlex.quote(PASSWORD)} && echo "logged in as $FT_E2E_USER with $FT_E2E_PASSWORD"'
FAILING_CHECK = f'echo "login rejected for $FT_E2E_PASSWORD"; echo "not ok 1 - login {PASSWORD}"; exit 1'


def write_env(path: Path, password: str = PASSWORD, extra: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# test login\nexport FT_E2E_USER={USER}\nFT_E2E_PASSWORD=\"{password}\"\n{extra}")
    path.chmod(0o600)
    return path


@pytest.fixture
def host_file(tmp_path):
    """The host file, outside the workspace (tmp_path/ws) and FARM_HOME."""
    return write_env(tmp_path / "etc" / "ui-e2e.env")


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    path = tmp_path / "ws"
    path.mkdir()
    return path


def capture_log():
    lines: list[str] = []
    return lines, lines.append


def files_containing(root: Path, needle: str) -> list[str]:
    hits = []
    for path in root.rglob("*"):
        if path.is_file() and needle.encode() in path.read_bytes():
            hits.append(str(path))
    return hits


def unreadable(path: Path, monkeypatch):
    """Mode 000; as root (which reads anything) the read raises
    PermissionError instead, so the case never skips."""
    path.chmod(0o000)
    if os.geteuid() == 0:
        real_open = open

        def denying_open(file, *args, **kwargs):
            if os.path.realpath(str(file)) == os.path.realpath(str(path)):
                raise PermissionError(13, "Permission denied", str(file))
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr("builtins.open", denying_open)


# ---- metric 1: run_checks — log, note, CheckFailure, digest, test_runs ----


def test_a_configured_check_gets_the_password_and_every_output_redacts_it(ws, host_file):
    lines, log = capture_log()
    test_runs: list = []
    note = run_checks(ws, log, configured={"test": PASSING_CHECK}, test_env_file=str(host_file), test_runs=test_runs)

    text = "\n".join(lines) + note + json.dumps(test_runs)
    assert PASSWORD not in text and USER not in text
    assert REDACTED in "\n".join(lines)  # the command line held the value
    assert note  # a pass: exit 0 only with the right value
    assert "FT_E2E_PASSWORD" not in os.environ


def test_a_failing_check_that_echoes_the_password_never_shows_it(ws, host_file):
    lines, log = capture_log()
    test_runs: list = []
    with pytest.raises(CheckFailure) as caught:
        run_checks(ws, log, configured={"test": FAILING_CHECK}, test_env_file=str(host_file), test_runs=test_runs)
    exc = caught.value

    for shown in (str(exc), exc.tail, exc.digest, exc.headline, exc.command, "\n".join(lines), json.dumps(test_runs)):
        assert PASSWORD not in shown
    assert REDACTED in exc.tail and REDACTED in exc.command


def test_a_wrong_password_fails_the_check(ws, tmp_path):
    wrong = write_env(tmp_path / "etc" / "wrong.env", password="not-the-password")
    with pytest.raises(CheckFailure):
        run_checks(ws, lambda *_: None, configured={"test": PASSING_CHECK}, test_env_file=str(wrong))


def test_only_test_and_e2e_commands_get_the_values_never_install_or_lint(ws, host_file, tmp_path):
    # HZ-505: the screenshots slot runs only beside a valid config.
    (ws / ".horizon").mkdir(exist_ok=True)
    (ws / ".horizon" / "screenshots.json").write_text(
        (Path(__file__).parent / "fixtures" / "screenshots" / "valid.json").read_text()
    )
    dumps = {slot: tmp_path / f"{slot}.env" for slot in checks.CHECK_SLOTS}
    configured = {slot: f"env > {dumps[slot]}" for slot in checks.CHECK_SLOTS}
    run_checks(ws, lambda *_: None, configured=configured, test_env_file=str(host_file))
    # HZ-506: the screenshots slot's saved line never runs; its runner gets
    # the values instead (test_screenshot_runner.py).
    assert not dumps[checks.SCREENSHOTS_SLOT].exists()
    seen = {slot: dumps[slot].read_text() for slot in ("install", "test", "lint", "e2e")}
    assert f"FT_E2E_PASSWORD={PASSWORD}" in seen["test"] and f"FT_E2E_PASSWORD={PASSWORD}" in seen["e2e"]
    assert "FT_E2E_PASSWORD" not in seen["install"] and "FT_E2E_PASSWORD" not in seen["lint"]


def test_the_screenshots_slot_gets_the_values():
    # HZ-506: the capture runner sends them on `login: true` shots only.
    assert checks.LOGIN_ENV_SLOTS == {"test", "e2e", checks.SCREENSHOTS_SLOT}


# ---- metric 1: the implement step's output ----


def run_main(tmp_path, monkeypatch, task, fake_run_agent=None):
    """step_agent.main() on a task file, as farmd runs it; returns the result
    it posted."""
    posted: list[dict] = []
    if fake_run_agent is not None:
        monkeypatch.setattr(step_agent, "run_agent", fake_run_agent)
    monkeypatch.setattr(step_agent, "post_result", posted.append)
    task_file = tmp_path / f"task-{task['run_id']}.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    step_agent.main()
    assert len(posted) == 1
    return posted[0]


@pytest.fixture
def implement(tmp_path, monkeypatch, host_file):
    ws_path, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws_path)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.setenv("FARM_FIX_LOOP_CAP", "0")
    agent_envs: list[dict] = []
    real = claude_provider.without_gate_credentials

    def recording():
        env = real()
        agent_envs.append(dict(env))
        return env

    monkeypatch.setattr(claude_provider, "without_gate_credentials", recording)

    def task_for(check, path=str(host_file)):
        task = make_task(11, IMPLEMENT, repo="acme/demo")
        task["check_commands"] = {"test": check}
        if path is not None:
            task["test_env_file"] = path
        return task

    return {"ws": ws_path, "origin": origin, "task": task_for, "agent_envs": agent_envs}


def origin_messages(origin: Path) -> str:
    return subprocess.run(
        ["git", "--git-dir", str(origin), "log", "--all", "--format=%B"], capture_output=True, text=True, check=True
    ).stdout


@pytest.mark.parametrize("check", [PASSING_CHECK, FAILING_CHECK], ids=["green", "red"])
def test_the_implement_step_output_shows_redacted_never_the_value(tmp_path, monkeypatch, implement, check):
    result = run_main(tmp_path, monkeypatch, implement["task"](check))

    posted = json.dumps(result)
    assert PASSWORD not in posted and USER not in posted
    assert result["ok"] is (check == PASSING_CHECK)
    assert REDACTED in posted
    # Metric 5: nothing in the workspace or on the pushed branch holds it.
    assert files_containing(implement["ws"], PASSWORD) == []
    assert PASSWORD not in origin_messages(implement["origin"])
    # Guardrail 1: the agent's own process got neither the names nor the values.
    assert implement["agent_envs"], "the agent was never spawned"
    for env in implement["agent_envs"]:
        assert not set(NAMES) & set(env) and PASSWORD not in env.values()
    assert "FT_E2E_PASSWORD" not in os.environ


def test_a_missing_file_fails_the_implement_step_by_name_with_no_traceback_and_no_fix_turn(
    tmp_path, monkeypatch, implement
):
    missing = str(tmp_path / "etc" / "absent.env")
    calls = []
    real = step_agent.run_agent
    monkeypatch.setattr(step_agent, "run_agent", lambda prompt, **kw: calls.append(prompt) or real(prompt, **kw))
    monkeypatch.setenv("FARM_FIX_LOOP_CAP", "2")

    result = run_main(tmp_path, monkeypatch, implement["task"](PASSING_CHECK, path=missing))

    assert result["ok"] is False
    assert missing in result["error"] and "does not exist" in result["error"]
    assert "Traceback" not in result["error"]
    # A host file is no code problem: the agent got no fix turn for it.
    assert len(calls) == 1
    assert missing in calls[0] and "could not be read" in calls[0]


# ---- metric 1: the premerge report ----


def test_premerge_cli_gets_the_password_and_its_report_and_log_redact_it(tmp_path, tmp_path_factory, monkeypatch):
    root = tmp_path / "farm-home"
    root.mkdir()
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", root / "workspaces")
    monkeypatch.setattr(premerge, "WORKSPACES_DIR", root / "workspaces")
    hub, shas = crossing_fixture(root)
    # Outside the child's FARM_HOME, which load_login_env() refuses.
    env_file = write_env(tmp_path_factory.mktemp("host-etc") / "ui-e2e.env")

    def premerge_run(check):
        env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "FARM_CHECK_CMD")}
        env["FARM_HOME"] = str(root)  # set for the child, never inherited
        proc = subprocess.run(
            [
                sys.executable, "-m", "farm.premerge", PREMERGE_REPO, "HZ-154", shas["pr_head"], "--base", shas["main"],
                "--json", "--check-commands", json.dumps({"test": check}), "--test-env-file", str(env_file),
            ],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(premerge.RUNNING_CHECKOUT),
        )
        return proc, json.loads(proc.stdout)

    green, report = premerge_run(PASSING_CHECK)
    assert green.returncode == 0 and report["ok"] is True, green.stderr
    assert PASSWORD not in green.stdout + green.stderr and REDACTED in green.stderr

    red, report = premerge_run(FAILING_CHECK)
    assert red.returncode == 1 and report["ok"] is False and report["reason"] == "checks_failed"
    assert PASSWORD not in red.stdout + red.stderr
    assert REDACTED in report["tail"]


# ---- metric 2: the deploy smoke check ----

SMOKE_PASS = """
const want = %s
if (process.env.FT_E2E_PASSWORD !== want) {
  console.log('SMOKE_RESULT=fail: no login')
  process.exit(1)
}
console.log(`SMOKE_RESULT=pass — logged in with ${process.env.FT_E2E_PASSWORD}`)
"""
SMOKE_STDERR_ONLY = """
console.error(`login failed for ${process.env.FT_E2E_PASSWORD}`)
process.exit(1)
"""


def smoke_stub(tmp_path, monkeypatch, body: str) -> Path:
    stub = tmp_path / "stub-smoke" / "check.mjs"
    stub.parent.mkdir(parents=True, exist_ok=True)
    stub.write_text(body)
    monkeypatch.setattr(step_agent, "SMOKE_CHECK_SCRIPT", stub)
    return stub


def devops_agent(prompts: list):
    def fake(prompt, **kwargs):
        prompts.append(prompt)
        reply = {"summary": "verified", "url": "https://example.test/", "expected_text": "Home", "artifact_md": "## Deploy"}
        return {"result": json.dumps(reply)}

    return fake


def deploy_task(path):
    task = make_task(14, DEPLOY, repo="acme/demo")
    if path is not None:
        task["test_env_file"] = path
    return task


def test_the_deploy_smoke_check_gets_the_password_and_its_report_redacts_it(tmp_path, monkeypatch, host_file):
    smoke_stub(tmp_path, monkeypatch, SMOKE_PASS % json.dumps(PASSWORD))
    prompts: list = []
    result = run_main(tmp_path, monkeypatch, deploy_task(str(host_file)), devops_agent(prompts))

    assert result["ok"] is True
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    for shown in (result["summary"], result["artifacts"]["artifact_md"]):
        assert f"logged in with {REDACTED}" in shown and PASSWORD not in shown
    # Metric 5: the agent's prompt names the variables, never a value.
    assert all(name in prompts[0] for name in NAMES)
    assert PASSWORD not in prompts[0] and USER not in prompts[0]
    assert "FT_E2E_PASSWORD" not in os.environ


def test_a_smoke_check_with_no_result_line_redacts_its_stderr(tmp_path, monkeypatch, host_file):
    smoke_stub(tmp_path, monkeypatch, SMOKE_STDERR_ONLY)
    result = run_main(tmp_path, monkeypatch, deploy_task(str(host_file)), devops_agent([]))

    assert result["artifacts"]["verdict"] == {"verdict": "fail"}
    for shown in (result["summary"], result["artifacts"]["artifact_md"]):
        assert f"login failed for {REDACTED}" in shown and PASSWORD not in shown


# ---- metric 3: no setting, no variables ----


def test_without_the_setting_neither_checks_nor_smoke_see_the_files_variables(ws, host_file, tmp_path, monkeypatch):
    dump = tmp_path / "check-env"
    run_checks(ws, lambda *_: None, configured={"test": f"env > {dump}"})
    assert not any(name in dump.read_text() for name in NAMES)

    smoke_dump = tmp_path / "smoke-env"
    smoke_stub(
        tmp_path,
        monkeypatch,
        f"import {{ writeFileSync }} from 'node:fs'\nwriteFileSync({json.dumps(str(smoke_dump))}, Object.keys(process.env).join('\\n'))\n"
        "console.log('SMOKE_RESULT=pass')\n",
    )
    result = run_main(tmp_path, monkeypatch, deploy_task(None), devops_agent([]))
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert not any(name in smoke_dump.read_text().split("\n") for name in NAMES)


# ---- metric 4: missing or unreadable file ----


@pytest.mark.parametrize("case", ["missing", "unreadable"])
def test_a_missing_or_unreadable_file_fails_the_check_and_the_smoke_by_name(ws, tmp_path, monkeypatch, case):
    path = tmp_path / "etc" / "ui-e2e.env"
    if case == "unreadable":
        write_env(path)
        unreadable(path, monkeypatch)
    ran = tmp_path / "ran"
    lines, log = capture_log()

    with pytest.raises(CheckFailure) as caught:
        run_checks(ws, log, configured={"test": f"env > {ran}"}, test_env_file=str(path))
    message = str(caught.value)
    assert str(path) in message
    assert ("does not exist" if case == "missing" else "permission denied") in message
    assert caught.value.reason == "failed" and caught.value.command == login_env.COMMAND_LABEL
    assert not ran.exists()  # nothing ran, so nothing was loaded anywhere
    assert PASSWORD not in message + "\n".join(lines)

    smoke_stub(tmp_path, monkeypatch, "console.log('SMOKE_RESULT=pass')\n")
    verdict, line = step_agent.run_smoke_check("https://example.test/", "Home", test_env_file=str(path))
    assert verdict == "fail" and str(path) in line

    # The prompt still builds, and says the checks will fail.
    prompt = step_agent.build_prompt({**make_task(11, IMPLEMENT, repo="acme/demo"), "test_env_file": str(path)})
    assert str(path) in prompt and PASSWORD not in prompt
    if case == "unreadable":
        path.chmod(0o600)


# ---- metric 5: the prompt lists names only ----


def test_the_prompt_lists_the_variable_names_and_never_a_value(host_file):
    prompt = step_agent.build_prompt({**make_task(11, IMPLEMENT, repo="acme/demo"), "test_env_file": str(host_file)})
    assert "FT_E2E_PASSWORD, FT_E2E_USER" in prompt
    assert PASSWORD not in prompt and USER not in prompt
    assert "test login" not in step_agent.build_prompt(make_task(11, IMPLEMENT, repo="acme/demo"))


# ---- guardrail 2: the file cannot reshape the farm's runtime ----


@pytest.mark.parametrize("name", ["PATH", "FARM_HOME", "NODE_OPTIONS", "LD_PRELOAD", "FARM_MAX_CONCURRENT_CHECKS"])
def test_a_reserved_name_fails_the_check_naming_the_key_not_the_value(ws, tmp_path, name):
    value = "/reserved-value-hz494"
    path = write_env(tmp_path / "etc" / "reserved.env", extra=f"{name}={value}\n")
    ran = tmp_path / "ran"
    with pytest.raises(CheckFailure) as caught:
        run_checks(ws, lambda *_: None, configured={"test": f"touch {ran}"}, test_env_file=str(path))
    assert name in str(caught.value) and value not in str(caught.value)
    assert not ran.exists()


def test_a_malformed_or_too_short_value_fails_without_quoting_the_line(ws, tmp_path):
    bad = write_env(tmp_path / "etc" / "bad.env", extra="this line holds Hz494-secret-shape\n")
    with pytest.raises(CheckFailure, match="line 4 is not NAME=value") as caught:
        run_checks(ws, lambda *_: None, configured={"test": "true"}, test_env_file=str(bad))
    assert "Hz494-secret-shape" not in str(caught.value)

    short = write_env(tmp_path / "etc" / "short.env", extra="FT_PIN=123\n")
    with pytest.raises(CheckFailure, match="FT_PIN is shorter than 4 characters") as caught:
        run_checks(ws, lambda *_: None, configured={"test": "true"}, test_env_file=str(short))
    assert "123" not in str(caught.value)


# ---- guardrail 3: read at run time, never cached, never in the farm's dirs ----


def test_each_run_reads_the_file_again_and_redacts_the_new_value(ws, host_file):
    run_checks(ws, lambda *_: None, configured={"test": PASSING_CHECK}, test_env_file=str(host_file))

    rotated = "Hz494-rotated-pa55word"
    write_env(host_file, password=rotated)
    lines, log = capture_log()
    check = f'test "$FT_E2E_PASSWORD" = {shlex.quote(rotated)} && echo "now $FT_E2E_PASSWORD"'
    run_checks(ws, log, configured={"test": check}, test_env_file=str(host_file))
    assert rotated not in "\n".join(lines) and REDACTED in "\n".join(lines)


@pytest.mark.parametrize("where", ["workspace", "workspaces_root", "farm_home", "symlink_into_workspace"])
def test_a_file_inside_a_workspace_or_the_farms_state_is_refused(ws, tmp_path, where):
    farm_home = config.farm_home()
    targets = {
        "workspace": ws / ".env",
        "workspaces_root": config.WORKSPACES_DIR / "hz494-other-item" / ".env",
        "farm_home": farm_home / "hz494-state" / "login.env",
        "symlink_into_workspace": ws / "linked.env",
    }
    target = write_env(targets[where])
    path = target
    if where == "symlink_into_workspace":
        path = tmp_path / "etc" / "link.env"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
    try:
        with pytest.raises(CheckFailure, match="must live outside the farm's state and workspaces"):
            run_checks(ws, lambda *_: None, configured={"test": "true"}, test_env_file=str(path))
    finally:
        target.unlink()
