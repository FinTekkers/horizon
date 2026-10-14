"""The Python binding for a Plan's Inventory block (HZ-447).

The Inventory step's reply carries a machine-readable `inventory` object:
(a) one current-state row per repo in the Plan's scope — what it has now,
its gaps, and the evidence for both — and (b) key facts that cut across the
repos. farm/step_agent.py validates it before the step may finish and
appends it to the artifact as a fenced block; the Design step's reply is
then held to it with check_citations().

The contract is domain/planInventory.schema.json, read here at import and
walked by _check(), so no field or enum is restated. The rule the schema's
subset cannot express — exactly one row per in-scope repo — lives in
validate().
"""

import json
import re
from pathlib import Path

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "planInventory.schema.json"
_SCHEMA: dict = json.loads(_SCHEMA_PATH.read_text())

FENCE_INFO = "json plan-inventory"
_FENCED = re.compile(r"```json plan-inventory\n(.*?)\n```", re.DOTALL)
_TYPES = {"object": dict, "array": list, "string": str}


def _check(schema: dict, value: object, at: str) -> None:
    """Raises ValueError naming the first path that breaks `schema` — never
    the value it holds. Only the keywords planInventory.schema.json uses."""
    if "$ref" in schema:
        schema = _SCHEMA["definitions"][schema["$ref"].rsplit("/", 1)[-1]]
    expected = _TYPES.get(schema.get("type"))
    if expected and not isinstance(value, expected):
        raise ValueError(f"{at} must be a {schema['type']}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{at} must be one of {schema['enum']}")
    if isinstance(value, str) and len(value.strip()) < schema.get("minLength", 0):
        raise ValueError(f"{at} must not be empty")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise ValueError(f"{at} needs at least {schema['minItems']} entry")
        for i, entry in enumerate(value):
            _check(schema.get("items", {}), entry, f"{at}[{i}]")
    if isinstance(value, dict):
        for field in schema.get("required", []):
            if field not in value:
                raise ValueError(f"{at} is missing '{field}'")
        properties = schema.get("properties", {})
        unknown = sorted(set(value) - set(properties))
        if unknown and schema.get("additionalProperties") is False:
            raise ValueError(f"{at} has unknown field(s): {unknown}")
        for field, sub in properties.items():
            if field in value:
                _check(sub, value[field], f"{at}.{field}")


def validate(block: object, scope: list[str]) -> dict:
    """The block itself when it satisfies the schema and has exactly one row
    per repo in `scope`. Raises ValueError naming what is wrong."""
    _check(_SCHEMA, block, "inventory")
    rows = [row["repo"] for row in block["repos"]]
    # Never names the outside repo: its name must not reach the stored error.
    if set(rows) - set(scope):
        raise ValueError("inventory has a row for a repo outside the Plan's scope")
    missing = sorted(set(scope) - set(rows))
    if missing:
        raise ValueError(f"inventory has no row for {missing}")
    duplicated = sorted({repo for repo in rows if rows.count(repo) > 1})
    if duplicated:
        raise ValueError(f"inventory has more than one row for {duplicated}")
    return block


def check_citations(design: object, inventory: dict) -> list[str]:
    """Each repo the design's recommendation changes that cites no evidence
    `ref` from that repo's Inventory row, sorted. Raises ValueError when the
    design is not {"changes": [{"repo": str, "cites": [str]}]}."""
    changes = design.get("changes") if isinstance(design, dict) else None
    if not isinstance(changes, list) or not changes:
        raise ValueError("design must list the repos it changes in 'changes'")
    refs = {row["repo"]: {e["ref"] for e in row["evidence"]} for row in inventory["repos"]}
    uncited = set()
    for i, change in enumerate(changes):
        if not isinstance(change, dict) or not isinstance(change.get("repo"), str):
            raise ValueError(f"design.changes[{i}] must name its 'repo'")
        cites = change.get("cites")
        if not isinstance(cites, list) or not set(c for c in cites if isinstance(c, str)) & refs.get(change["repo"], set()):
            uncited.add(change["repo"])
    return sorted(uncited)


def render(block: dict) -> str:
    """The block as the fenced section appended to the Inventory artifact."""
    return f"```{FENCE_INFO}\n{json.dumps(block, indent=2)}\n```"


def extract(artifact_md: str, scope: list[str]) -> dict:
    """The validated block from an Inventory artifact. Raises ValueError if
    the artifact carries none, or one that is not valid JSON or fails
    validate()."""
    found = _FENCED.findall(artifact_md or "")
    if not found:
        raise ValueError("the artifact carries no plan-inventory block")
    try:
        block = json.loads(found[-1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"the plan-inventory block is not valid JSON ({exc.msg})") from None
    return validate(block, scope)
