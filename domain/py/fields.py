"""The farm's one view of "how long may a work-item field be" (HZ-134).

This module READS domain/fields.json — the only place a field's limit is
declared — at import, so the farm never hand-types a cap the API then has to
agree with. farm/pm_agent.py builds PATCH_FIELDS from patch_limits() and
farm/tools/measure_text_caps.py reads the same numbers for its report; the
server derives its POST /api/items body schema from domain/js/fields.js.

Before HZ-134 the same three fields (outcome/desc, metric, guardrails) carried
two different limits: what the API accepted at intake, and a much lower cap the
PM revision path applied, so a PM revision could not write a value a human could
type into the create form. HZ-114 made those cuts marked rather than silent; this
module is what makes them unnecessary. The PM caps are now the API's, by
construction. The superseded numbers are recorded in
server/test/domain-one-field-declaration.test.mjs, which asserts they are gone —
naming them here would put them back in a file whose whole job is to hold one
copy of each.

Unlike domain/py/steps.py there is NO farm-shaped projection here: the limit the
API enforces and the limit a PM revision is held to are the same number, which
is the whole point of the file. Both bindings therefore expose the authored
table verbatim, and server/test/domain-fields-parity.test.mjs diffs them.

`name` is the field's name on the API; `column` is its work_item column, which
is also the key a PM patch uses. They differ for exactly one field
(outcome/desc), and that mapping lives here rather than being reimplemented by
each side.

_SOURCE_PATH is derived from __file__, never from the process's cwd: farm agents
run inside workspace clones, not from the repo root
(farm/tests/test_domain_import.py asserts that).

patch_limits() takes `fields` as its first argument rather than reading the
module-level FIELDS global internally — that's what lets a test fabricate a field
table and assert the derivation follows it, with zero literal limits in the test
itself. The same convention domain/py/steps.py's budget_for_label uses.
"""

import json
import re
from pathlib import Path

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "fields.json"


def _validate_source(data: object, source: str) -> dict:
    """Shape, flag, uniqueness and minLength-below-maxLength enforcement, applied
    at import time AND to anything _load_source reads off disk. Raises rather
    than returning a partly-usable table: a duplicate name would make
    field_by_name resolve to whichever entry came first, a duplicate column would
    make patch_limits() silently drop one field's limit, a minLength at or above
    maxLength would make the API reject every possible value, and a table with
    nothing agent-revisable would build an empty PATCH_FIELDS that silently
    discarded every PM revision.

    The rules and the message fragments are kept word-for-word in step with
    domain/js/fields.js's assertFieldsShape — domain/fixtures/fields-cases.json
    drives both, so the two cannot drift apart silently."""
    if not isinstance(data, dict):
        raise RuntimeError(f"domain/py/fields.py: {source} must be a JSON object with a fields array")
    fields = data.get("fields")
    if not isinstance(fields, list) or not fields:
        raise RuntimeError(
            f"domain/py/fields.py: {source}: fields must be a non-empty JSON array of field objects"
        )
    for i, field in enumerate(fields):
        if not isinstance(field, dict):
            raise RuntimeError(f"domain/py/fields.py: {source}: fields[{i}] must be a field object")
        name = field.get("name")
        if not isinstance(name, str) or not name:
            raise RuntimeError(f"domain/py/fields.py: {source}: fields[{i}] has no name")
        if not isinstance(field.get("column"), str) or not field["column"]:
            raise RuntimeError(f'domain/py/fields.py: {source}: fields[{i}] ("{name}") has no column')
        max_length = field.get("maxLength")
        # bool is an int subclass in Python; a `"maxLength": true` must not pass.
        if not isinstance(max_length, int) or isinstance(max_length, bool) or max_length < 1:
            raise RuntimeError(
                f'domain/py/fields.py: {source}: fields[{i}] ("{name}") declares a '
                "non-integer or non-positive maxLength"
            )
        min_length = field.get("minLength")
        if min_length is not None and (
            not isinstance(min_length, int) or isinstance(min_length, bool) or min_length < 1
        ):
            raise RuntimeError(
                f'domain/py/fields.py: {source}: fields[{i}] ("{name}") declares a '
                "non-integer or non-positive minLength"
            )
        max_lines = field.get("maxLines")
        if max_lines is not None and (
            not isinstance(max_lines, int) or isinstance(max_lines, bool) or max_lines < 1
        ):
            raise RuntimeError(
                f'domain/py/fields.py: {source}: fields[{i}] ("{name}") declares a '
                "non-integer or non-positive maxLines"
            )
        for flag in ("settableAtIntake", "agentRevisable"):
            if not isinstance(field.get(flag), bool):
                raise RuntimeError(
                    f'domain/py/fields.py: {source}: fields[{i}] ("{name}") declares a '
                    f"non-boolean {flag} — a truthy value is not a flag"
                )
        if min_length is not None and min_length >= max_length:
            raise RuntimeError(
                f'domain/py/fields.py: {source}: fields[{i}] ("{name}") declares minLength '
                f"{min_length} at or above maxLength {max_length} — no value could satisfy it"
            )

    names = [field["name"] for field in fields]
    dupe_names = {name for name in names if names.count(name) > 1}
    if dupe_names:
        raise RuntimeError(
            f"domain/py/fields.py: {source} has duplicate field name(s): {sorted(dupe_names)}"
        )
    columns = [field["column"] for field in fields]
    dupe_columns = {column for column in columns if columns.count(column) > 1}
    if dupe_columns:
        raise RuntimeError(f"domain/py/fields.py: {source} has duplicate column(s): {sorted(dupe_columns)}")
    if not any(field["settableAtIntake"] for field in fields):
        raise RuntimeError(
            f"domain/py/fields.py: {source}: no field is settableAtIntake "
            "— POST /api/items would accept nothing"
        )
    if not any(field["agentRevisable"] for field in fields):
        raise RuntimeError(
            f"domain/py/fields.py: {source}: no field is agentRevisable "
            "— every PM revision would be discarded"
        )
    return data


