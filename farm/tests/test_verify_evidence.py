"""HZ-771: Verify & report reads the full Run plan and this attempt's Execute
log as files in a scratch folder, never as a 60 KB prompt digest.

The evidence is built the way production builds it: farmd.job_artifact_md over
a log redacted with farm.checks.redact. The journey tests feed step_agent a
task file shaped like the server's /steps/run body and read the files from
inside a stub provider call, while the agent would be running.
"""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from domain.py import run_plan, steps
from farm import agent_runner, farmd, job_reports, step_agent, verify_evidence
from farm.agent_runner import AgentError
from farm.checks import redact
from farm.config import QUEUE_DIR
from farm.providers import claude

# Built in two halves so this file never holds a literal secret whole.
SECRET = "sk-live-" + "9f8e7d6c5b4a39281706"
SECRETS = {"PRICING_API_KEY": SECRET}
COMMANDS = [f"python3 step{n}.py --key $PRICING_API_KEY" for n in range(1, 11)]
PLAN_BLOCK = {"cwd": ".", "commands": COMMANDS, "budget_minutes": 30, "reports": ["out/summary.json"]}
RUN_PLAN = "## Commands\n1. load the book\n\n## Run plan block\n" + run_plan.render(PLAN_BLOCK)


def _execute_artifact(log_bytes=300 * 1024) -> str:
    """A ~300 KB Execute artifact whose only failure is the last command. The
    raw log holds the secret; the artifact, like the stored one, does not."""
    rows, n, size = [], 0, 0
    while size < log_bytes:
        rows.append(f"step{1 + n % 9} row {n} loaded ok with key {SECRET}\n")
        size += len(rows[-1]) - len(SECRET) + len("[redacted]")
        n += 1
    raw_log = "".join(rows) + "$ python3 step10.py\nERROR: step10 checksum mismatch on row 6001\nexit 1\n"
    lines = [f"- exit {1 if i == 9 else 0} — `{c}`" for i, c in enumerate(COMMANDS)]
    reports = job_reports.reports_md(
        [
            {"path": "out/summary.json", "status": "inlined", "bytes": 40, "text": '{"rows": 6001, "failed": 1}\n## not a heading\n'},
            {"path": "../../etc/passwd", "status": "refused", "bytes": 0, "text": "outside the plan's cwd and /tmp"},
        ]
    )
    return farmd.job_artifact_md(
        "10 command(s) run, 9 passed, 1 failed",
        redact(raw_log, SECRETS),
        commands=lines,
        reports_md=reports,
        full_log="Full log: `/home/farm/logs/farm-job-t-771.log` (this attempt is bytes 4,096–310,000)",
    )


EXECUTE = _execute_artifact()


def _evidence(plan=RUN_PLAN, execute=EXECUTE) -> list[dict]:
    return [
        {"label": step_agent.RUN_PLAN_LABEL, "stepIndex": steps.step_index_of("task.run-plan"), "content": plan},
        {"label": "Execute", "stepIndex": steps.step_index_of("task.execute"), "content": execute},
    ]


def _verify_task(evidence, repo=None) -> dict:
    label = step_agent.VERIFY_REPORT_LABEL
    return {
        "run_id": 771,
        "attempt": 1,
        "item": {"id": "T-771", "kind": "task", "title": "Backfill", "desc": "Run the backfill", "priority": "High", "repo": repo},
        "step": {"index": steps.step_index_of("task.verify-report"), "label": label},
        "artifacts": [{"label": "Assess", "content": "assess: the scripts exist"}],
        "evidence": evidence,
        "feedback": [],
    }


VERDICT = {
    "summary": "step10 failed: the metric does not hold",
    "artifact_md": "## Verdict\n**fail** — step10 exited 1",
    "verdict": {"verdict": "fail", "summary": "step10 exited 1."},
}


