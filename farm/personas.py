"""Specialist persona registry and role composition for step agents.

Personas are specializations *within* a lifecycle agent, and since HZ-125 they
are scoped BY that agent: the registry is two levels deep — agent, then persona
within that agent. The Eng agent on a Python item should think like a Python
backend engineer; the QA agent reviewing the same item should think like a
contract tester, not like the engineer who built it. Before HZ-125 there was
one flat list of Eng specializations and the QA prompts composed them too,
which told the reviewer it was building the thing it was asked to review.

An item therefore carries a MAP of personas, one per composing agent
({"eng": "python", "qa": "e2e_journey"}), not a single id. The map is chosen
per work item on the server side (PM proposal, human confirmation at the intake
gate) and arrives on the task payload; this module only validates ids and
composes role prompts — it never routes.

The id set is mirrored in server/src/personas.js and ui/src/domain/personas.js
and parity-tested in tests/test_personas.py, so treat ids as append-only and
change all three copies together.

Persona FILES are a flat directory with an agent-prefixed filename
(eng_python.md, qa_api_contract.md), not a nested tree: server/src/
definitions.js's credential-safe path whitelist (NAME_RE, definitionPath,
listKind) deliberately forbids a slash in a definition name, and widening that
security-relevant code to walk subdirectories would buy nothing here.
"""

from pathlib import Path

PERSONA_DIR = Path(__file__).parent / "roles" / "personas"

# agent -> {persona id -> markdown file in farm/roles/personas/}
#
# Which steps actually compose one is STEP_CONFIG's business
# (farm/step_agent.py), not this table's: today the Eng bucket composes into the
# implement step and the code-review pass, and the QA bucket into the QA
# test-plan step and the QA-review pass. The Architect and PM buckets are
# registered, storable and pickable but not composed anywhere yet — the
# planning steps stay generalist (HZ-22's architecture review, restated in
# HZ-125's out-of-scope section). Wiring them in is a separate decision.
#
# DevOps is deliberately absent and must stay absent: it is project-scoped via
# farm/rules/projects/*.md, not stack-scoped, so it composes no persona.
#
# Guardrail against duplicated stack guidance: no persona here restates another
# agent's stack conventions. The QA/Architect/PM personas are scoped by testing
# method and design discipline, not by language, precisely so none of them has
# to repeat eng_python.md. If a language-flavoured persona is ever wanted for a
# second agent, factor the shared conventions into one file both reference
# rather than copying them.
PERSONAS = {
    "eng": {
        "fullstack": "eng_fullstack.md",
        "python": "eng_python.md",
        "ui": "eng_ui.md",
        "performance": "eng_performance.md",
    },
    "qa": {
        "api_contract": "qa_api_contract.md",
        "e2e_journey": "qa_e2e_journey.md",
        "data_integrity": "qa_data_integrity.md",
    },
    "architect": {
        "data_modelling": "architect_data_modelling.md",
        "distributed_systems": "architect_distributed_systems.md",
    },
    "pm": {
        "roadmap": "pm_roadmap.md",
        "feature_development": "pm_feature_development.md",
    },
}

# agent -> the persona an item gets when it carries none for that agent (or
# carries one that does not belong to it).
DEFAULT_PERSONAS = {
    "eng": "fullstack",
    "qa": "e2e_journey",
    "architect": "data_modelling",
    "pm": "roadmap",
}

# Flat pre-HZ-125 persona value -> (agent, persona id). Items created before
# personas were agent-scoped carry a bare string in work_item.persona; every one
# of those values was an Eng specialization. Read-only compatibility, never
# written: resolve() accepts these so an item mid-flight when this shipped keeps
# the specialist it was routed to instead of silently falling back to the
# generalist. Mirrored in server/src/personas.js (LEGACY_PERSONA_IDS).
LEGACY_PERSONA_IDS = {
    "fullstack": ("eng", "fullstack"),
    "python_backend": ("eng", "python"),
    "frontend_ui": ("eng", "ui"),
}

