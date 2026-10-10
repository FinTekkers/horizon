"""The farm's one view of "which specialist personas exist, which agent each
belongs to, and which provider a persona forces" (HZ-133).

This module READS domain/personas.json — the one place persona ids, their agent
membership, each agent's default, each persona's role file, the pre-HZ-125
legacy aliases and the persona-to-provider map are declared — at import.
Before HZ-133 the id set was hand-typed three times (farm/personas.py,
server/src/personas.js, ui/src/domain/personas.js) and held together only by a
parity test that parsed JavaScript with a regex; PERSONA_PROVIDERS lived in
the farm alone.

HZ-381 repointed farm/personas.py here: it builds its registry from this
binding, and farm/tests/test_personas_hz381.py fails on any persona id it
still declares as a literal.

ORDER IS PART OF THE DECLARATION. Agent order is the picker's group order and
provider_for()'s scan order; persona order within an agent is the picker's
option order. Both are exposed as tuples in authored order.

Persona ids are unique WITHIN their agent, not globally (HZ-125): `python`
under one agent and `python` under another are different personas, which is
why PERSONA_PROVIDERS is keyed by the namespaced "<agent>.<persona>" form.

Each entry declares its role markdown filenames in `roleFiles` (HZ-381):
persona id -> file in farm/roles/personas/, returned as declared by
persona_role_file(). The filename shape (^[a-z][a-z0-9_]*\.md$) is pinned at
load time precisely because the declared value is interpolated into a path
under farm/roles/personas/: a value carrying a slash or ".." would escape the
directory, so the shape rule is what makes the declared path provably safe.

Nothing presentational lives here. Labels, initials, colours and the
persona-agent -> lifecycle-agent bridge (PERSONA_AGENT_ROLES) stay in the
layers that render them; server/test/domain-binding-hygiene.test.mjs pins this
module's public names by set equality so one cannot appear quietly.

The maps below are read-only views (MappingProxyType) and the sequences are
tuples: the farm must not be able to widen what the server enforces. A layer
module that needs a MUTABLE copy — farm/personas.py's registry is
monkeypatched by farm/tests/conftest.py — builds its own from these, never
aliases them.

HZ-192: the same document also declares which Claude model each agent call
uses (the `models` block). resolve_model() is the one resolver —
persona override, then step override, then agent default — and
farm/agent_runner.py is its only farm caller: run_agent() takes agent/step/
persona, never a model. HZ-398: every declared model id must be one
domain/providers.json declares under the default provider, and a persona
routed elsewhere by personaProviders cannot carry one.

_SOURCE_PATH is derived from __file__, never from the process's cwd: farm
agents run inside workspace clones, not from the repo root
(farm/tests/test_domain_import.py asserts that).
"""

import json
import re
import types
from pathlib import Path

from . import providers as _providers

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "personas.json"

# Kept in step with domain/js/personas.js's ID_SHAPE; both validators print it
# in their messages and domain/fixtures/personas-cases.json compares those.
_ID_SHAPE = re.compile(r"^[a-z][a-z0-9_]*$")
# HZ-398, kept in step with domain/js/personas.js's DECLARED_MODELS: the ids
# the `models` block may name — every model domain/providers.json declares
# under the default provider, selectable or not — so no models value can name
# another provider's model.
_DECLARED_MODELS: tuple[str, ...] = tuple(
    m["id"] for m in _providers.PROVIDERS[_providers.DEFAULT_PROVIDER]["models"]
)
# HZ-381, kept in step with domain/js/personas.js's ROLE_FILE_SHAPE.
_ROLE_FILE_SHAPE = re.compile(r"^[a-z][a-z0-9_]*\.md$")
_MODELS_KEYS = ("agents", "conflictAgent", "steps", "personas")


def _json(value: object) -> str:
    """json.dumps with JavaScript's spacing, so every message fragment below is
    byte-identical to the one domain/js/personas.js produces for the same input.
    Same helper as domain/py/priorities.py's."""
    return json.dumps(value, separators=(",", ":"), default=repr)


def _is_id(value: object) -> bool:
    # fullmatch, not match: `$` also matches before a trailing newline, and
    # "ui\n" must not pass as an id that is later interpolated into a filename.
    return isinstance(value, str) and _ID_SHAPE.fullmatch(value) is not None


def _is_role_file(value: object) -> bool:
    # fullmatch, like _is_id: `$` also matches before a trailing newline, and
    # a filename smuggling one must not pass.
    return isinstance(value, str) and _ROLE_FILE_SHAPE.fullmatch(value) is not None


