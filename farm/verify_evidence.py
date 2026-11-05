"""HZ-771: Verify & report's evidence as files, not prompt text.

The server sends the Run plan and this attempt's Execute artifact whole, in the
task's `evidence` list (server/src/orchestrator.js splitVerifyEvidence). Each
is the stored artifact, already redacted, so the files hold exactly what the
log view shows. write() puts them in a private scratch folder under /tmp,
outside every clone and worktree: never committed, never read by another step.
farm/tmp_sweep.py removes a `horizon-` folder a killed run leaves behind.

prompt_section() names each file with a short summary and never quotes a body.
"""

import re
import shutil
import tempfile
from pathlib import Path

from domain.py import run_plan

from .job_reports import ATTEMPT_LOG_HEADING, COMMANDS_HEADING, REPORT_HEADING_PREFIX, REPORTS_HEADING

RUN_PLAN_LABEL = "Run plan"
EXECUTE_LABEL = "Execute"
RUN_PLAN_FILE = "run-plan.md"
EXECUTE_FILE = "execute-log.md"
REPORTS_DIR = "reports"
SCRATCH_PREFIX = "horizon-verify-"
SCRATCH_ROOT = "/tmp"
# The failed commands the summary names, at most; the rest are counted.
FAILED_NAMED_MAX = 5
COMMAND_LINE_MAX_CHARS = 200

_FENCE = re.compile(r"^(`{3,})\s*$")
_SLUG = re.compile(r"[^A-Za-z0-9._-]+")


def _content(evidence, label: str) -> str | None:
    """The `content` of the first well-formed entry with `label`, else None."""
    for entry in evidence if isinstance(evidence, list) else []:
        if isinstance(entry, dict) and entry.get("label") == label and isinstance(entry.get("content"), str):
            return entry["content"]
    return None


def _write_bytes(path: Path, text: str) -> None:
    # Bytes, not text mode: a CRLF in the stored artifact stays a CRLF.
    path.write_bytes(text.encode("utf-8", "replace"))


def _report_sections(execute: str) -> list[tuple[str, str]]:
    """(path, section text) for each `### Report: <path>` section of the
    Execute artifact's `## Reports`. A heading inside a report's fence is body
    text, not a new section."""
    sections: list[tuple[str, list[str]]] = []
    in_reports, fence = False, None
    for line in execute.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        if fence is not None:
            if bare == fence:
                fence = None
            if sections:
                sections[-1][1].append(line)
            continue
        if not in_reports:
            in_reports = bare == REPORTS_HEADING
            continue
        if bare.startswith(f"### {REPORT_HEADING_PREFIX}"):
            sections.append((bare[len(f"### {REPORT_HEADING_PREFIX}"):], [line]))
            continue
        if bare.startswith("## "):
            break
        opened = _FENCE.match(bare)
        if opened:
            fence = opened.group(1)
        if sections:
            sections[-1][1].append(line)
    return [(path, "".join(lines).rstrip("\r\n") + "\n") for path, lines in sections]


def _report_name(n: int, path: str) -> str:
    """`<n>-<slug>.md`: no separator survives, so the file stays in reports/."""
    slug = _SLUG.sub("-", path).strip(".-")[:60] or "report"
    return f"{n}-{slug}.md"


def write(evidence) -> tuple[Path, list[Path]]:
    """Makes the scratch folder (0700, the run user's own) and writes
    run-plan.md, execute-log.md byte-for-byte, and reports/<n>-<slug>.md, one
    per report section. Returns the folder and the report files. An entry
    missing or malformed is skipped; prompt_section() says it was not
    supplied."""
    root = Path(tempfile.mkdtemp(prefix=SCRATCH_PREFIX, dir=SCRATCH_ROOT))
    try:
        reports: list[Path] = []
        plan = _content(evidence, RUN_PLAN_LABEL)
        if plan is not None:
            _write_bytes(root / RUN_PLAN_FILE, plan)
        execute = _content(evidence, EXECUTE_LABEL)
        if execute is not None:
            _write_bytes(root / EXECUTE_FILE, execute)
            sections = _report_sections(execute)
            if sections:
                (root / REPORTS_DIR).mkdir()
            for n, (path, text) in enumerate(sections, start=1):
                target = root / REPORTS_DIR / _report_name(n, path)
                if target.resolve().parent != (root / REPORTS_DIR).resolve():
                    raise ValueError(f"report file {target} is outside {root / REPORTS_DIR}")
                _write_bytes(target, text)
                reports.append(target)
        return root, reports
    except BaseException:
        remove(root)
        raise


def remove(root: Path) -> None:
    shutil.rmtree(root, ignore_errors=True)


def _section_lines(text: str, heading: str) -> list[str]:
    """The lines under `heading`, up to the next `## ` heading."""
    lines = text.splitlines()
    if heading not in lines:
        return []
    out = []
    for line in lines[lines.index(heading) + 1 :]:
        if line.startswith("## "):
            break
        out.append(line)
    return out


def _execute_summary(execute: str) -> str:
    """The Execute artifact's own summary line, then each command that did not
    exit 0, from its `## Commands` section only."""
    commands = [line for line in _section_lines(execute, COMMANDS_HEADING) if line.strip()]
    if not commands:
        return f"no `{COMMANDS_HEADING}` section"
    failed = [line[2:] for line in commands[1:] if line.startswith("- ") and not line.startswith("- exit 0 ")]
    parts = [commands[0].strip().rstrip(".") + "."]
    if failed:
        named = "; ".join(f[:COMMAND_LINE_MAX_CHARS] for f in failed[:FAILED_NAMED_MAX])
        more = f"; and {len(failed) - FAILED_NAMED_MAX} more" if len(failed) > FAILED_NAMED_MAX else ""
        parts.append(f"Did not exit 0: {named}{more}.")
    if ATTEMPT_LOG_HEADING not in execute.splitlines():
        parts.append(f"No `{ATTEMPT_LOG_HEADING}` section.")
    return " ".join(parts)


def _run_plan_summary(plan: str) -> str:
    try:
        block = run_plan.extract(plan)
    except ValueError as exc:
        return f"No valid Run plan block: {exc}."
    return f"{len(block.get('commands') or [])} command(s) in the Run plan block."


def _size(text: str) -> str:
    data = text.encode("utf-8", "replace")
    return f"{len(data):,} bytes, {len(text.splitlines()):,} lines"


def prompt_section(root: Path, evidence, reports: list[Path]) -> str:
    """The prompt's `## Evidence files` section: each path, its size and a
    one-line summary. No body text."""
    lines = ["", "", "## Evidence files (read these; they are not in this prompt)"]
    execute = _content(evidence, EXECUTE_LABEL)
    if execute is None:
        lines.append("- Execute log: not supplied.")
    else:
        lines.append(
            f"- {root / EXECUTE_FILE}: the Execute log, this attempt only, redacted. "
            f"{_size(execute)}. {_execute_summary(execute)}"
        )
    plan = _content(evidence, RUN_PLAN_LABEL)
    if plan is None:
        lines.append("- Run plan: not supplied.")
    else:
        lines.append(f"- {root / RUN_PLAN_FILE}: the approved Run plan. {_size(plan)}. {_run_plan_summary(plan)}")
    for path in reports:
        text = path.read_text(encoding="utf-8", errors="replace")
        shown = text.splitlines()[0][len(f"### {REPORT_HEADING_PREFIX}"):] if text else ""
        lines.append(f"- {path}: report `{shown}`, {_size(text)}.")
    if execute is not None and not reports:
        lines.append("- Reports: the Execute log has no report sections.")
    return "\n".join(lines)