@pytest.fixture
def reading_agent(monkeypatch):
    """A run_agent stub that, during its call, records the prompt and
    add_dirs and reads every evidence file back as bytes."""
    calls = []

    def fake(prompt, **kwargs):
        root = Path(kwargs["add_dirs"][0]) if kwargs.get("add_dirs") else None
        files = {}
        if root is not None and root.exists():
            files = {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}
        calls.append({"prompt": prompt, "root": root, "files": files, **kwargs})
        return {"result": json.dumps(VERDICT), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return calls


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    for args in (("init", "-b", "main"), ("config", "user.email", "t@example.com"), ("config", "user.name", "T")):
        subprocess.run(["git", "-C", str(ws), *args], check=True, capture_output=True)
    (ws / "README.md").write_text("# demo\n")
    subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(ws), "commit", "-m", "init"], check=True, capture_output=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo_full, item_id: ws)
    return ws


def _run_main(monkeypatch, tmp_path, task) -> tuple[int, list]:
    posted = []
    monkeypatch.setattr(step_agent, "post_result", posted.append)
    monkeypatch.setattr(step_agent.handoff, "clear_note", lambda *a: None)
    path = tmp_path / "771.json"
    path.write_text(json.dumps(task))
    monkeypatch.setattr("sys.argv", ["step_agent", "--task", str(path)])
    return step_agent.main(), posted


def _status(ws: Path) -> str:
    return subprocess.run(["git", "-C", str(ws), "status", "--porcelain", "--ignored"], capture_output=True, text=True, check=True).stdout


# ---- metrics 1 and 2: the journey, task file to provider call ----


def test_verify_reads_the_whole_log_run_plan_and_reports_as_files_and_its_prompt_only_names_them(
    monkeypatch, tmp_path, workspace, reading_agent
):
    assert len(EXECUTE.encode()) > 300 * 1024, "sanity: the log really is ~300 KB"
    assert SECRET not in EXECUTE and "[redacted]" in EXECUTE, "sanity: the stored artifact is redacted"
    code, posted = _run_main(monkeypatch, tmp_path, _verify_task(_evidence(), repo="acme/demo"))
    assert code == 0 and posted[0]["ok"] is True

    [call] = reading_agent
    root, files, prompt = call["root"], call["files"], call["prompt"]
    assert call["add_dirs"] == [str(root)]
    assert root.parent == Path("/tmp") and root.name.startswith("horizon-verify-")
    assert not root.is_relative_to(workspace)

    # Metric 1: byte-for-byte as stored, plus one file per report section.
    assert files["execute-log.md"] == EXECUTE.encode("utf-8")
    assert files["run-plan.md"] == RUN_PLAN.encode("utf-8")
    reports = {name: data.decode() for name, data in files.items() if name.startswith("reports/")}
    assert sorted(reports) == ["reports/1-out-summary.json.md", "reports/2-etc-passwd.md"]
    assert reports["reports/1-out-summary.json.md"].startswith("### Report: out/summary.json\n")
    assert '{"rows": 6001, "failed": 1}\n## not a heading\n' in reports["reports/1-out-summary.json.md"]
    assert reports["reports/2-etc-passwd.md"] == "### Report: ../../etc/passwd\n\nrefused: outside the plan's cwd and /tmp\n"

    # Metric 2: each path named with a summary; no body text, no notice.
    for name in files:
        assert str(root / name) in prompt, name
    assert "## Evidence files" in prompt
    assert "10 command(s) run, 9 passed, 1 failed." in prompt
    assert "This attempt only" in prompt or "this attempt only" in prompt
    assert "10 command(s) in the Run plan block." in prompt
    assert job_reports.ATTEMPT_LOG_HEADING not in prompt
    assert "loaded ok" not in prompt and "checksum mismatch" not in prompt
    assert "## Run plan block" not in prompt and "json run-plan" not in prompt and "1. load the book" not in prompt
    assert '"rows": 6001' not in prompt
    assert "Truncation notice" not in prompt
    assert "assess: the scripts exist" in prompt, "the other inputs still ride in the prompt"

    # Guardrail 1: no secret in any file or the prompt.
    assert all(SECRET.encode() not in data for data in files.values())
    assert SECRET not in prompt

    # Guardrail 3: gone after the run, and nothing in the worktree to commit.
    assert not root.exists()
    assert _status(workspace) == ""


