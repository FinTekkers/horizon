"""HZ-134's cross-language fixture, the Python half.

server/test/domain-fields-cases.test.mjs is the JS half. Both run the SAME
`shared` section off the SAME domain/fixtures/fields-cases.json, which is the
whole point of the file: domain/js/fields.js and domain/py/fields.py are two
independent hand-written implementations, and domain-fields-parity.test.mjs only
compares their DATA output. Without this file the Python validator's rejection
rules would carry no coverage at all, and the two validators' messages could
drift apart silently.

Three vacuity holes are closed deliberately, matching the JS half:
  1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
     and a new export with no case fails.
  2. NON-EMPTY sections — `"patch_limits": []` would satisfy a keys-only guard.
  3. A PINNED MANIFEST — this suite asserts it executed exactly the ids in
     shared.manifest, so it cannot skip a section and still claim the
     cross-language guarantee.
"""

import inspect
import json
from pathlib import Path

import pytest

from domain.py import fields

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain" / "fixtures" / "fields-cases.json").read_text())
SHARED = CASES["shared"]
PY = {name: cases for name, cases in CASES["py"].items() if not name.startswith("$")}

# The underscore-private function `shared` exists to compare across languages.
# Private by naming convention, load-bearing by role — so it is required to carry
# fixture coverage rather than being skipped for starting with an underscore.
# _load_source is deliberately NOT here: it is file I/O around _validate_source,
# and the real import path is what proves it works (domain-fields-schema.test.mjs
# imports the binding over a tampered copy in a temp dir).
REQUIRED_PRIVATE = {"_validate_source"}


def _defined_here(value) -> bool:
    """True for names this module owns, False for anything it merely imported.

    Filtering on __module__ rather than an ignore-list of today's imports means
    adding an import cannot fail this guard for an unrelated reason."""
    if inspect.ismodule(value):
        return False
    origin = getattr(value, "__module__", None)
    return origin is None or origin == fields.__name__


def _covered_names() -> set:
    public = {
        name
        for name, value in vars(fields).items()
        if not name.startswith("_") and _defined_here(value)
    }
    return public | REQUIRED_PRIVATE


# ---- coverage guard ----


def test_every_public_name_has_a_fixture_case_and_every_fixture_key_is_real():
    required = _covered_names()
    assert required, "the module exposes nothing — this guard would pass vacuously"
    assert set(PY) == required, (
        "domain/fixtures/fields-cases.json's \"py\" keys must equal "
        "domain/py/fields.py's public names (plus the required private ones) exactly"
    )


def test_no_fixture_section_is_empty():
    for name, cases in PY.items():
        assert cases, f"py.{name} has no cases"
    for section in ("validation", "fieldLookup", "patchLimits"):
        assert SHARED[section], f"shared.{section} has no cases"


# ---- shared: validation (_validate_source vs JS's assertFieldsShape) ----

_EXECUTED = {"validation": [], "fieldLookup": [], "patchLimits": []}


@pytest.mark.parametrize("case", SHARED["validation"], ids=lambda c: c["case"])
def test_shared_validation(case):
    _EXECUTED["validation"].append(case["case"])
    expect = case["expect"]
    if expect["throws"]:
        with pytest.raises(RuntimeError) as exc:
            fields._validate_source(case["input"], "domain/fields.json")
        assert expect["messageContains"] in str(exc.value), (
            f'expected a message containing {expect["messageContains"]!r}, got: {exc.value}'
        )
    else:
        assert fields._validate_source(case["input"], "domain/fields.json") is case["input"]


# ---- shared: field lookup (field_by_name vs JS's fieldByName) ----


@pytest.mark.parametrize("case", SHARED["fieldLookup"], ids=lambda c: c["case"])
def test_shared_field_lookup(case):
    _EXECUTED["fieldLookup"].append(case["case"])
    expect = case["expect"]
    table = case["input"]["fields"]
    if not expect["found"]:
        with pytest.raises(KeyError) as exc:
            fields.field_by_name(table, case["name"])
        assert expect["messageContains"] in str(exc.value)
        assert case["name"] in str(exc.value), "the error does not name the missing field"
        return
    field = fields.field_by_name(table, case["name"])
    assert field["name"] == case["name"]
    for key, value in expect.items():
        if key == "found":
            continue
        assert field[key] == value, f'{case["name"]}.{key}'


# ---- shared: patch-limit derivation (patch_limits vs JS's patchLimits) ----


@pytest.mark.parametrize("case", SHARED["patchLimits"], ids=lambda c: c["case"])
def test_shared_patch_limits(case):
    _EXECUTED["patchLimits"].append(case["case"])
    got = fields.patch_limits(case["input"]["fields"])
    assert got == case["expect"]
    assert list(got) == case["expectOrder"], "the derived key order does not match the authored order"


# ---- py-only names ----


def test_py_fields_is_non_empty():
    for case in PY["FIELDS"]:
        assert fields.FIELDS, f'FIELDS: {case["case"]}'


@pytest.mark.parametrize("key,mapping", [("name", "BY_NAME"), ("column", "BY_COLUMN")])
def test_py_lookup_maps_cover_every_authored_field(key, mapping):
    cases = PY[mapping]
    assert cases[0]["expectKeyedBy"] == key
    table = getattr(fields, mapping)
    assert len(table) == len(fields.FIELDS), f"{mapping} lost an entry — two fields share a {key}?"
    for field in fields.FIELDS:
        assert table[field[key]] is field


def test_py_helpers_are_driven_by_the_shared_section():
    for name in ("field_by_name", "patch_limits", *REQUIRED_PRIVATE):
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
