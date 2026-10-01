"""The single entrypoint above the provider seam (HZ-83, renamed from
claude_runner.py / run_claude()).

run_agent() picks a provider by FARM_PROVIDER config (default "claude" —
unchanged behaviour) and dispatches to a module under farm/providers/.
Everything above this file — pm_agent, step_agent, concierge_agent — talks
only to run_agent(); none of them know or care which provider actually ran.
"""

import json
import os
import re
from typing import Any, Callable

from domain.py.personas import resolve_model

from .config import FARM_PROVIDER, MAX_TURNS, STEP_TIMEOUT_S
from .providers import claude, muse
from .providers.base import AgentError, AgentExhaustedError

__all__ = [
    "AgentError",
    "AgentExhaustedError",
    "FIRST_OBJECT_NOTE",
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


# HZ-192: the one emergency override, for every Claude call at once. Read at
# call time, like FARM_PROVIDER. Shape-checked against the same pattern as
# domain/personas.json's model ids (kept in step with domain/py/personas.py's
# _MODEL_SHAPE), so a typo fails here instead of reaching the CLI.
MODEL_OVERRIDE_ENV = "FARM_MODEL_OVERRIDE"
_MODEL_SHAPE = re.compile(r"^claude-[a-z0-9][a-z0-9.-]*$")


def _model_for(name: str, agent: str, step: str | None, persona: str | None) -> str | None:
    """HZ-192: the model a run_agent() call hands its provider — the one place
    a farm call's model is chosen, and the one Muse guard.

    The agent is resolved on every provider, so a misspelt agent fails on Muse
    too. Any provider but DEFAULT_PROVIDER gets None (its own default): a
    Claude model id never reaches Muse, whichever path chose Muse — a
    persona's provider, FARM_PROVIDER, or both, and with or without
    FARM_MODEL_OVERRIDE."""
    model = resolve_model(agent, step, persona)
    if name != DEFAULT_PROVIDER:
        return None
    override = os.environ.get(MODEL_OVERRIDE_ENV, "")
    if not override:
        return model
    if _MODEL_SHAPE.fullmatch(override) is None:
        raise ValueError(
            f"{MODEL_OVERRIDE_ENV}={override!r} is not a Claude model id matching /{_MODEL_SHAPE.pattern}/ — "
            "unset it or fix it in /etc/horizon/farm.env"
        )
    return override


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
    agent: str,
    step: str | None = None,
    persona: str | None = None,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
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

    agent, step and persona (HZ-192) say WHO is calling, never which model:
    the model comes from domain/personas.json's `models` block through
    _model_for(). There is deliberately no model= parameter, so no caller can
    pick one any other way (farm/tests/test_model_call_sites.py). agent is a
    models.agents key; step a domain/steps.json label or CONFLICT_STEP_KEY;
    persona a namespaced "<agent>.<persona>".
    """
    name, provider_module = _selected_provider(provider, provider_locked=provider_locked)
    model = _model_for(name, agent, step, persona)
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


def _extract_json(text: str) -> tuple[Any, Exception | None]:
    """extract_json()'s work, plus which attempt produced the value.

    The second element is None when attempt 1 or 2 parsed the reply — i.e.
    whenever this is a reply that already parsed before HZ-156. When the
    last-resort scanner (attempt 3) produced the value it is instead the
    exception attempts 1 and 2 raised, which is exactly what a caller saw on
    this input before attempt 3 existed.

    parse_agent_reply() needs both halves: the fact that the scanner ran tells
    it the lossless retry is still owed, and the exception lets it build a
    byte-identical retry prompt. extract_json() itself is unchanged — it is the
    public entry point and returns only the value, so the success metric's
    behaviour and every existing test read the same as before.
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
        return json.loads(cleaned, strict=False), None
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise AgentError(f"no JSON object in agent reply: {text[:200]}")
    try:
        return json.loads(cleaned[start : end + 1], strict=False), None
    except json.JSONDecodeError as widest_failure:
        first = _first_balanced_object(cleaned)
        if first is None or first == cleaned[start : end + 1]:
            raise
        try:
            # strict=False here too, or a literal newline inside a string would
            # make this path stricter than the two above it.
            return json.loads(first, strict=False), widest_failure
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


def extract_json(text: str) -> Any:
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
    attempts 1 and 2 and, on attempt 3, returns that leading object — which is
    why parse_agent_reply() still spends the lossless retry on such a reply and
    keeps the scanned object only as a fallback: the retry, not the scanner, is
    what recovers a reply whose real payload came second.

    When attempt 3 also fails, attempt 2's error is re-raised, so the
    exception a caller sees for an unparseable reply is unchanged in type and
    message.
    """
    return _extract_json(text)[0]


# The retry prompt all three callers used before this one existed — byte for
# byte, so converting them changed no prompt the model sees.
RETRY_PROMPT = (
    "Your previous reply was invalid: {exc}. Respond again with ONLY the JSON object, no other text."
)

# The one note this item can actually produce. Reported when a reply only
# parsed because attempt 3 lifted its leading object out — the caller's output
# would otherwise look like a clean run, with the only evidence that the reply
# was malformed thrown away.
FIRST_OBJECT_NOTE = (
    "reply would not parse as a whole; used its first complete JSON object — see session log"
)


def _notes_for(reply_text: str, parsed: Any) -> list[str]:
    """Per-repair parser notes for one reply. Always empty in HZ-156, by design.

    NOT dead code: this is the reporting channel the two follow-up items
    (byte-altering repair, then truncation salvage) report through, and the seam
    their plumbing is already proven against — a test monkeypatches this function
    to inject a note and asserts it reaches the run's output line and the step's
    artifact. No repair exists yet, so it reports nothing yet, and every reply
    that parses the way replies parsed before this item produces no note at all.

    The one note HZ-156 itself can emit is FIRST_OBJECT_NOTE, added by
    parse_agent_reply() rather than here: it describes which attempt parsed the
    reply, not a repair applied to it.
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

    `validate` is applied INSIDE the retry envelope, so a reply that parses
    but is missing a required field takes the lossless retry. That is where
    pm_agent and concierge_agent have always run their validator — both wrapped
    validate(extract_json(...)) in one try — so they hand it in here. step_agent
    checks its required fields AFTER this call, as it always has, and hands in
    no validator: moving its checks in would buy a second full agent run for a
    reply that costs nothing to reject today.

    Retries are spent on exactly the replies that spent one before this item:

    * a reply that will not parse at all — unchanged;
    * a reply only attempt 3 could parse. Before attempt 3 existed the parse
      raised here and the caller retried, so the retry still runs and the
      retried reply still wins. The scanned object is kept only as a fallback
      for a retry that cannot parse either — a run that cancelled outright
      before this item — and that fallback is reported through `notes`.

    A reply that parses by attempt 1 or 2 never reaches the retry unless
    `validate` rejects it, which is the pre-HZ-156 behaviour for all three
    callers that pass one.

    Returns `(validate(parsed) if validate else parsed, notes)`.

    A failure from the retry itself — a second parse failure, or an
    AgentExhaustedError raised by run_agent inside the closure — propagates
    untouched. AgentExhaustedError is a subclass of AgentError, so it must
    never be mistaken for a parse failure and retried (or swallowed): the
    orchestrator auto-retries a run only if it still carries that tag.
    """

    def notes_for(text: str, parsed: Any, *, scanned: bool) -> list[str]:
        notes = [*_notes_for(text, parsed)]
        if scanned:
            notes.append(FIRST_OBJECT_NOTE)
        return notes

    fallback: tuple[Any, list[str]] | None = None
    pre_scan_failure: Exception | None = None
    try:
        parsed, pre_scan_failure = _extract_json(reply_text)
        notes = notes_for(reply_text, parsed, scanned=pre_scan_failure is not None)
        value = validate(parsed) if validate else parsed
    except AgentExhaustedError:
        raise
    except (AgentError, json.JSONDecodeError) as exc:
        if retry is None:
            raise
        # `pre_scan_failure or exc`: a reply only attempt 3 could parse is asked
        # to try again with the error attempts 1 and 2 raised, so the prompt is
        # byte-for-byte the one that reply produced before attempt 3 existed —
        # even when it was `validate` that then rejected the scanned object.
        failure: Exception = pre_scan_failure or exc
    else:
        if pre_scan_failure is None or retry is None:
            return value, notes
        fallback, failure = (value, notes), pre_scan_failure

    # Deliberately OUTSIDE every handler above: nothing retry() itself raises
    # may be caught here. An AgentExhaustedError from run_agent inside the
    # closure has to reach the caller with its turn-cap tag intact.
    fresh = retry(RETRY_PROMPT.format(exc=failure))
    try:
        parsed, retried_pre_scan_failure = _extract_json(fresh)
        notes = notes_for(fresh, parsed, scanned=retried_pre_scan_failure is not None)
        return (validate(parsed) if validate else parsed), notes
    except AgentExhaustedError:
        raise
    except (AgentError, json.JSONDecodeError):
        if fallback is None:
            raise
        return fallback


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
