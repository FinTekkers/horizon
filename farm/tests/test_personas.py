"""Persona registry, role composition and cross-language parity (HZ-4).

The success metric — a Python item runs with the Python persona, a UI item
with the UI persona — is proven at this end (validation + injection) plus the
server tests (proposal + gate + dispatch); together they cover the chain.

HZ-125 made the registry two levels deep (agent, then persona within that
agent) so the QA/Architect/PM agents have their own personas instead of
borrowing Eng's. Everything below is scoped per agent as a result, and the
shape invariants the restructure has to keep true — every persona belongs to
exactly one agent, at least two per agent, every id resolves to a file, no
non-Eng persona speaks in the implementer's voice — are asserted here rather
than left to careful prose.
"""

import re
from pathlib import Path

import pytest

from domain.py import personas as domain_personas
from farm import personas
from farm.personas import (
    DEFAULT_PERSONAS,
    LEGACY_PERSONA_IDS,
    PERSONA_PROVIDERS,
    PERSONAS,
    compose_role,
    provider_for,
    resolve,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# (agent, persona id, file name) for every registered persona.
ALL_PERSONAS = [(agent, pid, filename) for agent, bucket in PERSONAS.items() for pid, filename in bucket.items()]

COMPOSING_AGENTS = sorted(PERSONAS)


# ---- registry shape (HZ-125 success metrics 1–4) ----


def test_every_persona_is_namespaced_under_exactly_one_agent():
    """Metric 1. The nesting makes "has an agent" structural — a persona with
    no agent cannot be expressed — so what is actually at risk is the same id
    appearing under two agents, which would make `PERSONA_PROVIDERS` keys and
    UI labels ambiguous."""
    seen = {}
    for agent, persona_id, _filename in ALL_PERSONAS:
        assert persona_id not in seen, f"persona {persona_id!r} is registered under both {seen[persona_id]} and {agent}"
        seen[persona_id] = agent
    assert seen, "the registry is empty"


def test_at_least_two_personas_per_agent():
    """Metric 2. A single-persona agent is a flat list wearing a nested
    shape — there would be nothing to choose between."""
    for agent in ("eng", "qa", "architect", "pm"):
        assert agent in PERSONAS, f"no persona bucket for the {agent} agent"
        assert len(PERSONAS[agent]) >= 2, f"{agent} has fewer than two personas: {sorted(PERSONAS[agent])}"


def test_no_devops_personas():
    """HZ-125 guardrail 1: DevOps is project-scoped via
    farm/rules/projects/*.md, not stack-scoped, and composes no persona
    (HZ-22's architecture review)."""
    assert "devops" not in PERSONAS
    assert not list((personas.PERSONA_DIR).glob("devops_*.md"))


@pytest.mark.parametrize("agent,persona_id,filename", ALL_PERSONAS)
def test_every_registry_id_has_a_persona_file(agent, persona_id, filename):
    """Metric 3."""
    assert (personas.PERSONA_DIR / filename).is_file(), f"missing persona file for {agent}/{persona_id}"


@pytest.mark.parametrize("agent,persona_id,filename", ALL_PERSONAS)
def test_persona_file_names_are_prefixed_with_their_agent(agent, persona_id, filename):
    """The flat directory (see farm/personas.py on why it stays flat) carries
    the namespace in the file name, and server/src/definitions.js's
    effective-prompt preview maps a selected FILE back to its {agent, persona}
    slot by exactly this convention."""
    assert filename == f"{agent}_{persona_id}.md"


def test_every_persona_file_on_disk_is_registered():
    """The other direction: an orphan file is a persona someone can select in
    the definitions browser and edit, that no step will ever compose."""
    registered = {filename for _agent, _pid, filename in ALL_PERSONAS}
    on_disk = {path.name for path in personas.PERSONA_DIR.glob("*.md")}
    assert on_disk - registered == set(), f"unregistered persona file(s): {sorted(on_disk - registered)}"


# The exact phrase pair metric 4 bans for a non-Eng persona.
IMPLEMENTER_VOICE = re.compile(r"You are working as.{0,120}?specialist on this work item", re.DOTALL)
# The Eng side's own opening. Looser than the ban above because eng_fullstack
# reads "generalist", not "specialist" — it is still the builder's voice.
BUILDER_VOICE = re.compile(r"You are working as.{0,120}?on this work item", re.DOTALL)


@pytest.mark.parametrize(
    "agent,persona_id,filename", [triple for triple in ALL_PERSONAS if triple[0] != "eng"]
)
def test_non_eng_persona_files_do_not_use_implementer_voice(agent, persona_id, filename):
    """Metric 4, and the sentence the ticket was filed against: every persona
    file used to open "You are working as the X specialist on this work item",
    so the QA agent was told it was building the thing it was asked to
    review."""
    text = (personas.PERSONA_DIR / filename).read_text()
    assert not IMPLEMENTER_VOICE.search(text), f"{filename} speaks in the implementer's voice"


@pytest.mark.parametrize("persona_id", sorted(PERSONAS["eng"]))
def test_eng_persona_files_keep_the_implementer_voice(persona_id):
    """The complement of the test above: Eng personas SHOULD read as the
    implementer, so metric 4's ban must not have been applied everywhere."""
    text = (personas.PERSONA_DIR / PERSONAS["eng"][persona_id]).read_text()
    assert BUILDER_VOICE.search(text), f"eng/{persona_id} no longer reads as the implementer"


def test_every_agent_has_a_default_persona_in_its_own_bucket():
    assert set(DEFAULT_PERSONAS) == set(PERSONAS)
    for agent, default in DEFAULT_PERSONAS.items():
        assert default in PERSONAS[agent], f"{agent}'s default {default!r} is not one of its personas"


# ---- resolve (HZ-125 success metric 6) ----


@pytest.mark.parametrize("agent,persona_id,_filename", ALL_PERSONAS)
def test_resolve_accepts_ids_from_the_agents_own_bucket(agent, persona_id, _filename):
    assert resolve(agent, persona_id) == persona_id


@pytest.mark.parametrize("bogus", [None, "", "unknown_persona", 42, ["python"], {"id": "ui"}])
def test_resolve_falls_back_to_the_agents_default_on_junk(bogus):
    for agent in COMPOSING_AGENTS:
        assert resolve(agent, bogus) == DEFAULT_PERSONAS[agent]


def test_resolve_falls_back_when_the_persona_belongs_to_another_agent():
    """Metric 6's cross-agent half, at the unit level: 'python' is a real
    persona id, just not one the QA agent may wear."""
    assert resolve("qa", "python") == DEFAULT_PERSONAS["qa"]
    assert resolve("eng", "api_contract") == DEFAULT_PERSONAS["eng"]
    assert resolve("pm", "distributed_systems") == DEFAULT_PERSONAS["pm"]


@pytest.mark.parametrize("bad_agent", ["devops", "Eng", "", None, "nope"])
def test_resolve_raises_on_an_unknown_agent(bad_agent):
    """A caller only ever passes a literal from STEP_CONFIG, so an unknown
    agent is a code defect and must say so rather than quietly composing the
    generalist."""
    with pytest.raises(ValueError, match="unknown persona agent"):
        resolve(bad_agent, "fullstack")


def test_resolve_is_case_insensitive_and_strips_whitespace():
    assert resolve("eng", "Python") == "python"
    assert resolve("qa", "  E2E_Journey \n") == "e2e_journey"


# ---- legacy flat persona values (HZ-125 guardrail 3 / success metric 12) ----


def test_resolve_accepts_a_pre_hz125_flat_persona_value():
    """An item created before personas were agent-scoped carries a bare
    string. It must keep the specialist it was routed to, not be demoted to the
    generalist."""
    assert resolve("eng", "python_backend") == "python"
    assert resolve("eng", "frontend_ui") == "ui"
    assert resolve("eng", "fullstack") == "fullstack"


def test_a_legacy_value_is_not_accepted_for_another_agent():
    for agent in COMPOSING_AGENTS:
        if agent == "eng":
            continue
        assert resolve(agent, "python_backend") == DEFAULT_PERSONAS[agent]


def test_every_legacy_alias_points_at_a_live_persona():
    """A rename that forgets this map turns a legacy item's routing into a
    silent fallback."""
    for legacy_id, (agent, persona_id) in LEGACY_PERSONA_IDS.items():
        assert agent in PERSONAS, f"legacy alias {legacy_id} names unknown agent {agent}"
        assert persona_id in PERSONAS[agent], f"legacy alias {legacy_id} points at missing {agent}/{persona_id}"


# ---- compose_role ----


@pytest.mark.parametrize("agent,persona_id,filename", ALL_PERSONAS)
def test_compose_role_appends_each_personas_markdown(agent, persona_id, filename):
    composed = compose_role("BASE ROLE", agent, persona_id)
    assert composed.startswith("BASE ROLE")
    assert "## Your specialization" in composed
    assert (personas.PERSONA_DIR / filename).read_text() in composed


def test_compose_role_appends_and_never_replaces_the_role_text():
    """HZ-125 guardrail 8."""
    composed = compose_role("BASE ROLE", "qa", "e2e_journey")
    assert composed.index("BASE ROLE") < composed.index("## Your specialization")


def test_compose_role_with_a_wrong_bucket_id_falls_back_to_the_agents_default():
    """Metric 6 through the wrapper callers actually use."""
    composed = compose_role("BASE ROLE", "qa", "python")
    assert (personas.PERSONA_DIR / PERSONAS["qa"][DEFAULT_PERSONAS["qa"]]).read_text() in composed
    assert (personas.PERSONA_DIR / PERSONAS["eng"]["python"]).read_text() not in composed


@pytest.mark.parametrize("bad_agent", ["devops", "", None, "nope"])
def test_compose_role_returns_the_bare_role_for_an_unknown_agent(bad_agent):
    """compose_role is the never-raises wrapper: unlike resolve() it degrades,
    because a broken persona install must not dead-letter a run."""
    assert compose_role("BASE ROLE", bad_agent, "fullstack") == "BASE ROLE"


def test_compose_role_missing_file_falls_back_to_default(monkeypatch):
    monkeypatch.setitem(PERSONAS["eng"], "python", "does_not_exist.md")
    composed = compose_role("BASE ROLE", "eng", "python")
    assert (personas.PERSONA_DIR / PERSONAS["eng"][DEFAULT_PERSONAS["eng"]]).read_text() in composed


def test_compose_role_with_no_files_at_all_returns_bare_role(monkeypatch):
    monkeypatch.setattr(personas, "PERSONA_DIR", Path("/nonexistent-persona-dir"))
    assert compose_role("BASE ROLE", "eng", "python") == "BASE ROLE"


# ---- registry parity (architecture review note 1) ----
# The id set lives in three languages. This is the drift tripwire: an id added
# on one side without the others fails the build here, loudly. HZ-125 nested
# the registry, so the parser reads agent -> {ids} out of both JS copies rather
# than one flat level.


def _js_persona_ids(js_path: Path) -> dict[str, set[str]]:
    source = js_path.read_text()
    match = re.search(r"export const PERSONAS = \{(.*?)\n\}", source, re.DOTALL)
    assert match, f"could not find the `export const PERSONAS = {{` literal in {js_path}"
    by_agent: dict[str, set[str]] = {}
    agent = None
    for line in match.group(1).splitlines():
        agent_match = re.match(r"^ {2}(\w+): \{$", line)
        if agent_match:
            agent = agent_match.group(1)
            by_agent[agent] = set()
            continue
        persona_match = re.match(r"^ {4}(\w+):", line)
        if persona_match:
            assert agent, f"persona {persona_match.group(1)} outside any agent block in {js_path}"
            by_agent[agent].add(persona_match.group(1))
    # An empty extraction means the parser broke, not that parity holds.
    assert by_agent, f"extracted zero persona agents from {js_path} — the regex no longer matches the file"
    for found_agent, ids in by_agent.items():
        assert ids, f"extracted zero personas for {found_agent} in {js_path}"
    return by_agent


def _farm_persona_ids() -> dict[str, set[str]]:
    return {agent: set(bucket) for agent, bucket in PERSONAS.items()}


def test_registry_parity_across_farm_server_and_ui():
    server_ids = _js_persona_ids(REPO_ROOT / "server" / "src" / "personas.js")
    ui_ids = _js_persona_ids(REPO_ROOT / "ui" / "src" / "domain" / "personas.js")
    assert _farm_persona_ids() == server_ids == ui_ids


def test_the_parity_parser_still_fails_on_drift(tmp_path):
    """A rewritten parser that silently extracts nothing (or ignores the
    nesting) would make the test above pass forever. This proves it still
    catches both an added id and a moved one."""
    original = (REPO_ROOT / "server" / "src" / "personas.js").read_text()

    added = tmp_path / "added.js"
    added.write_text(original.replace("  qa: {\n", "  qa: {\n    smuggled_in: { label: 'X' },\n", 1))
    assert _js_persona_ids(added) != _farm_persona_ids()

    moved = tmp_path / "moved.js"
    moved.write_text(original.replace("    performance: {", "    moved_away: {", 1))
    assert _js_persona_ids(moved) != _farm_persona_ids()


def test_the_parity_parser_rejects_a_file_it_can_no_longer_read(tmp_path):
    empty = tmp_path / "empty.js"
    empty.write_text("export const PERSONAS = {\n}\n")
    with pytest.raises(AssertionError, match="extracted zero persona agents"):
        _js_persona_ids(empty)


def test_default_persona_parity_across_farm_and_the_js_copies():
    """HZ-380: the defaults are declared once, in domain/personas.json, and
    every layer derives them — the farm from domain/py/personas.py, the two JS
    copies from domain/js/personas.js. The grep test in test_pm_default.py
    bans a literal in any layer; this asserts the positive side, that each
    layer really derives rather than merely lacking a literal."""
    assert (REPO_ROOT / "farm" / "personas.py").read_text().count("from domain.py.personas import") == 1
    assert DEFAULT_PERSONAS == dict(domain_personas.DEFAULT_PERSONAS)
    for js_path, rel in (
        (REPO_ROOT / "server" / "src" / "personas.js", "../../domain/js/personas.js"),
        (REPO_ROOT / "ui" / "src" / "domain" / "personas.js", "../../../domain/js/personas.js"),
    ):
        source = js_path.read_text()
        assert re.search(
            r"import\s*\{\s*DEFAULT_PERSONAS\s+as\s+\w+\s*\}\s*from\s*['\"]"
            + re.escape(rel)
            + r"['\"]",
            source,
        ), f"{js_path} no longer derives DEFAULT_PERSONAS from the domain binding"
        assert re.search(
            r"export const DEFAULT_PERSONAS = \{\s*\.\.\.\w+\s*\}", source
        ), f"{js_path} no longer spreads the domain defaults into a fresh object"


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
    for bucket in PERSONAS.values():
        assert "muse_smoke_test" not in bucket
    assert "eng.muse_smoke_test" not in PERSONA_PROVIDERS
    assert not (REPO_ROOT / "farm" / "roles" / "personas" / "eng_muse_smoke_test.md").exists()
    assert not (REPO_ROOT / "farm" / "roles" / "personas" / "muse_smoke_test.md").exists()


def test_muse_smoke_test_persona_fixture_is_registered_and_mapped_to_muse(muse_smoke_test_persona):
    assert muse_smoke_test_persona in PERSONAS["eng"]
    assert PERSONA_PROVIDERS[f"eng.{muse_smoke_test_persona}"] == "muse"


def test_persona_provider_keys_are_namespaced_ids(muse_smoke_test_persona):
    """HZ-125 success metric 10: the mapping's keys moved with the ids. A bare
    persona id must no longer key an override — ids are only unique within an
    agent, so 'python' under eng and a future 'python' under qa have to be able
    to route differently."""
    for key in PERSONA_PROVIDERS:
        agent, _, persona_id = key.partition(".")
        assert agent in PERSONAS, f"provider key {key!r} names unknown agent {agent!r}"
        assert persona_id in PERSONAS[agent], f"provider key {key!r} names unknown persona"
    assert muse_smoke_test_persona not in PERSONA_PROVIDERS


def test_muse_smoke_test_persona_fixture_composes_into_a_role(muse_smoke_test_persona):
    """The fixture's absolute-path plumbing (PERSONA_DIR / PERSONAS[agent][id],
    where the value is an absolute path outside PERSONA_DIR) is otherwise
    never exercised — no shipped code calls compose_role() with this id."""
    composed = compose_role("BASE ROLE", "eng", muse_smoke_test_persona)
    assert composed.startswith("BASE ROLE")
    fixture_path = Path(PERSONAS["eng"][muse_smoke_test_persona])
    assert fixture_path.is_absolute()
    assert fixture_path.read_text() in composed


@pytest.mark.parametrize("agent,persona_id,_filename", ALL_PERSONAS)
def test_provider_for_returns_none_for_every_real_persona(agent, persona_id, _filename):
    assert provider_for({agent: persona_id}) is None


def test_provider_for_muse_smoke_test_returns_muse(muse_smoke_test_personas):
    assert provider_for(muse_smoke_test_personas) == "muse"


def test_provider_for_finds_a_forcing_persona_in_any_slot(muse_smoke_test_persona):
    """provider_for takes the item's whole map, so a forcing persona is found
    wherever it sits — and the real personas alongside it change nothing."""
    assert provider_for({"eng": muse_smoke_test_persona, "qa": "e2e_journey"}) == "muse"
    assert provider_for({"qa": "e2e_journey", "eng": muse_smoke_test_persona}) == "muse"
    assert provider_for({"qa": "e2e_journey", "architect": "data_modelling"}) is None


@pytest.mark.parametrize(
    "bogus",
    [None, "", {}, 42, "muse_smoke_test", {"eng": None}, {"nope": "muse_smoke_test"}, {"eng": "unknown_persona"}],
)
def test_provider_for_falls_back_to_none_on_junk(bogus, muse_smoke_test_persona):
    """Junk resolves to a default persona first, and no default is ever in
    PERSONA_PROVIDERS — an unrecognized persona (or a bare string where a map
    belongs) must never accidentally force a provider."""
    assert provider_for(bogus) is None


def test_provider_for_is_case_insensitive_and_strips_whitespace(muse_smoke_test_persona):
    assert provider_for({"eng": "Muse_Smoke_Test"}) == "muse"
    assert provider_for({"eng": "  muse_smoke_test \n"}) == "muse"
