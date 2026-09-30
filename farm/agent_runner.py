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
from pathlib import Path

from .config import FARM_PROVIDER, MAX_TURNS, STATE_DIR, STEP_TIMEOUT_S
from .providers import claude, muse
from .providers.base import AgentError, AgentExhaustedError

__all__ = [
    "AgentError",
    "AgentExhaustedError",
    "assert_provider_auth",
    "run_agent",
    "extract_json",
    "parse_agent_reply",
    "read_and_clear_handoff_note",
    "repair_stats_path",
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
    (from farm/steps.py's providerLocked field — today, implement and
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


def extract_json(text: str) -> dict:
    """Lift a JSON object out of a model reply (tolerates fences/prose).

    HZ-124: the public contract (text in, dict out, raises AgentError) is
    unchanged — this is now a thin wrapper over _extract_json_with_notes(),
    which is where the repair ladder actually lives, so extending the ladder
    never means rewriting this function.
    """
    parsed, _notes = _extract_json_with_notes(text)
    return parsed


def _strip_fences(cleaned: str) -> str:
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    return cleaned


def _first_balanced_object(s: str) -> str | None:
    """Returns the FIRST complete top-level `{...}` object in s (metric 3:
    `{"s":"first"} prose {"s":"second"}` must return the first one), or None
    if the first `{` never reaches a matching `}` (a genuinely truncated or
    absent object — extract_json must still raise for that, never fabricate).

    Quote/escape-aware so a `}`/`{` inside a string literal never miscounts
    depth — but it only recognizes double-quoted strings, which is why this
    runs BEFORE the single-quote repair, not after: it has to see the raw
    reply exactly as the model wrote it.
    """
    start = s.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
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
                return s[start : i + 1]
    return None


_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def _strip_trailing_commas(s: str) -> str:
    """`{"a":1,}` -> `{"a":1}` (metric 1). A deterministic byte-level fix —
    never chooses between two readings, so it needs no lossless-retry gate."""
    return _TRAILING_COMMA_RE.sub(r"\1", s)


def _single_to_double_quotes(s: str) -> str:
    """`{'a':1}` -> `{"a":1}` (metric 2). Deliberately naive: a global
    replace scoped to exactly the metric's shape, with no attempt at
    disambiguating a double-quoted JSON string that happens to contain a
    literal apostrophe — only a result that actually parses is ever
    returned by the caller, so a bad naive rewrite is just discarded, never
    surfaced."""
    return s.replace("'", '"')


# ndjson counter (metric 15): one line per repair/retry/salvage/handoff
# firing, keyed by a short path name. Append-only — single-line appends are
# POSIX-atomic under PIPE_BUF, so concurrent step-agent processes never need
# a lock, mirroring this codebase's existing pm-session-*.txt convention.


def repair_stats_path() -> Path:
    """Read STATE_DIR at call time, not import time — a module-level
    constant here would be frozen at import and ignore a later
    monkeypatch.setattr(agent_runner, "STATE_DIR", ...) (or a runtime
    FARM_HOME change), same reasoning as _handoff_note_path()."""
    return STATE_DIR / "repair-stats.ndjson"


def _record_repair(path: str) -> None:
    try:
        stats_path = repair_stats_path()
        stats_path.parent.mkdir(parents=True, exist_ok=True)
        with open(stats_path, "a") as f:
            f.write(json.dumps({"path": path}) + "\n")
    except OSError:
        pass  # telemetry is best-effort; never fail a run over a stats write


def _extract_json_with_notes(text: str) -> tuple[dict, list[str]]:
    """The private helper extract_json() delegates to (HZ-124) — this is
    where the repair ladder actually lives, so extending it never means
    touching extract_json()'s own signature or contract (guardrail: extend,
    don't rewrite).

    Returns (parsed, notes) — notes is empty unless bytes were actually
    altered to make the reply parse (guardrail: no repair note for reads
    that pass through unmodified).
    """
    cleaned = _strip_fences(text.strip())

    # Fast path: strict=False parse of the WHOLE cleaned string, unchanged
    # from pre-HZ-124 behaviour — covers a fence-stripped reply, a reply with
    # a literal control character inside a JSON string, and (trivially) a
    # reply that's already valid, all with zero repair notes.
    try:
        return json.loads(cleaned, strict=False), []
    except json.JSONDecodeError:
        pass

    candidate = _first_balanced_object(cleaned)
    if candidate is None:
        raise AgentError(f"no JSON object in agent reply: {text[:200]}")

    # As-is (handles prose-wrapped-and-otherwise-valid, and first-of-two).
    try:
        return json.loads(candidate, strict=False), []
    except json.JSONDecodeError:
        pass

    comma_fixed = _strip_trailing_commas(candidate)
    quote_fixed = _single_to_double_quotes(candidate)
    both_fixed = _single_to_double_quotes(comma_fixed)

    variants = []
    if comma_fixed != candidate:
        variants.append((comma_fixed, ["stripped a trailing comma"]))
    if quote_fixed != candidate:
        variants.append((quote_fixed, ["converted single quotes to double quotes"]))
    if both_fixed != candidate and both_fixed not in (comma_fixed, quote_fixed):
        notes = []
        if comma_fixed != candidate:
            notes.append("stripped a trailing comma")
        if both_fixed != comma_fixed:
            notes.append("converted single quotes to double quotes")
        variants.append((both_fixed, notes))

    for variant_text, notes in variants:
        try:
            parsed = json.loads(variant_text, strict=False)
        except json.JSONDecodeError:
            continue
        for note in notes:
            _record_repair(note)
        return parsed, notes

    # Nothing repaired it — raising here (never fabricating plausible
    # content) is the correct outcome for e.g. an unescaped inner quote,
    # which is genuinely ambiguous and must go through the lossless retry in
    # parse_agent_reply() instead, never a heuristic guess.
    raise AgentError(f"no JSON object in agent reply: {text[:200]}")


def _salvage_truncated_json(text: str) -> tuple[dict, str] | None:
    """Exhaustion-only (metric 9): if `text` is valid JSON except cut off
    mid-string or mid-object (an open brace/bracket or an unterminated quote
    still pending at EOF), close the minimum needed and re-parse. Returns
    None — never a fabricated guess — if the result still doesn't parse
    (e.g. truncation mid-literal, `..."b": tru`) or if nothing was actually
    open at EOF (a genuinely different failure, not exhaustion truncation).
    """
    cleaned = _strip_fences(text.strip())
    start = cleaned.find("{")
    if start == -1:
        return None
    body = cleaned[start:]

    stack: list[str] = []
    in_string = False
    escape = False
    for ch in body:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()

    if not in_string and not stack:
        return None  # nothing left open — not a truncation this can fix

    closers = {"{": "}", "[": "]"}
    patch = ('"' if in_string else "") + "".join(closers[c] for c in reversed(stack))

    try:
        parsed = json.loads(body + patch, strict=False)
    except json.JSONDecodeError:
        return None

    _record_repair("salvaged_truncated_json")
    return parsed, "salvaged a reply truncated mid-string/object at the point of turn-budget exhaustion"


# ---- cross-attempt handoff note (metric 11) ----
# A plain-text file under STATE_DIR, read once by the next attempt's
# build_prompt() and deleted — mirrors pm_agent's existing pm-session-*.txt
# convention. Deliberately a file, never a resumed session: see
# docs/providers/claude-resume-after-exhaustion.md (metric 12) for why.


def _handoff_note_path(item_id: str, step_index) -> Path:
    return STATE_DIR / f"handoff-{item_id}-s{step_index}.txt"


def _write_handoff_note(item_id: str, step_index, text: str) -> None:
    path = _handoff_note_path(item_id, step_index)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text[:2000])


def read_and_clear_handoff_note(item_id: str, step_index) -> str | None:
    """Read-once: a stale note from a superseded/rejected attempt must never
    leak into an unrelated later one, so this deletes what it reads."""
    path = _handoff_note_path(item_id, step_index)
    if not path.exists():
        return None
    text = path.read_text().strip()
    path.unlink(missing_ok=True)
    return text or None


_HANDOFF_PROMPT = (
    "You ran out of turn/time budget before finishing this step. In 3-5 sentences, "
    "summarize what you had completed and what was still left to do, so the next "
    "attempt can pick up where you left off. Do not use any tools and do not make "
    "further edits — just answer with the summary, in plain text."
)


def _fire_handoff(exc: AgentExhaustedError, *, run_agent_fn, run_kwargs: dict, item_id: str, step_index) -> None:
    """Exactly one extra model call, resuming the exhausted session, asking
    for an unverified progress summary — never retried itself (guardrail: no
    loop, no retry of the handoff call). A failure here (including the
    handoff call exhausting too) is swallowed: worst case is no note this
    time, identical to pre-HZ-124 total-loss behaviour, never worse."""
    handoff_max_turns = max(1, min(3, run_kwargs.get("max_turns", MAX_TURNS) - 1))
    handoff_timeout_s = min(120, run_kwargs.get("timeout_s", STEP_TIMEOUT_S))
    try:
        reply = run_agent_fn(
            _HANDOFF_PROMPT,
            session_id=exc.session_id,
            append_system=run_kwargs.get("append_system"),
            cwd=run_kwargs.get("cwd"),
            model=run_kwargs.get("model"),
            max_turns=handoff_max_turns,
            timeout_s=handoff_timeout_s,
            allowed_tools=None,
            provider=run_kwargs.get("provider"),
            provider_locked=run_kwargs.get("provider_locked", False),
        )
    except AgentError:
        return

    text = str(reply.get("result", "")).strip()
    if not text:
        return
    _write_handoff_note(item_id, step_index, text)
    _record_repair("handoff_fired")


def _handle_exhaustion(
    exc: AgentExhaustedError,
    *,
    run_agent_fn,
    run_kwargs: dict,
    on_exhaustion: str,
    handoff_item_id: str | None,
    handoff_step_index,
) -> tuple[dict, dict, list[str]]:
    if on_exhaustion == "reraise":
        raise exc

    salvaged = _salvage_truncated_json(exc.partial_text or "")
    if salvaged is not None:
        parsed, note = salvaged
        reply_meta = {"provider": None, "command_id": None, "session_id": exc.session_id}
        return parsed, reply_meta, [note]

    if handoff_item_id is not None and handoff_step_index is not None and exc.session_id:
        _fire_handoff(exc, run_agent_fn=run_agent_fn, run_kwargs=run_kwargs, item_id=handoff_item_id, step_index=handoff_step_index)

    # Salvage failed (or wasn't attempted): this attempt still fails and is
    # still retryable as turn_cap — the handoff (if any) only enriches the
    # NEXT attempt's prompt, it never turns this one into a success.
    raise exc


def parse_agent_reply(
    prompt: str,
    *,
    run_agent_fn=None,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int = MAX_TURNS,
    timeout_s: int = STEP_TIMEOUT_S,
    allowed_tools: str | None = None,
    provider: str | None = None,
    provider_locked: bool = False,
    retry_on_failure: bool = True,
    on_exhaustion: str = "salvage_or_handoff",
    handoff_item_id: str | None = None,
    handoff_step_index=None,
) -> tuple[dict | None, dict, list[str]]:
    """The one shared run_agent + extract_json + retry/repair/salvage/handoff
    helper (metric 14) — farm/pm_agent.py and farm/step_agent.py must both
    call this rather than parsing a reply themselves.

    run_agent_fn defaults to this module's own run_agent, but callers should
    pass their OWN module-level `run_agent` reference (the one their test
    suite monkeypatches) so existing `monkeypatch.setattr(step_agent,
    "run_agent", ...)`-style tests keep faking calls made through this
    helper, without this module reaching back into the caller's namespace.

    retry_on_failure=False (the implement step only) returns (None,
    reply_meta, []) instead of raising on a parse failure — implement
    tolerates a malformed final summary (HZ-29): the code in the workspace is
    the deliverable, not the message.

    on_exhaustion="reraise" (the implement step only) skips salvage/handoff
    entirely and re-raises AgentExhaustedError unchanged, so HZ-31's
    checkpoint-salvage scope is untouched (guardrail).

    Returns (parsed_or_None, reply_meta, notes) where reply_meta is
    {"provider", "command_id", "session_id"} and notes lists every repair
    that altered bytes to produce `parsed` (guardrail: callers must surface
    these in both the run log and the artifact).
    """
    run_agent_fn = run_agent_fn or run_agent
    run_kwargs = dict(
        append_system=append_system,
        cwd=cwd,
        model=model,
        max_turns=max_turns,
        timeout_s=timeout_s,
        allowed_tools=allowed_tools,
        provider=provider,
        provider_locked=provider_locked,
    )

    try:
        reply = run_agent_fn(prompt, session_id=session_id, **run_kwargs)
    except AgentExhaustedError as exc:
        return _handle_exhaustion(
            exc,
            run_agent_fn=run_agent_fn,
            run_kwargs=run_kwargs,
            on_exhaustion=on_exhaustion,
            handoff_item_id=handoff_item_id,
            handoff_step_index=handoff_step_index,
        )

    reply_meta = {
        "provider": reply.get("provider"),
        "command_id": reply.get("command_id"),
        "session_id": reply.get("session_id"),
    }

    try:
        parsed, notes = _extract_json_with_notes(reply["result"])
        return parsed, reply_meta, notes
    except (AgentError, json.JSONDecodeError) as exc:
        if not retry_on_failure:
            return None, reply_meta, []

        # The lossless retry (metric 5/guardrail 1): re-ask the model for
        # valid JSON before any repair that could pick between readings —
        # by construction, since no such heuristic repair exists above, this
        # is the ONLY recovery path for a genuinely ambiguous reply (e.g. an
        # unescaped inner quote).
        try:
            retry_reply = run_agent_fn(
                f"Your previous reply was invalid: {exc}. Respond again with ONLY the JSON object, no other text.",
                session_id=reply.get("session_id"),
                **run_kwargs,
            )
        except AgentExhaustedError as retry_exc:
            return _handle_exhaustion(
                retry_exc,
                run_agent_fn=run_agent_fn,
                run_kwargs=run_kwargs,
                on_exhaustion=on_exhaustion,
                handoff_item_id=handoff_item_id,
                handoff_step_index=handoff_step_index,
            )

        retry_meta = {
            "provider": retry_reply.get("provider"),
            "command_id": retry_reply.get("command_id"),
            "session_id": retry_reply.get("session_id"),
        }
        # A second failure propagates uncaught (metric 6: unrepairable input
        # still raises, no fabricated content) — no second retry, no loop.
        parsed, notes = _extract_json_with_notes(retry_reply["result"])
        return parsed, retry_meta, notes
