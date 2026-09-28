"""The single entrypoint above the provider seam (HZ-83, renamed from
claude_runner.py / run_claude()).

run_agent() picks a provider by FARM_PROVIDER config (default "claude" —
unchanged behaviour) and dispatches to a module under farm/providers/.
Everything above this file — pm_agent, step_agent, concierge_agent — talks
only to run_agent(); none of them know or care which provider actually ran.
"""

import json
import os

from .config import FARM_PROVIDER, MAX_TURNS, STEP_TIMEOUT_S
from .providers import claude, muse
from .providers.base import AgentError, AgentExhaustedError

__all__ = ["AgentError", "AgentExhaustedError", "assert_provider_auth", "run_agent", "extract_json"]

_PROVIDERS = {"claude": claude, "muse": muse}


def _selected_provider_name() -> str:
    # Read at call time so a restarted agent (or a test) can flip providers
    # without re-importing config.
    return os.environ.get("FARM_PROVIDER", FARM_PROVIDER)


def _selected_provider(name: str | None = None):
    # An explicit name (HZ-102: a persona-forced provider override) always
    # wins over FARM_PROVIDER for this one call; omitting it keeps the
    # env-selected default unchanged for every other caller.
    name = name or _selected_provider_name()
    provider = _PROVIDERS.get(name)
    if provider is None:
        raise AgentError(f"unknown provider '{name}' — expected one of {sorted(_PROVIDERS)}")
    return name, provider


def assert_provider_auth() -> None:
    """The HZ-5 boot-time/request-time cost guardrail, for whichever
    provider is configured — farmd calls this instead of a Claude-specific
    check so the guarantee holds no matter which provider is selected."""
    _, provider = _selected_provider()
    provider.assert_subscription_auth()


def run_agent(
    prompt: str,
    *,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int = MAX_TURNS,
    timeout_s: int = STEP_TIMEOUT_S,
    allowed_tools: str | None = None,
    provider: str | None = None,
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>, "provider": <name>,
    "command_id": <id or None>}.

    provider names which entry in _PROVIDERS to dispatch to for this one
    call, overriding FARM_PROVIDER (HZ-102 — e.g. a persona mapped to Muse
    via farm/personas.py's PERSONA_PROVIDERS). It's a plain parameter rather
    than an env var so the override can never leak into a later call in the
    same process, and so a test can assert it as a call argument. Omit it
    (the default) for the unchanged, env-selected behaviour every other
    caller keeps.
    """
    name, provider_module = _selected_provider(provider)
    provider_module.assert_subscription_auth()
    if session_id and not provider_module.SUPPORTS_RESUME:
        # Refuse rather than silently starting fresh — a resume-incapable
        # provider handed a session_id must not quietly restart from zero,
        # which would break HZ-31's checkpoint continuation. The dispatch
        # function (provider.run) is never called in this branch.
        raise AgentError(
            f"provider '{name}' does not support resuming a session (SUPPORTS_RESUME=False) — "
            "refusing this call rather than silently starting fresh"
        )
    result = provider_module.run(
        prompt,
        session_id=session_id,
        append_system=append_system,
        cwd=cwd,
        model=model,
        max_turns=max_turns,
        timeout_s=timeout_s,
        allowed_tools=allowed_tools,
    )
    # Provenance (HZ-102): which provider actually ran, plus its run-level
    # id where one exists (Muse's command_id; Claude has no equivalent).
    result["provider"] = name
    result.setdefault("command_id", None)
    return result


def extract_json(text: str) -> dict:
    """Lift a JSON object out of a model reply (tolerates fences/prose)."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    try:
        # strict=False: models occasionally emit raw control characters
        # (literal newlines/tabs) inside JSON strings — meaningful content
        # that the strict parser rejects, failing an otherwise-good step.
        return json.loads(cleaned, strict=False)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise AgentError(f"no JSON object in agent reply: {text[:200]}")
    return json.loads(cleaned[start : end + 1], strict=False)
