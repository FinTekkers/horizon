"""HZ-447 metric 2: domain/py/plan_inventory.py against the samples in
domain/fixtures/plan-inventory-cases.json, which server/test/
domain-schema.test.mjs runs through the JSON schema too."""

import json
from pathlib import Path

import pytest

from domain.py import plan_inventory

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "domain/fixtures/plan-inventory-cases.json").read_text())
CASES = {case["case"]: case for case in FIXTURE["cases"]}


@pytest.mark.parametrize("name", sorted(CASES))
def test_validate_matches_the_shared_fixture(name):
    case = CASES[name]
    if case["valid"]:
        assert plan_inventory.validate(case["block"], FIXTURE["scope"]) is case["block"]
    else:
        with pytest.raises(ValueError):
            plan_inventory.validate(case["block"], FIXTURE["scope"])


def test_the_fixture_holds_the_cases_metric_2_names():
    assert CASES["a 2-repo sample with key facts"]["valid"] is True
    assert CASES["a row with no evidence"]["valid"] is False
    assert CASES["a row for a repo outside the scope"]["valid"] is False


def test_a_missing_evidence_and_an_outside_row_say_why_without_naming_the_outside_repo():
    with pytest.raises(ValueError, match="missing 'evidence'"):
        plan_inventory.validate(CASES["a row with no evidence"]["block"], FIXTURE["scope"])
    with pytest.raises(ValueError, match="outside the Plan's scope") as raised:
        plan_inventory.validate(CASES["a row for a repo outside the scope"]["block"], FIXTURE["scope"])
    assert "acme/billing" not in str(raised.value)


def test_a_repo_in_scope_with_no_row_fails():
    with pytest.raises(ValueError, match="no row for"):
        plan_inventory.validate(CASES["a 2-repo sample with key facts"]["block"], [*FIXTURE["scope"], "acme/data"])


def test_render_and_extract_round_trip():
    block = CASES["a check evidence row"]["block"]
    artifact = f"## Current state\n...\n\n## Inventory block\n{plan_inventory.render(block)}"
    assert plan_inventory.extract(artifact, FIXTURE["scope"]) == block
    with pytest.raises(ValueError, match="no plan-inventory block"):
        plan_inventory.extract("## Current state\nno block", FIXTURE["scope"])


def test_check_citations_names_each_changed_repo_with_no_evidence_ref():
    inventory = CASES["a 2-repo sample with key facts"]["block"]
    cited = {"changes": [{"repo": "acme/api", "cites": ["server/src/db.js:129"]}]}
    assert plan_inventory.check_citations(cited, inventory) == []
    uncited = {
        "changes": [
            {"repo": "acme/api", "cites": ["server/src/db.js:129"]},
            # A ref from another repo's row does not count for this one.
            {"repo": "acme/web", "cites": ["server/src/db.js:129"]},
        ]
    }
    assert plan_inventory.check_citations(uncited, inventory) == ["acme/web"]
    with pytest.raises(ValueError, match="changes"):
        plan_inventory.check_citations({"recommendation": "A"}, inventory)
