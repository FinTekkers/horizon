"""The farm's one view of "what can make a step fail" (HZ-132).

This module READS domain/reasons.json — the only place a failure reason is
declared — at import, so the farm never hand-types a tag the server then has to
recognise. farm/step_agent.py and farm/farmd.py emit REASON[...] values; the
server classifies the same document through domain/js/reasons.js.

Unlike domain/py/steps.py there is NO farm-shaped projection here: the
vocabulary is identical on both sides of the wire, which is the whole point.
Both bindings therefore expose the authored table verbatim, and
server/test/domain-reasons-parity.test.mjs diffs them pair by pair.

REASON is a dict rather than module-level attributes: a typo raises KeyError at
the call site, loudly. Attributes written in by globals().update() would be
invisible to an IDE and a mistyped one would raise only at use — and the JS
binding's object form cannot raise at all, which is why
server/test/domain-reason-member-access.test.mjs exists for that side.

_SOURCE_PATH is derived from __file__, never from the process's cwd: farm
agents run inside workspace clones, not from the repo root
(farm/tests/test_domain_import.py asserts that).
"""

import json
import re
from pathlib import Path

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "reasons.json"

# LOAD-BEARING, not cosmetic: REASON's keys are derived by id.upper(), so a
# hyphenated id would produce a key no caller can name, and a mixed-case one
# would collide with its own lower-case form. Kept word-for-word in step with
# ID_SHAPE in domain/js/reasons.js.
_ID_SHAPE = re.compile(r"^[a-z][a-z0-9_]*$")


def _validate_source(data: object, source: str) -> dict:
    """Shape, id-shape, uniqueness and at-least-one-retryable enforcement,
    applied at import time AND to anything _load_source reads off disk. Raises
    rather than returning a partly-usable vocabulary: a duplicate id would make
    is_retryable resolve to whichever entry came first, and a vocabulary with
    nothing retryable would silently turn every transient failure into a pause.

    The rules and the message fragments are kept word-for-word in step with
    domain/js/reasons.js's assertReasonsShape."""
    if not isinstance(data, dict):
        raise RuntimeError(f"domain/py/reasons.py: {source} must be a JSON object with a reasons array")
    reasons = data.get("reasons")
    if not isinstance(reasons, list) or not reasons:
        raise RuntimeError(
            f"domain/py/reasons.py: {source}: reasons must be a non-empty JSON array of reason objects"
        )
    for i, reason in enumerate(reasons):
        if not isinstance(reason, dict):
            raise RuntimeError(f"domain/py/reasons.py: {source}: reasons[{i}] must be a reason object")
        reason_id = reason.get("id")
        if not isinstance(reason_id, str) or not _ID_SHAPE.match(reason_id):
            raise RuntimeError(
                f"domain/py/reasons.py: {source}: reasons[{i}] declares id {json.dumps(reason_id)} "
                f"— expected lower_snake_case matching {_ID_SHAPE.pattern}"
            )
        # bool is an int subclass in Python, and a truthy string is not a flag.
        if not isinstance(reason.get("retryable"), bool):
            raise RuntimeError(
                f'domain/py/reasons.py: {source}: reasons[{i}] ("{reason_id}") declares a '
                "non-boolean retryable — a truthy value is not a flag"
            )

    ids = [reason["id"] for reason in reasons]
    dupes = {reason_id for reason_id in ids if ids.count(reason_id) > 1}
    if dupes:
        raise RuntimeError(f"domain/py/reasons.py: {source} has duplicate reason id(s): {sorted(dupes)}")
    if not any(reason["retryable"] for reason in reasons):
        raise RuntimeError(
            f"domain/py/reasons.py: {source}: no reason is retryable "
            "— every transient failure would pause for a human"
        )
    return data


def _load_source(path: Path) -> dict:
    """Reads the authored reason document off disk and validates it. This is how
    the production vocabulary below is built — not a test-only helper."""
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/reasons.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/reasons.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


_SOURCE: dict = _load_source(_SOURCE_PATH)

REASONS: list[dict] = _SOURCE["reasons"]
REASON_IDS: list[str] = [reason["id"] for reason in REASONS]

# Keyed by the id's upper-case form, same derivation as the JS binding's REASON.
REASON: dict[str, str] = {reason["id"].upper(): reason["id"] for reason in REASONS}

# DERIVED, never hand-typed. A frozenset rather than a set so no caller can
# widen the server's retry policy from the farm side.
AUTO_RETRY_REASONS: frozenset[str] = frozenset(
    reason["id"] for reason in REASONS if reason["retryable"]
)


def is_retryable(reason_id: str) -> bool:
    """Whether the server auto-retries this reason (HZ-76's cap still applies on
    top). Safe on an unknown id — the farm never decides a retry itself."""
    return reason_id in AUTO_RETRY_REASONS