def _split_pair(value: object, ids: dict) -> tuple[str, str] | None:
    """("agent", "persona") when `value` is "<agent>.<persona>" naming a live
    pair in `ids`, else None."""
    if not isinstance(value, str):
        return None
    parts = value.split(".")
    if len(parts) != 2:
        return None
    agent, persona = parts
    if agent not in ids or persona not in ids[agent]:
        return None
    return agent, persona


def _validate_source(data: object, source: str, declared_models=_DECLARED_MODELS) -> dict:
    """Every load-time rule, applied at import AND to anything _load_source
    reads off disk. Raises rather than returning a partly-usable registry.

    `declared_models` is a parameter with a default so a fixture can drive the
    models rules with fabricated ids (HZ-398) rather than a second copy of
    domain/providers.json.

    The rules and the message fragments are kept word-for-word in step with
    domain/js/personas.js's assertPersonasShape —
    domain/fixtures/personas-cases.json drives both, so the two cannot drift
    apart silently."""
    prefix = "domain/py/personas.py: "
    if not isinstance(data, dict):
        raise RuntimeError(f"{prefix}{source} must be a JSON object with a non-empty agents array")
    agents = data.get("agents")
    if not isinstance(agents, list) or not agents:
        raise RuntimeError(f"{prefix}{source}: agents must be a non-empty JSON array")

    ids: dict = {}
    for i, entry in enumerate(agents):
        if not isinstance(entry, dict):
            raise RuntimeError(f"{prefix}{source}: agents[{i}] must be a JSON object")
        agent = entry.get("agent")
        if not _is_id(agent):
            raise RuntimeError(
                f"{prefix}{source}: agents[{i}].agent declares {_json(agent)} — "
                f"expected a lower-case id matching /{_ID_SHAPE.pattern}/"
            )
        if agent in ids:
            raise RuntimeError(f"{prefix}{source}: agent {_json(agent)} is declared more than once")
        personas = entry.get("personas")
        if not isinstance(personas, list) or not personas:
            raise RuntimeError(
                f"{prefix}{source}: agents[{i}].personas must be a non-empty JSON array of persona ids"
            )
        for j, persona in enumerate(personas):
            if not _is_id(persona):
                raise RuntimeError(
                    f"{prefix}{source}: agents[{i}].personas[{j}] declares {_json(persona)} — "
                    f"expected a lower-case id matching /{_ID_SHAPE.pattern}/"
                )
            if personas.index(persona) != j:
                raise RuntimeError(
                    f"{prefix}{source}: agent {_json(agent)} declares persona {_json(persona)} more than once"
                )
        default = entry.get("default")
        if not isinstance(default, str) or default not in personas:
            raise RuntimeError(
                f"{prefix}{source}: agents[{i}].default {_json(default)} is not one of "
                f"agent {_json(agent)}'s personas {_json(personas)}"
            )
        # HZ-381: every persona declares its role file. Keys must equal the
        # entry's own personas exactly — a missing key leaves a persona with no
        # file, an extra key names a file no persona composes.
        role_files = entry.get("roleFiles")
        if not isinstance(role_files, dict):
            raise RuntimeError(
                f"{prefix}{source}: agents[{i}].roleFiles must be a JSON object "
                "mapping every persona id to its role file"
            )
        for persona in personas:
            if persona not in role_files:
                raise RuntimeError(
                    f"{prefix}{source}: agents[{i}].roleFiles is missing persona {_json(persona)}"
                )
        for key in role_files:
            if key not in personas:
                raise RuntimeError(
                    f"{prefix}{source}: agents[{i}].roleFiles key {_json(key)} is not one of "
                    f"agent {_json(agent)}'s personas {_json(personas)}"
                )
        for key, value in role_files.items():
            if not _is_role_file(value):
                raise RuntimeError(
                    f"{prefix}{source}: agents[{i}].roleFiles[{_json(key)}] {_json(value)} "
                    f"is not a role file matching /{_ROLE_FILE_SHAPE.pattern}/"
                )
        seen_files: dict = {}
        for key, value in role_files.items():
            if value in seen_files:
                raise RuntimeError(
                    f"{prefix}{source}: agents[{i}].roleFiles declares {_json(value)} for both "
                    f"{_json(seen_files[value])} and {_json(key)}"
                )
            seen_files[value] = key
        ids[agent] = personas

    primary = data.get("primaryAgent")
    if not isinstance(primary, str) or primary not in ids:
        raise RuntimeError(
            f"{prefix}{source}: primaryAgent {_json(primary)} is not a declared agent {_json(list(ids))}"
        )

    legacy = data.get("legacyIds")
    if not isinstance(legacy, dict):
        raise RuntimeError(f"{prefix}{source}: legacyIds must be a JSON object")
    for key, value in legacy.items():
        if not _is_id(key):
            raise RuntimeError(
                f"{prefix}{source}: legacyIds key {_json(key)} — "
                f"expected a lower-case id matching /{_ID_SHAPE.pattern}/"
            )
        if _split_pair(value, ids) is None:
            raise RuntimeError(
                f"{prefix}{source}: legacyIds[{_json(key)}] {_json(value)} "
                "does not name a declared <agent>.<persona> pair"
            )

    providers = data.get("personaProviders")
    if not isinstance(providers, dict):
        raise RuntimeError(f"{prefix}{source}: personaProviders must be a JSON object")
    for key, value in providers.items():
        if _split_pair(key, ids) is None:
            raise RuntimeError(
                f"{prefix}{source}: personaProviders key {_json(key)} "
                "does not name a declared <agent>.<persona> pair"
            )
        if not isinstance(value, str) or not value:
            raise RuntimeError(
                f"{prefix}{source}: personaProviders[{_json(key)}] {_json(value)} "
                "must be a non-empty provider id string"
            )

    _validate_models(data.get("models"), ids, providers, prefix + source, declared_models)
    return data


