"""HZ-135's cross-language fixture, the Python half.

server/test/domain-priorities-cases.test.mjs is the JS half. Both run the SAME
`shared` section off the SAME domain/fixtures/priorities-cases.json, which is the
whole point of the file: domain/js/priorities.js and domain/py/priorities.py are
two independent hand-written implementations, and
server/test/domain-priorities-parity.test.mjs only compares their DATA output.
Without this file the Python validator's rejection rules would carry no coverage
at all, and the two validators' messages could drift apart silently.

Three vacuity holes are closed deliberately, matching the JS half:
  1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
     and a new export with no case fails.
  2. NON-EMPTY sections — `"membership": []` would satisfy a keys-only guard.
  3. A PINNED MANIFEST — this suite asserts it executed exactly the ids in
     shared.manifest, so it cannot skip a section and still claim the
     cross-language guarantee.
"""

import inspect
import json
from pathlib import Path

import pytest

from domain.py import priorities

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain" / "fixtures" / "priorities-cases.json").read_text())
SHARED = CASES["shared"]
PY = {name: cases for name, cases in CASES["py"].items() if not name.startswith("$")}

# The underscore-private function `shared` exists to compare across languages.
# Private by naming convention, load-bearing by role — so it is required to carry
# fixture coverage rather than being skipped for starting with an underscore.
# _load_source is deliberately NOT here: it is file I/O around _validate_source,
# and the real import path is what proves it works
# (server/test/domain-priorities-schema.test.mjs imports the binding over a
# tampered copy in a temp dir, in BOTH languages). _json is not here either: it is
# a formatting shim with no rule of its own, and the message-parity test in
# farm/tests/test_priorities.py is what holds it to its job.
REQUIRED_PRIVATE = {"_validate_source"}


def _defined_here(value) -> bool:
    """True for names this module owns, False for anything it merely imported.

    Filtering on __module__ rather than an ignore-list of today's imports means
    adding an import cannot fail this guard for an unrelated reason."""
    if inspect.ismodule(value):
        return False
    origin = getattr(value, "__module__", None)
    return origin is None or origin == priorities.__name__


def _covered_names() -> set:
    public = {
        name
        for name, value in vars(priorities).items()
        if not name.startswith("_") and _defined_here(value)
    }
    return public | REQUIRED_PRIVATE


# ---- coverage guard ----


def test_every_public_name_has_a_fixture_case_and_every_fixture_key_is_real():
    required = _covered_names()
    assert required, "the module exposes nothing — this guard would pass vacuously"
    assert set(PY) == required, (
        "domain/fixtures/priorities-cases.json's \"py\" keys must equal "
        "domain/py/priorities.py's public names (plus the required private ones) exactly"
    )


def test_no_fixture_section_is_empty():
    for name, cases in PY.items():
        assert cases, f"py.{name} has no cases"
    for section in ("validation", "membership"):
        assert SHARED[section], f"shared.{section} has no cases"


# ---- shared: validation (_validate_source vs JS's assertPrioritiesShape) ----

_EXECUTED = {"validation": [], "membership": []}


@pytest.mark.parametrize("case", SHARED["validation"], ids=lambda c: c["case"])
def test_shared_validation(case):
    _EXECUTED["validation"].append(case["case"])
    expect = case["expect"]
    if expect["throws"]:
        with pytest.raises(RuntimeError) as exc:
            priorities._validate_source(case["input"], "domain/priorities.json")
        assert expect["messageContains"] in str(exc.value), (
            f'expected a message containing {expect["messageContains"]!r}, got: {exc.value}'
        )
    else:
        assert (
            priorities._validate_source(case["input"], "domain/priorities.json") is case["input"]
        )


# ---- shared: membership (is_priority vs JS's isPriority) ----


@pytest.mark.parametrize("case", SHARED["membership"], ids=lambda c: c["case"])
def test_shared_membership(case):
    _EXECUTED["membership"].append(case["case"])
    assert priorities.is_priority(case["value"], tuple(case["priorities"])) is case["expect"]


# ---- py-only names ----


def test_py_priorities_is_a_non_empty_tuple():
    for case in PY["PRIORITIES"]:
        assert priorities.PRIORITIES, f'PRIORITIES: {case["case"]}'
        assert isinstance(priorities.PRIORITIES, tuple)


def test_py_default_priority_is_a_member_of_the_live_vocabulary():
    for case in PY["DEFAULT_PRIORITY"]:
        assert case["expectMember"]
        assert priorities.DEFAULT_PRIORITY in priorities.PRIORITIES, f'DEFAULT_PRIORITY: {case["case"]}'


def test_py_helpers_are_driven_by_the_shared_section():
    for name in ("is_priority", *REQUIRED_PRIVATE):
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
