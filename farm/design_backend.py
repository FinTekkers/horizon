"""HZ-938: which tool draws a design sub-step's round on this box.

Three tools, chosen per box by FARM_DESIGN_BACKEND in the farm's env:

- `studio` (the default): Meta Studio, farm/design_canvas.py, exactly as
  HO-850 built it.
- `claude`: a Claude Design project, made and updated by the agent through
  its existing Claude login (the DesignSync tool). Never ANTHROPIC_API_KEY.
  On only once `python -m farm.design_backend probe-claude` has passed on
  this box, within PROBE_MAX_AGE_S.
- `html`: a self-contained HTML mock the farm checks, captures and stores in
  the item's design page slot (farm/visual_page.py, slot "design"); the
  server serves it sandboxed at /api/items/<id>/design-page.

resolve() is the one place a round's tool is picked. A chosen tool that
cannot run on this box (no `meta`, no fresh Claude probe) falls back to
`html`, and the round records which tool it fell back from, so the server's
card says so. Every other tool error still fails the round: a fallback never
hides one. An unknown FARM_DESIGN_BACKEND is a config error, never a fallback.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from typing import NamedTuple

from . import config, design_canvas, screenshot_runner
from .checks import scrub

ENV = "FARM_DESIGN_BACKEND"
STUDIO, CLAUDE, HTML = "studio", "claude", "html"
TOOLS = (STUDIO, CLAUDE, HTML)
DEFAULT = STUDIO
# The design system each tool draws in, recorded on every round so the owner
# can compare boxes (server/src/designRounds.js design_system).
SYSTEMS = {STUDIO: design_canvas.DESIGN_SYSTEM, CLAUDE: "claude-design", HTML: "horizon-production"}

# Each tool's first artifact line: domain/js/designCanvas.js holds the same
# constants (farm/tests/test_design_backend.py pins them equal). Studio's is
# design_canvas.format_canvas_line.
PAGE_MARKER = "**Design page:**"
PAGE_LINK_TEXT = "Open the design page"
CLAUDE_MARKER = "**Claude Design:**"
CLAUDE_LINK_TEXT = "Open the Claude Design project"
CLAUDE_HOST = "claude.ai"
CLAUDE_PROJECT_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CLAUDE_PROJECT_RE = re.compile(CLAUDE_PROJECT_PATTERN)
CLAUDE_URL_RE = re.compile(rf"https://{re.escape(CLAUDE_HOST)}/design/p/({CLAUDE_PROJECT_PATTERN})")

PROBE_FILE = "design-claude-probe.json"
# A passing probe older than this no longer turns `claude` on: the login it
# proved may have expired since.
PROBE_MAX_AGE_S = 7 * 24 * 3600
PROBE_REASON_MAX_CHARS = 300


class Resolved(NamedTuple):
    tool: str
    system: str
    # The tool the box chose when it could not run here, else None.
    fallback_from: str | None
    # Why the chosen tool could not run, for the log and the artifact.
    reason: str | None

    def provenance(self) -> dict:
        """The result's `artifacts.design`."""
        return {"tool": self.tool, "system": self.system, "fallback_from": self.fallback_from}


class ConfigError(ValueError):
    """FARM_DESIGN_BACKEND names no tool."""


def design_page_url(item_id: str) -> str:
    return f"/api/items/{item_id}/design-page"


def format_page_line(item_id: str, round_no: int) -> str:
    return f"{PAGE_MARKER} [{PAGE_LINK_TEXT}]({design_page_url(item_id)}) · round {round_no}"


def claude_project_url(project_id: str) -> str:
    return f"https://{CLAUDE_HOST}/design/p/{project_id}"


def claude_project_from_url(url) -> str | None:
    """The project id of a Claude Design link, or None for anything else."""
    match = CLAUDE_URL_RE.fullmatch(url) if isinstance(url, str) else None
    return match.group(1) if match else None


def format_claude_line(project_id: str, round_no: int) -> str:
    return f"{CLAUDE_MARKER} [{CLAUDE_LINK_TEXT}]({claude_project_url(project_id)}) · project `{project_id}` · round {round_no}"


def chosen() -> str:
    """The box's chosen tool, read at call time. Raises ConfigError for a
    value that is not one of TOOLS."""
    raw = os.environ.get(ENV, "").strip().lower()
    if not raw:
        return DEFAULT
    if raw not in TOOLS:
        raise ConfigError(f"{ENV}={raw[:40]!r} is not one of {', '.join(TOOLS)}")
    return raw


def probe_path():
    return config.farm_home() / "state" / PROBE_FILE


