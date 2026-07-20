"""Project/repo rules — the per-project layer of agent instructions (HZ-9).

Role personas (farm/roles/personas/) are global per role; rules add the
project- and repo-specific layer on top: build/run/test commands, environment
quirks, service ports and startup order, architectural constraints. Rules are
versioned files in this repo (farm/rules/projects/<project-slug>.md and
farm/rules/repos/<owner>__<repo>.md), stamped verbatim into the task payload
by farmd at enqueue and rendered into every agent prompt — they compose with
the global personas, never fork them.

The compose logic is mirrored in server/src/definitions.js for the UI's
effective-prompt preview and parity-tested byte-for-byte in
server/test/definitions-parity.test.mjs — change both sides together.
"""

import os
import re
from pathlib import Path

from .config import slugify
from .personas import compose_role

# Overridable so the server-side parity test can point both languages at one
# fixture tree; defaults to the versioned rules shipped with the farm.
RULES_DIR = Path(os.environ.get("FARM_RULES_DIR", str(Path(__file__).parent / "rules")))

# Per-file byte cap: an oversized rules file is dropped whole (never
# truncated) so a prompt can't silently carry half a constraint.
MAX_RULES_BYTES = 8192

# Defensive cap on the rendered prompt section (two files under the byte cap
# fit comfortably; anything beyond this is runaway input, not rules).
MAX_PROMPT_RULES_CHARS = 24000

# Write-side lint (server/src/definitions.js) mirrors these — keep in sync.
# Assignments to $ENV_VAR references deliberately pass: that is exactly how
# credentials are supposed to appear in rules files.
CREDENTIAL_PATTERNS = [
    ("credential assignment", re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|aws_secret_access_key)\b\s*[:=]\s*(?!\$)\S+")),
    ("credential in URL", re.compile(r"://[^\s/:@]+:(?!\$)[^\s@]+@")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{8,}")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")),
]


def lint_rules(text: str) -> list[str]:
    """Names of credential patterns found in the text (empty = clean)."""
    if not isinstance(text, str):
        return []
    return [label for label, pattern in CREDENTIAL_PATTERNS if pattern.search(text)]


def _read_capped(path: Path) -> str:
    """One rules file, or '' — missing, unreadable or oversized files degrade
    to nothing. Rules must never dead-letter a run."""
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    if len(raw) > MAX_RULES_BYTES:
        print(f"rules: WARNING {path.name} is {len(raw)} bytes (cap {MAX_RULES_BYTES}) — dropped", flush=True)
        return ""
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return ""


def resolve_rules(project_name, repo) -> str:
    """Project rules then repo rules, concatenated. Never raises: anything
    missing or malformed contributes nothing, mirroring personas.compose_role."""
    parts = []
    if isinstance(project_name, str) and project_name.strip():
        parts.append(_read_capped(RULES_DIR / "projects" / f"{slugify(project_name)}.md"))
    if isinstance(repo, str) and repo.strip():
        parts.append(_read_capped(RULES_DIR / "repos" / f"{repo.strip().replace('/', '__')}.md"))
    return "\n\n".join(p for p in parts if p)


def render_rules_section(rules_text) -> str:
    """The '## Project rules' prompt block, or '' when there are no rules —
    an absent layer renders nothing, never an empty header."""
    if not isinstance(rules_text, str):
        return ""
    text = rules_text.strip()
    if not text:
        return ""
    return f"## Project rules\n{text[:MAX_PROMPT_RULES_CHARS]}"


def effective_prompt(role_text: str, persona_id, project_name, repo) -> str:
    """Full composition an agent would receive: role -> persona -> project
    rules -> repo rules. Later layers add, never replace. This is the exact
    string the server's preview must reproduce (parity-tested)."""
    composed = compose_role(role_text, persona_id)
    section = render_rules_section(resolve_rules(project_name, repo))
    return f"{composed}\n\n{section}" if section else composed