def test_the_summary_says_one_failed_and_names_the_last_command():
    root, reports = verify_evidence.write(_evidence())
    try:
        section = verify_evidence.prompt_section(root, _evidence(), reports)
    finally:
        verify_evidence.remove(root)
    [line] = [l for l in section.splitlines() if "execute-log.md" in l]
    assert "1 failed" in line
    assert "Did not exit 0: exit 1 — `python3 step10.py --key $PRICING_API_KEY`." in line
    assert "step9.py" not in line


def test_files_keep_non_ascii_crlf_and_a_missing_final_newline_byte_for_byte(monkeypatch, tmp_path, reading_agent):
    execute = "## Commands\n1 command(s) run, 1 passed, 0 failed\n- exit 0 — `load`\n\n## Log (this attempt)\nprix chargé ✅ 🚀\r\nwindows line\r\nlast line, no newline"
    plan = "## Plan\nété 💶\r\nno trailing newline"
    code, _ = _run_main(monkeypatch, tmp_path, _verify_task(_evidence(plan=plan, execute=execute)))
    assert code == 0
    files = reading_agent[0]["files"]
    assert files["execute-log.md"] == execute.encode("utf-8")
    assert files["run-plan.md"] == plan.encode("utf-8")


# ---- guardrail 3: never left behind, never in a clone ----


def test_the_scratch_folder_is_gone_when_the_agent_fails(monkeypatch, tmp_path, workspace):
    seen = []

    def failing(prompt, **kwargs):
        root = Path(kwargs["add_dirs"][0])
        seen.append((root, (root / "execute-log.md").exists()))
        raise AgentError("claude exited 1: boom")

    monkeypatch.setattr(step_agent, "run_agent", failing)
    code, posted = _run_main(monkeypatch, tmp_path, _verify_task(_evidence(), repo="acme/demo"))
    assert posted[0]["ok"] is False, (code, posted)
    [(root, existed)] = seen
    assert existed, "the files were there while the agent ran"
    assert not root.exists()
    assert _status(workspace) == ""


def test_a_report_path_with_dotdot_stays_inside_the_reports_folder():
    execute = (
        "## Commands\n1 command(s) run\n\n## Reports\n\n"
        "### Report: ../../../home/farm/.ssh/id\n\nmissing: no such file\n\n"
        "### Report: ..\n\nmissing: no such file\n\n## Log (this attempt)\nok\n"
    )
    root, reports = verify_evidence.write([{"label": "Execute", "content": execute}])
    try:
        assert [p.name for p in reports] == ["1-home-farm-.ssh-id.md", "2-report.md"]
        assert all(p.resolve().parent == (root / "reports").resolve() for p in reports)
        assert sorted(p.name for p in root.iterdir()) == ["execute-log.md", "reports"]
    finally:
        verify_evidence.remove(root)
    assert not root.exists()


def test_a_step_with_no_evidence_gets_no_section_and_no_folder(monkeypatch, tmp_path, reading_agent):
    task = _verify_task(None)
    del task["evidence"]
    code, _ = _run_main(monkeypatch, tmp_path, task)
    assert code == 0
    assert reading_agent[0]["add_dirs"] is None
    assert "## Evidence files" not in reading_agent[0]["prompt"]


def test_an_execute_entry_not_supplied_is_said_so():
    evidence = _evidence()[:1]
    root, reports = verify_evidence.write(evidence)
    try:
        section = verify_evidence.prompt_section(root, evidence, reports)
    finally:
        verify_evidence.remove(root)
    assert "- Execute log: not supplied." in section


# ---- guardrail 1: the queue file farmd writes holds no secret ----


