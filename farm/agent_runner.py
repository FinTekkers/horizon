"""The single entrypoint above the provider seam (HZ-83, renamed from
claude_runner.py / run_claude()).

run_agent() picks a provider by FARM_PROVIDER config (default "claude" —
unchanged behaviour) and dispatches to a module under farm/providers/.
Everything above this file — pm_agent, step_agent, concierge_agent — talks
only to run_agent(); none of them know or care which provider actually ran.
"""

import json
import os
from typing import Any, Callable

from .config import FARM_PROVIDER, MAX_TURNS, STEP_TIMEOUT_S
from .providers import claude, muse
from .providers.base import AgentError, AgentExhaustedError

__all__ = [
    "AgentError",
    "AgentExhaustedError",
    "assert_provider_auth",
    "run_agent",
    "extract_json",
    "parse_agent_reply",
    "stamp_notes",
    "stamp_notes_artifact",
]

_PROVIDERS = {"claude": claude, "muse": muse}

# HZ-117: the one non-Claude provider is Muse, reachable either via an
# explicit provider= override (a persona forcing it) or a bare FARM_PROVIDER
# env var. provider_locked steps (implement, deploy) must refuse BOTH paths
# — see run_agent()'s check below, which is the actual enforcement point
# (this used to be enforced only on the persona-override path, in
# step_agent.py's PROVIDER_OVERRIDE_ELIGIBLE_STEPS allowlist, which left the
# bare-env path completely unguarded).
DEFAULT_PROVIDER = "claude"


def _selected_provider_name() -> str:
    # Read at call time so a restarted agent (or a test) can flip providers
    # without re-importing config.
    return os.environ.get("FARM_PROVIDER", FARM_PROVIDER)


