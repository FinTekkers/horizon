"""The Python binding for a Task's Run plan block (HZ-383).

The Run plan step's reply carries a machine-readable `run_plan` object —
where the run happens (`cwd`), what it runs, in order (`commands`), how long
it may take (`budget_minutes`) and which environment variables it needs
(`env`). farm/step_agent.py validates it before the step may finish and
appends it to the artifact as a fenced block; HZ-378's Execute reads it back
with extract(). The server reads the same block through
domain/js/runPlan.js (HZ-384) to show it on the Approve the run gate.

The contract is domain/runPlan.schema.json, read here at import so the
required fields and the field list are never restated. One rule the schema's
Draft-07 subset cannot express lives here instead: every `env` value names a
variable (`$GITHUB_TOKEN`), never a literal value.

literal_secrets() is the guard for the rest of the reply: it returns the
NAMES of the secret shapes it finds, never the matched text, so a caller can
log or report a hit without leaking the secret it found.
"""

import json
import os
import re
from pathlib import Path, PurePosixPath

from domain.py import fields

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
    _check_relative(cwd, ValueError)
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
    # HZ-416: optional; absent leaves it to the server (HZ-491). Unknown values fail here,
    # never at Execute, so a bad plan is refused before anything runs.
    if "runner" in block and block["runner"] not in RUNNER_VALUES:
        raise ValueError("run_plan 'runner' must be 'container' or 'host'")
    # HZ-434: shape only; Execute's realpath check owns where a report may be.
    reports = block.get("reports", [])
    if not isinstance(reports, list):
        raise ValueError(REPORTS_SHAPE)
    for path in reports:
        if not isinstance(path, str) or not path.strip():
            raise ValueError(REPORTS_SHAPE)
        if ".." in PurePosixPath(path).parts:
            raise ValueError(REPORTS_PARENT)
    _check_requires(block.get("requires", []))
    _check_proof(block.get("proof", []), len(commands), reports)
    return block


REPORTS_SHAPE = "run_plan 'reports' must be a list of non-empty file paths"
REPORTS_PARENT = "run_plan 'reports' paths must not contain '..'"

# HZ-502: what the commands need on the runner, checked there before Impact
# review (farm/run_plan_requires.py). A tool name never starts with `-`, so
# it can never read as an option; a path never holds a control character, so
# it reaches the check as exactly the path the plan named.
TOOL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
REQUIRES_SHAPE = "run_plan 'requires' must be a list of {\"tool\": ...} or {\"path\": ...} objects, one key each"
REQUIRES_TOOL = "run_plan 'requires' tool names must be letters, digits and . _ + -, not starting with -"
REQUIRES_PATH = "run_plan 'requires' paths must be relative to the repo root, with no '..' and no control characters"


def _check_requires(requires: object) -> None:
    if not isinstance(requires, list):
        raise ValueError(REQUIRES_SHAPE)
    for entry in requires:
        if not isinstance(entry, dict) or len(entry) != 1:
            raise ValueError(REQUIRES_SHAPE)
        ((key, value),) = entry.items()
        if key not in ("tool", "path") or not isinstance(value, str) or not value:
            raise ValueError(REQUIRES_SHAPE)
        if key == "tool" and not TOOL_NAME.fullmatch(value):
            raise ValueError(REQUIRES_TOOL)
        if key == "path" and (
            os.path.isabs(value) or ".." in PurePosixPath(value).parts or _CONTROL.search(value) or not value.strip()
        ):
            raise ValueError(REQUIRES_PATH)

# HZ-503: what proves each metric line. validate() checks the shape only, so
# a plan approved before HZ-503 (no `proof`) still passes extract() at
# Execute; unproven() checks coverage, and only when a Run plan reply is
# written (farm/step_agent.py).
PROOF_SHAPE = "run_plan 'proof' must be a list of {\"line\": <n>, \"command\": <n>} or {\"line\": <n>, \"report\": \"<path>#<field>\"} objects"
PROOF_SOURCE = "run_plan 'proof' entries must name exactly one of 'command' or 'report'"
PROOF_COMMAND_RANGE = "run_plan 'proof' command must be a 1-based index into 'commands'"
PROOF_REPORT = "run_plan 'proof' report must be '<path>#<field>', both non-empty, with the path listed in 'reports'"


def _whole(value: object) -> bool:
    # bool is an int subclass in Python; `"line": true` must not pass.
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _check_proof(proof: object, command_count: int, reports: list) -> None:
    if not isinstance(proof, list):
        raise ValueError(PROOF_SHAPE)
    for entry in proof:
        if not isinstance(entry, dict) or not _whole(entry.get("line")) or set(entry) - {"line", "command", "report"}:
            raise ValueError(PROOF_SHAPE)
        if ("command" in entry) == ("report" in entry):
            raise ValueError(PROOF_SOURCE)
        if "command" in entry and not (_whole(entry["command"]) and entry["command"] <= command_count):
            raise ValueError(PROOF_COMMAND_RANGE)
        if "report" in entry:
            report = entry["report"]
            path, _, field = report.partition("#") if isinstance(report, str) else ("", "", "")
            if not path.strip() or not field.strip() or path not in reports:
                raise ValueError(PROOF_REPORT)


def _numbers(lines: list[int]) -> str:
    return ("line " if len(lines) == 1 else "lines ") + ", ".join(map(str, lines))


