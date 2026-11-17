"""HO-851: the design prompts. The metric step of an item with a design
sub-step (`design_verdict: true`) ends with the addendum asking for one
`design_needed: yes|no — <reason>` line; a later design round
(`design_round.n > 1`) is told its brief and asked for one `what_changed:`
line. A task without these fields gets exactly the prompt it got before."""

import copy
import json
import re
from pathlib import Path

import pytest

from farm import step_agent

REPO = Path(__file__).resolve().parents[2]
ADDENDUM = (step_agent.ROLES / step_agent.DESIGN_VERDICT_ADDENDUM).read_text().rstrip("\n")
METRIC = "Define how we measure success"


def _task(label: str, **extra) -> dict:
    return {
        "item": {"id": "HO-9", "title": "Board filters", "priority": "High", "metric": "1. m", "kind": "change"},
        "step": {"index": 1, "label": label, "agent": "PM"},
        **extra,
    }


def _js_constant(name: str) -> str:
    source = (REPO / "domain" / "js" / "designVerdict.js").read_text()
    return re.search(rf"export const {name} = '([^']+)'", source).group(1)


@pytest.mark.parametrize("label", [METRIC, "How we'll verify"])
def test_the_metric_steps_get_the_addendum_with_the_flag(label):
    assert step_agent.design_verdict_section(_task(label, design_verdict=True)) == ADDENDUM


def test_the_prompt_ends_with_the_addendum_and_is_byte_for_byte_unchanged_without_the_flag():
    off = step_agent.build_prompt(_task(METRIC))
    on = step_agent.build_prompt(_task(METRIC, design_verdict=True))
    assert ADDENDUM not in off
    assert on == f"{off}\n\n{ADDENDUM}"
    assert step_agent.build_prompt(_task(METRIC, design_verdict=False)) == off


@pytest.mark.parametrize("label", [step_agent.IMPLEMENT_LABEL, step_agent.OPTIONS_LABEL, "Set guardrails"])
def test_other_steps_get_nothing_even_with_the_flag(label):
    task = _task(label, design_verdict=True)
    assert step_agent.design_verdict_section(task) is None
    plain = copy.deepcopy(task)
    del plain["design_verdict"]
    assert step_agent.build_prompt(task) == step_agent.build_prompt(plain)


def test_the_addendum_asks_for_the_line_the_server_parses():
    key = _js_constant("VERDICT_KEY")
    assert f"{key}: yes — <one-line reason>" in ADDENDUM
    assert f"{key}: no — <one-line reason>" in ADDENDUM


def test_the_pm_runner_appends_the_addendum_only_with_the_flag(monkeypatch):
    seen = []

    def fake(prompt, **kwargs):
        seen.append(prompt)
        reply = {"summary": "set the metric", "artifact_md": "design_needed: no — backend only"}
        return {"result": json.dumps(reply), "session_id": "s", "provider": "claude", "model": "m", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    step_agent._execute_pm(_task(METRIC, design_verdict=True))
    step_agent._execute_pm(_task(METRIC))
    assert seen[0].endswith(ADDENDUM)
    assert ADDENDUM not in seen[1]
    assert seen[0] == f"{seen[1]}\n\n{ADDENDUM}"


def _design_task(**extra) -> dict:
    return {
        **_task(METRIC),
        "attempt": 2,
        "substep": {"id": "design-screens", "label": "Design the screens", "output": "design"},
        **extra,
    }


def test_a_later_design_round_is_told_its_brief_and_asked_for_what_changed():
    prompt = step_agent.design_prompt(_design_task(design_round={"n": 2, "brief": "Move the filters left."}), "rules", None)
    assert "## This round (round 2)" in prompt
    assert "Move the filters left." in prompt
    assert f"`{_js_constant('WHAT_CHANGED_KEY')}: <one line" in prompt


@pytest.mark.parametrize("design_round", [None, {"n": 1, "brief": "first"}, {"n": "2", "brief": "x"}, "junk"])
def test_a_first_round_or_no_round_field_keeps_the_design_prompt(design_round):
    plain = step_agent.design_prompt(_design_task(), "rules", None)
    extra = {} if design_round is None else {"design_round": design_round}
    assert step_agent.design_prompt(_design_task(**extra), "rules", None) == plain