def _selected_provider(name: str | None = None, *, provider_locked: bool = False):
    # An explicit name (HZ-102: a persona-forced provider override) always
    # wins over FARM_PROVIDER for this one call; omitting it keeps the
    # env-selected default unchanged for every other caller.
    name = name or _selected_provider_name()
    provider = _PROVIDERS.get(name)
    if provider is None:
        raise AgentError(f"unknown provider '{name}' — expected one of {sorted(_PROVIDERS)}")
    if provider_locked and name != DEFAULT_PROVIDER:
        raise AgentError(
            f"step is provider-locked — refusing to dispatch to '{name}' (only '{DEFAULT_PROVIDER}' is allowed), "
            "whether requested explicitly or via a bare FARM_PROVIDER override"
        )
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
    provider_locked: bool = False,
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

    provider_locked (HZ-117) is the caller's declaration that this step
    (from domain/steps.json's providerLocked field — today, implement and
    deploy) must run on DEFAULT_PROVIDER no matter what, refusing BOTH an
    explicit provider= override and a bare FARM_PROVIDER env var. Checked
    once, at this single dispatch chokepoint, before any provider call is
    made — every caller that omits it (the default) is unaffected.
    """
    name, provider_module = _selected_provider(provider, provider_locked=provider_locked)
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


def _first_balanced_object(text: str) -> str | None:
    """The first brace-balanced span starting at the first `{`, or None.

    String-aware: a `{`/`}` inside a JSON string literal is content, not
    structure, so `{"a": "}"}` must come back whole. Backslash escapes are
    honoured, so a trailing `\\\\` before a quote does not swallow the quote.

    One forward pass, no backtracking — a reply of ten thousand unclosed
    braces returns None in linear time rather than exploring spans.
    """
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_json(text: str) -> dict:
    """Lift a JSON object out of a model reply (tolerates fences/prose).

    Three attempts, in this order — the order is load-bearing (HZ-156):

    1. the whole cleaned text;
    2. the widest `{`…`}` span, i.e. first brace to LAST brace;
    3. the FIRST brace-balanced object.

    Attempts 1 and 2 are exactly what this function did before attempt 3
    existed, so every reply that parses today still parses by the same route
    to the same value. Attempt 3 only ever sees input on which both of those
    already failed — that is the precise boundary between the success metric
    ("given `{"s":"first"} prose {"s":"second"}`, return the first object")
    and the guardrail ("input that fails to parse today still fails"). A
    reply carrying a small valid object BEFORE the real payload keeps failing
    attempts 1 and 2 and, on attempt 3, returns that leading object — which
    is why callers must keep the lossless retry: the retry, not the scanner,
    is what recovers a reply whose real payload came second.

    When attempt 3 also fails, attempt 2's error is re-raised, so the
    exception a caller sees for an unparseable reply is unchanged in type and
    message.
    """
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
    try:
        return json.loads(cleaned[start : end + 1], strict=False)
    except json.JSONDecodeError as widest_failure:
        first = _first_balanced_object(cleaned)
        if first is None or first == cleaned[start : end + 1]:
            raise
        try:
            # strict=False here too, or a literal newline inside a string would
            # make this path stricter than the two above it.
            return json.loads(first, strict=False)
        except json.JSONDecodeError:
            # Attempt 3 is purely additive: when it fails too, the caller must
            # see the exception it saw before attempt 3 existed. Today the two
            # messages coincide anyway (the first balanced object is a PREFIX of
            # the widest span, and the decoder scans left to right, so both stop
            # at the same character) — re-raising attempt 2's error makes that a
            # guarantee rather than a coincidence, and keeps the retry prompt,
            # which embeds this text, byte-identical. `from None` drops the
            # chained context so the log shows one failure, not two.
            raise widest_failure from None


# The retry prompt all three callers used before this one existed — byte for
# byte, so converting them changed no prompt the model sees.
RETRY_PROMPT = (
    "Your previous reply was invalid: {exc}. Respond again with ONLY the JSON object, no other text."
)


def _notes_for(reply_text: str, parsed: Any) -> list[str]:
    """Parser notes for one reply. Always empty in HZ-156, by design.

    NOT dead code: this is the reporting channel the two follow-up items
    (byte-altering repair, then truncation salvage) report through, and the
    seam their plumbing is already proven against — a test monkeypatches this
    function to inject a note and asserts it reaches the run's output line and
    the step's artifact. Landing the channel empty is what keeps this item's
    output byte-identical to before it.
    """
    return []


def parse_agent_reply(
    reply_text: str,
    retry: Callable[[str], str] | None = None,
    *,
    validate: Callable[[Any], Any] | None = None,
) -> tuple[Any, list[str]]:
    """THE parser for a model's final JSON reply. Every caller above this
    module uses it; nothing else calls extract_json() (enforced by
    farm/tests/test_one_reply_parser.py).

    Before HZ-156 pm_agent, step_agent and concierge_agent each kept their own
    copy of this parse-then-retry-once path, and they had already drifted.

    `retry` receives the fully formatted retry prompt and returns the model's
    fresh reply text. Omit it (step_agent's implement step) and a first
    failure propagates immediately with no retry.

    `validate` is applied INSIDE the retry envelope. pm_agent and
    concierge_agent both validated inside their retry try-block, so a reply
    that parses but is missing a required field takes the lossless retry
    today — passing the validator here is what preserves that. step_agent
    passes none: its own summary check sits outside the retry and stays there.

    Returns `(validate(parsed) if validate else parsed, notes)`.

    A failure from the retry itself — a second parse failure, or an
    AgentExhaustedError raised by run_agent inside the closure — propagates
    untouched. AgentExhaustedError is a subclass of AgentError, so it must
    never be mistaken for a parse failure and retried (or swallowed): the
    orchestrator auto-retries a run only if it still carries that tag.
    """

    def _attempt(text: str) -> tuple[Any, list[str]]:
        parsed = extract_json(text)
        notes = _notes_for(text, parsed)
        return (validate(parsed) if validate else parsed), notes

    try:
        return _attempt(reply_text)
    except AgentExhaustedError:
        raise
    except (AgentError, json.JSONDecodeError) as exc:
        if retry is None:
            raise
        prompt = RETRY_PROMPT.format(exc=exc)
    # Deliberately OUTSIDE the except clause: nothing the retry raises may be
    # caught by the handler above.
    return _attempt(retry(prompt))


def stamp_notes(summary: str, notes: list[str], limit: int) -> str:
    """Append parser notes to a summary, keeping the result within `limit`.

    Room is reserved for the notes rather than appending and re-slicing: both
    callers hand in a summary they have already cut to exactly `limit`, so a
    suffix followed by `[:limit]` would drop the note in the common case
    instead of the rare one. The existing human-feedback stamp survives that
    treatment only because it is a prefix.

    An empty `notes` returns `summary` unchanged and untouched — with no notes
    the payload is byte-identical to before this channel existed.
    """
    if not notes:
        return summary
    suffix = f" [{'; '.join(notes)}]"
    if len(suffix) >= limit:
        return suffix[:limit]  # pathological notes: the note wins, not the summary
    return summary[: limit - len(suffix)] + suffix


def stamp_notes_artifact(artifact: str, notes: list[str], limit: int) -> str:
    """Same reserve-room rule as stamp_notes(), for a markdown artifact.

    The artifact ceiling has the identical defect: an artifact already at
    WRITE_ARTIFACT_SANITY_CEILING_CHARS would lose the section entirely.
    """
    if not notes:
        return artifact
    section = "\n\n## Parser notes\n" + "\n".join(f"- {note}" for note in notes)
    if len(section) >= limit:
        return section[:limit]
    return artifact[: limit - len(section)] + section
