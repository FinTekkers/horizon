"""HZ-463: a Plan's draft review on the farm.

domain/fixtures/plan-inventory-rendered.md is the Inventory block that
server/test/plan-review.test.mjs reads gaps from; it must stay exactly what
plan_inventory.render() writes, so the coverage check parses the Inventory
format as it is. The coverage review's `plan_review` reply is checked by
domain/py/plan_review.py inside the step's retry envelope.
"""

import json
from pathlib import Path

import pytest

from domain.py import plan_inventory, plan_review
from farm import step_agent
from farm.agent_runner import AgentError

FIXTURES = Path(__file__).resolve().parents[2] / "domain" / "fixtures"
CASES = json.loads((FIXTURES / "plan-review-cases.json").read_text())
REPLY = {"coverage": CASES["base"]["coverage"], "overlaps": CASES["base"]["overlaps"]}


def test_the_rendered_inventory_fixture_is_what_render_writes():
    assert (FIXTURES / "plan-inventory-rendered.md").read_text() == plan_inventory.render(CASES["inventory"]) + "\n"


def test_a_clean_reply_passes():
    assert plan_review.validate(REPLY) is REPLY


def with_entry(entry: dict) -> dict:
    return {"coverage": [entry], "overlaps": []}


@pytest.mark.parametrize(
    ("reply", "match"),
    [
        pytest.param(None, "must be object", id="no-reply"),
        pytest.param({"coverage": []}, "missing 'overlaps'", id="no-overlaps"),
        pytest.param(with_entry({"repo": "a/b", "gap": "g", "draft": None}), "never neither", id="null-without-reason"),
        pytest.param(
            with_entry({"repo": "a/b", "gap": "g", "draft": "#1", "out_of_scope_reason": "x"}), "never both", id="draft-and-reason"
        ),
        pytest.param(with_entry({"repo": "a/b", "gap": "g", "draft": "HZ-1"}), "expected form", id="draft-not-local-id"),
        pytest.param(with_entry({"repo": "a/b", "gap": " ", "draft": "#1"}), "must not be blank", id="blank-gap"),
        pytest.param({"coverage": [], "overlaps": [{"draft": "#1", "key": "hz-1", "reason": "r"}]}, "expected form", id="bad-key"),
        pytest.param({"coverage": [], "overlaps": [], "extra": 1}, "unknown field", id="unknown-field"),
    ],
)
def test_a_bad_reply_names_what_is_wrong(reply, match):
    with pytest.raises(ValueError, match=match):
        plan_review.validate(reply)


def test_the_coverage_review_reply_check_takes_the_retry_on_a_bad_plan_review():
    check = step_agent._reply_validator("plan", step_agent.PLAN_COVERAGE_REVIEW_LABEL)
    good = {"summary": "s", "artifact_md": "a", "plan_review": REPLY}
    assert check(good) is good
    with pytest.raises(AgentError, match="invalid plan review"):
        check({"summary": "s", "artifact_md": "a"})
