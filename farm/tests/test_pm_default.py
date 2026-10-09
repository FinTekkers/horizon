"""HZ-380: the PM agent defaults to the feature-development persona.

domain/personas.json is the one place the default is declared; farm, server
and UI derive it. A stored `roadmap` choice keeps resolving to Roadmap.
"""

import json
from pathlib import Path

import pytest

from farm import personas as farm_personas
from farm.personas import DEFAULT_PERSONAS, compose_role, resolve

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _domain_defaults() -> dict:
    """The agent -> default table straight off domain/personas.json, not via
    the binding farm/personas.py derives from — comparing the farm to the
    binding would compare the document to itself."""
    doc = json.loads((REPO_ROOT / "domain" / "personas.json").read_text())
    return {entry["agent"]: entry["default"] for entry in doc["agents"]}


def _persona_md(filename: str) -> str:
    return (farm_personas.PERSONA_DIR / filename).read_text()


# ---- metric 1: with no PM persona chosen, the farm resolves feature_development ----


@pytest.mark.parametrize("missing", [None, "", "retired_id", 42])
def test_pm_with_no_persona_chosen_resolves_to_feature_development(missing):
    assert resolve("pm", missing) == "feature_development"


def test_compose_role_for_an_unset_pm_persona_includes_the_feature_development_text():
    composed = compose_role("BASE ROLE", "pm", None)
    assert _persona_md("pm_feature_development.md") in composed
    assert _persona_md("pm_roadmap.md") not in composed


# ---- metric 3, farm leg: the farm default equals the declared one ----


def test_farm_pm_default_equals_domain_personas_json():
    assert DEFAULT_PERSONAS["pm"] == _domain_defaults()["pm"]
    assert DEFAULT_PERSONAS["pm"] == "feature_development"


# ---- metric 4, farm leg: a stored roadmap choice still resolves to Roadmap ----


def test_stored_roadmap_still_resolves_to_roadmap():
    assert resolve("pm", "roadmap") == "roadmap"


def test_compose_role_for_stored_roadmap_includes_the_roadmap_text():
    composed = compose_role("BASE ROLE", "pm", "roadmap")
    assert _persona_md("pm_roadmap.md") in composed
    assert _persona_md("pm_feature_development.md") not in composed


# ---- guardrail 1, second half: every non-pm default is unchanged ----


def test_non_pm_defaults_are_unchanged_in_the_farm_and_the_document():
    expected = {"eng": "fullstack", "qa": "e2e_journey", "architect": "data_modelling"}
    assert {agent: DEFAULT_PERSONAS[agent] for agent in expected} == expected
    domain = _domain_defaults()
    assert {agent: domain[agent] for agent in expected} == expected