def _validate_models(models: object, ids: dict, providers: dict, where: str, declared_models) -> None:
    """HZ-192's load-time rules for the `models` block. Same message fragments
    as domain/js/personas.js's assertModelsShape."""

    def _is_model(value: object) -> bool:
        return isinstance(value, str) and value in declared_models

    def model_error(key: str, value: object) -> RuntimeError:
        return RuntimeError(
            f"{where}: {key} {_json(value)} is not a model domain/providers.json declares for the default provider"
        )

    if not isinstance(models, dict):
        raise RuntimeError(f"{where}: models must be a JSON object with agents, conflictAgent, steps and personas")
    for key in models:
        if key not in _MODELS_KEYS:
            raise RuntimeError(f"{where}: models has unknown key {_json(key)} — expected only {_json(list(_MODELS_KEYS))}")

    agents = models.get("agents")
    if not isinstance(agents, dict) or not agents:
        raise RuntimeError(f"{where}: models.agents must be a non-empty JSON object")
    for key, value in agents.items():
        if not _is_id(key):
            raise RuntimeError(
                f"{where}: models.agents key {_json(key)} — expected a lower-case id matching /{_ID_SHAPE.pattern}/"
            )
        if not _is_model(value):
            raise model_error(f"models.agents[{_json(key)}]", value)

    conflict_agent = models.get("conflictAgent")
    if not isinstance(conflict_agent, str) or conflict_agent not in agents:
        raise RuntimeError(
            f"{where}: models.conflictAgent {_json(conflict_agent)} is not a models.agents key {_json(list(agents))}"
        )

    steps = models.get("steps")
    if not isinstance(steps, dict):
        raise RuntimeError(f"{where}: models.steps must be a JSON object")
    for key, value in steps.items():
        if not key:
            raise RuntimeError(f"{where}: models.steps has an empty step key")
        if not _is_model(value):
            raise model_error(f"models.steps[{_json(key)}]", value)

    personas = models.get("personas")
    if not isinstance(personas, dict):
        raise RuntimeError(f"{where}: models.personas must be a JSON object")
    for key, value in personas.items():
        if _split_pair(key, ids) is None:
            raise RuntimeError(
                f"{where}: models.personas key {_json(key)} does not name a declared <agent>.<persona> pair"
            )
        if key in providers:
            raise RuntimeError(
                f"{where}: models.personas key {_json(key)} is routed to {_json(providers[key])} by "
                "personaProviders — only a Claude-run persona can carry a model"
            )
        if not _is_model(value):
            raise model_error(f"models.personas[{_json(key)}]", value)


def _load_source(path: Path) -> dict:
    """Reads the authored registry off disk and validates it. This is how the
    production values below are built — not a test-only helper."""
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/personas.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/personas.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


_SOURCE: dict = _load_source(_SOURCE_PATH)

# Every persona agent, in authored order.
PERSONA_AGENTS: tuple[str, ...] = tuple(entry["agent"] for entry in _SOURCE["agents"])

# agent -> its persona ids, in authored order.
PERSONA_IDS = types.MappingProxyType(
    {entry["agent"]: tuple(entry["personas"]) for entry in _SOURCE["agents"]}
)

# HZ-381: agent -> {persona id -> its role markdown filename in
# farm/roles/personas/}, as declared in the document's `roleFiles`.
PERSONA_ROLE_FILES = types.MappingProxyType(
    {entry["agent"]: types.MappingProxyType(dict(entry["roleFiles"])) for entry in _SOURCE["agents"]}
)

