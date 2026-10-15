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

HZ-449 adds what filing needs, in the same order as the JS binding: each
draft's optional priority, kind and lane (enums added at load from
priorities.json and steps.json; a lane must be one of the kind's,
lane_kind_mismatch), every text `#n` names a draft (unknown_ref), each can be
filed after the drafts it names (ref_cycle), and the filed text fits the
work-item limits (over_limit).
"""

import json
import re
from pathlib import Path

from . import fields as _fields
from . import priorities as _priorities
from . import steps as _steps

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "planDraft.schema.json"


def _with_field_limits(schema: dict) -> dict:
    item = schema["properties"]["items"]["items"]["properties"]
    for name in ("title", "outcome", "repo"):
        field = _fields.field_by_name(_fields.FIELDS, name)
        item[name].update({k: field[k] for k in ("minLength", "maxLength") if k in field})
    for name in ("metric", "guardrails"):
        item[name]["maxItems"] = _fields.field_by_name(_fields.FIELDS, name)["maxLines"]
    return schema


def _with_enums(schema: dict) -> dict:
    item = schema["properties"]["items"]["items"]["properties"]
    item["priority"]["enum"] = list(_priorities.PRIORITIES)
    item["kind"]["enum"] = list(_steps.FARM_VIEWS)
    item["lane"]["enum"] = list(_steps.LANE_KINDS)
    return schema


SCHEMA: dict = _with_enums(_with_field_limits(json.loads(_SCHEMA_PATH.read_text())))

LOCAL_ID = re.compile(r"^#[1-9][0-9]*$")
# A plan-local id in free text: `#3`, never `owner/repo#3` or `a-#3`. ASCII,
# like the JS binding's \w and \b.
LOCAL_REF = re.compile(r"(?<![\w/.-])#([1-9][0-9]*)\b", re.ASCII)
# The room over_limit keeps for each `#n` (and the Plan's own key) to become a
# real key once filed — the JS binding's KEY_ROOM.
KEY_ROOM = 20


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
        if "enum" in schema and value not in schema["enum"]:
            return path, f"must be one of {', '.join(schema['enum'])}"
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


def local_refs_in(text: str) -> list[str]:
    """The plan-local ids `text` names, in order, each once."""
    return list(dict.fromkeys(f"#{m.group(1)}" for m in LOCAL_REF.finditer(text)))


def filed_text(item: dict, shared_guardrails: list[str], plan_key: str) -> dict:
    """The text one draft is filed with — the JS binding's filedText."""
    cover = item["must_also_cover"]
    cover_text = "\n\n**Must also cover**\n" + "\n".join(f"- {c}" for c in cover) if cover else ""
    return {
        "title": item["title"],
        "outcome": f"{item['outcome']}{cover_text}\n\nFiled by Plan {plan_key}.",
        "metric": "\n".join(f"{i + 1}. {m}" for i, m in enumerate(item["metric"])),
        "guardrails": "\n".join(f"- {g}" for g in [*item["guardrails"], *shared_guardrails]),
    }


def _filed_fields(item: dict, i: int):
    yield f"items[{i}].title", item["title"]
    yield f"items[{i}].outcome", item["outcome"]
    for name in ("metric", "guardrails", "must_also_cover"):
        for j, text in enumerate(item[name]):
            yield f"items[{i}].{name}[{j}]", text


def _filing_edges(items: list[dict]) -> list[list[tuple[str, str]]]:
    out = []
    for i, item in enumerate(items):
        edges: dict[str, str] = {}
        for j, dep in enumerate(item["depends_on"]):
            if LOCAL_ID.match(dep) and dep not in edges:
                edges[dep] = f"items[{i}].depends_on[{j}]"
        for path, text in _filed_fields(item, i):
            for ref in local_refs_in(text):
                edges.setdefault(ref, path)
        out.append(list(edges.items()))
    return out


def _references(doc: dict) -> tuple[str, str, str] | None:
    """The first problem with the drafts' text references, or None."""
    items = doc["items"]
    ids = {item["id"] for item in items}
    for i, item in enumerate(items):
        for path, text in _filed_fields(item, i):
            unknown = next((ref for ref in local_refs_in(text) if ref not in ids), None)
            if unknown:
                return "unknown_ref", path, f"{item['id']} names {unknown}, which is not a draft in this plan"
    for j, text in enumerate(doc["shared_guardrails"]):
        refs = local_refs_in(text)
        if refs and refs[0] not in ids:
            return "unknown_ref", f"shared_guardrails[{j}]", f"a shared guardrail names {refs[0]}, which is not a draft in this plan"
        if refs:
            return (
                "ref_cycle",
                f"shared_guardrails[{j}]",
                f"a shared guardrail names {refs[0]}, but every draft carries it — name {refs[0]} in a draft's own text",
            )
    edges = _filing_edges(items)
    index = {item["id"]: i for i, item in enumerate(items)}
    state: dict[str, str] = {}

    def visit(node: str, stack: list[str]):
        state[node] = "open"
        stack.append(node)
        for to, path in edges[index[node]]:
            if state.get(to) == "open":
                loop = stack[stack.index(to) :] + [to]
                return "ref_cycle", path, f"{' → '.join(loop)}: a draft's text may name only a draft filed before it"
            if to not in state:
                found = visit(to, stack)
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


def _over_limit(doc: dict) -> tuple[str, str, str] | None:
    """The first draft too long to file, or None."""
    cap = _fields.field_by_name(_fields.FIELDS, "guardrails")["maxLines"]
    shared = doc["shared_guardrails"]
    for i, item in enumerate(doc["items"]):
        count = len(item["guardrails"]) + len(shared)
        if count > cap:
            return "over_limit", f"items[{i}].guardrails", f"{item['id']} would carry {count} guardrails with the shared ones, over the {cap} limit"
        text = filed_text(item, shared, "X" * KEY_ROOM)
        for name in ("title", "outcome", "metric", "guardrails"):
            max_length = _fields.field_by_name(_fields.FIELDS, name)["maxLength"]
            length = len(text[name]) + KEY_ROOM * len(local_refs_in(text[name]))
            if length > max_length:
                return "over_limit", f"items[{i}].{name}", f"{item['id']}'s {name} would be {length} characters once filed, over the {max_length} limit"
    return None


def _lane_mismatch(items: list[dict]) -> tuple[str, str, str] | None:
    for i, item in enumerate(items):
        if "lane" in item and _steps.LANE_KINDS.get(item["lane"]) != item.get("kind", "change"):
            kind = item.get("kind", "change")
            return "lane_kind_mismatch", f"items[{i}].lane", f"{item['id']}'s lane {item['lane']} is not a lane of a {kind} item"
    return None


def validate(doc: object) -> dict:
    """The draft itself when it satisfies the contract. Raises PlanDraftError
    (a ValueError) naming the first rule it breaks."""
    found = _shape(SCHEMA, doc, "")
    if found:
        path, detail = found
        raise PlanDraftError("invalid_shape", path or "plan_draft", f"{path or 'plan_draft'} {detail}")
    problem = _graph(doc["items"]) or _lane_mismatch(doc["items"]) or _references(doc) or _over_limit(doc)
    if problem:
        raise PlanDraftError(*problem)
    return doc
