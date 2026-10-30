"""HZ-536: the git-only tool allow-list a project persona names tools from.

farm/tools/allowlist.json lists each tool a project persona may use: an id, the
venv it is installed in, and the commands under that venv's bin/. It changes
only through a reviewed PR — no server route, Admin page or farm code path
writes it, and this module only ever reads it. docs/tool-allowlist.md is the
how-to.

A project persona (farm/projects/<slug>/personas.json, HZ-535) names tool ids
in its optional `tools` array. farm/personas.py's load_project_personas checks
every id against the allow-list through validate_ids(), so an unknown id fails
the load and names the id and the persona.

When that persona composes into a step, apply() adds each tool's commands to
the step's fixed tool string and denies every write to the tool's venv. The
rules a tool can add are fixed by construction:

- `Bash(<VENV_ROOT>/<id>/bin/<cmd>:*)` per command, and `Read(/<VENV_ROOT>/<id>/**)`.
  The commands are bare names — lint() refuses `*`, `/` and anything else
  outside [A-Za-z0-9._-] — and the venv path is always VENV_ROOT/<id>.
- `Edit`, `Write` and `NotebookEdit` deny rules on that venv, through the
  HZ-447 disallowed_tools path. No allow rule that writes is ever added.

Path syntax: a Bash rule matches the command as typed, so it takes the plain
absolute path; a file rule's absolute path starts with `//` (a single `/` is
relative to the settings file), as in farm/plan_bundle.py's tool_rules. The
two are different on purpose.

Only a step whose base tool string already grants bare `Bash` gets persona
tools. A read-only step (PLANNER_TOOLS: no shell at all) keeps its string byte
for byte: `ruff --fix` or `black` would let it write the worktree, which would
widen what it may change.
"""

import json
import re
import sys
from pathlib import Path

ALLOWLIST_PATH = Path(__file__).parent / "tools" / "allowlist.json"

# Every tool venv lives at VENV_ROOT/<id>, root-owned and mode 0755 on the
# host (docs/tool-allowlist.md). lint() refuses any other path.
VENV_ROOT = "/opt/horizon-tools"

_DOC_KEYS = ("version", "tools")
_ENTRY_KEYS = ("id", "venv", "commands")
TOOL_ID_SHAPE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_COMMAND_SHAPE = re.compile(r"^[A-Za-z0-9._-]+$")

# A secret-like key or value anywhere in the document fails the lint: the
# allow-list is public, committed config and must never carry a credential.
SECRET_PATTERNS = [
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+|\bgithub_pat_")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{4,}")),
    ("API key", re.compile(r"\bsk-[A-Za-z0-9_-]+")),
    ("Slack token", re.compile(r"\bxox[baprs]-")),
    ("private key block", re.compile(r"-----BEGIN ")),
    ("credential assignment", re.compile(r"(?i)\b(?:api[_-]?key|key|token|secret|password|passwd)\s*[:=]")),
]


class AllowlistError(RuntimeError):
    """farm/tools/allowlist.json failed to read, parse or lint."""


class UnknownToolError(RuntimeError):
    """A persona names a tool id the allow-list does not declare."""


def _secret_hits(value) -> list[str]:
    """Labels of SECRET_PATTERNS found in any key or string value of `value`."""
    if isinstance(value, str):
        return [label for label, pattern in SECRET_PATTERNS if pattern.search(value)]
    if isinstance(value, dict):
        hits: list[str] = []
        for key, item in value.items():
            hits += _secret_hits(key) + _secret_hits(item)
        return hits
    if isinstance(value, list):
        return [hit for item in value for hit in _secret_hits(item)]
    return []


def lint(doc) -> list[str]:
    """Every problem with an allow-list document; empty means it passes."""
    errors: list[str] = []
    hits = _secret_hits(doc)
    if hits:
        errors.append(f"secret-like content ({', '.join(sorted(set(hits)))}) — the allow-list must carry no credential")
    if not isinstance(doc, dict):
        return errors + ["the allow-list must be a JSON object"]
    for key in doc:
        if key not in _DOC_KEYS:
            errors.append(f"unknown top-level key {key!r} — expected only {list(_DOC_KEYS)}")
    if doc.get("version") != 1:
        errors.append(f"version must be 1, got {doc.get('version')!r}")
    entries = doc.get("tools")
    if not isinstance(entries, list):
        return errors + ["tools must be an array"]
    seen: set[str] = set()
    for i, entry in enumerate(entries):
        at = f"tools[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{at} must be a JSON object")
            continue
        for key in entry:
            if key == "env":
                errors.append(f"{at} carries an env field — a tool may not set environment variables")
            elif key not in _ENTRY_KEYS:
                errors.append(f"{at} has unknown key {key!r} — expected only {list(_ENTRY_KEYS)}")
        tool_id = entry.get("id")
        if not isinstance(tool_id, str) or TOOL_ID_SHAPE.fullmatch(tool_id) is None:
            errors.append(f"{at}.id {tool_id!r} must match {TOOL_ID_SHAPE.pattern}")
            continue
        at = f"tools[{i}] ({tool_id})"
        if tool_id in seen:
            errors.append(f"{at} is declared more than once")
        seen.add(tool_id)
        if entry.get("venv") != f"{VENV_ROOT}/{tool_id}":
            errors.append(f"{at}.venv {entry.get('venv')!r} must be exactly {VENV_ROOT}/{tool_id}")
        commands = entry.get("commands")
        if not isinstance(commands, list) or not commands:
            errors.append(f"{at}.commands must be a non-empty array")
            continue
        for command in commands:
            if not isinstance(command, str) or _COMMAND_SHAPE.fullmatch(command) is None or command in (".", ".."):
                errors.append(
                    f"{at} command {command!r} must be a bare name matching {_COMMAND_SHAPE.pattern} "
                    "— no wildcard, path or argument"
                )
        if isinstance(commands, list) and len(set(map(str, commands))) != len(commands):
            errors.append(f"{at}.commands lists a command more than once")
    return errors


