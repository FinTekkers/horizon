"""HZ-728: a reply's ``asks`` list reaches the server untouched on every reply
path — the generic agent steps, both passes of the automated review and the
PM steps. The server (server/src/asks.js) validates and stores each ask; the
farm drops only an ``asks`` that is not a list."""

import json
import subprocess

import pytest

from domain.py import steps
from farm import pm_steps, step_agent
from farm.step_agent import execute

ASK = {
    "kind": "blocking",
    "title": "Publish script must use the bot identity",
    "repo": "acme/demo",
    "outcome": "The publish script commits as the bot.",
    "metric": "1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints it.",
    "guardrails": "1. No new secrets.",
    "why": "Architecture review: 'commits under the owner identity'",
}
SOFT = {**ASK, "kind": "soft", "title": "Document the identity"}


def generic_task(label, kind="change"):
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "d", "metric": "m", "guardrails": "", "priority": "Medium",
                 "repo": None, "issue": None, "kind": kind},
        "step": {"index": steps.by_kind_label(kind, label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


def reply_with(monkeypatch, **extra):
    def _fake(prompt, **kwargs):
        return {"result": json.dumps({"summary": "reviewed", "artifact_md": "## Verdict\n**pass**", **extra})}

    monkeypatch.setattr(step_agent, "run_agent", _fake)


@pytest.mark.parametrize(("label", "kind"), [("Architecture review", "change"), ("Impact review", "task")])
def test_asks_reach_the_artifacts_from_a_generic_step(monkeypatch, label, kind):
    reply_with(monkeypatch, asks=[ASK, SOFT])
    result = execute(generic_task(label, kind))
    assert result["artifacts"]["asks"] == [ASK, SOFT]
    assert result["artifacts"]["artifact_md"].endswith("## Verdict\n**pass**")


@pytest.mark.parametrize("value", [ASK, "file a follow-up", None])
def test_asks_that_are_not_a_list_are_dropped(monkeypatch, value):
    reply_with(monkeypatch, asks=value)
    result = execute(generic_task("Architecture review"))
    assert "asks" not in result.get("artifacts", {})


def test_a_reply_with_no_asks_adds_no_key(monkeypatch):
    reply_with(monkeypatch)
    assert "asks" not in execute(generic_task("Architecture review")).get("artifacts", {})


# ---- the automated review: both passes, code pass first ----


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def pr_workspace(tmp_path, monkeypatch):
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-b", "main")
    git(seed, "config", "user.email", "t@example.com")
    git(seed, "config", "user.name", "T")
    (seed / "app.py").write_text("A = 1\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    git(ws, "checkout", "-b", "horizon/t-1")
    (ws / "app.py").write_text("A = 2\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "implement")
    git(ws, "push", "-u", "origin", "horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)


def test_both_review_passes_asks_are_joined(tmp_path, monkeypatch):
    pr_workspace(tmp_path, monkeypatch)
    code = {"verdict": "pass", "findings": [], "artifact_md": "## Code review\n**pass**", "asks": [ASK]}
    qa = {"verdict": "pass", "regression_tests_run": True, "new_code_unit_coverage": True, "e2e_test_present": True,
          "findings": [], "artifact_md": "## QA review\n**pass**", "asks": [SOFT]}

    def fake(prompt, **kwargs):
        is_qa = "QA Reviewer" in (kwargs.get("append_system") or "")
        return {"result": json.dumps(qa if is_qa else code)}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    label = "Automated review (code + QA)"
    result = execute({
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "", "metric": "1. Works.", "guardrails": "",
                 "priority": "High", "repo": "acme/demo", "issue": 42},
        "step": {"index": steps.by_label(label)["index"], "label": label, "agent": "Review"},
        "artifacts": [],
        "feedback": [],
    })
    assert result["artifacts"]["asks"] == [ASK, SOFT]


# ---- the PM steps ----


def test_a_pm_reply_carries_its_asks_beside_its_split(run_pm_step):
    label = "Summarize reviews & recommend"
    split = {"title": "measuresForArm", "description": "The deferred half.", "metric": "1. measuresForArm works."}
    reply = {"summary": "recommend", "artifact_md": "## Recommendation\n**PROCEED**", "split": split, "asks": [SOFT]}
    task = {
        "run_id": 728,
        "attempt": 1,
        "item": {"id": "HZ-728", "title": "t", "metric": "1. Works.", "guardrails": ""},
        "step": {"index": steps.by_label(label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }
    posted = run_pm_step(task, lambda prompt, **kw: {"result": json.dumps(reply), "session_id": "s"})
    assert posted["ok"] is True
    assert posted["artifacts"]["asks"] == [SOFT]
    assert posted["artifacts"]["split"] == split


@pytest.mark.parametrize("asks", [None, [], "not a list"])
def test_pm_finish_drops_asks_that_are_empty_or_not_a_list(asks):
    task = {"step": {"label": "Summarize reviews & recommend"}, "item": {}, "feedback": []}
    outcome = pm_steps.finish(task, "s", {}, "## Recommendation", [], asks=asks)
    assert "asks" not in outcome.get("artifacts", {})
