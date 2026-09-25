"""Specialist persona registry and role composition for step agents.

Personas are stack specializations *within* a lifecycle role: the Eng agent on
a Python item should think like a Python backend engineer, on a UI item like a
frontend engineer. The persona id is chosen per work item on the server side
(PM proposal, human confirmation at the intake gate) and arrives on the task
payload; this module only validates the id and composes the role prompt — it
never routes. The id set is mirrored in server/src/personas.js and
ui/src/domain/personas.js and parity-tested in tests/test_personas.py, so
treat ids as append-only and change all three copies together.
"""

from pathlib import Path

PERSONA_DIR = Path(__file__).parent / "roles" / "personas"

# persona id -> markdown file in farm/roles/personas/
PERSONAS = {
    "fullstack": "fullstack.md",
    "python_backend": "python_backend.md",
    "frontend_ui": "frontend_ui.md",
    # HZ-102: test-only — proves the Muse provider seam (HZ-83) actually runs
    # a real step, never a real persona. Filtered out of the UI's persona
    # picker (ui/src/components/Tracker.jsx) and never proposed automatically
    # (server/src/personas.js's proposePersona heuristic never returns it) —
    # an item only carries it if someone sets it by hand on a throwaway item.
    "muse_smoke_test": "muse_smoke_test.md",
}

DEFAULT_PERSONA = "fullstack"

# persona id -> provider name (farm/agent_runner.py's _PROVIDERS), for the
# one persona that must force a non-default provider. Every real persona is
# absent from this map on purpose: provider_for() returns None for them, so
# run_agent() falls back to its normal FARM_PROVIDER-selected default
# (Claude) unchanged (HZ-102 guardrail: this adds one mapped test persona,
# it does not make Muse the default for anything real).
#
# Kept separate from PERSONAS rather than an extra field on each entry:
# PERSONAS's id set is mirrored append-only into server/src/personas.js and
# ui/src/domain/personas.js (parity-tested), and neither of those has any
# notion of a farm provider — folding "provider" onto PERSONAS would either
# leak a farm-only routing concept into that three-way mirror or force the
# server/UI copies to carry a field they can't act on.
PERSONA_PROVIDERS = {"muse_smoke_test": "muse"}


def resolve(persona_id) -> str:
    """Map an item's persona field to a registry id, best-effort.

    Case-insensitive and whitespace-tolerant; anything unknown (None, wrong
    type, unregistered id) falls back to DEFAULT_PERSONA — persona routing
    must never block a run.
    """
    if not isinstance(persona_id, str):
        return DEFAULT_PERSONA
    candidate = persona_id.strip().lower()
    return candidate if candidate in PERSONAS else DEFAULT_PERSONA


def provider_for(persona_id) -> str | None:
    """The provider a persona forces (farm/agent_runner.py's run_agent(provider=...)),
    or None to keep the caller's normal FARM_PROVIDER-selected default.

    Resolves persona_id the same way resolve() does, so an unknown/junk id
    behaves identically here too — it never accidentally forces a provider.
    """
    return PERSONA_PROVIDERS.get(resolve(persona_id))


def compose_role(role_text: str, persona_id) -> str:
    """Append the persona's markdown to a role prompt.

    Never raises: a missing persona file falls back to the default persona's
    file, and if that is also missing the role text is returned untouched —
    a broken persona install degrades to today's behavior, not a dead run.
    """
    resolved = resolve(persona_id)
    for candidate in (resolved, DEFAULT_PERSONA):
        try:
            persona_md = (PERSONA_DIR / PERSONAS[candidate]).read_text()
        except OSError:
            continue
        return f"{role_text}\n\n## Your specialization\n{persona_md}"
    return role_text