# namespaced persona id ("<agent>.<persona>") -> provider name
# (farm/agent_runner.py's _PROVIDERS), for a persona that must force a
# non-default provider. Ships empty: every real persona is absent from this map
# on purpose, so provider_for() returns None for all of them and run_agent()
# falls back to its normal FARM_PROVIDER-selected default (Claude), unchanged.
# The override mechanism itself (HZ-102) is proven by a test-registered fixture
# persona (farm/tests/conftest.py's muse_smoke_test_persona), not a shipped one
# — see HZ-121. Which real personas, if any, should route to a non-default
# provider is a decision that needs evidence about provider capability that
# doesn't exist yet; don't populate this map to "use" the mechanism.
#
# Keys are namespaced because persona ids are only unique within an agent
# (HZ-125) — "python" under eng and a future "python" under qa are different
# personas and must be able to route differently.
#
# Kept separate from PERSONAS rather than an extra field on each entry:
# PERSONAS's id set is mirrored append-only into server/src/personas.js and
# ui/src/domain/personas.js (parity-tested), and neither of those has any
# notion of a farm provider — folding "provider" onto PERSONAS would either
# leak a farm-only routing concept into that three-way mirror or force the
# server/UI copies to carry a field they can't act on.
PERSONA_PROVIDERS = {}


def resolve(agent: str, persona_id) -> str:
    """Map an item's persona value for `agent` to a persona id in that agent's
    bucket, best-effort.

    Case-insensitive and whitespace-tolerant. Accepts a pre-HZ-125 flat id
    (LEGACY_PERSONA_IDS) when it belongs to this agent. Anything else — None,
    wrong type, an unregistered id, or a perfectly valid id belonging to a
    DIFFERENT agent — falls back to DEFAULT_PERSONAS[agent]: persona routing
    must never block a run, and a QA step must never end up wearing an Eng
    persona.

    Raises ValueError for an unknown agent. That is a programmer error, not
    data: every caller passes a literal from STEP_CONFIG, so an unknown agent
    means the code is wrong and should say so rather than quietly compose the
    generalist. compose_role() below is the never-raises wrapper callers use.
    """
    bucket = PERSONAS.get(agent)
    if bucket is None:
        raise ValueError(f"unknown persona agent {agent!r} — known agents: {sorted(PERSONAS)}")
    candidate = persona_id.strip().lower() if isinstance(persona_id, str) else ""
    if candidate in bucket:
        return candidate
    legacy = LEGACY_PERSONA_IDS.get(candidate)
    if legacy and legacy[0] == agent and legacy[1] in bucket:
        return legacy[1]
    return DEFAULT_PERSONAS[agent]


def provider_for(personas) -> str | None:
    """The provider an item's personas force (farm/agent_runner.py's
    run_agent(provider=...)), or None to keep the caller's normal
    FARM_PROVIDER-selected default.

    Takes the item's whole {agent: persona id} map, since a provider override
    is a property of the persona rather than of the step's agent: the only
    persona that forces one today is a test fixture (HZ-121) and the steps
    eligible for an override are the generalist planning steps, which compose
    no persona at all. So whichever slot holds a provider-forcing persona wins,
    scanned in registry order for determinism.

    Note the widening this implies: pre-HZ-125 one flat field could hold a
    provider-forcing persona, now four slots can, and a persona in (say) the pm
    slot would affect any override-eligible step rather than only PM steps.
    Inert today (PERSONA_PROVIDERS ships empty) but a real consideration before
    mapping a shipped persona to a provider.

    Junk (None, wrong type, unknown agent, unregistered id) contributes
    nothing — an unrecognized persona must never accidentally force a provider.
    """
    if not isinstance(personas, dict):
        return None
    for agent in PERSONAS:
        if agent not in personas:
            continue
        provider = PERSONA_PROVIDERS.get(f"{agent}.{resolve(agent, personas[agent])}")
        if provider:
            return provider
    return None


def compose_role(role_text: str, agent: str, persona_id) -> str:
    """Append the `agent` bucket's persona markdown to a role prompt.

    Appends under a "## Your specialization" heading — it never replaces the
    step's role text.

    Never raises: an unknown agent, a missing persona file, or a persona id
    belonging to another agent all degrade rather than failing the run. An
    unknown agent returns the role untouched; a wrong-bucket or junk id falls
    back to that agent's default persona (resolve() above); a missing file
    falls back to the default persona's file, and if that is also missing the
    role text is returned untouched — a broken persona install degrades to
    pre-persona behavior, not a dead run.
    """
    bucket = PERSONAS.get(agent)
    if bucket is None:
        return role_text
    resolved = resolve(agent, persona_id)
    for candidate in (resolved, DEFAULT_PERSONAS[agent]):
        try:
            persona_md = (PERSONA_DIR / bucket[candidate]).read_text()
        except OSError:
            continue
        return f"{role_text}\n\n## Your specialization\n{persona_md}"
    return role_text
