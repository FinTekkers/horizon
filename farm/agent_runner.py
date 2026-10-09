"""The single entrypoint above the provider seam (HZ-83, renamed from
claude_runner.py / run_claude()).

run_agent() picks a provider by FARM_PROVIDER config (default "claude" —
unchanged behaviour) and dispatches to a module under farm/providers/.
Everything above this file — step_agent, concierge_agent — talks
only to run_agent(); none of them know or care which provider actually ran.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple

from domain.py.personas import resolve_model

from .config import FARM_PROVIDER, MAX_TURNS, STATE_DIR, STEP_TIMEOUT_S
from .providers import claude, muse
from .providers.base import AgentError, AgentExhaustedError

__all__ = [
    "AgentError",
    "AgentExhaustedError",
    "FIRST_OBJECT_NOTE",
    "REPAIRS",
    "REPAIR_COUNTS_PATH",
    "REPAIR_NOTES",
    "SINGLE_QUOTE_NOTE",
    "TRAILING_COMMA_NOTE",
    "Repair",
    "assert_provider_auth",
    "extract_json",
    "parse_agent_reply",
    "provider_resumes_after_exhaustion",
    "record_repair",
    "repair_counts",
    "run_agent",
    "salvage_truncated_reply",
    "stamp_notes",
    "stamp_notes_artifact",
]

_PROVIDERS = {"claude": claude, "muse": muse}

# HZ-117: the one non-Claude provider is Muse, reachable either via an
# explicit provider= override (a persona forcing it) or a bare FARM_PROVIDER
# env var. provider_locked steps (deploy, plus implement when no choice is
# set — HZ-369) must refuse BOTH paths
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
    retry_fresh: bool = True,
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>, "provider": <name>,
    "command_id": <id or None>}.

    retry_fresh=False (HZ-158) is handed to the provider: a failed resume
    raises instead of quietly starting a fresh session. Every caller but the
    handoff note keeps the default. An AgentExhaustedError leaves here with
    .provider set to the provider that ran.

    provider names which entry in _PROVIDERS to dispatch to for this one
    call, overriding FARM_PROVIDER (HZ-102 — e.g. a persona mapped to Muse
    via farm/personas.py's PERSONA_PROVIDERS). It's a plain parameter rather
    than an env var so the override can never leak into a later call in the
    same process, and so a test can assert it as a call argument. Omit it
    (the default) for the unchanged, env-selected behaviour every other
    caller keeps.

    provider_locked (HZ-117) is the caller's declaration that this step
    (from domain/steps.json's providerLocked field — today deploy, plus
    implement when the owner set no choice, HZ-369) must run on DEFAULT_PROVIDER no matter what, refusing BOTH an
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
    try:
        result = provider_module.run(
            prompt,
            session_id=session_id,
            append_system=append_system,
            cwd=cwd,
            model=model,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
            retry_fresh=retry_fresh,
        )
    except AgentExhaustedError as exc:
        # The same provenance a reply carries, so a salvaged reply can record
        # which provider really ran (HZ-158).
        exc.provider = name
        raise
    # Provenance (HZ-102): which provider actually ran, plus its run-level
    # id where one exists (Muse's command_id; Claude has no equivalent).
    result["provider"] = name
    result.setdefault("command_id", None)
    return result


def provider_resumes_after_exhaustion(name: str | None) -> bool:
    """HZ-158: whether provider `name` can resume a session that ran out of
    budget — the provider module's RESUMES_AFTER_EXHAUSTION. False for an
    unknown or missing name: no resume is ever attempted on a guess."""
    module = _PROVIDERS.get(name) if isinstance(name, str) else None
    return bool(getattr(module, "RESUMES_AFTER_EXHAUSTION", False))


SALVAGE_NOTE = (
    "the agent ran out of turns while writing this reply; it was salvaged from a "
    "JSON reply cut off mid-string, so its last field is incomplete"
)


def salvage_truncated_reply(text: str | None, required_keys: tuple[str, ...]) -> tuple[dict, str] | None:
    """HZ-158: recover a reply that was valid JSON until it was cut off inside
    a string value, or None. Returns (parsed object, note for the record).

    Only one repair is made, and it adds no content: close the open string,
    then the open arrays and objects in stack order. Everything else returns
    None, so the caller re-raises the exhaustion:

    * no text, or text that does not start with `{` once fences are stripped;
    * a cut anywhere but inside a string — `{`, or between tokens, where a
      value or key would have to be invented;
    * a cut right after a backslash (a half-written escape);
    * text whose top-level object already closed — it was not cut off;
    * a closed result that does not parse — e.g. a cut inside a key;
    * a non-object, an empty object, or one where any of required_keys is
      missing, null or an empty string. No required_keys at all is also a
      rejection: a caller must say what a reply needs.
    * any object with a "verdict" key. This is a backstop only: which steps
      may be salvaged is decided by step_agent.SALVAGE_STEPS, never here.

    Deliberately not extract_json(): its prose-tolerant attempts would accept
    the shapes this function must refuse (farm/tests/test_one_reply_parser.py).
    """
    if not required_keys or not isinstance(text, str):
        return None
    cleaned = _strip_fences(text).lstrip()
    if not cleaned.startswith("{") or cleaned.endswith("\\"):
        return None
    stack: list[str] = []
    pairs = {"}": "{", "]": "["}
    in_string_at_end = False
    # The appended quote closes the string the text was cut in — and reports
    # in_string=True for it — or opens a new one, reporting False.
    for i, ch, in_string in _scan(cleaned + '"'):
        if i == len(cleaned):
            in_string_at_end = in_string
            break
        if in_string:
            continue
        if ch in "{[":
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                return None
            if not stack:
                return None  # the object closed, so the reply was not cut off
    if not in_string_at_end or not stack:
        return None
    closers = "".join("}" if opener == "{" else "]" for opener in reversed(stack))
    try:
        parsed = json.loads(cleaned + '"' + closers, strict=False)
    except (ValueError, RecursionError):
        return None
    if not isinstance(parsed, dict) or not parsed or "verdict" in parsed:
        return None
    for key in required_keys:
        value = parsed.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
    return parsed, SALVAGE_NOTE


def _scan(text: str, start: int = 0) -> Iterator[tuple[int, str, bool]]:
    """One forward pass over `text`, yielding `(index, char, in_string)`.

    THE string/escape state machine for this module (HZ-157). It was inline in
    _first_balanced_object() until the repair rungs below needed the identical
    rule — and two hand-maintained copies of escape handling is precisely the
    bug this seam exists to prevent, since a rung that got it wrong would edit
    bytes inside a string literal, i.e. fabricate content.

    A `{`/`}`/`,` inside a JSON string literal is content, not structure, so
    `in_string` is True for it. Backslash escapes are honoured, so a trailing
    `\\\\` before a quote does not swallow the quote. The OPENING quote of a
    literal reports in_string=False and the CLOSING quote reports True, which
    is the convention _first_balanced_object() has always used.

    No backtracking — a reply of ten thousand unclosed braces is walked once,
    in linear time, rather than exploring spans.
    """
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            yield i, ch, True
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        yield i, ch, False
        if ch == '"':
            in_string = True


def _first_balanced_object(text: str) -> str | None:
    """The first brace-balanced span starting at the first `{`, or None."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i, ch, in_string in _scan(text, start):
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _strip_fences(text: str) -> str:
    """The cleaning both _extract_json() and the repair rungs work from.

    Byte-lossless in the sense that matters: it only ever removes surrounding
    whitespace and a markdown code fence, never anything inside the JSON.
    Factored out so a rung operates on exactly the bytes _extract_json()'s
    attempt 2 saw — see _repair_span().
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    return cleaned


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
    cleaned = _strip_fences(text)
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

# HZ-157's two notes. One per repair rung, declared here rather than inline so
# the six tests that assert them read the same constant the code emits.
TRAILING_COMMA_NOTE = (
    "reply had a trailing comma before a closing brace or bracket; removed it to parse "
    "— see session log"
)
SINGLE_QUOTE_NOTE = (
    "reply used single quotes as JSON string delimiters; re-quoted them to parse — see session log"
)


def _notes_for(reply_text: str, parsed: Any) -> list[str]:
    """Per-repair parser notes for one reply. Still empty, by design.

    NOT dead code: this is the reporting channel the follow-up items report
    through, and the seam their plumbing is proven against — a test
    monkeypatches this function to inject a note and asserts it reaches the
    run's output line and the step's artifact.

    HZ-157's own two notes are emitted by the repair ladder rather than here,
    for the same reason FIRST_OBJECT_NOTE is: this function is handed the reply
    and its parsed value, which is not enough to say WHICH transform ran. A
    note must name the byte change it describes.
    """
    return []


def _notes_with_scan(text: str, parsed: Any, *, scanned: bool) -> list[str]:
    """_notes_for() plus the which-attempt-parsed note. One definition, because
    both parse_agent_reply() and the repair ladder need exactly this list."""
    notes = [*_notes_for(text, parsed)]
    if scanned:
        notes.append(FIRST_OBJECT_NOTE)
    return notes


# ---- HZ-157: the repair ladder ----
# Repairs live HERE and nowhere else. extract_json() and _extract_json() stay
# byte-lossless: they are the public/private raw extractors, and
# farm/tests/test_one_reply_parser.py fails any module that reaches for either.
#
# Every rung obeys three rules, and each rule closes a way this could go wrong:
#
# 1. A rung only ever sees bytes the LOSSLESS ladder already refused. A reply
#    that parses today parses by the same route to the same value.
# 2. A rung that changes no byte is skipped before any parse attempt — no note,
#    no counter tick. So "a note exists" and "bytes changed" are the same fact
#    in both directions, which is the guardrail this item was split out for.
# 3. An `ambiguous` rung — one where the bytes admit more than one reading —
#    may only run AFTER the lossless retry has actually run. Declared as a
#    field, not argued in prose, so part 3's rungs inherit the rule.
#
# Rungs are tried ONE AT A TIME and never composed, which is a deliberate limit
# rather than an oversight: a reply carrying both defects (`{'a':1,}`) leaves
# bytes that still fail after either rung alone, so no rung succeeds and the
# reply raises. Raising is a correct outcome here — composing rungs would stack
# an unambiguous edit underneath an ambiguous one and make the combined
# transform's reading harder to defend than either part, for a shape nothing has
# been observed to produce. The near-miss sweep in
# farm/tests/test_agent_runner_repair.py carries `{'a':1,}` so the limit is
# pinned, and the next change to this ladder is a decision rather than a drift.


class Repair(NamedTuple):
    """One rung of the ladder.

    `apply` returns its input unchanged to decline (see rule 2 above): that is
    how a rung says "these bytes are not my shape" and how it refuses bytes it
    cannot edit safely. Raising is not the refusal channel — a rung must not
    invent an exception the caller would have to classify.
    """

    name: str  # counter key and test handle
    ambiguous: bool  # True -> post-retry only
    note: str
    apply: Callable[[str], str]


def _repair_trailing_commas(span: str) -> str:
    """Drop a `,` whose next non-space character closes the object or array.

    UNAMBIGUOUS. A comma immediately before `}` or `]` is illegal JSON in every
    reading, and deleting it is the only single-character edit that makes those
    bytes valid — so there is nothing to choose between and no reason to spend a
    retry first. String content is untouched: the comma in `{"a":"x, }"}` is
    reported in_string by _scan() and never considered.

    One pass, so ten thousand commas cost one walk. Two adjacent commas
    (`{"a":1,,}`) leave only the last one dropped, the result still fails to
    parse, and the rung fails — which is correct. Guessing further would be
    fabrication.
    """
    drop: set[int] = set()
    pending: int | None = None  # index of the most recent structural comma
    for i, ch, in_string in _scan(span):
        if in_string:
            pending = None
            continue
        if ch == ",":
            pending = i
        elif ch in "}]":
            if pending is not None:
                drop.add(pending)
            pending = None
        elif not ch.isspace():
            pending = None
    if not drop:
        return span
    return "".join(ch for i, ch in enumerate(span) if i not in drop)


def _repair_single_quotes(span: str) -> str:
    """Rewrite `'` delimiters to `"`.

    AMBIGUOUS, so post-retry only: an apostrophe inside a value has a second
    reading, and nothing in the bytes says which was meant. Two preconditions
    make the refusal case the default rather than the exception:

    * any `"` in the span -> refuse. A mixed-quote reply (`{'a':"b"}`) could
      only be re-quoted by choosing which quotes are delimiters, and a
      re-quoting that collides with an existing double quote can silently
      change what a value says.
    * any `\\'` in the span -> refuse. That is not a JSON escape, and rewriting
      it would turn an apostrophe the model escaped into a literal `"` inside
      the value — content the reply never contained.

    Anything that survives both and still does not parse (`{'a':'it's fine'}`)
    fails the rung and raises, which is the correct outcome for bytes with two
    readings.
    """
    if '"' in span or "\\'" in span or "'" not in span:
        return span
    return span.replace("'", '"')


REPAIRS: tuple[Repair, ...] = (
    Repair("trailing_comma", False, TRAILING_COMMA_NOTE, _repair_trailing_commas),
    Repair("single_quotes", True, SINGLE_QUOTE_NOTE, _repair_single_quotes),
)

# Which notes mean "bytes were changed". Exported because a caller that labels
# its log line needs to tell the two kinds of note apart: FIRST_OBJECT_NOTE
# reports WHICH lossless attempt parsed the reply and no byte was edited, so
# calling it a repair would overstate what happened on a reply the parser only
# read differently. Derived from REPAIRS rather than listed, so part 3's rungs
# join it without a second edit.
REPAIR_NOTES: frozenset[str] = frozenset(rung.note for rung in REPAIRS)


def _repairs_enabled() -> bool:
    """Read at call time — like _selected_provider_name() above — so the lever
    actually moves. An import-bound flag cannot be flipped by a restart's env
    or by a test, which is a rollback lever that only looks like one."""
    return os.environ.get("FARM_REPLY_REPAIR", "1").strip().lower() not in ("0", "false", "no")


def _repair_span(text: str) -> str | None:
    """The only bytes a rung is allowed to touch: the cleaned reply's widest
    `{`…`}` span — exactly what _extract_json()'s attempt 2 tried.

    Scoping matters more than it looks. A real reply carries prose and code
    fences around its JSON, and a rung that inspected the whole reply would see
    every `"` in that prose: the single-quote rung's refusal precondition would
    then fire on almost every real reply while still passing against bare test
    fixtures. Running on the span also means a repair can never edit the prose.
    """
    cleaned = _strip_fences(text)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        return None
    return cleaned[start : end + 1]


class _Repaired(NamedTuple):
    value: Any
    notes: list[str]
    repair: str
    # The repaired bytes parsed only by attempt 3's scan. HZ-156 owes such a
    # reply the lossless retry first, so parse_agent_reply() may not take this
    # value ahead of a retry it can still spend.
    scanned: bool


def _repair_ladder(
    text: str, *, ambiguous: bool, validate: Callable[[Any], Any] | None
) -> _Repaired | None:
    """Try each rung of one ambiguity tier against `text`'s JSON span.

    Returns the first rung's result that both parses AND passes `validate`, or
    None when no rung fired. A validator rejection means the rung FAILED, not
    that it succeeded with a bad value: `validate` is what the caller actually
    consumes (concierge_agent unpacks a 4-tuple out of it), so an unvalidated
    repair would hand the caller the wrong shape entirely.

    Nothing this function raises is a parse failure the caller should classify.
    An AgentExhaustedError from a validator keeps its turn-cap tag, and a rung's
    own apply() is deliberately called OUTSIDE the try — a rung is pure text
    editing, and swallowing an exception from one would hide a real bug.
    """
    if not _repairs_enabled():
        return None
    span = _repair_span(text)
    if span is None:
        return None
    for rung in REPAIRS:
        if rung.ambiguous != ambiguous:
            continue
        candidate = rung.apply(span)
        if candidate == span:
            # Rule 2: no byte changed, so there is nothing to report and
            # nothing to count. Skipped before any parse attempt, so a rung
            # that declines is indistinguishable from a rung that is not there.
            continue
        try:
            parsed, pre_scan_failure = _extract_json(candidate)
            notes = _notes_with_scan(candidate, parsed, scanned=pre_scan_failure is not None)
            value = validate(parsed) if validate else parsed
        except AgentExhaustedError:
            raise
        except (AgentError, json.JSONDecodeError):
            continue
        return _Repaired(value, [rung.note, *notes], rung.name, pre_scan_failure is not None)
    return None


# ---- HZ-157: how often each rung actually fires ----
# A file rather than a process counter because the callers of this helper
# (step_agent, concierge_agent, and conflict_resolver inside farmd)
# are SEPARATE PROCESSES — an in-memory tally is unreadable by any script,
# which is what the success metric asks for.
REPAIR_COUNTS_PATH = STATE_DIR / "parser-repairs.json"


def repair_counts(path: Path | None = None) -> dict[str, int]:
    """Totals per repair path. Never raises.

    A missing file, an unreadable file and a corrupt file all read as empty:
    this is a measurement, and a broken measurement must not fail a step run.
    Non-integer values are dropped rather than coerced, so one bad key cannot
    poison the rest of the totals.
    """
    target = Path(path) if path is not None else REPAIR_COUNTS_PATH
    try:
        raw = json.loads(target.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): int(value)
        for key, value in raw.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def record_repair(name: str, path: Path | None = None) -> None:
    """Tick one repair path's counter. Best effort — never raises.

    mkdir first, not just on failure: STATE_DIR is created by config's
    ensure_dirs() at farmd startup, and an agent process may never have run it.
    Without this every tick would be dropped into a missing directory and the
    script would honestly print zeros forever — a metric that passes its own
    test while measuring nothing.

    Unknown keys are preserved, so a later item's rung cannot erase this one's
    totals. Written to a sibling and os.replace()d, so a reader never sees a
    half-written file — and the sibling is removed if the rename is what failed,
    or a half-written `.tmp` would sit in STATE_DIR forever with nothing to
    clean it up.

    KNOWN LIMIT: two agent processes ticking in the same instant can lose one
    increment. These are indicative totals, not an audit trail; locking the
    farm's processes against each other is not worth a counter's correctness.
    """
    target = Path(path) if path is not None else REPAIR_COUNTS_PATH
    counts = repair_counts(target)
    counts[name] = counts.get(name, 0) + 1
    tmp = target.with_name(target.name + ".tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(counts, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, target)
    except OSError:
        # A counter must never be the reason a step failed — but it must not
        # leave litter either. missing_ok: the write itself may be what failed.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return


def parse_agent_reply(
    reply_text: str,
    retry: Callable[[str], str] | None = None,
    *,
    validate: Callable[[Any], Any] | None = None,
) -> tuple[Any, list[str]]:
    """THE parser for a model's final JSON reply. Every caller above this
    module uses it; nothing else calls extract_json() (enforced by
    farm/tests/test_one_reply_parser.py).

    Before HZ-156 the PM runner, step_agent and concierge_agent each kept their own
    copy of this parse-then-retry-once path, and they had already drifted.

    `retry` receives the fully formatted retry prompt and returns the model's
    fresh reply text. Omit it (step_agent's implement step) and a first
    failure propagates immediately with no retry.

    `validate` is applied INSIDE the retry envelope, so a reply that parses
    but is missing a required field takes the lossless retry. That is where
    the PM steps and concierge_agent have always run their validator — both
    wrapped validate(extract_json(...)) in one try — so they hand it in here.
    step_agent's other steps check their required fields AFTER this call, as it always has, and hands in
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

    HZ-157 adds byte-altering repairs, under one invariant that decides every
    branch below: a rung is only ever attempted on bytes the LOSSLESS ladder
    refused, and only when no losslessly-parsed value is available. Two
    consequences worth naming, because both were undefined in the plan:

    * `_extract_json()` SUCCEEDING — including by attempt 3, with a
      `pre_scan_failure` recorded — means no repair runs on that reply at all.
      A value parsed from unaltered bytes is already in hand; repairing bytes
      that parsed would change which value a reply returns today.
    * when the retry will not parse but `fallback` holds a scanned object, the
      FALLBACK WINS and no rung runs on the retried text. Lossless beats
      repaired, always, even when the lossless value came from the weakest
      attempt.

    * a REPAIRED reply that parses only by attempt 3 is held to the same rule
      as an unrepaired one: with a retry to spend, the lossless retry runs
      first and the repair is only taken after it fails.

    So repairs are reached on exactly two paths: the original reply failed the
    lossless ladder outright (unambiguous rungs only, before the retry is
    spent, and only when the repaired bytes parse without the scan), or that
    plus the retry also failed with no fallback (both tiers).
    """
    fallback: tuple[Any, list[str]] | None = None
    pre_scan_failure: Exception | None = None
    extracted = False  # did the LOSSLESS ladder produce a value at all?
    try:
        parsed, pre_scan_failure = _extract_json(reply_text)
        extracted = True
        notes = _notes_with_scan(reply_text, parsed, scanned=pre_scan_failure is not None)
        value = validate(parsed) if validate else parsed
    except AgentExhaustedError:
        raise
    except (AgentError, json.JSONDecodeError) as exc:
        # `extracted` separates the two failures this handler catches. False
        # means _extract_json() refused the bytes, which is the only thing a
        # repair can help with. True means the reply parsed cleanly and
        # `validate` rejected the RESULT — editing bytes there would not fix a
        # missing field, it would only invent a different object.
        if not extracted:
            repaired = _repair_ladder(reply_text, ambiguous=False, validate=validate)
            # A repair that only parsed via the attempt-3 scan is the repaired
            # twin of a reply only attempt 3 could parse — and HZ-156 spends
            # the lossless retry on those first. So it is taken here only when
            # there is no retry to spend; otherwise the retry runs and the
            # unambiguous tier is tried again on the original after it fails.
            if repaired is not None and (not repaired.scanned or retry is None):
                return _accept(repaired)
        if retry is None:
            # Ambiguous rungs stop here on purpose: the guardrail is that no
            # repair chooses between two readings before the lossless retry has
            # RUN, and with no retry to spend it never can. step_agent's
            # implement step already has a documented fallback for a malformed
            # final message, so raising costs it little.
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
    fresh_extracted = False
    try:
        parsed, retried_pre_scan_failure = _extract_json(fresh)
        fresh_extracted = True
        notes = _notes_with_scan(fresh, parsed, scanned=retried_pre_scan_failure is not None)
        return (validate(parsed) if validate else parsed), notes
    except AgentExhaustedError:
        raise
    except (AgentError, json.JSONDecodeError):
        if fallback is not None:
            return fallback  # lossless beats repaired — see the docstring
        # The lossless retry has now run and produced nothing usable, so the
        # ambiguous tier is unlocked. The retried reply is tried first: the
        # model was explicitly told what was wrong with the original, so its
        # second attempt is the better-informed bytes.
        #
        # The `extracted` flags apply the same rule to both texts as the
        # pre-retry branch did to the original: a reply the LOSSLESS ladder
        # already parsed is never repaired, because the only thing left wrong
        # with it is a validator rejection that no byte edit can honestly fix.
        # The original's unambiguous tier IS re-run: a repair that parsed only
        # via the scan was deferred above until the retry had run, and this is
        # where it is now allowed to win. When that tier failed outright above
        # it fails identically here, costing one parse.
        candidates = (
            (fresh, () if fresh_extracted else (False, True)),
            (reply_text, () if extracted else (False, True)),
        )
        for text, tiers in candidates:
            for ambiguous in tiers:
                repaired = _repair_ladder(text, ambiguous=ambiguous, validate=validate)
                if repaired is not None:
                    return _accept(repaired)
        raise


def _accept(repaired: _Repaired) -> tuple[Any, list[str]]:
    """Tick the counter and hand back the repaired value.

    The tick lives HERE, at the one place a repaired value is actually
    returned, rather than where a rung parsed. A rung that parses but whose
    value loses to the retry must not show up in the totals as a repair that
    happened — it did not.
    """
    record_repair(repaired.repair)
    return repaired.value, repaired.notes


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
