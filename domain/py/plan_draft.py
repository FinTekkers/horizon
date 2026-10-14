"""The Python binding for a Plan's item drafts (HZ-448).

The Draft items step's reply carries a `plan_draft` object: the items the
Plan would file, each named by a plan-local id (#1, #2, …), plus shared
guardrails and open questions. farm/step_agent.py validates it inside the
reply's retry envelope, so a malformed draft takes the one retry and then
fails the step. The server re-checks the same document through
domain/js/planDraft.js on ingest and on every owner edit.

The contract is domain/planDraft.schema.json, interpreted here directly so a
shape rule is never restated. The work-item field limits it uses come from
domain/fields.json, added at load the same way the JS binding adds them. The rules a schema cannot express live here,
in the same order as the JS binding, so both report the same first error:
no blank text, unique ids, every `#n` dependency names a draft in the set,
and the dependencies form a DAG. Whether a real key or repo exists is the
server's to check (unknown_key, unknown_repo): the farm has no database.
"""

import json
import re
from pathlib import Path

from . import fields as _fields

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "planDraft.schema.json"


def _with_field_limits(schema: dict) -> dict:
    item = schema["properties"]["items"]["items"]["properties"]
    for name in ("title", "outcome", "repo"):
        field = _fields.field_by_name(_fields.FIELDS, name)
        item[name].update({k: field[k] for k in ("minLength", "maxLength") if k in field})
    for name in ("metric", "guardrails"):
        item[name]["maxItems"] = _fields.field_by_name(_fields.FIELDS, name)["maxLines"]
    return schema


SCHEMA: dict = _with_field_limits(json.loads(_SCHEMA_PATH.read_text()))

LOCAL_ID = re.compile(r"^#[1-9][0-9]*$")


class PlanDraftError(ValueError):
    """The first rule the draft breaks: a code from the shared vocabulary
    (invalid_shape, duplicate_id, self_dep, unknown_dep, cycle), the path of
    the offending field, and a one-line message that names it."""

    def __init__(self, code: str, path: str, detail: str):
        self.code = code
        self.path = path
        self.message = f"{code}: {detail}"
        super().__init__(f"{self.message} (at {path})")


def _at(parent: str, key) -> str:
    if isinstance(key, int):
        return f"{parent}[{key}]"
    return f"{parent}.{key}" if parent else key


def _shape(schema: dict, value, path: str) -> tuple[str, str] | None:
    """The first way `value` breaks `schema`, as (path, detail), or None."""
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return path, "must be an object"
        props = schema.get("properties", {})
        for field in schema.get("required", []):
            if field not in value:
                return _at(path, field), "is missing"
        unknown = sorted(set(value) - set(props))
        if schema.get("additionalProperties") is False and unknown:
            return path, f"has unknown field(s): {', '.join(unknown)}"
        for field, sub in props.items():
            if field in value:
                found = _shape(sub, value[field], _at(path, field))
                if found:
                    return found
    elif kind == "array":
        if not isinstance(value, list):
            return path, "must be a list"
        if len(value) < schema.get("minItems", 0):
            return path, f"must have at least {schema['minItems']} entries"
        if len(value) > schema.get("maxItems", len(value)):
            return path, f"must have at most {schema['maxItems']} entries"
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            return path, "has a duplicate entry"
        for i, entry in enumerate(value):
            found = _shape(schema["items"], entry, _at(path, i))
            if found:
                return found
    elif kind == "string":
        if not isinstance(value, str):
            return path, "must be a string"
        if not value.strip():
            return path, "must not be blank"
        if len(value) < schema.get("minLength", 0):
            return path, f"must be at least {schema['minLength']} characters"
        if len(value) > schema.get("maxLength", len(value)):
            return path, f"must be at most {schema['maxLength']} characters"
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            return path, f"{json.dumps(value)} is not in the expected form"
    return None


def _graph(items: list[dict]) -> tuple[str, str, str] | None:
    """The first dependency problem, as (code, path, detail), or None."""
    index: dict[str, int] = {}
    for i, item in enumerate(items):
        if item["id"] in index:
            return "duplicate_id", f"items[{i}].id", f"{item['id']} is used by more than one draft"
        index[item["id"]] = i
    for i, item in enumerate(items):
        for j, dep in enumerate(item["depends_on"]):
            if dep == item["id"]:
                return "self_dep", f"items[{i}].depends_on[{j}]", f"{dep} depends on itself"
            if LOCAL_ID.match(dep) and dep not in index:
                return "unknown_dep", f"items[{i}].depends_on[{j}]", f"{item['id']} depends on {dep}, which is not a draft in this plan"
    # Depth-first in draft order, each draft's dependencies in listed order —
    # the same walk as the JS binding, so both name the same cycle.
    state: dict[str, str] = {}

    def visit(node: str, stack: list[str]):
        state[node] = "open"
        stack.append(node)
        for j, dep in enumerate(items[index[node]]["depends_on"]):
            if not LOCAL_ID.match(dep):
                continue
            if state.get(dep) == "open":
                loop = stack[stack.index(dep) :] + [dep]
                return "cycle", f"items[{index[node]}].depends_on[{j}]", " → ".join(loop)
            if dep not in state:
                found = visit(dep, stack)
                if found:
                    return found
        stack.pop()
        state[node] = "done"
        return None

    for item in items:
        if item["id"] not in state:
            found = visit(item["id"], [])
            if found:
                return found
    return None


def validate(doc: object) -> dict:
    """The draft itself when it satisfies the contract. Raises PlanDraftError
    (a ValueError) naming the first rule it breaks."""
    found = _shape(SCHEMA, doc, "")
    if found:
        path, detail = found
        raise PlanDraftError("invalid_shape", path or "plan_draft", f"{path or 'plan_draft'} {detail}")
    problem = _graph(doc["items"])
    if problem:
        raise PlanDraftError(*problem)
    return doc
