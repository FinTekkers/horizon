"""HZ-345, farm half: line budgets on steps 1-2, and violation-only guardrail review.

Budgets are read off domain/fields.json (pm_steps.LINE_LIMITS), never typed
here. The review cases run the real review branch of step_agent.execute() over
a real git diff, with only the two reviewer model calls stubbed.
"""

import json
import subprocess
from types import SimpleNamespace

import pytest

from domain.py import fields, steps
from farm import pm_steps, step_agent
from farm.step_agent import execute

MEASURE = "Define how we measure success"
GUARDRAILS = "Set guardrails"
SUMMARIZE = "Summarize reviews & recommend"
IMPLEMENT = "Specialist agent implements"
REVIEW = "Automated review (code + QA)"


def numbered(prefix: str, count: int) -> str:
    return "\n".join(f"{n}. {prefix} line {n}" for n in range(1, count + 1))


def bullets(prefix: str, count: int) -> str:
    return "\n".join(f"- {prefix} {n}" for n in range(1, count + 1))


# ---- metric line 1: the PM steps keep metric <= 5 and guardrails <= 4 lines ----


def _pm_task(label: str, **item) -> dict:
    return {
        "run_id": 345,
        "attempt": 1,
        "item": {"id": "HZ-345", "title": "t", "metric": "old metric", "guardrails": "old guardrails", **item},
        "step": {"index": steps.by_label(label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


@pytest.fixture
def pm(run_pm_step):
    """A real PM step through step_agent.main(), run_agent and the result
    post stubbed (run_pm_step)."""
    lane = SimpleNamespace(replies=[], calls=[], posted=[])

    def fake_run_agent(prompt, **kw):
        lane.calls.append({"prompt": prompt, **kw})
        return {"result": lane.replies.pop(0), "session_id": "sess-345"}


    def run(label, item, *replies):
        lane.replies = list(replies)
        lane.calls.clear()
        lane.posted.clear()
        lane.posted.append(run_pm_step(_pm_task(label, **item), fake_run_agent))
        assert len(lane.posted) == 1
        return lane.posted[0]

    lane.run = run
    return lane


def _reply(summary="revised", **patch) -> str:
    return json.dumps({"summary": summary, "patch": patch})


def test_the_line_budgets_come_from_fields_json():
    assert pm_steps.LINE_LIMITS == fields.line_limits(fields.FIELDS)
    assert set(pm_steps.LINE_LIMITS) == {"metric", "guardrails"}
    assert f"metric <={pm_steps.LINE_LIMITS['metric']} lines" in pm_steps.ROLE_PROMPT
    assert f"guardrails <={pm_steps.LINE_LIMITS['guardrails']} lines" in pm_steps.ROLE_PROMPT


def test_r1_an_8_line_metric_is_retried_and_the_kept_reply_names_the_dropped_lines(pm):
    limit = pm_steps.LINE_LIMITS["metric"]
    before = numbered("metric", limit + 3)
    lines = before.split("\n")
    kept = "\n".join(lines[:limit])
    result = pm.run(MEASURE, {"metric": before}, _reply(metric=before), _reply(summary="merged the metric", metric=kept))

    assert len(pm.calls) == 2
    assert f"metric has {limit + 3} lines; budget is {limit} lines" in pm.calls[1]["prompt"]
    assert result["ok"] is True
    assert fields.count_criteria_lines(result["patch"]["metric"]) <= limit
    dropped = ", ".join(str(n) for n in range(limit + 1, limit + 4))
    assert f"merged or dropped metric lines {dropped} of {limit + 3}" in result["summary"]
    assert result["summary"].startswith("merged the metric")


def test_r3_9_guardrails_cut_to_4_in_one_reply_still_name_the_5_dropped_lines(pm):
    limit = pm_steps.LINE_LIMITS["guardrails"]
    before = bullets("guardrail", limit + 5)
    kept = "\n".join(before.split("\n")[:limit])
    result = pm.run(GUARDRAILS, {"guardrails": before}, _reply(guardrails=kept))

    assert len(pm.calls) == 1, "a reply within budget takes no retry"
    assert result["ok"] is True
    assert fields.count_criteria_lines(result["patch"]["guardrails"]) == limit
    dropped = ", ".join(str(n) for n in range(limit + 1, limit + 6))
    assert f"merged or dropped guardrails lines {dropped} of {limit + 5}" in result["summary"]


def test_r2_a_retry_still_over_budget_fails_the_step_with_no_patch(pm):
    limit = pm_steps.LINE_LIMITS["metric"]
    over = numbered("metric", limit + 1)
    result = pm.run(MEASURE, {"metric": numbered("metric", limit + 3)}, _reply(metric=over), _reply(metric=over))

    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result
    assert f"metric has {limit + 1} lines; budget is {limit} lines" in result["error"]


def test_a_reply_that_leaves_an_over_budget_field_unpatched_is_rejected(pm):
    limit = pm_steps.LINE_LIMITS["guardrails"]
    result = pm.run(GUARDRAILS, {"guardrails": bullets("g", limit + 2)}, _reply(), _reply())
    assert result["ok"] is False
    assert f"guardrails has {limit + 2} lines in the item and your reply did not patch it" in result["error"]


def test_g2_a_summarize_reply_with_8_metric_lines_is_not_rejected(pm):
    metric = numbered("metric", pm_steps.LINE_LIMITS["metric"] + 3)
    result = pm.run(SUMMARIZE, {"metric": metric}, _reply(metric=metric))
    assert len(pm.calls) == 1
    assert result["ok"] is True
    assert result["patch"]["metric"] == metric
    assert "merged or dropped" not in result["summary"]


def test_each_step_line_checks_only_the_field_it_owns(pm):
    over_metric = numbered("metric", pm_steps.LINE_LIMITS["metric"] + 1)
    result = pm.run(GUARDRAILS, {}, _reply(metric=over_metric, guardrails="- one"))
    assert len(pm.calls) == 1
    assert result["ok"] is True


# ---- metric line 2: guardrails fail on a quoted violation only ----

GUARDRAIL_TEXT = "- Never write to the ledger.\n- Keep the CSV format stable."
METRIC_TEXT = "Each line is pass/fail.\n1. The export runs in under a minute.\n2. Manual: post the before/after numbers in the PR."
VIOLATION = "LEDGER.write(row)  # mirror the export"


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def commit(ws, files, message):
    for name, text in files.items():
        (ws / name).write_text(text)
    git(ws, "add", "-A")
    git(ws, "commit", "-m", message)


def pr_workspace(tmp_path, monkeypatch, branch_text):
    """main has export.py; horizon/t-1 changes it. Pushed, like a real PR branch."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-b", "main")
    git(seed, "config", "user.email", "t@example.com")
    git(seed, "config", "user.name", "T")
    commit(seed, {"export.py": "import csv\nREAD_ONLY_REPLICA = True\n"}, "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    git(ws, "checkout", "-b", "horizon/t-1")
    commit(ws, {"export.py": branch_text}, "implement")
    git(ws, "push", "-u", "origin", "horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    return ws


QA_PASS = {"verdict": "pass", "regression_tests_run": True, "new_code_unit_coverage": True, "e2e_test_present": True,
           "findings": [], "artifact_md": "## QA review\n**pass**"}
CODE_PASS = {"verdict": "pass", "findings": [], "artifact_md": "## Code review\n**pass**"}


def run_review(tmp_path, monkeypatch, *, code=CODE_PASS, qa=QA_PASS, branch_text=None, implement_output=None):
    branch_text = branch_text or "import csv\nREAD_ONLY_REPLICA = True\nROWS = load()\n"
    pr_workspace(tmp_path, monkeypatch, branch_text)

    def fake(prompt, **kwargs):
        is_qa = "QA Reviewer" in (kwargs.get("append_system") or "")
        return {"result": json.dumps(qa if is_qa else code)}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    artifacts = []
    if implement_output is not None:
        artifacts.append({"label": IMPLEMENT, "content": implement_output})
    result = execute({
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "", "metric": METRIC_TEXT, "guardrails": GUARDRAIL_TEXT,
                 "priority": "High", "repo": "acme/demo", "issue": 42},
        "step": {"index": 12, "label": REVIEW, "agent": "Review"},
        "artifacts": artifacts,
        "feedback": [],
    })
    return result["artifacts"]


def guardrail_block(**extra):
    return {"file": "export.py", "line": 3, "severity": "block", **extra}


@pytest.mark.parametrize("which", ["code_review", "qa_review"])
def test_r5_a_no_evidence_guardrail_block_on_an_untouched_guardrail_passes(tmp_path, monkeypatch, which):
    finding = guardrail_block(detail="No evidence the guardrail 'Never write to the ledger' held.")
    code = {**CODE_PASS, "verdict": "fail", "findings": [finding]} if which == "code_review" else CODE_PASS
    qa = {**QA_PASS, "verdict": "fail", "findings": [finding]} if which == "qa_review" else QA_PASS
    artifacts = run_review(tmp_path, monkeypatch, code=code, qa=qa)

    verdict = artifacts["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"
    assert verdict[which]["findings"][0]["severity"] == "note"
    assert len(verdict["guardrail_downgrades"]) == 1
    assert verdict["guardrail_downgrades"][0]["pass"] == which
    assert "Downgraded 1 finding(s)" in artifacts["artifact_md"]


def test_r6_a_quoted_violation_stays_a_block_and_keeps_both_quotes(tmp_path, monkeypatch):
    finding = guardrail_block(
        detail="Writes to the ledger; read-only access is not shown anywhere.",
        guardrail="Never write to the ledger.",
        diff_line=f"+{VIOLATION}",
    )
    artifacts = run_review(
        tmp_path,
        monkeypatch,
        code={**CODE_PASS, "verdict": "fail", "findings": [finding]},
        branch_text=f"import csv\nREAD_ONLY_REPLICA = True\n{VIOLATION}\n",
    )
    section = artifacts["verdict"]["code_review"]
    assert section["verdict"] == "fail"
    assert section["findings"] == [finding]
    assert "guardrail_downgrades" not in artifacts["verdict"]


def test_r7_a_diff_line_quoted_from_a_context_line_is_downgraded(tmp_path, monkeypatch):
    finding = guardrail_block(
        detail="Breaks the ledger guardrail.",
        guardrail="Never write to the ledger.",
        diff_line="READ_ONLY_REPLICA = True",
    )
    artifacts = run_review(tmp_path, monkeypatch, code={**CODE_PASS, "verdict": "fail", "findings": [finding]})
    verdict = artifacts["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert "not an added or removed line" in verdict["guardrail_downgrades"][0]["reason"]


def test_a_paraphrased_guardrail_is_downgraded(tmp_path, monkeypatch):
    finding = guardrail_block(detail="Breaks a guardrail.", guardrail="Do not touch the ledger", diff_line=f"+{VIOLATION}")
    artifacts = run_review(
        tmp_path,
        monkeypatch,
        code={**CODE_PASS, "verdict": "fail", "findings": [finding]},
        branch_text=f"import csv\nREAD_ONLY_REPLICA = True\n{VIOLATION}\n",
    )
    assert artifacts["verdict"]["code_review"]["verdict"] == "pass"
    assert "does not quote the guardrail" in artifacts["verdict"]["guardrail_downgrades"][0]["reason"]


MANUAL_BLOCK = {"file": "PR", "line": 1, "severity": "block", "metric_line": 2, "detail": "No test for line 2."}


def test_r8_a_manual_line_with_a_pr_statement_passes(tmp_path, monkeypatch):
    output = "built the export · checks passed — opened PR #7\n\n## Manual checks\n- Line 2: the owner posts the numbers after 20 items."
    artifacts = run_review(
        tmp_path, monkeypatch, qa={**QA_PASS, "verdict": "fail", "findings": [MANUAL_BLOCK]}, implement_output=output
    )
    verdict = artifacts["verdict"]
    assert verdict["qa_review"]["verdict"] == "pass"
    assert "Manual metric line 2" in verdict["guardrail_downgrades"][0]["reason"]


def test_r8_a_manual_line_without_a_statement_keeps_the_block_and_names_the_line(tmp_path, monkeypatch):
    output = "built the export · checks passed — opened PR #7"
    artifacts = run_review(
        tmp_path, monkeypatch, qa={**QA_PASS, "verdict": "fail", "findings": [MANUAL_BLOCK]}, implement_output=output
    )
    section = artifacts["verdict"]["qa_review"]
    assert section["verdict"] == "fail"
    assert section["findings"][0]["severity"] == "block"
    assert "Manual line 2 has no statement under `## Manual checks`" in section["findings"][0]["detail"]
    assert "Manual: post the before/after numbers in the PR." in section["findings"][0]["detail"]


def test_r9_an_untested_automated_metric_line_that_mentions_guardrail_stays_a_block(tmp_path, monkeypatch):
    finding = {"file": "export.py", "line": 1, "severity": "block", "metric_line": 1,
               "detail": "Line 1 has no test; the guardrail suite does not time the export either."}
    artifacts = run_review(tmp_path, monkeypatch, qa={**QA_PASS, "verdict": "fail", "findings": [finding]})
    section = artifacts["verdict"]["qa_review"]
    assert section["verdict"] == "fail"
    assert section["findings"] == [finding]
    assert "guardrail_downgrades" not in artifacts["verdict"]


def test_r10_qa_stays_fail_when_a_check_is_false_even_with_every_block_downgraded(tmp_path, monkeypatch):
    finding = guardrail_block(detail="Guardrail not verified by any test.")
    qa = {**QA_PASS, "verdict": "fail", "new_code_unit_coverage": False, "findings": [finding]}
    artifacts = run_review(tmp_path, monkeypatch, qa=qa)
    section = artifacts["verdict"]["qa_review"]
    assert section["findings"][0]["severity"] == "note"
    assert section["verdict"] == "fail"


def test_a_fail_with_no_findings_stays_fail():
    section = {"verdict": "fail", "findings": []}
    result, downgrades = step_agent.downgrade_unproven_findings(
        section, guardrails=GUARDRAIL_TEXT, metric=METRIC_TEXT, diff="", manual_checks="", qa=False
    )
    assert result["verdict"] == "fail"
    assert downgrades == []


def test_a_defect_finding_with_no_guardrail_is_judged_as_written():
    finding = {"file": "export.py", "line": 3, "severity": "block", "detail": "Crashes on an empty file."}
    result, downgrades = step_agent.downgrade_unproven_findings(
        {"verdict": "fail", "findings": [finding]},
        guardrails=GUARDRAIL_TEXT, metric=METRIC_TEXT, diff="", manual_checks="", qa=False,
    )
    assert result == {"verdict": "fail", "findings": [finding]}
    assert downgrades == []


# ---- metric line 2(c): the implement step carries its Manual statements to the server ----


def test_the_implement_reply_s_manual_checks_reach_the_result_artifacts(tmp_path, monkeypatch):
    from farm.tests.test_step_agent import NO_CHECKS, _replies, make_git_workspace, make_task

    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    statement = "- Line 2: the owner posts the numbers after 20 items."
    fake, _calls = _replies(json.dumps({"summary": "built it", "manual_checks": f"  {statement}\n"}), writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, IMPLEMENT, repo="acme/demo", checks_waiver=NO_CHECKS))

    assert result["artifacts"]["manual_checks"] == statement
