"""HZ-133's cross-language fixture, the Python half.

server/test/domain-personas-cases.test.mjs is the JS half. Both run the SAME
`shared` section off the SAME domain/fixtures/personas-cases.json:
domain/js/personas.js and domain/py/personas.py are two independent
hand-written implementations, and server/test/domain-personas-parity.test.mjs
only compares their DATA output. Without this file the Python validator's
rejection rules would carry no coverage at all.

Same three vacuity guards as test_priorities_fixtures.py: SET EQUALITY between
fixture keys and public names, NON-EMPTY sections, and a PINNED MANIFEST.
"""

import inspect
import json
import types
from pathlib import Path

import pytest

from domain.py import personas

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain" / "fixtures" / "personas-cases.json").read_text())
SHARED = CASES["shared"]
PY = {name: cases for name, cases in CASES["py"].items() if not name.startswith("$")}

# The underscore-private validator is what `shared.validation` exists to compare
# across languages, so it is required to carry fixture coverage. _load_source is
# file I/O around it, proven by the real-import tests in
# server/test/domain-personas-schema.test.mjs; _json/_is_id/_split_pair are
# helpers with no rule of their own.
REQUIRED_PRIVATE = {"_validate_source"}

SECTIONS = ("validation", "membership", "roleFile", "resolveModel")


def _defined_here(value) -> bool:
    if inspect.ismodule(value):
        return False
    origin = getattr(value, "__module__", None)
    return origin is None or origin == personas.__name__


def _covered_names() -> set:
    public = {name for name, value in vars(personas).items() if not name.startswith("_") and _defined_here(value)}
    return public | REQUIRED_PRIVATE


# ---- coverage guard ----


def test_every_public_name_has_a_fixture_case_and_every_fixture_key_is_real():
    required = _covered_names()
    assert required, "the module exposes nothing — this guard would pass vacuously"
    assert set(PY) == required, (
        "domain/fixtures/personas-cases.json's \"py\" keys must equal "
        "domain/py/personas.py's public names (plus the required private ones) exactly"
    )


def test_no_fixture_section_is_empty():
    for name, cases in PY.items():
        assert cases, f"py.{name} has no cases"
    for section in SECTIONS:
        assert SHARED[section], f"shared.{section} has no cases"


_EXECUTED = {section: [] for section in SECTIONS}


# ---- shared: validation (_validate_source vs JS's assertPersonasShape) ----


@pytest.mark.parametrize("case", SHARED["validation"], ids=lambda c: c["case"])
def test_shared_validation(case):
    _EXECUTED["validation"].append(case["case"])
    expect = case["expect"]
    if expect["throws"]:
        with pytest.raises(RuntimeError) as exc:
            personas._validate_source(case["input"], "domain/personas.json")
        assert expect["messageContains"] in str(exc.value), (
            f'expected a message containing {expect["messageContains"]!r}, got: {exc.value}'
        )
    else:
        assert personas._validate_source(case["input"], "domain/personas.json") is case["input"]


# ---- shared: membership (is_persona vs JS's isPersona) ----


@pytest.mark.parametrize("case", SHARED["membership"], ids=lambda c: c["case"])
def test_shared_membership(case):
    _EXECUTED["membership"].append(case["case"])
    assert personas.is_persona(case["agent"], case["id"], case["personaIds"]) is case["expect"]


# ---- shared: roleFile (persona_role_file vs JS's personaRoleFile) ----


@pytest.mark.parametrize("case", SHARED["roleFile"], ids=lambda c: c["case"])
def test_shared_role_file(case):
    _EXECUTED["roleFile"].append(case["case"])
    expect = case["expect"]
    if "throws" in expect:
        with pytest.raises(ValueError) as exc:
            personas.persona_role_file(case["agent"], case["id"], case["personaIds"])
        assert expect["throws"] in str(exc.value)
    else:
        assert personas.persona_role_file(case["agent"], case["id"], case["personaIds"]) == expect["file"]


# ---- shared: resolveModel (resolve_model vs JS's resolveModel) — HZ-192 ----


@pytest.mark.parametrize("case", SHARED["resolveModel"], ids=lambda c: c["case"])
def test_shared_resolve_model(case):
    _EXECUTED["resolveModel"].append(case["case"])
    expect = case["expect"]
    if "throws" in expect:
        with pytest.raises(ValueError) as exc:
            personas.resolve_model(case["agent"], case["step"], case["persona"], case["models"])
        assert expect["throws"] in str(exc.value)
    else:
        assert personas.resolve_model(case["agent"], case["step"], case["persona"], case["models"]) == expect["model"]


