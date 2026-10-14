"""HZ-448 metrics 1 and 2: a Plan's Draft items reply is held to
domain/planDraft.schema.json and its dependencies must form a DAG. The shared
cases in domain/fixtures/plan-draft-cases.json run here through the Python
binding and in server/test/plan-draft-schema.test.mjs through the JS one. A
malformed draft takes the step's one retry, then fails the step.

Every agent run is stubbed: run_agent is monkeypatched at step_agent's import.
"""

import copy
import json
from pathlib import Path

import pytest

from domain.py import plan_draft, steps
from farm import step_agent
from farm.agent_runner import AgentError

FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "domain" / "fixtures" / "plan-draft-cases.json").read_text())
BASE = FIXTURES["base"]


def build(case: dict) -> dict:
    doc = copy.deepcopy(BASE)

    def walk(dotted: str):
        parts = [int(p) if p.isdigit() else p for p in dotted.split(".")]
        node = doc
        for part in parts[:-1]:
            node = node[part]
        return node, parts[-1]

    for dotted, value in case.get("set", {}).items():
        parent, key = walk(dotted)
        parent[key] = copy.deepcopy(value)
    for dotted in case.get("drop", []):
        parent, key = walk(dotted)
        del parent[key]
    return doc


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=[c["case"] for c in FIXTURES["cases"]])
def test_shared_case(case):
    doc = build(case)
    # A server-only rule (does this key or repo exist?) is not the farm's to check.
    if case["expect"] is None or case.get("serverOnly"):
        assert plan_draft.validate(doc) is doc
        return
    with pytest.raises(plan_draft.PlanDraftError) as raised:
        plan_draft.validate(doc)
    assert raised.value.code == case["expect"]["code"]
    assert case["expect"]["contains"] in raised.value.message
    assert raised.value.path


def test_the_cycle_error_names_the_path_and_the_edge_that_closes_it():
    with pytest.raises(plan_draft.PlanDraftError) as raised:
        plan_draft.validate(build({"set": {"items.0.depends_on": ["#2"]}}))
    assert (raised.value.code, raised.value.path, raised.value.message) == (
        "cycle",
        "items[1].depends_on[0]",
        "cycle: #1 → #2 → #1",
    )


def test_a_pattern_must_match_the_whole_value():
    with pytest.raises(plan_draft.PlanDraftError, match="items\\[0\\].id"):
        plan_draft.validate(build({"set": {"items.0.id": "#1\n"}}))


# ---- the Draft items step ----


def make_task() -> dict:
    return {
        "run_id": 448,
        "attempt": 1,
        "item": {"id": "P-448", "title": "Plan the Plan kind", "priority": "High", "repo": None, "kind": "plan"},
        "step": {"index": steps.by_kind_label("plan", step_agent.PLAN_DRAFT_LABEL)["index"], "label": step_agent.PLAN_DRAFT_LABEL},
        "artifacts": [],
        "feedback": [],
    }


def stub_agent(monkeypatch, drafts):
    """run_agent stub replying with each draft in turn (the last repeats)."""
    calls = []

    def fake(prompt, **kwargs):
        calls.append(kwargs)
        body = {"summary": "drafted 3 items", "artifact_md": "## Approach\nbody"}
        draft = drafts[min(len(calls), len(drafts)) - 1]
        if draft is not None:
            body["plan_draft"] = draft
        return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return calls


def test_the_draft_step_runs_its_own_read_only_role():
    assert step_agent._step_config("plan", step_agent.PLAN_DRAFT_LABEL) == ("plan_draft.md", True, "Read,Glob,Grep", None)
    assert (step_agent.ROLES / "plan_draft.md").read_text().strip()


def test_a_valid_draft_rides_through_to_the_server(monkeypatch):
    calls = stub_agent(monkeypatch, [BASE])
    result = step_agent.execute(make_task())
    assert len(calls) == 1
    assert result["artifacts"]["plan_draft"] == BASE


SIX_METRIC_LINES = build({"set": {"items.0.metric": ["a", "b", "c", "d", "e", "f"]}})
CYCLE = build({"set": {"items.0.depends_on": ["#2"]}})


@pytest.mark.parametrize("bad", [SIX_METRIC_LINES, CYCLE, None], ids=["six metric lines", "a cycle", "no plan_draft"])
def test_a_bad_draft_twice_fails_the_step_after_one_retry(monkeypatch, bad):
    calls = stub_agent(monkeypatch, [bad])
    with pytest.raises(AgentError, match="invalid plan draft"):
        step_agent.execute(make_task())
    assert len(calls) == 2


def test_a_bad_draft_then_a_good_one_succeeds(monkeypatch):
    calls = stub_agent(monkeypatch, [CYCLE, BASE])
    result = step_agent.execute(make_task())
    assert len(calls) == 2
    assert result["artifacts"]["plan_draft"] == BASE


def test_other_plan_steps_and_task_steps_keep_their_reply_checks():
    # HZ-447 extends the Plan check by label: Inventory has one, a review row none.
    assert step_agent._reply_validator("plan", step_agent.PLAN_INVENTORY_LABEL) is not None
    assert step_agent._reply_validator("plan", step_agent.PLAN_COVERAGE_REVIEW_LABEL) is None
    assert step_agent._reply_validator("change", step_agent.ENG_PLAN_LABEL) is None
    assert step_agent._reply_validator("task", step_agent.RUN_PLAN_LABEL) is not None