def _load_source(path: Path) -> dict:
    """Reads the authored field document off disk and validates it. This is how
    the production table below is built — not a test-only helper."""
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/fields.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/fields.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


_SOURCE: dict = _load_source(_SOURCE_PATH)

FIELDS: list[dict] = _SOURCE["fields"]

# Keyed both ways, because both keys are real: callers that speak the API's
# vocabulary look a field up by `name`, callers that speak the database's
# (farm/tools/measure_text_caps.py) look it up by `column`.
BY_NAME: dict[str, dict] = {field["name"]: field for field in FIELDS}
BY_COLUMN: dict[str, dict] = {field["column"]: field for field in FIELDS}


def field_by_name(fields: list[dict], name: str) -> dict:
    """The one field entry with this name. Raises KeyError naming the field
    (never returns a blank/absent limit, which a caller would read as "no cap")
    if it isn't in the table — e.g. it was renamed on one side of the JS/Python
    boundary but not the other."""
    for field in fields:
        if field["name"] == name:
            return field
    raise KeyError(f"no work-item field named {name!r} in the field table")


def patch_limits(fields: list[dict]) -> dict[str, int]:
    """{column: maxLength} for every agent-revisable field, in authored order.

    DERIVED, never hand-typed — this is success criterion 3. farm/pm_agent.py's
    PATCH_FIELDS *is* this dict, so the order matters: validate() iterates it,
    and server/src/orchestrator.js's FARM_PATCH_FIELDS is the same key list on
    the other side of the wire. Keyed by column because that is what a patch
    payload and the work_item UPDATE both use."""
    return {field["column"]: field["maxLength"] for field in fields if field["agentRevisable"]}


def line_limits(fields: list[dict]) -> dict[str, int]:
    """{column: maxLines} for every field that declares a line budget (HZ-345):
    metric and guardrails. The same derivation as domain/js/fields.js's
    lineLimits(); farm/pm_agent.py rejects a step-1/2 reply over it."""
    return {field["column"]: field["maxLines"] for field in fields if "maxLines" in field}


# ---- criteria lines (HZ-345) ----
# The same rule as domain/js/fields.js's criteriaLines(), driven from both sides
# by domain/fixtures/fields-cases.json.
_LIST_MARKER = re.compile(r"^(?:[-*+]|\d+[.)])\s+")
_DEFERRED_PREFIX = "deferred to a follow-up item"


def _normalise_line(line: str) -> str:
    return " ".join(_LIST_MARKER.sub("", line.strip(), count=1).split())


def _is_deferred_line(normalised: str) -> bool:
    return normalised.lstrip("*_").lower().startswith(_DEFERRED_PREFIX)


def criteria_lines(text) -> list[str]:
    """The lines a metric or guardrails budget counts, normalised: trimmed, list
    marker stripped, whitespace collapsed. When any line is a list item only
    list items count; otherwise every non-blank line does. The split-scope
    "Deferred to a follow-up item" line never counts."""
    lines = [line.strip() for line in str(text or "").split("\n") if line.strip()]
    listed = any(_LIST_MARKER.match(line) for line in lines)
    normalised = [_normalise_line(line) for line in lines if not listed or _LIST_MARKER.match(line)]
    return [line for line in normalised if line and not _is_deferred_line(line)]


def count_criteria_lines(text) -> int:
    return len(criteria_lines(text))