# Every "<agent>.<persona>", agents in order, personas in order within each.
NAMESPACED_PERSONA_IDS: tuple[str, ...] = tuple(
    f"{agent}.{persona}" for agent in PERSONA_AGENTS for persona in PERSONA_IDS[agent]
)

# agent -> the persona an item gets when it carries none for that agent (or
# carries one that does not belong to it).
DEFAULT_PERSONAS = types.MappingProxyType({entry["agent"]: entry["default"] for entry in _SOURCE["agents"]})

# The agent whose persona is an item's primary specialization.
PRIMARY_PERSONA_AGENT: str = _SOURCE["primaryAgent"]

# Flat pre-HZ-125 persona value -> (agent, persona id). Read-only compatibility
# for rows written before personas were agent-scoped; never written.
LEGACY_PERSONA_IDS = types.MappingProxyType(
    {key: tuple(value.split(".")) for key, value in _SOURCE["legacyIds"].items()}
)

# "<agent>.<persona>" -> the provider that persona forces. Ships empty (HZ-121).
PERSONA_PROVIDERS = types.MappingProxyType(dict(_SOURCE["personaProviders"]))

# HZ-192: {"agents", "steps", "personas"} -> read-only {key -> Claude model id}.
# See resolve_model() for the order they apply in.
MODELS = types.MappingProxyType(
    {key: types.MappingProxyType(dict(_SOURCE["models"][key])) for key in ("agents", "steps", "personas")}
)

# The model agent the WhatsApp concierge runs as.
CONCIERGE_MODEL_AGENT = "concierge"

# Merge-conflict resolution (farm/conflict_resolver.py) runs as this model
# agent, under the reserved step key CONFLICT_STEP_KEY — it is not a
# domain/steps.json step, so it has no label of its own.
CONFLICT_MODEL_AGENT: str = _SOURCE["models"]["conflictAgent"]
CONFLICT_STEP_KEY = "conflict"


def is_persona(agent: str, persona_id: str, persona_ids=PERSONA_IDS) -> bool:
    """Whether `persona_id` is a declared persona OF `agent`. An id is only a
    persona within an agent, so both halves are always passed together.

    `persona_ids` is a parameter with a default so a fixture can drive it with
    a fabricated registry — the convention is_priority uses."""
    if not isinstance(agent, str) or not isinstance(persona_id, str):
        return False
    bucket = persona_ids.get(agent)
    return bucket is not None and persona_id in bucket


def persona_role_file(agent: str, persona_id: str, role_files=PERSONA_ROLE_FILES) -> str:
    """The role markdown's filename in farm/roles/personas/, as DECLARED in
    the document's `roleFiles` (HZ-381). Raises ValueError for an undeclared
    pair rather than returning a path from data nobody validated.

    `role_files` is a parameter with a default so a fixture can drive it with
    a fabricated registry — the convention is_persona uses."""
    unknown = f"domain/py/personas.py: unknown persona {_json([agent, persona_id])}"
    if not isinstance(agent, str) or not isinstance(persona_id, str):
        raise ValueError(unknown)
    try:
        bucket = role_files[agent]
    except (KeyError, TypeError):
        raise ValueError(unknown) from None
    try:
        value = bucket[persona_id]
    except (KeyError, TypeError):
        raise ValueError(unknown) from None
    return value


def model_agent_for_step(step_agent: str) -> str:
    """The model agent a domain/steps.json step runs as: its `agent` display
    name lower-cased ("DevOps" -> "devops"). Those names are therefore a
    contract — renaming one without its models.agents key fails at dispatch,
    and farm/tests/test_models_domain.py fails first."""
    return step_agent.lower()


def resolve_model(agent: str, step: str | None = None, persona: str | None = None, models=MODELS) -> str:
    """The Claude model a call runs on: models["personas"][persona] (a
    namespaced "<agent>.<persona>"), else models["steps"][step], else
    models["agents"][agent].

    Raises ValueError for an agent with no default, even when an override
    would apply, so a misspelt agent fails on every call rather than only on
    the ones no override happens to cover. Says nothing about providers:
    farm/agent_runner.py passes the result only to Claude.

    `models` is a parameter with a default so a fixture can drive it with a
    fabricated block — the convention is_persona uses."""
    agents = models["agents"]
    if not isinstance(agent, str) or agent not in agents:
        raise ValueError(f"domain/py/personas.py: unknown model agent {_json(agent)}")
    if isinstance(persona, str) and persona in models["personas"]:
        return models["personas"][persona]
    if isinstance(step, str) and step in models["steps"]:
        return models["steps"][step]
    return agents[agent]
