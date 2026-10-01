"""HZ-182, farm half: the fix-pass implement run and the delta review.

The server decides the scope; these tests check this side executes it
faithfully and falls back to a full review whenever the delta can't be trusted.
"""

import json
import subprocess

from farm import step_agent
from farm.step_agent import execute

IMPLEMENT = "Specialist agent implements"
REVIEW = "Automated review (code + QA)"
FINDING = {"index": 0, "file": "fix.py", "line": 1, "detail": "FINDING_DETAIL_TEXT"}


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def commit(ws, files, message):
    for name, text in files.items():
        (ws / name).write_text(text)
    git(ws, "add", "-A")
    git(ws, "commit", "-m", message)
    return git(ws, "rev-parse", "HEAD")


def pr_workspace(tmp_path, monkeypatch):
    """main has README; horizon/t-1 adds old.py (reviewed at `base`) then the
    fix commit. Both pushed, like a real PR branch after a fix pass."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-b", "main")
    git(seed, "config", "user.email", "t@example.com")
    git(seed, "config", "user.name", "T")
    commit(seed, {"README.md": "# demo\n"}, "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    git(ws, "checkout", "-b", "horizon/t-1")
    base = commit(ws, {"old.py": "OLD_REVIEWED_LINE = 1\n"}, "first attempt")
    commit(ws, {"fix.py": "FIX_LINE = 2\n"}, "fix pass")
    git(ws, "push", "-u", "origin", "horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    return ws, base


def task(label, scope):
    return {
        "run_id": 1,
        "attempt": 2,
        "item": {"id": "T-1", "title": "t", "desc": "", "metric": "", "guardrails": "", "priority": "High",
                 "repo": "acme/demo", "issue": 42},
        "step": {"index": 0, "label": label, "agent": "Eng"},
        "artifacts": [],
        "feedback": [{"message": "Automated review cycle 1/3 failed — fix and re-implement."}],
        "scope": scope,
    }


def fake_reviewers(monkeypatch, code_reply, qa_reply, prompts):
    def _fake(prompt, **kwargs):
        prompts.append(prompt)
        is_qa = "QA Reviewer" in (kwargs.get("append_system") or "")
        return {"result": json.dumps(qa_reply if is_qa else code_reply)}

    monkeypatch.setattr(step_agent, "run_agent", _fake)


QA_PASS = {"verdict": "pass", "regression_tests_run": True, "new_code_unit_coverage": True, "e2e_test_present": True,
           "findings": [], "artifact_md": "## QA review"}


def review(ws, base, monkeypatch, code=None, qa=None, findings=(FINDING,)):
    prompts = []
    code = code if code is not None else {"verdict": "pass", "findings": [],
                                          "previous_findings": [{"index": 0, "resolved": True, "detail": "fixed"}]}
    qa = qa if qa is not None else {**QA_PASS, "previous_findings": [{"index": 0, "resolved": True}]}
    fake_reviewers(monkeypatch, code, qa, prompts)
    result = execute(task(REVIEW, {"mode": "delta", "base_sha": base, "previous_findings": list(findings)}))
    return result["artifacts"], prompts[0]


def test_delta_review_reads_only_the_fix_and_the_previous_findings(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    artifacts, prompt = review(ws, base, monkeypatch)
    assert "FIX_LINE = 2" in prompt
    assert "OLD_REVIEWED_LINE" not in prompt  # already reviewed: excluded
    assert "FINDING_DETAIL_TEXT" in prompt
    assert artifacts["review_mode"] == "delta"
    assert artifacts["delta_files"] == ["fix.py"]
    assert artifacts["reviewed_sha"] == git(ws, "rev-parse", "HEAD")
    assert artifacts["verdict"]["previous_findings"] == [{"index": 0, "resolved": True, "detail": "fixed"}]


def test_previous_findings_merge_fail_closed_across_both_reviewers(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    qa = {**QA_PASS, "previous_findings": [{"index": 0, "resolved": False}]}
    artifacts, _ = review(ws, base, monkeypatch, qa=qa)
    assert artifacts["verdict"]["previous_findings"][0]["resolved"] is False


def test_an_empty_reviewer_reply_leaves_every_previous_finding_unresolved(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    artifacts, _ = review(ws, base, monkeypatch, code={}, qa={})
    verdict = artifacts["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["previous_findings"] == [{"index": 0, "resolved": False, "detail": ""}]


def test_files_outside_the_findings_are_listed_for_the_reviewer(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    commit(ws, {"other.py": "EXTRA = 3\n"}, "also touched")
    git(ws, "push", "origin", "horizon/t-1")
    artifacts, prompt = review(ws, base, monkeypatch)
    assert artifacts["delta_files"] == ["fix.py", "other.py"]
    listed = prompt.split("Changed outside the findings")[1].split("## Code diff under review")[0]
    assert "`other.py`" in listed and "`fix.py`" not in listed
    assert "EXTRA = 3" in prompt


def test_a_rebased_away_base_falls_back_to_a_full_review(tmp_path, monkeypatch):
    # The orphaned commit still exists in the object store; only the ancestor
    # check catches it.
    ws, base = pr_workspace(tmp_path, monkeypatch)
    git(ws, "reset", "--hard", "origin/main")
    commit(ws, {"old.py": "REWRITTEN = 1\n"}, "rebased")
    git(ws, "push", "--force", "origin", "horizon/t-1")
    assert git(ws, "cat-file", "-t", base) == "commit"
    artifacts, prompt = review(ws, base, monkeypatch)
    assert artifacts["review_mode"] == "full"
    assert artifacts["scope_fallback"] == "base_not_ancestor"
    assert "previous_findings" not in artifacts["verdict"]
    assert "REWRITTEN = 1" in prompt


def test_a_missing_base_falls_back_to_a_full_review(tmp_path, monkeypatch):
    ws, _ = pr_workspace(tmp_path, monkeypatch)
    artifacts, prompt = review(ws, "0123456789abcdef0123456789abcdef01234567", monkeypatch)
    assert artifacts["review_mode"] == "full"
    assert artifacts["scope_fallback"] == "base_missing"
    assert "OLD_REVIEWED_LINE" in prompt


def test_a_merge_from_main_over_pr_files_falls_back_to_a_full_review(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    git(ws, "checkout", "main")
    commit(ws, {"old.py": "MAIN_EDIT = 1\n"}, "main touches a PR file")
    git(ws, "push", "origin", "main")
    git(ws, "checkout", "horizon/t-1")
    subprocess.run(["git", "-C", str(ws), "merge", "origin/main", "-X", "ours", "--no-edit"], check=True, capture_output=True)
    git(ws, "push", "origin", "horizon/t-1")
    artifacts, _ = review(ws, base, monkeypatch)
    assert artifacts["scope_fallback"] == "main_merged"
    assert artifacts["review_mode"] == "full"


def test_fix_pass_implement_runs_on_the_reduced_budget_with_the_scope_rule(tmp_path, monkeypatch):
    ws, base = pr_workspace(tmp_path, monkeypatch)
    captured = {}

    def _fake(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        (ws / "fix.py").write_text("FIX_LINE = 2\nGUARD = True\n")
        return {"result": '{"summary": "guarded it"}'}

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    scope = {"mode": "fix", "base_sha": base, "max_turns": 53, "timeout_s": 900,
             "findings": [{"file": "fix.py", "line": 1, "detail": "FINDING_DETAIL_TEXT"}]}
    result = execute(task(IMPLEMENT, scope))
    assert captured["max_turns"] == 53
    assert captured["timeout_s"] == 900
    assert "## Fix pass" in captured["prompt"]
    assert "Files the findings involve: `fix.py`" in captured["prompt"]
    # Findings arrive once, via the feedback list — not repeated by the scope rule.
    assert "FINDING_DETAIL_TEXT" not in captured["prompt"]
    assert result["artifacts"]["fix_diff_lines"] == 2  # base..HEAD: fix.py, two added lines
    assert result["artifacts"]["fix_diff_files"] == ["fix.py"]


def test_a_full_implement_task_keeps_the_full_budget(tmp_path, monkeypatch):
    ws, _ = pr_workspace(tmp_path, monkeypatch)
    captured = {}

    def _fake(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        (ws / "new.py").write_text("X = 1\n")
        return {"result": '{"summary": "did it"}'}

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    result = execute(task(IMPLEMENT, {"mode": "full"}))
    assert (captured["max_turns"], captured["timeout_s"]) == step_agent.steps.budget_for_label(step_agent.steps.STEPS, IMPLEMENT)
    assert "## Fix pass" not in captured["prompt"]
    assert "fix_diff_lines" not in result["artifacts"]
