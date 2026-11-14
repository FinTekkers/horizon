"""HO-845: one stage of an owner-patched command's checks (farm/command_checks.py)
and farmd's POST /commands/check.

Each stage runs on a one-command block holding only the patched command k,
bound to k's hash. Its result — the callback body the server reads — holds
only allowlisted keys: names, access flags and reason ids. A fixture secret
and fixture file contents, echoed by every stubbed checker in its output and
in its exception text, never reach the result or farmd's log.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from domain.py import run_plan
from farm import command_checks, container_runner, farmd, preflight, run_plan_requires, task_job

REPO_ROOT = Path(__file__).resolve().parents[2]
SECRET = "hz845-fixture-secret-91c2"
FILE_CONTENTS = "hz845-fixture-file-contents-5be0"
RESULT_KEYS = {"stage", "status", "command_hash", "reason", "summary"}
SUMMARY_KEYS = {"gaps", "env", "files", "failures"}

client = TestClient(farmd.app)


def artifact_of(block: dict) -> str:
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


BLOCK = {
    "cwd": ".",
    "commands": ["./load.sh --since 2026-11-01", "jq -e '.rows | length' out.json"],
    "budget_minutes": 5,
    "requires": [{"tool": "jq"}],
    "proof": [{"line": 1, "command": 2}],
    "rehearsal": {"dry_run": "./load.sh --dry-run", "samples": [{"command": 2, "expect": "3"}]},
}


def task_for(block: dict = BLOCK, k: int = 1, **extra) -> dict:
    artifact = artifact_of(block)
    return {
        "check_id": 7,
        "command_index": k,
        "command_hash": command_checks.command_hash_of(block["commands"][k]),
        "plan_artifact": artifact,
        "plan_hash": task_job.plan_hash_of(artifact),
        "runner": "host",
        "item": {"id": "HO-900", "kind": "task", "repo": "FinTekkers/horizon"},
        **extra,
    }


def assert_allowlisted(result: dict) -> None:
    assert set(result) == RESULT_KEYS
    assert set(result["summary"]) <= SUMMARY_KEYS
    assert result["reason"] is None or result["reason"] in command_checks.REASONS
    text = json.dumps(result)
    assert SECRET not in text and FILE_CONTENTS not in text


def no_rehearse(_task):
    raise AssertionError("no rehearsal may run for this stage")


# ---- guardrail 3: k by hash, and the same hash as the server's ----


def test_command_hash_matches_the_shared_fixture_the_server_asserts_too():
    cases = json.loads((REPO_ROOT / "domain" / "fixtures" / "run-plan-cases.json").read_text())["command_hash"]
    assert any(any(ord(ch) > 127 for ch in case["command"]) for case in cases)
    for case in cases:
        assert command_checks.command_hash_of(case["command"]) == case["hash"], case["case"]


@pytest.mark.parametrize("stage", command_checks.STAGES)
def test_a_command_whose_text_no_longer_matches_its_hash_fails_command_hash_changed(stage):
    task = task_for(command_hash=command_checks.command_hash_of("something else"))
    got = command_checks.run_stage(stage, task, rehearse=no_rehearse)
    assert (got["status"], got["reason"]) == ("fail", "command_hash_changed")
    assert_allowlisted(got)


def test_a_plan_that_is_not_the_one_on_record_fails_command_hash_changed():
    got = command_checks.run_stage("audit", task_for(plan_hash="0" * 64), rehearse=no_rehearse)
    assert (got["status"], got["reason"]) == ("fail", "command_hash_changed")


def test_the_one_command_block_holds_only_k_with_its_proof_and_sample_renumbered():
    one = command_checks.one_command_block(BLOCK, 1)
    assert one["commands"] == [BLOCK["commands"][1]]
    assert one["proof"] == [{"line": 1, "command": 1}]
    assert one["rehearsal"] == {"dry_run": "./load.sh --dry-run", "samples": [{"command": 1, "expect": "3"}]}
    assert one["requires"] == BLOCK["requires"]
    first = command_checks.one_command_block(BLOCK, 0)
    assert first["commands"] == [BLOCK["commands"][0]] and "proof" not in first and "samples" not in first["rehearsal"]


# ---- each stage, for real where it is static ----


def test_audit_passes_a_declared_tool_and_fails_an_undeclared_one_by_name_only():
    passed = command_checks.run_stage("audit", task_for(), rehearse=no_rehearse)
    assert (passed["status"], passed["reason"]) == ("pass", None)
    block = {**BLOCK, "requires": []}
    failed = command_checks.run_stage("audit", task_for(block), rehearse=no_rehearse)
    assert (failed["status"], failed["reason"]) == ("fail", "command_check_failed")
    assert failed["summary"] == {"gaps": [{"kind": "tool", "name": "jq"}]}


def test_preflight_runs_on_the_one_command_plan_and_reports_unmet_names_only(monkeypatch):
    seen = {}

    def fake_run(task, *, deadline):
        seen["block"] = run_plan.extract(task["plan_artifact"])
        seen["hash_ok"] = task_job.plan_hash_of(task["plan_artifact"]) == task["plan_hash"]
        return {
            "passed": False,
            "unmet": [
                {"kind": "env", "name": "DB_URL", "reason": f"not set ({SECRET})"},
                {"kind": "file", "name": "/etc/horizon/db.conf", "reason": f"unreadable: {FILE_CONTENTS}"},
                {"kind": "tool", "name": f"{SECRET} {FILE_CONTENTS}", "reason": "bad"},
            ],
        }

    monkeypatch.setattr(preflight, "run", fake_run)
    got = command_checks.run_stage("preflight", task_for(), rehearse=no_rehearse)
    assert seen["block"]["commands"] == [BLOCK["commands"][1]] and seen["hash_ok"]
    assert (got["status"], got["reason"]) == ("fail", "command_check_failed")
    assert got["summary"]["env"] == [{"name": "DB_URL", "set": False}]
    assert got["summary"]["files"] == [{"path": "/etc/horizon/db.conf", "readable": False}]
    assert {g["kind"] for g in got["summary"]["gaps"]} == {"env", "file"}
    assert_allowlisted(got)


def test_rehearsal_runs_k_only_and_keeps_reason_ids_never_output(monkeypatch):
    seen = {}

    def rehearse(task):
        seen["block"] = run_plan.extract(task["plan_artifact"])
        return {
            "clean": False,
            "reason": "rehearsal_parser_failed",
            "output": f"{SECRET}\n{FILE_CONTENTS}",
            "failures": [
                {"what": "proof command 1 (metric line 1)", "reason": "rehearsal_parser_failed", "exit": 5, "stderr": SECRET},
                {"what": f"echo {SECRET}", "reason": "rehearsal_parser_failed", "exit": 1},
            ],
        }

    got = command_checks.run_stage("rehearsal", task_for(), rehearse=rehearse)
    assert seen["block"]["commands"] == [BLOCK["commands"][1]]
    assert (got["status"], got["reason"]) == ("fail", "command_check_failed")
    assert got["summary"] == {"failures": [{"what": "proof command 1 (metric line 1)", "reason": "rehearsal_parser_failed", "exit": 5}]}
    assert_allowlisted(got)
    clean = command_checks.run_stage("rehearsal", task_for(), rehearse=lambda _t: {"clean": True, "failures": []})
    assert (clean["status"], clean["reason"]) == ("pass", None)


# ---- metric 3 / guardrail 2: an error or an unavailable sandbox is never a pass ----


@pytest.mark.parametrize(
    ("stage", "target", "exc", "reason"),
    [
        ("audit", "contract_gaps", RuntimeError, "command_check_error"),
        ("preflight", "run", RuntimeError, "command_check_error"),
        ("preflight", "run", run_plan_requires.Unavailable, "command_check_unavailable"),
        ("rehearsal", None, container_runner.Unavailable, "command_check_unavailable"),
        ("rehearsal", None, ValueError, "command_check_error"),
    ],
)
def test_a_checker_that_raises_is_an_error_with_no_exception_text(monkeypatch, stage, target, exc, reason):
    def boom(*_a, **_k):
        raise exc(f"leaked {SECRET} {FILE_CONTENTS}")

    if target == "contract_gaps":
        monkeypatch.setattr(run_plan_requires, "contract_gaps", boom)
    elif target == "run":
        monkeypatch.setattr(preflight, "run", boom)
    got = command_checks.run_stage(stage, task_for(), rehearse=boom)
    assert (got["status"], got["reason"]) == ("error", reason)
    assert_allowlisted(got)


# ---- farmd's route ----


@pytest.fixture
def posted(monkeypatch):
    """Runs the stage inline and captures the result farmd posts back."""
    sent = []

    class Inline:
        def __init__(self, target, args, **_k):
            self.target, self.args = target, args

        def start(self):
            self.target(*self.args)

    class Reply:
        status_code = 200

    monkeypatch.setattr(farmd.threading, "Thread", Inline)
    monkeypatch.setattr(farmd.httpx, "post", lambda url, json, headers, timeout: sent.append((url, json, headers)) or Reply())
    monkeypatch.setattr(farmd, "_stamp_preflight_context", lambda task: task.update(jobs_enabled=True, job_uid=1000, job_env_names=[]))
    return sent


def test_farmd_runs_a_stage_and_posts_only_the_allowlisted_result(posted, monkeypatch, capsys):
    monkeypatch.setattr(preflight, "run", lambda task, *, deadline: {"passed": False, "unmet": [{"kind": "env", "name": "DB_URL", "reason": SECRET}]})
    res = client.post("/commands/check", json={**task_for(), "stage": "preflight", "test_env_file": "/home/u/.login.env"})
    assert res.status_code == 202 and res.json() == {"accepted": True}
    [(url, body, headers)] = posted
    assert url.endswith("/api/farm/command-checks/7/result") and headers["x-farm-secret"]
    assert body["status"] == "fail" and body["stage"] == "preflight"
    assert_allowlisted(body)
    log = capsys.readouterr().out
    assert "command check 7 preflight: fail (command_check_failed)" in log
    assert SECRET not in log and FILE_CONTENTS not in log


def test_farmd_refuses_a_bad_stage_and_a_rehearsal_with_no_sandbox(posted, monkeypatch):
    assert client.post("/commands/check", json={**task_for(), "stage": "deploy"}).status_code == 400
    assert client.post("/commands/check", json={**task_for(), "command_hash": "nope", "stage": "audit"}).status_code == 400
    monkeypatch.setattr(container_runner, "available", lambda: False)
    res = client.post("/commands/check", json={**task_for(), "stage": "rehearsal"})
    assert res.status_code == 409 and res.json() == {"error": "sandbox_unavailable"}
    assert posted == []
