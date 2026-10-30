"""HZ-541: the golden-cases prompt text. A golden_cases sub-step gets the
producer contract; the metric steps and Eng plan of an item with golden cases
get the addendum, whose metric-line token is the one the first-gate table
links to. A task without the flag gets exactly the prompt it got before."""

import copy
import re
from pathlib import Path

import pytest

from farm import step_agent

REPO = Path(__file__).resolve().parents[2]


def _task(label: str, **extra) -> dict:
    return {
        "item": {"id": "HZ-1", "title": "T", "priority": "Medium", "metric": "1. m"},
        "step": {"index": 0, "label": label, "agent": "Eng"},
        **extra,
    }


def _marker() -> str:
    source = (REPO / "domain" / "js" / "goldenCases.js").read_text()
    return re.search(r"export const GOLDEN_CASES_MARKER = '([^']+)'", source).group(1)


ADDENDUM = (step_agent.ROLES / step_agent.GOLDEN_CASES_ADDENDUM).read_text().rstrip("\n")
CONTRACT = (step_agent.ROLES / step_agent.GOLDEN_CASES_ROLE).read_text().rstrip("\n")


@pytest.mark.parametrize("label", ["Define how we measure success", "How we'll verify", step_agent.ENG_PLAN_LABEL])
def test_the_metric_steps_and_eng_plan_get_the_addendum(label):
    assert step_agent.golden_cases_section(_task(label, golden_cases=True)) == ADDENDUM


def test_eng_plan_prompt_ends_with_the_addendum_and_is_unchanged_without_the_flag():
    off = step_agent.build_prompt(_task(step_agent.ENG_PLAN_LABEL))
    on = step_agent.build_prompt(_task(step_agent.ENG_PLAN_LABEL, golden_cases=True))
    assert ADDENDUM not in off
    assert on == f"{off}\n\n{ADDENDUM}"


@pytest.mark.parametrize("label", [step_agent.IMPLEMENT_LABEL, step_agent.REVIEW_LABEL, step_agent.OPTIONS_LABEL])
def test_other_steps_get_nothing_even_with_the_flag(label):
    task = _task(label, golden_cases=True)
    assert step_agent.golden_cases_section(task) is None
    plain = copy.deepcopy(task)
    del plain["golden_cases"]
    assert step_agent.build_prompt(task) == step_agent.build_prompt(plain)


def test_the_addendum_asks_for_the_marker_the_gate_table_matches():
    assert f"`{_marker()}`" in ADDENDUM


def test_a_golden_cases_substep_gets_the_producer_contract():
    task = _task("Define how we measure success", substep={"id": "golden-cases", "output": "golden_cases"})
    assert step_agent.golden_cases_section(task) == CONTRACT
    assert step_agent.build_prompt(task).endswith(CONTRACT)
    assert "Never read, run or search the" in CONTRACT
    assert "```json golden-cases" in CONTRACT


def test_another_substep_output_gets_nothing():
    task = _task(step_agent.IMPLEMENT_LABEL, substep={"id": "audit", "output": "findings"})
    assert step_agent.golden_cases_section(task) is None