def load_allowlist(path: Path | None = None) -> dict[str, dict]:
    """The allow-list's entries keyed by id, in file order. Read fresh on every
    call — only a project whose personas name tools ever calls it, so a broken
    file never touches any other project. Raises AllowlistError naming the
    file and every lint error."""
    path = ALLOWLIST_PATH if path is None else path
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise AllowlistError(f"{path.name} could not be loaded ({exc})") from exc
    errors = lint(doc)
    if errors:
        raise AllowlistError(f"{path.name} failed the allow-list lint: " + "; ".join(errors))
    return {entry["id"]: entry for entry in doc["tools"]}


def validate_ids(persona_id: str, tool_ids, allowlist: dict[str, dict]) -> None:
    """Raises UnknownToolError on the first id `allowlist` does not declare,
    naming the id and the persona."""
    for tool_id in tool_ids:
        if not isinstance(tool_id, str) or tool_id not in allowlist:
            raise UnknownToolError(f"persona {persona_id!r} names unknown tool id {tool_id!r} — not in {ALLOWLIST_PATH.name}")


def merge(base: str, entries: list[dict]) -> tuple[str, str | None]:
    """(allowed, disallowed) for `entries` on top of the step's `base` string.
    Pure, and ordered by `entries`. No entries: (base, None) exactly."""
    if not entries:
        return base, None
    allow, deny = [base], []
    for entry in entries:
        venv = f"{VENV_ROOT}/{entry['id']}"
        allow += [f"Bash({venv}/bin/{command}:*)" for command in entry["commands"]]
        # `//` marks an absolute path in a file rule; see the module docstring.
        allow.append(f"Read(/{venv}/**)")
        deny += [f"{rule}(/{venv}/**)" for rule in ("Edit", "Write", "NotebookEdit")]
    return ",".join(allow), ",".join(deny)


def _ensure_installed(entries: list[dict]) -> None:
    """Fail the step before the agent starts when a tool's command is missing,
    naming the path, rather than leaving the agent to discover it."""
    for entry in entries:
        for command in entry["commands"]:
            binary = Path(VENV_ROOT) / entry["id"] / "bin" / command
            if not binary.is_file():
                raise RuntimeError(
                    f"persona tool {entry['id']!r}: {binary} is not installed — see docs/tool-allowlist.md"
                )


def apply(base: str, resolved_persona: str | None, overlay) -> tuple[str, str | None]:
    """The step's (allowed_tools, disallowed_tools) once the composed persona's
    tools are added. (base, None) unchanged when there is no overlay (no
    project, or its definitions switch off), the step composes no persona,
    the persona names no tools, or `base` grants no bare Bash.

    `overlay` is farm/personas.py's project_overlay(); its "tools" map was
    checked against the allow-list when the overlay loaded."""
    if not isinstance(overlay, dict) or not resolved_persona:
        return base, None
    tool_ids = overlay.get("tools", {}).get(resolved_persona)
    if not tool_ids or "Bash" not in base.split(","):
        return base, None
    allowlist = load_allowlist()
    validate_ids(resolved_persona, tool_ids, allowlist)
    entries = [allowlist[tool_id] for tool_id in allowlist if tool_id in tool_ids]
    _ensure_installed(entries)
    return merge(base, entries)


def main(argv: list[str] | None = None) -> int:
    """`python -m farm.persona_tools ids [<farm dir>]` prints the allow-list's
    tool ids, in file order, as a JSON array. HZ-542: this is how the server
    learns which tools a project persona may name, so this module stays the
    one reader of the allow-list. A farm dir reads that farm's allow-list (the
    server's tests use a temp farm). Exits 1, printing nothing to stdout, when
    the allow-list fails to load."""
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] != "ids" or len(args) > 2:
        print("usage: python -m farm.persona_tools ids [<farm dir>]", file=sys.stderr)
        return 2
    path = Path(args[1]) / "tools" / ALLOWLIST_PATH.name if len(args) == 2 else None
    try:
        allowlist = load_allowlist(path)
    except AllowlistError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(list(allowlist)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
