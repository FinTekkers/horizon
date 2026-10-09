"""HZ-133: domain/personas.json against the farm's own registry, as it stands today.

server/test/domain-personas-parity.test.mjs pins the domain document to the two
JS registries; this is the farm leg. Without it the JS and Python bindings
could agree with each other and both be wrong, and repointing farm/personas.py
at domain/ would then change behaviour with every test green.

HZ-380 repointed farm/personas.py's DEFAULT_PERSONAS at the domain binding, so
the defaults leg that stood here compared the document to itself and was
deleted; what remains pins the still-hand-typed PERSONAS, legacy and provider
tables. The document itself is pinned by farm/tests/test_pm_default.py.

Order is compared, not just membership: provider_for() scans PERSONAS in
registry order, so agent order is behaviour.
"""

from pathlib import Path

from domain.py import personas as domain_personas
from farm import personas as farm_personas

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_the_domain_agents_and_ids_equal_the_farm_registry_in_order():
    assert list(farm_personas.PERSONAS) == list(domain_personas.PERSONA_AGENTS)
    for agent in domain_personas.PERSONA_AGENTS:
        assert tuple(farm_personas.PERSONAS[agent]) == domain_personas.PERSONA_IDS[agent], agent


def test_the_domain_legacy_aliases_equal_the_farm_ones_verbatim():
    assert dict(domain_personas.LEGACY_PERSONA_IDS) == farm_personas.LEGACY_PERSONA_IDS
    assert domain_personas.LEGACY_PERSONA_IDS["python_backend"] == ("eng", "python")
    assert domain_personas.LEGACY_PERSONA_IDS["frontend_ui"] == ("eng", "ui")
    assert domain_personas.LEGACY_PERSONA_IDS["fullstack"] == ("eng", "fullstack")
    for miss in ("eng.python", "python", "", "__proto__"):
        assert domain_personas.LEGACY_PERSONA_IDS.get(miss) is None, miss


def test_the_domain_persona_providers_equal_the_farm_ones_and_ship_empty():
    # HZ-121: no shipped persona forces a provider.
    assert dict(domain_personas.PERSONA_PROVIDERS) == farm_personas.PERSONA_PROVIDERS == {}


def test_the_derived_role_file_equals_the_farm_registry_and_exists_on_disk():
    """Metric 4, asserted on the DOMAIN binding: every persona id resolves to a
    role file in farm/roles/personas/, and the derived name is the one the farm
    registry hand-types today."""
    for pair in domain_personas.NAMESPACED_PERSONA_IDS:
        agent, persona_id = pair.split(".")
        filename = domain_personas.persona_role_file(agent, persona_id)
        assert filename == farm_personas.PERSONAS[agent][persona_id], pair
        assert (farm_personas.PERSONA_DIR / filename).is_file(), f"missing role file {filename}"


def test_every_role_file_on_disk_is_a_declared_persona():
    """The complement: no orphan role file the domain document does not declare."""
    on_disk = {path.name for path in (REPO_ROOT / "farm" / "roles" / "personas").glob("*.md")}
    derived = {
        domain_personas.persona_role_file(*pair.split(".")) for pair in domain_personas.NAMESPACED_PERSONA_IDS
    }
    assert derived
    assert on_disk == derived
