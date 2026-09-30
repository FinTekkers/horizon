"""HZ-139 success metric 6, the Python half.

server/test/domain-fixture-cases.test.mjs is the JS half. Both run the SAME
`shared` section off the SAME domain/fixtures/lifecycle-cases.json, which is the
whole point of the file: until HZ-139, domain/js/lifecycle.js and
domain/py/steps.py were two independent hand-written implementations and
nothing ever proved a label lookup, a farm projection or a validation rule
meant the same thing in both languages.

Three vacuity holes are closed deliberately, matching the JS half:
  1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
     and a new export with no case fails.
  2. NON-EMPTY sections — `"budget_for_label": []` would satisfy a keys-only
     guard.
  3. A PINNED MANIFEST — this suite asserts it executed exactly the ids in
     shared.manifest, so it cannot skip a section and still claim the
     cross-language guarantee.
"""

import inspect
import json
from pathlib import Path

import pytest

from domain.py import steps

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain" / "fixtures" / "lifecycle-cases.json").read_text())
SHARED = CASES["shared"]
PY = {name: cases for name, cases in CASES["py"].items() if not name.startswith("$")}

# The two underscore-private functions `shared` exists to compare across
# languages, plus the lookup everything else is built on. Private by naming
# convention, load-bearing by role — so they are required to carry fixture
# coverage rather than being skipped for starting with an underscore.
REQUIRED_PRIVATE = {"_validate_source", "_project_farm_view", "_find_by_label"}


def _defined_here(value) -> bool:
    """True for names this module owns, False for anything it merely imported.

    Filtering on __module__ rather than an ignore-list of today's imports
    ({"json", "Path"}) means adding an import cannot fail this guard for an
    unrelated reason."""
    if inspect.ismodule(value):
        return False
    origin = getattr(value, "__module__", None)
    return origin is None or origin == steps.__name__


def _covered_names() -> set:
    public = {
        name
        for name, value in vars(steps).items()
        if not name.startswith("_") and _defined_here(value)
    }
    return public | REQUIRED_PRIVATE


# ---- coverage guard (metric 6) ----


def test_every_public_name_has_a_fixture_case_and_every_fixture_key_is_real():
    required = _covered_names()
    assert required, "the module exposes nothing — this guard would pass vacuously"
    assert set(PY) == required, (
        "domain/fixtures/lifecycle-cases.json's \"py\" keys must equal "
        "domain/py/steps.py's public names (plus the required private ones) exactly"
    )


def test_no_fixture_section_is_empty():
    for name, cases in PY.items():
        assert cases, f"py.{name} has no cases"
    for section in ("labelLookup", "farmProjection", "validation"):
        assert SHARED[section], f"shared.{section} has no cases"


# ---- shared: validation (_validate_source vs JS's assertLifecycleShape) ----

_EXECUTED = {"labelLookup": [], "farmProjection": [], "validation": []}


@pytest.mark.parametrize("case", SHARED["validation"], ids=lambda c: c["case"])
def test_shared_validation(case):
    _EXECUTED["validation"].append(case["case"])
    expect = case["expect"]
    if expect["throws"]:
        with pytest.raises(RuntimeError) as exc:
            steps._validate_source(case["input"], "domain/steps.json")
        assert expect["messageContains"] in str(exc.value), (
            f'expected a message containing {expect["messageContains"]!r}, got: {exc.value}'
        )
    else:
        assert steps._validate_source(case["input"], "domain/steps.json") is case["input"]


# ---- shared: label lookup (by_label / _find_by_label vs JS's requiredStepIndex) ----


@pytest.mark.parametrize("case", SHARED["labelLookup"], ids=lambda c: c["case"])
def test_shared_label_lookup(case):
    _EXECUTED["labelLookup"].append(case["case"])
    expect = case["expect"]
    if not expect["found"]:
        with pytest.raises(KeyError) as exc:
            steps.by_label(case["label"])
        assert expect["messageContains"] in str(exc.value)
        return
    entry = steps.by_label(case["label"])
    assert entry["label"] == case["label"]
    for field, value in expect.items():
        if field == "found":
            continue
        assert entry[field] == value, f'{case["label"]}.{field}'


