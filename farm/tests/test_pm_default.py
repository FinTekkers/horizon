"""HZ-380: the PM agent defaults to the feature-development persona.

domain/personas.json is the one place the default is declared; farm, server
and UI derive it (farm/personas.py, server/src/personas.js and
ui/src/domain/personas.js hold no literal of their own — the grep test below
is the tripwire). A stored `roadmap` choice keeps resolving to Roadmap.
"""

import json
import re
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


_PM_DEFAULT_LITERAL = re.compile(r"""^\s*['"]?pm['"]?\s*:\s*['"]""")


def test_no_layer_file_declares_a_literal_pm_default():
    """HZ-380 metric 3's grep leg: the pm default lives in
    domain/personas.json, so no `pm` key with a persona-id value may appear in
    any layer file. The PERSONAS buckets keep their `pm` agent keys and both
    pm ids — those are the registry, not a default declaration."""
    for path in (
        REPO_ROOT / "farm" / "personas.py",
        REPO_ROOT / "server" / "src" / "personas.js",
        REPO_ROOT / "ui" / "src" / "domain" / "personas.js",
    ):
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            assert not _PM_DEFAULT_LITERAL.match(line), (
                f"{path}:{lineno} declares a literal pm default: {line.strip()}"
            )
    # Negative control: the scan still sees each file's legitimate roadmap
    # references — it bans the default declaration, not the id.
    for path in (
        REPO_ROOT / "farm" / "personas.py",
        REPO_ROOT / "server" / "src" / "personas.js",
        REPO_ROOT / "ui" / "src" / "domain" / "personas.js",
    ):
        text = path.read_text()
        assert "roadmap" in text, f"{path} lost its roadmap persona?"
        assert "feature_development" in text, f"{path} lost its feature_development persona?"


def test_the_pm_default_pattern_matches_the_old_literals():
    """Positive control: the pattern above catches a pm default however the
    layer spells it."""
    for literal in (
        '"pm": "roadmap",',
        "pm: 'roadmap',",
        '"pm": "feature_development",',
        "  pm: 'feature_development',",
    ):
        assert _PM_DEFAULT_LITERAL.match(literal), literal


def test_the_pm_default_pattern_ignores_registry_lines():
    """Negative control: agent keys, persona ids and role-file references pass."""
    for line in (
        '"pm": {',
        "  pm: {",
        '"roadmap": "pm_roadmap.md",',
        "    roadmap: { label: 'Roadmap' },",
        "file: 'pm_roadmap.md',",
    ):
        assert not _PM_DEFAULT_LITERAL.match(line), line


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
