"""HZ-446: a Plan's steps on the farm. Its five farm-lane steps run one
read-only placeholder role with the planner's read-only tools, workspace or
not, so a Plan never edits code in any repo. Its PM steps run on the PM step
kind. "File items" is Horizon's own server step: it never reaches a farm view.

Every agent run is stubbed: run_agent is monkeypatched at step_agent's import.
"""

import json

import pytest

from domain.py import steps
from farm import pm_steps, step_agent

PLAN_FARM_LABELS = [
    "Inventory current state",
    "Design options & recommendation",
    "Draft items",
    "Review drafts: coverage & overlap",
    "Review drafts: metrics & size",
]
PLAN_PM_LABELS = ["Define the question", "Set guardrails"]
WRITE_TOOLS = ("Edit", "Write", "Bash")


def make_task(label: str) -> dict:
    return {
        "run_id": 446,
        "attempt": 1,
        "item": {"id": "P-446", "title": "Retire the FIX gateway", "priority": "High", "repo": None, "kind": "plan"},
        "step": {"index": steps.by_kind_label("plan", label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


def test_the_plan_farm_view_holds_its_agent_steps_and_never_file_items():
    view = steps.FARM_VIEWS["plan"]
    assert [entry["label"] for entry in view] == PLAN_PM_LABELS + PLAN_FARM_LABELS
    assert "File items" not in {entry["label"] for entry in view}
    assert all(entry["runsIn"] in ("pm", "farm") for entry in view)
    with pytest.raises(KeyError):
        steps.by_kind_label("plan", "File items")


def test_each_plan_farm_step_runs_the_read_only_placeholder_with_the_planner_tools():
    for label in PLAN_FARM_LABELS:
        role, wants_artifact, tools, persona = step_agent._step_config("plan", label)
        assert (role, wants_artifact, tools, persona) == ("plan_placeholder.md", True, "Read,Glob,Grep", None)
        assert not any(tool in tools.split(",") for tool in WRITE_TOOLS)
        assert step_agent._is_read_only("plan", label)
        assert steps.by_kind_label("plan", label)["workspaceMutating"] is False
    assert (step_agent.ROLES / "plan_placeholder.md").read_text().strip()


def test_each_plan_pm_step_runs_on_the_pm_step_kind():
    for label in PLAN_PM_LABELS:
        assert step_agent._step_config("plan", label) == ("pm.md", True, None, None)
        assert step_agent._is_pm_step(label, "plan")
        assert not step_agent._is_read_only("plan", label)


@pytest.mark.parametrize("label", PLAN_FARM_LABELS)
def test_a_plan_step_with_no_workspace_is_still_held_to_the_read_only_tools(monkeypatch, label):
    calls = []

    def fake(prompt, **kwargs):
        calls.append(kwargs)
        body = {"summary": "placeholder", "artifact_md": "## Not built yet"}
        return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    step_agent.execute(make_task(label))
    assert len(calls) == 1
    assert calls[0]["allowed_tools"] == "Read,Glob,Grep"
    assert calls[0]["provider_locked"] is True


def test_change_and_task_read_only_sets_are_unchanged():
    assert step_agent.READ_ONLY_LABELS_BY_KIND["change"] is step_agent.READ_ONLY_LABELS
    assert step_agent.READ_ONLY_LABELS_BY_KIND["task"] is step_agent.TASK_READ_ONLY_LABELS
    assert not step_agent._is_read_only("change", step_agent.IMPLEMENT_LABEL)


def test_set_guardrails_may_be_shared_by_change_and_plan_only():
    table = {
        "change": [{"label": "Set guardrails", "runsIn": "pm"}],
        "task": [{"label": "Set guardrails", "runsIn": "pm"}],
        "plan": [{"label": "Set guardrails", "runsIn": "pm"}],
    }
    shared = pm_steps.SHARED_LINE_BUDGETS
    pm_steps._assert_line_budgets_are_kind_safe(
        {"Set guardrails": "guardrails"}, {"change": table["change"], "plan": table["plan"]}, shared
    )
    with pytest.raises(RuntimeError, match="more than one kind"):
        pm_steps._assert_line_budgets_are_kind_safe({"Set guardrails": "guardrails"}, table, shared)
    with pytest.raises(RuntimeError, match="more than one kind"):
        pm_steps._assert_line_budgets_are_kind_safe(
            {"Set guardrails": "guardrails"}, {"change": table["change"], "plan": table["plan"]}
        )