# ---- shared: farm projection (_project_farm_view — the rule Python owns) ----


@pytest.mark.parametrize("case", SHARED["farmProjection"], ids=lambda c: c["case"])
def test_shared_farm_projection(case):
    _EXECUTED["farmProjection"].append(case["case"])
    assert steps._project_farm_view(case["input"]["steps"]) == case["expect"]


# ---- py-only helpers ----

_FABRICATED = [
    {
        "index": 0,
        "label": "Existing Farm Step",
        "agent": "Eng",
        "runsIn": "farm",
        "workspaceMutating": False,
        "providerOverrideEligible": True,
        "providerLocked": False,
        "maxTurns": 10,
        "timeoutS": 100,
    },
    {
        "index": 1,
        "label": "Inserted Farm Step",
        "agent": "Eng",
        "runsIn": "farm",
        "workspaceMutating": True,
        "providerOverrideEligible": False,
        "providerLocked": True,
        "maxTurns": 77,
        "timeoutS": 777,
    },
    {
        "index": 2,
        "label": "Existing PM Step",
        "agent": "PM",
        "runsIn": "pm",
        "workspaceMutating": None,
        "providerOverrideEligible": None,
        "providerLocked": None,
        "maxTurns": None,
        "timeoutS": None,
    },
]


def test_py_phases_and_steps_are_non_empty():
    for name in ("PHASES", "STEPS"):
        for case in PY[name]:
            assert getattr(steps, name), f'{name}: {case["case"]}'


def test_py_step_by_index():
    for case in PY["STEP_BY_INDEX"]:
        if case.get("expectKeyedByIndex"):
            for entry in steps.STEPS:
                assert steps.STEP_BY_INDEX[entry["index"]] == entry
        if case.get("expectMissing"):
            # farmd's dispatch loop reads task payloads off the network — an
            # unknown index must never raise, only miss.
            assert steps.STEP_BY_INDEX.get(case["index"]) is None


@pytest.mark.parametrize("case", PY["budget_for_label"], ids=lambda c: c["case"])
def test_py_budget_for_label(case):
    expect = case["expect"]
    if isinstance(expect, dict) and expect.get("throws"):
        with pytest.raises(KeyError) as exc:
            steps.budget_for_label(_FABRICATED, case["label"])
        assert expect["messageContains"] in str(exc.value)
    else:
        assert steps.budget_for_label(_FABRICATED, case["label"]) == tuple(expect)


@pytest.mark.parametrize("case", PY["provider_override_eligible"], ids=lambda c: c["case"])
def test_py_provider_override_eligible(case):
    assert steps.provider_override_eligible(_FABRICATED, case["label"]) is case["expect"]


@pytest.mark.parametrize("case", PY["provider_locked_for"], ids=lambda c: c["case"])
def test_py_provider_locked_for(case):
    assert steps.provider_locked_for(_FABRICATED, case["label"]) is case["expect"]


def test_py_private_helpers_are_driven_by_the_shared_section():
    for name in REQUIRED_PRIVATE:
        assert PY[name][0]["drivenBy"].startswith("shared."), f"py.{name} claims no shared driver"


# ---- the manifest: this suite really ran every shared case ----
# Declared last on purpose: pytest collects and runs in file order, so every
# parametrized shared case above has already appended its id by the time this
# runs.


def test_manifest_the_python_suite_executed_exactly_the_pinned_shared_cases():
    for section, ids in SHARED["manifest"].items():
        assert sorted(_EXECUTED[section]) == sorted(ids), (
            f"the Python suite did not run shared.{section} as pinned — "
            "the cross-language guarantee is only as good as this list"
        )
