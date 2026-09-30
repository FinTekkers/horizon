"""HZ-117 success metric: "a test inserts a step into the table and asserts
nothing needs a literal index changed anywhere — lane routing, workspace
mutation, turn budgets and provider eligibility all follow the new step
automatically."

Feeds a fabricated 3-entry step table (one pre-existing farm step, one
newly-*inserted* step, one pre-existing PM step) into steps.py's pure
derivation functions and farmd.py's pure lane/workspace functions. Every
assertion reads the inserted step's own fields back off the fabricated
dict — no literal step index or budget number is re-typed anywhere in this
file, so the test can't pass by coincidence.
"""

from domain.py import steps
from farm import farmd


def _existing_farm_step():
    return {
        "index": 0,
        "label": "Existing Farm Step",
        "agent": "Eng",
        "runsIn": "farm",
        "workspaceMutating": False,
        "providerOverrideEligible": True,
        "providerLocked": False,
        "maxTurns": 10,
        "timeoutS": 100,
    }


def _inserted_step():
    """A brand-new step spliced into the middle of the table — the scenario
    the ticket names: "inserting a step into STEPS silently repoints [things]
    at the wrong steps." Every field here is chosen to be verifiably distinct
    from every other fabricated entry, so a passing assertion can't be an
    accident of two entries sharing a value."""
    return {
        "index": 1,
        "label": "Inserted Between Two Existing Steps",
        "agent": "Eng",
        "runsIn": "farm",
        "workspaceMutating": True,
        "providerOverrideEligible": False,
        "providerLocked": True,
        "maxTurns": 77,
        "timeoutS": 777,
    }


def _existing_pm_step():
    return {
        "index": 2,
        "label": "Existing PM Step",
        "agent": "PM",
        "runsIn": "pm",
        "workspaceMutating": None,
        "providerOverrideEligible": None,
        "providerLocked": None,
        "maxTurns": None,
        "timeoutS": None,
    }


def _fabricated_table():
    existing_farm, inserted, existing_pm = _existing_farm_step(), _inserted_step(), _existing_pm_step()
    return [existing_farm, inserted, existing_pm], existing_farm, inserted, existing_pm


# ---- turn budgets (step_agent.py's steps.budget_for_label) ----


def test_budget_for_label_follows_the_inserted_step():
    table, _existing_farm, inserted, _existing_pm = _fabricated_table()
    assert steps.budget_for_label(table, inserted["label"]) == (inserted["maxTurns"], inserted["timeoutS"])


def test_budget_for_label_leaves_the_other_steps_alone():
    table, existing_farm, _inserted, _existing_pm = _fabricated_table()
    assert steps.budget_for_label(table, existing_farm["label"]) == (
        existing_farm["maxTurns"],
        existing_farm["timeoutS"],
    )


# ---- provider eligibility (step_agent.py's steps.provider_override_eligible / provider_locked_for) ----


def test_provider_override_eligible_follows_the_inserted_step():
    table, _existing_farm, inserted, _existing_pm = _fabricated_table()
    assert steps.provider_override_eligible(table, inserted["label"]) is inserted["providerOverrideEligible"]


def test_provider_locked_for_follows_the_inserted_step():
    table, _existing_farm, inserted, _existing_pm = _fabricated_table()
    assert steps.provider_locked_for(table, inserted["label"]) is inserted["providerLocked"]


def test_provider_flags_leave_the_pre_existing_farm_step_alone():
    table, existing_farm, _inserted, _existing_pm = _fabricated_table()
    assert steps.provider_override_eligible(table, existing_farm["label"]) is existing_farm["providerOverrideEligible"]
    assert steps.provider_locked_for(table, existing_farm["label"]) is existing_farm["providerLocked"]


# ---- workspace mutation (farmd.py's workspace_mutating_indexes) ----


def test_workspace_mutating_indexes_follows_the_inserted_step():
    table, existing_farm, inserted, _existing_pm = _fabricated_table()
    mutating = farmd.workspace_mutating_indexes(table)
    assert inserted["index"] in mutating
    assert existing_farm["index"] not in mutating


# ---- the farm-shaped projection (steps.py's _project_farm_view) ----
# HZ-139 moved this assertion here from server/test/lifecycle-step-insertion.test.mjs,
# which asserted it against the deleted generator's toGeneratedSteps. Same
# scenario, same fabricated table, now asserted against the implementation that
# owns the rule. Note the input here is the AUTHORED shape (no `index`, gates
# included) — the projection is what turns it into the farm shape above.


def _authored_table():
    existing = {
        "phase": 0,
        "kind": "agent",
        "agent": "Eng",
        "label": "Existing Farm Step",
        "runsIn": "farm",
        "workspaceMutating": False,
        "providerOverrideEligible": True,
        "providerLocked": False,
        "maxTurns": 10,
        "timeoutS": 100,
    }
    inserted = {
        "phase": 0,
        "kind": "agent",
        "agent": "Eng",
        "label": "Inserted Between Two Existing Steps",
        "runsIn": "farm",
        "workspaceMutating": True,
        "providerOverrideEligible": False,
        "providerLocked": True,
        "maxTurns": 77,
        "timeoutS": 777,
    }
    gate = {"phase": 0, "kind": "gate", "gate": "required", "label": "Existing Gate"}
    return [existing, inserted, gate], existing, inserted


def test_project_farm_view_carries_the_inserted_step_at_its_own_index():
    table, existing, inserted = _authored_table()
    projected = steps._project_farm_view(table)
    entry = next(e for e in projected if e["label"] == inserted["label"])

    assert entry["index"] == table.index(inserted)
    for field in ("workspaceMutating", "providerOverrideEligible", "providerLocked", "maxTurns", "timeoutS"):
        assert entry[field] == inserted[field]

    # The pre-existing step's own fields must be unaffected by the insertion.
    existing_entry = next(e for e in projected if e["label"] == existing["label"])
    assert existing_entry["maxTurns"] == existing["maxTurns"]
    assert existing_entry["index"] == table.index(existing)

    # And the gate never reaches the farm view at all.
    assert all(e["label"] != "Existing Gate" for e in projected)


# ---- lane routing (farmd.py's lane_for_index) ----


def test_lane_for_index_routes_the_inserted_step_by_its_own_runsin():
    table, _existing_farm, inserted, _existing_pm = _fabricated_table()
    # inserted["runsIn"] == "farm" — lane_for_index must land it in "runs",
    # never "pm", purely because that's what its own entry declares.
    assert farmd.lane_for_index(table, inserted["index"]) == "runs"


def test_lane_for_index_routes_the_pm_step_to_pm_regardless_of_where_it_sits():
    table, _existing_farm, _inserted, existing_pm = _fabricated_table()
    assert farmd.lane_for_index(table, existing_pm["index"]) == "pm"


def test_lane_for_index_falls_back_to_the_default_for_an_index_absent_from_the_table():
    table, _existing_farm, _inserted, _existing_pm = _fabricated_table()
    absent_index = max(e["index"] for e in table) + 1
    assert farmd.lane_for_index(table, absent_index, default="runs") == "runs"
