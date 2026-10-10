"""The farm's one view of "which agent providers exist and which models each
may run" (HZ-398).

This module READS domain/providers.json — the only place provider names,
their labels and their model ids are declared — at import. Before HZ-398 the
farm held its own STEP_PROVIDER_CHOICES tuple, the server its STEP_PROVIDERS
list, and three files a ^claude- regex standing in for "a model id"; none of
them knew which models actually exist.

farm/agent_runner.py's _model_for() is the one consumer that picks a model:
it checks every chosen or overriding id with declares() against the provider
that will run it, so a Claude id can never reach Muse or the reverse.
farm/step_agent.py reads the owner's stored step choice with parse_choice().

A stored step choice is "<provider>" (the pre-HZ-398 bare form, that
provider's own default model) or "<provider>:<model id>" (one of that
provider's SELECTABLE models). domain/js/providers.js is the JS twin;
domain/fixtures/providers-cases.json drives both so the rules and the
message fragments cannot drift.
"""

import json
import re
import types
from pathlib import Path

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "providers.json"

# Kept in step with domain/js/providers.js's NAME_SHAPE / MODEL_SHAPE.
_NAME_SHAPE = re.compile(r"^[a-z]+$")
_MODEL_SHAPE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


def _json(value: object) -> str:
    """json.dumps with JavaScript's spacing, so message fragments match the JS
    binding's byte for byte. Same helper as domain/py/personas.py's."""
    return json.dumps(value, separators=(",", ":"), default=repr)


def _is_text(value: object) -> bool:
    return isinstance(value, str) and len(value) > 0


def _validate_source(data: object, source: str) -> dict:
    """Every load-time rule, word-for-word in step with domain/js/providers.js's
    assertProvidersShape. Raises rather than returning a partly-usable
    catalogue."""
    prefix = "domain/py/providers.py: "
    where = prefix + source
    if not isinstance(data, dict):
        raise RuntimeError(f"{where} must be a JSON object with a non-empty providers array")
    providers = data.get("providers")
    if not isinstance(providers, list) or not providers:
        raise RuntimeError(f"{where} must be a JSON object with a non-empty providers array")
    names: list[str] = []
    seen_ids: dict[str, str] = {}
    for i, entry in enumerate(providers):
        if not isinstance(entry, dict):
            raise RuntimeError(f"{where}: providers[{i}] is not an object")
        name = entry.get("name")
        # fullmatch: `$` also matches before a trailing newline.
        if not isinstance(name, str) or _NAME_SHAPE.fullmatch(name) is None:
            raise RuntimeError(
                f"{where}: providers[{i}] name {_json(name)} — expected a lower-case name matching /{_NAME_SHAPE.pattern}/"
            )
        if name in names:
            raise RuntimeError(f"{where}: provider {_json(name)} is declared twice")
        names.append(name)
        if not _is_text(entry.get("label")):
            raise RuntimeError(f"{where}: provider {_json(name)} has no label")
        models = entry.get("models")
        if not isinstance(models, list) or not models:
            raise RuntimeError(f"{where}: provider {_json(name)} must declare a non-empty models array")
        ids: list[str] = []
        for j, model in enumerate(models):
            model_id = model.get("id") if isinstance(model, dict) else None
            if not isinstance(model_id, str) or _MODEL_SHAPE.fullmatch(model_id) is None:
                raise RuntimeError(
                    f"{where}: provider {_json(name)} models[{j}] id {_json(model_id)} — "
                    f"expected a model id matching /{_MODEL_SHAPE.pattern}/"
                )
            if model_id in seen_ids:
                raise RuntimeError(
                    f"{where}: model {_json(model_id)} is declared by both {_json(seen_ids[model_id])} and {_json(name)}"
                )
            seen_ids[model_id] = name
            if not _is_text(model.get("label")):
                raise RuntimeError(f"{where}: model {_json(model_id)} has no label")
            if not isinstance(model.get("selectable"), bool):
                raise RuntimeError(f"{where}: model {_json(model_id)} selectable must be true or false")
            ids.append(model_id)
        default_model = entry.get("defaultModel")
        # A missing key is refused like an unknown id, as the JS binding does.
        if "defaultModel" not in entry or (default_model is not None and default_model not in ids):
            raise RuntimeError(
                f"{where}: provider {_json(name)} defaultModel {_json(default_model)} is not null or one of its own models"
            )
    default = data.get("default")
    if not isinstance(default, str) or default not in names:
        raise RuntimeError(f"{where}: default {_json(default)} is not a declared provider {_json(names)}")
    return data


def _load_source(path: Path) -> dict:
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/providers.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/providers.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


_SOURCE: dict = _load_source(_SOURCE_PATH)

# name -> read-only {"name", "label", "defaultModel", "models": ({"id", "label", "selectable"}, ...)},
# in authored order.
PROVIDERS = types.MappingProxyType(
    {
        p["name"]: types.MappingProxyType(
            {**p, "models": tuple(types.MappingProxyType(dict(m)) for m in p["models"])}
        )
        for p in _SOURCE["providers"]
    }
)

# The provider a step runs on when nobody chose one.
DEFAULT_PROVIDER: str = _SOURCE["default"]


# Every helper takes `providers` as a parameter with a default, so a fixture
# can drive it with a fabricated catalogue — the convention is_priority uses.
def provider_names(providers=PROVIDERS) -> tuple[str, ...]:
    return tuple(providers)


def declares(provider: str, model_id: str, providers=PROVIDERS) -> bool:
    """Whether `model_id` is one of `provider`'s declared models, selectable or
    not. Never true for another provider's id."""
    if not isinstance(provider, str) or not isinstance(model_id, str) or provider not in providers:
        return False
    return any(m["id"] == model_id for m in providers[provider]["models"])


def default_model(provider: str, providers=PROVIDERS) -> str | None:
    """`provider`'s pinned default model, or None (the default provider's comes
    from domain/personas.json's `models` block; an unknown provider has none)."""
    if not isinstance(provider, str) or provider not in providers:
        return None
    return providers[provider]["defaultModel"]


def parse_choice(value: object, providers=PROVIDERS) -> tuple[str, str | None] | None:
    """A stored step choice as (provider, model id or None for the bare form),
    or None for anything a reader must not act on: not a string, an unknown
    provider, or a model that is not one of that provider's selectable ones."""
    if not isinstance(value, str):
        return None
    name, sep, model_id = value.partition(":")
    if name not in providers:
        return None
    if not sep:
        return name, None
    if any(m["id"] == model_id and m["selectable"] for m in providers[name]["models"]):
        return name, model_id
    return None
