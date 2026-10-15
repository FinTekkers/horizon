"""The Python binding for a Plan's draft review (HZ-463).

The `Review drafts: coverage & overlap` step's reply carries a `plan_review`
object: each Inventory gap mapped to the draft (#n) that covers it, or to
null with an out-of-scope reason, and the drafts the agent says duplicate an
existing item. farm/step_agent.py validates it inside the reply's retry
envelope, so a malformed one takes the one retry and then fails the step.
The server checks it again through domain/js/planReview.js and decides every
finding itself.

The contract is domain/planReview.schema.json, read here at import and walked
by _check(), so no field is restated. The rule the schema's subset cannot
express — a gap's draft is null exactly when it gives a reason — lives in
validate().
"""

import json
import re
from pathlib import Path

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "planReview.schema.json"
_SCHEMA: dict = json.loads(_SCHEMA_PATH.read_text())

_TYPES = {"object": dict, "array": list, "string": str, "null": type(None)}


def _check(schema: dict, value: object, at: str) -> None:
    """Raises ValueError naming the first path that breaks `schema`. Only the
    keywords planReview.schema.json uses."""
    kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
    if not any(isinstance(value, _TYPES[kind]) for kind in kinds):
        raise ValueError(f"{at} must be {' or '.join(kinds)}")
    if isinstance(value, str):
        if len(value.strip()) < schema.get("minLength", 0):
            raise ValueError(f"{at} must not be blank")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise ValueError(f"{at} {json.dumps(value)} is not in the expected form")
    if isinstance(value, list):
        for i, entry in enumerate(value):
            _check(schema["items"], entry, f"{at}[{i}]")
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


def validate(block: object) -> dict:
    """The block itself when it satisfies the contract. Raises ValueError
    naming what is wrong."""
    _check(_SCHEMA, block, "plan_review")
    for i, entry in enumerate(block["coverage"]):
        if (entry["draft"] is None) != ("out_of_scope_reason" in entry):
            raise ValueError(
                f"plan_review.coverage[{i}] must name a draft, or be null with an out_of_scope_reason — never both, never neither"
            )
    return block
