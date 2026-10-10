"""HZ-133: domain/personas.json against the farm's own registry, as it stands today.

HZ-381 repointed farm/personas.py's PERSONAS and LEGACY_PERSONA_IDS at the
domain binding, so comparing the farm's tables to the domain's would compare
the document to itself. What remains pins the document's own facts instead:
the declared role files exist on disk and cover it exactly (both directions),
and the agent/persona order plus the legacy aliases equal hand-typed values —
a repoint that changed behaviour fails here, not silently.

Order is compared against literals, not just membership: provider_for() scans
PERSONAS in registry order, so agent order is behaviour.
"""

import shutil
from pathlib import Path

from domain.py import personas as domain_personas
from farm import personas as farm_personas

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# The registry order as it stands today: agent order is the picker's group
# order and provider_for()'s scan order, persona order the picker's option
# order. Hand-typed — comparing the farm to the domain would compare the
# document to itself after the HZ-381 repoint.
EXPECTED_ORDER = {
    "eng": ["fullstack", "python", "ui", "performance"],
    "qa": ["api_contract", "e2e_journey", "data_integrity"],
    "architect": ["data_modelling", "distributed_systems"],
    "pm": ["roadmap", "feature_development"],
}

EXPECTED_LEGACY = {
    "fullstack": ("eng", "fullstack"),
    "python_backend": ("eng", "python"),
    "frontend_ui": ("eng", "ui"),
}


def _declared_role_files() -> dict[str, str]:
    """Namespaced pair -> declared role file, straight off the binding."""
    return {
        pair: domain_personas.persona_role_file(*pair.split("."))
        for pair in domain_personas.NAMESPACED_PERSONA_IDS
    }


def _role_files_on_disk(personas_dir: Path) -> set[str]:
    """The *.md files in a personas directory, minus the directory's own
    README — documentation, not a persona, when one exists."""
    return {path.name for path in personas_dir.glob("*.md") if path.name != "README.md"}


def _check_role_files(personas_dir: Path, declared: dict[str, str]) -> list[str]:
    """Every way a personas directory can disagree with the declaration:
    a declared file that is missing, or a file on disk no persona declares."""
    problems = []
    on_disk = _role_files_on_disk(personas_dir)
    for pair in sorted(declared):
        if declared[pair] not in on_disk:
            problems.append(f"missing role file for {pair}: {declared[pair]}")
    for filename in sorted(on_disk - set(declared.values())):
        problems.append(f"role file on disk with no declaring persona: {filename}")
    return problems


def test_the_registry_order_equals_todays_hand_typed_order():
    assert list(farm_personas.PERSONAS) == list(EXPECTED_ORDER)
    assert list(domain_personas.PERSONA_AGENTS) == list(EXPECTED_ORDER)
    for agent, ids in EXPECTED_ORDER.items():
        assert list(farm_personas.PERSONAS[agent]) == ids, agent
        assert list(domain_personas.PERSONA_IDS[agent]) == ids, agent


def test_the_legacy_aliases_equal_their_pre_hz125_meaning_verbatim():
    assert dict(farm_personas.LEGACY_PERSONA_IDS) == EXPECTED_LEGACY
    assert dict(domain_personas.LEGACY_PERSONA_IDS) == EXPECTED_LEGACY
    for miss in ("eng.python", "python", "", "__proto__"):
        assert domain_personas.LEGACY_PERSONA_IDS.get(miss) is None, miss
        assert farm_personas.LEGACY_PERSONA_IDS.get(miss) is None, miss


def test_the_domain_persona_providers_equal_the_farm_ones_and_ship_empty():
    # HZ-121: no shipped persona forces a provider.
    assert dict(domain_personas.PERSONA_PROVIDERS) == farm_personas.PERSONA_PROVIDERS == {}


def test_every_declared_role_file_exists_on_disk():
    """Metric 1, first direction: every persona id resolves to a declared role
    file in farm/roles/personas/."""
    declared = _declared_role_files()
    assert len(declared) == 11
    assert len(set(declared.values())) == 11
    for pair, filename in sorted(declared.items()):
        assert (farm_personas.PERSONA_DIR / filename).is_file(), f"missing role file for {pair}: {filename}"


def test_every_role_file_on_disk_is_a_declared_persona():
    """Metric 1, second direction: no orphan role file the domain document
    does not declare."""
    assert _check_role_files(REPO_ROOT / "farm" / "roles" / "personas", _declared_role_files()) == []


def _copied_personas_dir(tmp_path: Path) -> Path:
    target = tmp_path / "personas"
    shutil.copytree(REPO_ROOT / "farm" / "roles" / "personas", target)
    return target


def test_the_disk_check_fails_naming_a_deleted_file(tmp_path):
    copied = _copied_personas_dir(tmp_path)
    (copied / "qa_api_contract.md").unlink()
    problems = _check_role_files(copied, _declared_role_files())
    assert len(problems) == 1
    assert "qa_api_contract.md" in problems[0]


def test_the_disk_check_fails_on_an_undeclared_file(tmp_path):
    copied = _copied_personas_dir(tmp_path)
    (copied / "x.md").write_text("# undeclared\n")
    problems = _check_role_files(copied, _declared_role_files())
    assert len(problems) == 1
    assert "x.md" in problems[0]


def test_the_disk_check_ignores_a_readme(tmp_path):
    """README.md is directory documentation, not a persona: its presence alone
    must not fail the check."""
    copied = _copied_personas_dir(tmp_path)
    (copied / "README.md").write_text("# personas\n")
    assert _check_role_files(copied, _declared_role_files()) == []
