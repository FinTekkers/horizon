"""Persona registry, role composition and cross-language parity (HZ-4).

The success metric — a Python item runs with the Python persona, a UI item
with the UI persona — is proven at this end (validation + injection) plus the
server tests (proposal + gate + dispatch); together they cover the chain.
"""

import re
from pathlib import Path

import pytest

from farm import personas
from farm.personas import DEFAULT_PERSONA, PERSONA_PROVIDERS, PERSONAS, compose_role, provider_for, resolve

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_every_registry_id_has_a_persona_file():
    for persona_id, filename in PERSONAS.items():
        assert (personas.PERSONA_DIR / filename).is_file(), f"missing persona file for {persona_id}"


@pytest.mark.parametrize("valid_id", sorted(PERSONAS))
def test_resolve_accepts_registry_ids(valid_id):
    assert resolve(valid_id) == valid_id


@pytest.mark.parametrize("bogus", [None, "", "unknown_persona", 42, ["python_backend"], {"id": "frontend_ui"}])
def test_resolve_falls_back_to_default_on_junk(bogus):
    assert resolve(bogus) == DEFAULT_PERSONA


def test_resolve_is_case_insensitive_and_strips_whitespace():
    assert resolve("Python_Backend") == "python_backend"
    assert resolve("  frontend_ui \n") == "frontend_ui"


def test_compose_role_appends_each_personas_markdown():
    for persona_id, filename in PERSONAS.items():
        composed = compose_role("BASE ROLE", persona_id)
        assert composed.startswith("BASE ROLE")
        assert "## Your specialization" in composed
        assert (personas.PERSONA_DIR / filename).read_text() in composed


def test_compose_role_missing_file_falls_back_to_default(monkeypatch):
    monkeypatch.setitem(PERSONAS, "python_backend", "does_not_exist.md")
    composed = compose_role("BASE ROLE", "python_backend")
    assert (personas.PERSONA_DIR / PERSONAS[DEFAULT_PERSONA]).read_text() in composed


def test_compose_role_with_no_files_at_all_returns_bare_role(monkeypatch):
    monkeypatch.setattr(personas, "PERSONA_DIR", Path("/nonexistent-persona-dir"))
    assert compose_role("BASE ROLE", "python_backend") == "BASE ROLE"


# ---- registry parity (architecture review note 1) ----
# The id set lives in three languages. This is the drift tripwire: an id added
# on one side without the others fails the build here, loudly.


def _js_persona_ids(js_path: Path) -> set[str]:
    source = js_path.read_text()
    match = re.search(r"export const PERSONAS = \{(.*?)\n\}", source, re.DOTALL)
    assert match, f"could not find the `export const PERSONAS = {{` literal in {js_path}"
    ids = set(re.findall(r"^ {2}(\w+):", match.group(1), re.MULTILINE))
    # An empty extraction means the parser broke, not that parity holds.
    assert ids, f"extracted zero persona ids from {js_path} — the regex no longer matches the file"
    return ids


def test_registry_parity_across_farm_server_and_ui():
    server_ids = _js_persona_ids(REPO_ROOT / "server" / "src" / "personas.js")
    ui_ids = _js_persona_ids(REPO_ROOT / "ui" / "src" / "domain" / "personas.js")
    assert set(PERSONAS) == server_ids == ui_ids


# ---- persona -> provider override (HZ-102 / HZ-121) ----
# PERSONA_PROVIDERS ships empty — no shipped persona forces a non-default
# provider. The override mechanism itself still needs proof it works, so
# these tests register a test-only fixture persona (conftest.py's
# muse_smoke_test_persona) mapped to a non-default provider rather than
# relying on a shipped fake persona. Every real persona must return None
# here — Claude stays the default for all real work.


def test_persona_providers_ships_empty():
    assert PERSONA_PROVIDERS == {}


def test_muse_smoke_test_persona_is_not_shipped():
    """HZ-121: the fake persona used to prove provider routing must not ship
    in the production registry or on disk — only a test fixture may register
    it (see muse_smoke_test_persona below)."""
    assert "muse_smoke_test" not in PERSONAS
    assert "muse_smoke_test" not in PERSONA_PROVIDERS
    assert not (REPO_ROOT / "farm" / "roles" / "personas" / "muse_smoke_test.md").exists()


def test_muse_smoke_test_persona_fixture_is_registered_and_mapped_to_muse(muse_smoke_test_persona):
    assert muse_smoke_test_persona in PERSONAS
    assert PERSONA_PROVIDERS[muse_smoke_test_persona] == "muse"


def test_muse_smoke_test_persona_fixture_composes_into_a_role(muse_smoke_test_persona):
    """The fixture's absolute-path plumbing (PERSONA_DIR / PERSONAS[id],
    where PERSONAS[id] is an absolute path outside PERSONA_DIR) is otherwise
    never exercised — no shipped code calls compose_role() with this id."""
    composed = compose_role("BASE ROLE", muse_smoke_test_persona)
    assert composed.startswith("BASE ROLE")
    fixture_path = Path(PERSONAS[muse_smoke_test_persona])
    assert fixture_path.is_absolute()
    assert fixture_path.read_text() in composed


@pytest.mark.parametrize("real_persona", ["fullstack", "python_backend", "frontend_ui"])
def test_provider_for_returns_none_for_every_real_persona(real_persona):
    assert provider_for(real_persona) is None


def test_provider_for_muse_smoke_test_returns_muse(muse_smoke_test_persona):
    assert provider_for(muse_smoke_test_persona) == "muse"


@pytest.mark.parametrize("bogus", [None, "", "unknown_persona", 42])
def test_provider_for_falls_back_to_none_on_junk(bogus):
    """Junk resolves to DEFAULT_PERSONA (fullstack) first, which is never in
    PERSONA_PROVIDERS — an unrecognized persona must never accidentally force
    a provider."""
    assert provider_for(bogus) is None


def test_provider_for_is_case_insensitive_and_strips_whitespace(muse_smoke_test_persona):
    assert provider_for("Muse_Smoke_Test") == "muse"
    assert provider_for("  muse_smoke_test \n") == "muse"
