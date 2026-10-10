"""The Python binding for a Task's Run plan block (HZ-383).

The Run plan step's reply carries a machine-readable `run_plan` object —
where the run happens (`cwd`), what it runs, in order (`commands`), how long
it may take (`budget_minutes`) and which environment variables it needs
(`env`). farm/step_agent.py validates it before the step may finish and
appends it to the artifact as a fenced block; HZ-378's Execute reads it back
with extract(). There is no JS binding: only the farm reads the block.

The contract is domain/runPlan.schema.json, read here at import so the
required fields and the field list are never restated. One rule the schema's
Draft-07 subset cannot express lives here instead: every `env` value names a
variable (`$GITHUB_TOKEN`), never a literal value.

literal_secrets() is the guard for the rest of the reply: it returns the
NAMES of the secret shapes it finds, never the matched text, so a caller can
log or report a hit without leaking the secret it found.
"""

import json
import re
from pathlib import Path

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "runPlan.schema.json"
_SCHEMA: dict = json.loads(_SCHEMA_PATH.read_text())
REQUIRED: tuple[str, ...] = tuple(_SCHEMA["required"])
FIELDS: tuple[str, ...] = tuple(_SCHEMA["properties"])

ENV_REFERENCE = re.compile(r"^\$[A-Z_][A-Z0-9_]*$")
FENCE_INFO = "json run-plan"
_FENCED = re.compile(r"```json run-plan\n(.*?)\n```", re.DOTALL)

# Each a shape a live credential takes, long enough that ordinary prose
# ("sk-learn", "the API key") does not match.
SECRET_PATTERNS: dict[str, re.Pattern] = {
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "aws-access-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "private-key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "slack-token": re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}"),
    "api-key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    # NAME=value or "NAME": "value" where NAME ends in a secret word and the
    # value is not itself a reference ($NAME, ${NAME}, <placeholder>).
    "secret-assignment": re.compile(
        r"\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[\"']?\s*[=:]\s*[\"']?(?![$<{])[^\s\"'`,;]{8,}"
    ),
}


def literal_secrets(text: str) -> list[str]:
    """The names of every secret shape found in `text`, in a fixed order —
    never the matched text itself."""
    if not isinstance(text, str):
        return []
    return [name for name, pattern in SECRET_PATTERNS.items() if pattern.search(text)]


def validate(block: object) -> dict:
    """The block itself when it satisfies the contract. Raises ValueError
    naming the first field that does not — never the value it holds."""
    if not isinstance(block, dict):
        raise ValueError("run_plan must be a JSON object")
    for field in REQUIRED:
        if field not in block:
            raise ValueError(f"run_plan is missing '{field}'")
    unknown = sorted(set(block) - set(FIELDS))
    if unknown:
        raise ValueError(f"run_plan has unknown field(s): {unknown}")
    cwd = block["cwd"]
    if not isinstance(cwd, str) or not cwd.strip():
        raise ValueError("run_plan 'cwd' must be a non-empty string")
    commands = block["commands"]
    if not isinstance(commands, list) or not commands:
        raise ValueError("run_plan 'commands' must be a non-empty list")
    for i, command in enumerate(commands):
        if not isinstance(command, str) or not command.strip():
            raise ValueError(f"run_plan 'commands'[{i}] must be a non-empty string")
    budget = block["budget_minutes"]
    # bool is an int subclass in Python; `"budget_minutes": true` must not pass.
    if not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
        raise ValueError("run_plan 'budget_minutes' must be a whole number of minutes, at least 1")
    env = block.get("env", {})
    if not isinstance(env, dict):
        raise ValueError("run_plan 'env' must be an object")
    for name, value in env.items():
        if not isinstance(value, str) or not ENV_REFERENCE.match(value):
            raise ValueError(f"run_plan 'env'.{name} must name a variable like $NAME, never a literal value")
    return block


def render(block: dict) -> str:
    """The block as the fenced section appended to the Run plan artifact."""
    return f"```{FENCE_INFO}\n{json.dumps(block, indent=2)}\n```"


def extract(artifact_md: str) -> dict:
    """The validated block from a Run plan artifact. Raises ValueError if the
    artifact carries none, or one that is not valid JSON or fails validate()."""
    found = _FENCED.findall(artifact_md or "")
    if not found:
        raise ValueError("the artifact carries no run-plan block")
    try:
        block = json.loads(found[-1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"the run-plan block is not valid JSON ({exc.msg})") from None
    return validate(block)