def test_the_queued_task_file_holds_the_evidence_and_no_secret(monkeypatch):
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: False)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    task = _verify_task(_evidence(), repo="acme/demo")
    task.update(run_id=77101, project={"id": 1, "name": "FinTekkers"})
    task["step"]["key"] = "task.verify-report"
    path = QUEUE_DIR / "runs" / "77101.json"
    try:
        res = TestClient(farmd.app).post("/steps/run", json=task)
        assert res.status_code == 200, res.text
        queued = path.read_text()
        assert json.loads(queued)["evidence"] == task["evidence"]
        assert SECRET not in queued
    finally:
        farmd.state.update(saved)
        path.unlink(missing_ok=True)


# ---- the provider wiring: the automated stand-in for metric 4 ----


def test_the_claude_argv_carries_one_add_dir_per_folder_and_keeps_the_read_only_tools(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    argvs = []

    def fake_run(cmd, **kwargs):
        argvs.append(cmd)
        return SimpleNamespace(returncode=0, stdout=json.dumps({"result": "{}", "session_id": "s"}), stderr="")

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    claude.run("p", allowed_tools=step_agent.PLANNER_TOOLS, add_dirs=["/tmp/horizon-verify-a", "/tmp/horizon-verify-b"])
    claude.run("p", allowed_tools=step_agent.PLANNER_TOOLS)
    with_dirs, without = argvs
    pairs = [with_dirs[i + 1] for i, arg in enumerate(with_dirs) if arg == "--add-dir"]
    assert pairs == ["/tmp/horizon-verify-a", "/tmp/horizon-verify-b"]
    assert "--add-dir" not in without
    assert step_agent.PLANNER_TOOLS == "Read,Glob,Grep"
    assert with_dirs[with_dirs.index("--allowedTools") + 1] == "Read,Glob,Grep"


def test_the_sdk_options_carry_add_dirs(monkeypatch):
    import claude_agent_sdk as sdk

    monkeypatch.setenv("FARM_RUNNER", "sdk")
    seen = []
    real_options = sdk.ClaudeAgentOptions

    def recording_options(**kwargs):
        seen.append(kwargs)
        return real_options(**kwargs)

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield sdk.ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="s", result="{}"
            )

        return gen()

    monkeypatch.setattr(sdk, "ClaudeAgentOptions", recording_options)
    monkeypatch.setattr(sdk, "query", fake_query)
    claude.run("p", add_dirs=["/tmp/horizon-verify-a"])
    claude.run("p")
    assert seen[0]["add_dirs"] == ["/tmp/horizon-verify-a"]
    assert seen[1]["add_dirs"] == []


def test_run_agent_forwards_add_dirs_and_refuses_a_provider_that_cannot_read_them(monkeypatch):
    calls = []
    monkeypatch.setattr(claude, "assert_subscription_auth", lambda: None)
    monkeypatch.setattr(claude, "run", lambda prompt, **kw: calls.append(kw) or {"result": "{}", "session_id": "s"})
    agent_runner.run_agent("p", agent="qa", step=step_agent.VERIFY_REPORT_LABEL, provider="claude", add_dirs=["/tmp/x"])
    agent_runner.run_agent("p", agent="qa", step=step_agent.VERIFY_REPORT_LABEL, provider="claude")
    assert calls[0]["add_dirs"] == ["/tmp/x"]
    assert "add_dirs" not in calls[1]

    muse_calls = []
    monkeypatch.setattr(agent_runner.muse, "run", lambda prompt, **kw: muse_calls.append(kw))
    with pytest.raises(AgentError, match="cannot read add_dirs"):
        agent_runner.run_agent("p", agent="qa", step=step_agent.VERIFY_REPORT_LABEL, provider="muse", add_dirs=["/tmp/x"])
    assert muse_calls == []


def test_verify_is_locked_to_a_provider_that_reads_add_dirs():
    assert steps.by_kind_label("task", step_agent.VERIFY_REPORT_LABEL)["providerLocked"] is True
    with pytest.raises(AgentError, match="provider-locked"):
        agent_runner._selected_provider("muse", provider_locked=True)
    name, module = agent_runner._selected_provider(None, provider_locked=True)
    assert name == agent_runner.DEFAULT_PROVIDER == "claude"
    assert module.READS_ADD_DIRS is True
