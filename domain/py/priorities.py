"""The farm's one view of "what priority may a work item carry" (HZ-135).

This module READS domain/priorities.json — the only place the vocabulary is
declared — at import, so the farm never hand-types a list the API then has to
agree with. farm/wizard.py builds its numbered WhatsApp prompt and its
number->value parser from PRIORITIES, and farm/concierge_agent.py validates a
`set_priority` action against it before that action can reach the server.

Before HZ-135 the vocabulary existed ten times across three layers, as hand-typed
lists. The farm held three of those copies: wizard.py's tuple, the numbered prompt
text spelling every value out twice (the question and the retry line), and
concierge_agent.py's own tuple. A value added to the API would have been silently
rejected by the wizard, and one added to the wizard would have been rejected by
the API's enum.

ORDER IS PART OF THE DECLARATION, and it is DISPLAY order — severity, highest
first. Nothing in this repo sorts work items by priority, so there are no rank
integers; array position is the whole of it. options_line() below is what turns
that order into the wizard's "1) ... 2) ..." prompt, so the numbering cannot
drift from the vocabulary it numbers.

Unlike domain/py/steps.py there is NO farm-shaped projection here: the value the
API accepts, the value the database stores and the value the wizard offers are
the same string, which is the whole point of the file. Both bindings therefore
expose the authored vocabulary verbatim, and
server/test/domain-priorities-parity.test.mjs diffs them.

Nothing presentational lives here. The two colour maps stay where they are
(server/src/github.js, ui/src/domain/lifecycle.js), both keyed off the
vocabulary rather than re-typing it.

_SOURCE_PATH is derived from __file__, never from the process's cwd: farm agents
run inside workspace clones, not from the repo root
(farm/tests/test_domain_import.py asserts that).

options_line() takes `priorities` as its first argument rather than reading the
module-level PRIORITIES global internally — that's what lets a test fabricate a
vocabulary and assert the numbering follows it, with zero literals in the test
itself. The same convention domain/py/steps.py's budget_for_label and
domain/py/fields.py's patch_limits use.
"""

import json
import re
from pathlib import Path

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "priorities.json"

# Kept in step with domain/js/priorities.js's VALUE_SHAPE by
# farm/tests/test_priorities.py, which reads the JS regex out of the binding and
# compares the two patterns as strings.
_VALUE_SHAPE = re.compile(r"^[A-Z][A-Za-z]*$")


def _json(value: object) -> str:
    """json.dumps with JavaScript's spacing, so every message fragment below is
    byte-identical to the one domain/js/priorities.js produces for the same
    input. Python's default puts a space after a comma; JSON.stringify does not,
    and farm/tests/test_priorities.py compares the two messages."""
    return json.dumps(value, separators=(",", ":"))


def _validate_source(data: object, source: str) -> dict:
    """Shape, value-shape, case-insensitive uniqueness and default-membership
    enforcement, applied at import time AND to anything _load_source reads off
    disk. Raises rather than returning a partly-usable vocabulary.

    Every rule is load-bearing. server/src/db.js interpolates these values into
    the work_item CHECK constraint, so the value shape is what makes the
    generated SQL provably safe rather than safe-by-convention — and it is also
    what keeps the JS binding's PRIORITY keys reachable, since those are derived
    by upper-casing. Uniqueness is checked IGNORING CASE because the GitHub label
    match in server/src/priorityLabels.js is case-insensitive, so two values
    differing only in case would make priorityFromLabels() resolve to whichever
    came first. A default outside the vocabulary would be written straight into
    work_item and then rejected by the constraint the same list built.

    The rules and the message fragments are kept word-for-word in step with
    domain/js/priorities.js's assertPrioritiesShape —
    domain/fixtures/priorities-cases.json drives both, so the two cannot drift
    apart silently."""
    if not isinstance(data, dict):
        raise RuntimeError(
            f"domain/py/priorities.py: {source} must be a JSON object with a priorities array"
        )
    priorities = data.get("priorities")
    if not isinstance(priorities, list) or not priorities:
        raise RuntimeError(
            f"domain/py/priorities.py: {source}: priorities must be a non-empty JSON array of strings"
        )
    for i, value in enumerate(priorities):
        if not isinstance(value, str) or not _VALUE_SHAPE.match(value):
            raise RuntimeError(
                f"domain/py/priorities.py: {source}: priorities[{i}] declares "
                f"{_json(value)} — expected a capitalised letters-only word matching "
                f"/{_VALUE_SHAPE.pattern}/"
            )

    folded = [value.lower() for value in priorities]
    dupes = sorted({value for value in folded if folded.count(value) > 1})
    if dupes:
        raise RuntimeError(
            f"domain/py/priorities.py: {source} has duplicate priority value(s), "
            f"ignoring case: {_json(dupes)} — label matching is case-insensitive"
        )

    default = data.get("default")
    if not isinstance(default, str) or default not in priorities:
        raise RuntimeError(
            f"domain/py/priorities.py: {source}: default {_json(default)} is not one of "
            f"the declared priorities {_json(priorities)}"
        )
    return data


def _load_source(path: Path) -> dict:
    """Reads the authored vocabulary off disk and validates it. This is how the
    production tuple below is built — not a test-only helper."""
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/priorities.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/priorities.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


_SOURCE: dict = _load_source(_SOURCE_PATH)

# A tuple, not a list: the farm must not be able to widen the vocabulary the
# server enforces. Same reasoning as reasons.AUTO_RETRY_REASONS being a frozenset.
PRIORITIES: tuple[str, ...] = tuple(_SOURCE["priorities"])

DEFAULT_PRIORITY: str = _SOURCE["default"]


def is_priority(value: str, priorities: tuple[str, ...] = PRIORITIES) -> bool:
    """Whether `value` is a declared priority. Exact match, deliberately: the
    API's enum is exact too, so a concierge action the wizard would have accepted
    case-insensitively must not sneak past this one and then 400 at the server.

    `priorities` is a parameter with a default so a fixture can drive it with a
    fabricated vocabulary — the same convention field_by_name uses."""
    return value in priorities


def options_line(priorities: tuple[str, ...]) -> str:
    """The numbered option list the WhatsApp wizard offers, e.g. "1) A 2) B".

    DERIVED, never hand-typed — this is success metric 2 from the farm side.
    farm/wizard.py spells this list out in two places (the question and the
    retry line) and parses the numbers back in a third, so the numbering and the
    vocabulary have to come from one expression or they drift. 1-based, because a
    human is typing the reply."""
    return " ".join(f"{i + 1}) {value}" for i, value in enumerate(priorities))


def by_number(priorities: tuple[str, ...]) -> dict[str, str]:
    """{"1": <first>, "2": <second>, ...} — the inverse of options_line(), for
    parsing the wizard's numeric reply. Keys are strings because the reply
    arrives as text."""
    return {str(i + 1): value for i, value in enumerate(priorities)}