# ---- py-only names, checked against the live document ----


def test_py_persona_agents_is_a_non_empty_tuple():
    assert PY["PERSONA_AGENTS"]
    assert isinstance(personas.PERSONA_AGENTS, tuple) and personas.PERSONA_AGENTS


def test_py_persona_ids_maps_every_agent_to_a_non_empty_tuple_read_only():
    assert PY["PERSONA_IDS"]
    assert isinstance(personas.PERSONA_IDS, types.MappingProxyType)
    assert tuple(personas.PERSONA_IDS) == personas.PERSONA_AGENTS
    for agent, ids in personas.PERSONA_IDS.items():
        assert isinstance(ids, tuple) and ids, agent
    with pytest.raises(TypeError):
        personas.PERSONA_IDS["intruder"] = ("x",)


def test_py_namespaced_persona_ids_are_ordered_agent_then_persona():
    assert PY["NAMESPACED_PERSONA_IDS"]
    assert personas.NAMESPACED_PERSONA_IDS == tuple(
        f"{agent}.{persona}" for agent in personas.PERSONA_AGENTS for persona in personas.PERSONA_IDS[agent]
    )


def test_py_default_personas_belong_to_their_own_agent():
    assert PY["DEFAULT_PERSONAS"]
    assert tuple(personas.DEFAULT_PERSONAS) == personas.PERSONA_AGENTS
    for agent, default in personas.DEFAULT_PERSONAS.items():
        assert personas.is_persona(agent, default), agent


def test_py_primary_persona_agent_is_declared():
    assert PY["PRIMARY_PERSONA_AGENT"]
    assert personas.PRIMARY_PERSONA_AGENT in personas.PERSONA_IDS


def test_py_legacy_persona_ids_name_declared_pairs_as_tuples():
    assert PY["LEGACY_PERSONA_IDS"]
    assert personas.LEGACY_PERSONA_IDS
    for alias, pair in personas.LEGACY_PERSONA_IDS.items():
        assert isinstance(pair, tuple) and len(pair) == 2, alias
        assert personas.is_persona(*pair), alias


def test_py_persona_providers_keys_name_declared_pairs():
    assert PY["PERSONA_PROVIDERS"]
    assert isinstance(personas.PERSONA_PROVIDERS, types.MappingProxyType)
    for key in personas.PERSONA_PROVIDERS:
        assert key in personas.NAMESPACED_PERSONA_IDS, key


def test_py_models_carries_agents_steps_and_personas_read_only():
    assert PY["MODELS"]
    assert isinstance(personas.MODELS, types.MappingProxyType)
    assert tuple(personas.MODELS) == ("agents", "steps", "personas")
    assert personas.MODELS["agents"]
    for name, mapping in personas.MODELS.items():
        assert isinstance(mapping, types.MappingProxyType), name
    with pytest.raises(TypeError):
        personas.MODELS["agents"]["intruder"] = "claude-x"


def test_py_concierge_and_conflict_model_agents_have_a_default_model():
    assert PY["CONCIERGE_MODEL_AGENT"] and PY["CONFLICT_MODEL_AGENT"]
    assert personas.CONCIERGE_MODEL_AGENT in personas.MODELS["agents"]
    assert personas.CONFLICT_MODEL_AGENT in personas.MODELS["agents"]


def test_py_conflict_step_key_is_not_a_steps_json_label():
    from domain.py import steps

    assert PY["CONFLICT_STEP_KEY"]
    assert personas.CONFLICT_STEP_KEY not in {step["label"] for step in steps.STEPS}


@pytest.mark.parametrize("case", CASES["py"]["model_agent_for_step"], ids=lambda c: c["case"])
def test_py_model_agent_for_step_lower_cases_the_display_name(case):
    assert personas.model_agent_for_step(case["stepAgent"]) == case["expect"]


def test_py_helpers_are_driven_by_the_shared_sections():
    for name in ("is_persona", "persona_role_file", "resolve_model", *REQUIRED_PRIVATE):
        assert PY[name][0]["drivenBy"].startswith("shared."), f"py.{name} claims no shared driver"


# ---- the manifest: this suite really ran every shared case ----
# Declared last on purpose: pytest runs in file order, so every parametrized
# shared case above has already appended its id by the time this runs.


def test_manifest_the_python_suite_executed_exactly_the_pinned_shared_cases():
    assert set(SHARED["manifest"]) == set(SECTIONS)
    for section, ids in SHARED["manifest"].items():
        assert sorted(_EXECUTED[section]) == sorted(ids), (
            f"the Python suite did not run shared.{section} as pinned — "
            "the cross-language guarantee is only as good as this list"
        )
