"""HZ-381: persona ids, agent membership and role files are declared once, in
domain/personas.json — the farm reads them from there.

- farm/personas.py declares no persona id as a string literal (metric 2, farm
  leg) — outside LEGACY_PERSONA_IDS, which is compatibility, not a declaration.
- The farm's composed prompts equal the pre-change snapshot byte for byte
  (metric 4, farm leg).
- domain/personas.json is the pre-change document plus roleFiles (guardrail 2).
"""

import ast
import json
from pathlib import Path

from domain.py import personas as domain_personas
from farm.personas import compose_role

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

HZ381_ROLE_TEXT = "HZ-381 composed-prompt snapshot sentinel"


def _domain_persona_ids() -> set[str]:
    """Every persona id in domain/personas.json, straight off the document
    rather than via the binding farm/personas.py derives from."""
    doc = json.loads((REPO_ROOT / "domain" / "personas.json").read_text())
    return {persona_id for entry in doc["agents"] for persona_id in entry["personas"]}


def _flagged_id_literals(source: str, ids: set[str]) -> list[tuple[int, str]]:
    """(line, value) for every string literal in `source` equal to a domain
    persona id, outside the LEGACY_PERSONA_IDS statement (when the file has
    one).

    Equality, not substring: a docstring that mentions an id is one long
    literal, never equal to the id itself.
    """
    tree = ast.parse(source)
    legacy_span: tuple[int, int] | None = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "LEGACY_PERSONA_IDS" for target in node.targets
        ):
            legacy_span = (node.lineno, node.end_lineno or node.lineno)
    flagged = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        if node.value not in ids:
            continue
        if legacy_span and legacy_span[0] <= node.lineno <= legacy_span[1]:
            continue
        flagged.append((node.lineno, node.value))
    return sorted(flagged)


def test_farm_personas_declares_no_persona_id_as_a_string_literal():
    ids = _domain_persona_ids()
    assert len(ids) == 11, "positive control: the scan compares against a real id set"
    source = (REPO_ROOT / "farm" / "personas.py").read_text()
    assert _flagged_id_literals(source, ids) == []


def test_the_farm_scan_flags_a_bare_persona_id():
    """Positive control: the scan is not vacuous."""
    assert _flagged_id_literals("CHOSEN = 'roadmap'\n", {"roadmap"}) == [(1, "roadmap")]


def test_the_farm_scan_exempts_only_the_legacy_aliases_declaration():
    """A literal inside the LEGACY_PERSONA_IDS statement is compatibility, not
    a declaration; the same literal one statement later is."""
    source = 'LEGACY_PERSONA_IDS = {"x": ("eng", "roadmap")}\nCHOSEN = "roadmap"\n'
    assert _flagged_id_literals(source, {"roadmap"}) == [(2, "roadmap")]


def test_composed_prompts_match_the_pre_change_snapshot_byte_for_byte():
    """Metric 4, farm leg: compose_role() output for all 11 personas equals
    the snapshot taken before the HZ-381 repoint, compared raw — no strip,
    no newline normalisation."""
    snapshot = json.loads((FIXTURES / "personas-prompts-hz381.json").read_text())
    assert snapshot["role_text"] == HZ381_ROLE_TEXT
    assert set(snapshot["prompts"]) == set(domain_personas.NAMESPACED_PERSONA_IDS)
    assert len(snapshot["prompts"]) == 11
    for pair in domain_personas.NAMESPACED_PERSONA_IDS:
        agent, persona_id = pair.split(".")
        assert compose_role(snapshot["role_text"], agent, persona_id) == snapshot["prompts"][pair]


def test_domain_personas_json_is_the_pre_change_document_plus_rolefiles():
    """Guardrail 2: HZ-381 only ADDS role-file declarations — every default,
    legacyIds, models and personaProviders value is identical to the pre-change
    document."""
    live = json.loads((REPO_ROOT / "domain" / "personas.json").read_text())
    step0 = json.loads((FIXTURES / "personas-json-hz381-step0.json").read_text())
    assert len(live["agents"]) == len(step0["agents"]) == 4
    for entry in live["agents"]:
        assert set(entry["roleFiles"]) == set(entry["personas"])
        del entry["roleFiles"]
    assert live == step0
