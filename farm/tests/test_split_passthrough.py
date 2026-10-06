"""HZ-313: the Ensemble's optional cross-repo ``split`` reaches the server
untouched, from the plan-options step only, and only as an object. The server
(server/src/split.js) validates it and files nothing before gate 5."""

import json

import pytest

from domain.py import steps
from farm import step_agent
from farm.step_agent import SPLIT_STEP_LABEL, execute

SPLIT = {
    "repo": "FinTekkers/ledger-models",
    "title": "Fix Decimal serialization",
    "description": "Serialize Decimal without losing scale.",
    "metric": "1. Round-trips keep scale.",
    "guardrails": "1. No wire change.",
    "remaining_description": "Use the fixed model.",
    "remaining_metric": "1. Bump ledger-models.",
}


def make_task(index, label):
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "d", "metric": "m", "guardrails": "", "priority": "Medium", "repo": None, "issue": None},
        "step": {"index": index, "label": label, "agent": "Ensemble"},
        "artifacts": [],
        "feedback": [],
    }


def reply_with(monkeypatch, split):
    def _fake(prompt, **kwargs):
        return {"result": json.dumps({"summary": "planned", "artifact_md": "# plan", "split": split})}

    monkeypatch.setattr(step_agent, "run_agent", _fake)


def test_the_split_label_is_a_real_step():
    # A rename in domain/steps.json must fail here, not silently drop every split.
    assert steps.by_label(SPLIT_STEP_LABEL)["label"] == SPLIT_STEP_LABEL


def test_split_reaches_the_artifacts_from_the_options_step(monkeypatch):
    reply_with(monkeypatch, SPLIT)
    result = execute(make_task(steps.by_label(SPLIT_STEP_LABEL)["index"], SPLIT_STEP_LABEL))
    assert result["artifacts"]["split"] == SPLIT
    assert result["artifacts"]["artifact_md"] == "# plan"


@pytest.mark.parametrize("label", ["Draft implementation plan", "Architecture review"])
def test_split_is_dropped_for_any_other_step(monkeypatch, label):
    reply_with(monkeypatch, SPLIT)
    result = execute(make_task(steps.by_label(label)["index"], label))
    assert "split" not in result.get("artifacts", {})


@pytest.mark.parametrize("value", ["FinTekkers/ledger-models", ["FinTekkers/ledger-models"], None])
def test_split_that_is_not_an_object_is_dropped(monkeypatch, value):
    reply_with(monkeypatch, value)
    result = execute(make_task(steps.by_label(SPLIT_STEP_LABEL)["index"], SPLIT_STEP_LABEL))
    assert "split" not in result.get("artifacts", {})