def read_probe() -> dict | None:
    try:
        data = json.loads(probe_path().read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _age_s(checked_at, now: datetime) -> float | None:
    if not isinstance(checked_at, str):
        return None
    try:
        at = datetime.strptime(checked_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (now - at).total_seconds()


def claude_availability(now: datetime | None = None) -> tuple[bool, str | None]:
    record = read_probe()
    if record is None:
        return False, "no Claude Design probe has passed on this box (run `python -m farm.design_backend probe-claude`)"
    if record.get("ok") is not True:
        reason = str(record.get("reason") or "no reason recorded")[:PROBE_REASON_MAX_CHARS]
        return False, f"the Claude Design probe failed on this box: {reason}"
    age = _age_s(record.get("checkedAt"), now or datetime.now(timezone.utc))
    if age is None or age < 0 or age > PROBE_MAX_AGE_S:
        return False, "the Claude Design probe on this box is out of date; run it again"
    return True, None


def html_availability() -> tuple[bool, str | None]:
    """A Horizon page needs the capture worker for its screenshots."""
    if not shutil.which(screenshot_runner.WORKER_CMD[0]) or not screenshot_runner.worker_installed():
        return False, f"the farm capture worker is not installed ({screenshot_runner.INSTALL_HINT})"
    return True, None


def availability(tool: str) -> tuple[bool, str | None]:
    """(whether `tool` can run on this box, why not)."""
    if tool == STUDIO:
        return (True, None) if design_canvas.tool_available() else (False, "Meta Studio (`meta`) is not installed on this box")
    if tool == CLAUDE:
        return claude_availability()
    if tool == HTML:
        return html_availability()
    raise ConfigError(f"unknown design tool {tool!r}")


def fallback(from_tool: str, reason: str) -> Resolved:
    return Resolved(HTML, SYSTEMS[HTML], from_tool, reason)


def resolve() -> Resolved:
    """The tool this round draws with. Raises ConfigError for a bad
    FARM_DESIGN_BACKEND. `html` that cannot run is returned as is: the round
    then fails naming why, rather than pretend."""
    tool = chosen()
    ok, reason = availability(tool) if tool != HTML else (True, None)
    if ok:
        return Resolved(tool, SYSTEMS[tool], None, None)
    return fallback(tool, reason or "it cannot run on this box")


# ---- the Claude Design probe (run by hand on a box) ----

PROBE_PROMPT = """You are checking whether this headless session can make and update a Claude Design project.
Use only the DesignSync tool, in this order, and stop at the first step that fails:
1. list_projects.
2. create_project with the name "Horizon design probe {stamp}".
3. finalize_plan on that project with writes ["probe/index.html"] and no deletes.
4. write_files: probe/index.html with inline data "<!doctype html><html><body><p>round 1</p></body></html>".
5. finalize_plan again with the same writes, then write_files the same path with "<p>round 2</p>" in place of "<p>round 1</p>".
6. get_file probe/index.html and check it holds "round 2".
Reply with JSON only: {{"ok": true|false, "project_id": "<uuid or null>", "reason": "<the step that failed and why, or null>"}}"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_probe(record: dict) -> None:
    path = probe_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2) + "\n")


def probe_claude(run=None) -> dict:
    """Asks one headless agent run, on the box's own Claude login, to make and
    update a Claude Design project, and records {ok, reason, checkedAt}
    (plus projectId on a pass) at FARM_HOME/state/design-claude-probe.json.
    Refuses with ANTHROPIC_API_KEY set, before any agent runs."""
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        record = {"ok": False, "reason": "ANTHROPIC_API_KEY is set; Claude Design runs only on the farm's Claude login", "checkedAt": _now()}
        write_probe(record)
        return record
    from .agent_runner import parse_agent_reply

    if run is None:
        from .agent_runner import run_agent as run
    stamp = _now()
    try:
        with tempfile.TemporaryDirectory(prefix="design-claude-probe-") as cwd:
            reply = run(
                PROBE_PROMPT.format(stamp=stamp),
                agent="Eng",
                step="Design the screens (probe)",
                cwd=cwd,
                max_turns=20,
                timeout_s=600,
                allowed_tools="DesignSync",
                provider="claude",
                provider_locked=True,
            )
        parsed, notes = parse_agent_reply(str((reply or {}).get("result") or ""))
    except Exception as exc:  # the probe records why, whatever it was
        parsed, notes = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}, []
    if not isinstance(parsed, dict):
        parsed = {"ok": False, "reason": "the agent answered no JSON"}
    ok = parsed.get("ok") is True and isinstance(parsed.get("project_id"), str) and bool(parsed["project_id"].strip())
    reason = None if ok else str(parsed.get("reason") or "the agent did not report a project it made and updated")
    record = {"ok": ok, "reason": None if reason is None else scrub(reason)[:PROBE_REASON_MAX_CHARS], "checkedAt": _now()}
    if ok:
        record["projectId"] = parsed["project_id"].strip()[:100]
    if notes:
        record["notes"] = [scrub(str(note))[:PROBE_REASON_MAX_CHARS] for note in notes]
    write_probe(record)
    return record


def main(argv: list[str]) -> int:
    if argv[:1] != ["probe-claude"]:
        print("usage: python -m farm.design_backend probe-claude", file=sys.stderr)
        return 2
    record = probe_claude()
    print(json.dumps(record, indent=2))
    return 0 if record["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