def unproven(block: dict, metric: str | None) -> str | None:
    """HZ-503: why a validated block's `proof` does not cover the metric —
    one entry per metric line, numbered as fields.criteria_lines() numbers
    them — or None when it does. Names every missing, doubled and
    out-of-range line number."""
    total = len(fields.criteria_lines(metric))
    named = [entry["line"] for entry in block.get("proof", [])]
    missing = [n for n in range(1, total + 1) if n not in named]
    doubled = sorted({n for n in named if named.count(n) > 1})
    beyond = sorted({n for n in named if n > total})
    gaps = []
    if missing:
        gaps.append(f"proof has no entry for metric {_numbers(missing)}")
    if doubled:
        gaps.append(f"proof names metric {_numbers(doubled)} more than once")
    if beyond:
        gaps.append(f"proof names metric {_numbers(beyond)}, but the metric has {total} line{'' if total == 1 else 's'}")
    return "; ".join(gaps) or None


# HZ-416: where Execute runs the plan. Absent means the container; only an
# explicit `host` runs on the host.
RUNNER_VALUES = ("container", "host")


CWD_ABSOLUTE = "run_plan 'cwd' must be relative to the repo root, not an absolute path"
CWD_PARENT = "run_plan 'cwd' must not contain '..'"


class CwdRefused(ValueError):
    """Execute must not start: the plan's cwd does not resolve to a directory
    inside the Task repo's checkout. The message is one line, safe to show."""


def _check_relative(cwd: str, error: type) -> None:
    # HZ-415: `cwd` names a directory inside the repo root, never outside it.
    if os.path.isabs(cwd):
        raise error(CWD_ABSOLUTE)
    if ".." in PurePosixPath(cwd).parts:
        raise error(CWD_PARENT)


def _inside(path: str, root: str) -> bool:
    return os.path.commonpath([path, root]) == root


def resolve_cwd(repo_dir: str | None, cwd: str, *, forbid: str | None = None) -> str:
    """HZ-415: the real absolute directory Execute's commands run in — the
    plan's `cwd` resolved inside the Task repo's deploy-target `repo_dir`.
    Fails closed: raises CwdRefused (one line) on any problem, including an
    error from the check itself, and never returns a fallback path. `forbid`
    is Horizon's own checkout: a directory inside it, or one that contains
    it, is refused too."""
    try:
        if not isinstance(repo_dir, str) or not repo_dir or not os.path.isabs(repo_dir):
            raise CwdRefused("this repo has no deploy target directory")
        real_repo = os.path.realpath(repo_dir)
        if not os.path.isdir(real_repo) or not os.access(real_repo, os.R_OK | os.X_OK):
            raise CwdRefused("the repo directory is missing or unreadable")
        if not isinstance(cwd, str) or not cwd.strip():
            raise CwdRefused("run_plan 'cwd' must be a non-empty string")
        _check_relative(cwd, CwdRefused)
        target = os.path.realpath(os.path.join(real_repo, cwd))
        if not _inside(target, real_repo):
            raise CwdRefused("cwd resolves outside the repo directory")
        if not os.path.isdir(target):
            raise CwdRefused("cwd is not a directory in the repo")
        if forbid:
            real_forbid = os.path.realpath(forbid)
            if _inside(target, real_forbid) or _inside(real_forbid, real_repo):
                raise CwdRefused("cwd is inside Horizon's own checkout")
        return target
    except CwdRefused:
        raise
    except (OSError, TypeError, ValueError) as exc:
        raise CwdRefused(f"the cwd check failed ({type(exc).__name__})") from None


DEFAULT_VENV = ".venv"


class VenvRefused(CwdRefused):
    """Execute must not start: the repo's virtualenv does not resolve inside
    the Task repo's checkout. A CwdRefused, so every HZ-415 refusal path
    (state, 400, forward) carries it unchanged. One line, safe to show."""


def resolve_venv(repo_dir: str, setting: str | None, *, forbid: str | None = None) -> str | None:
    """HZ-431: the real absolute virtualenv a Task's commands run with, or
    None for the system interpreter. Call only after resolve_cwd() passed.

    `setting` is the deploy target's venv_dir: empty or None means
    `<repo>/.venv` when it holds a bin/python, otherwise system. The venv
    directory's realpath — never bin/python's, which a real venv symlinks to
    /usr/bin — and its bin/'s realpath must both sit inside the repo and
    never inside (or around) `forbid`. Fails closed like resolve_cwd: a
    default .venv that resolves outside the repo is refused, not ignored."""
    try:
        real_repo = os.path.realpath(repo_dir)
        configured = isinstance(setting, str) and bool(setting.strip())
        candidate = os.path.join(real_repo, setting if configured else DEFAULT_VENV)
        if not configured and not os.path.lexists(candidate):
            return None
        venv = os.path.realpath(candidate)
        venv_bin = os.path.realpath(os.path.join(venv, "bin"))
        if forbid:
            real_forbid = os.path.realpath(forbid)
            if _inside(venv, real_forbid) or _inside(venv_bin, real_forbid) or _inside(real_forbid, real_repo):
                raise VenvRefused("venv is inside Horizon's own checkout")
        if not _inside(venv, real_repo) or not _inside(venv_bin, venv):
            raise VenvRefused("venv resolves outside the repo directory")
        python = os.path.join(venv_bin, "python")
        if not (os.path.isfile(python) and os.access(python, os.X_OK)):
            if configured:
                raise VenvRefused("venv has no bin/python")
            return None
        return venv
    except CwdRefused:
        raise
    except (OSError, TypeError, ValueError) as exc:
        raise VenvRefused(f"the venv check failed ({type(exc).__name__})") from None


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
