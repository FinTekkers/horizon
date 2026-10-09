"""The PM step kind: the logic specific to lifecycle steps 0, 1, 2 and 9.

HZ-371: farm/step_agent.py runs every farm agent step, these four included —
its _execute_pm() builds the prompt here, runs the shared run_agent() and
parse_agent_reply(), validates through validate_within_budget(), and hands the
parsed reply to finish(). Logging, result reporting, pause handling and the
parse retry are step_agent's; this module holds none of them.

Each step starts on the code, env and farm/roles/pm.md present at dispatch.
Nothing is resumed: the HZ-204 project-context block in the prompt is the only
memory a step has of other items.
"""

from datetime import datetime, timezone
from pathlib import Path

from domain.py import fields

from .agent_runner import AgentError, stamp_notes, stamp_notes_artifact
from .rules import render_rules_section
from .task_files import task_project

# The fields a PM revision may patch, and how long each may be — DERIVED from
# domain/fields.json (HZ-134), which is also where server/src/app.js's POST
# /api/items body schema gets the same numbers. Until HZ-134 these were four
# hand-typed integers that had drifted below what the API accepted, so a PM
# revision could not write a guardrails value a human could type into the create
# form. Keyed by work_item column, which is what a patch payload uses.
#
# Every entry here is a PROSE field. The specialist routing tag is not one of
# them any more: since HZ-125 it is a {agent: persona id} MAP carried under
# `personas`, with no single length to cap, so domain/fields.json marks the
# legacy `persona` column agentRevisable: false and it drops out of this
# derivation — see _clean_personas() below for the shape check it gets instead.
PATCH_FIELDS = fields.patch_limits(fields.FIELDS)

# Size caps for that map (HZ-125). Not limits in the PATCH_FIELDS sense: the
# server registry-validates every agent/id pair and drops re-proposals over a
# set value, so these only ever fire on a pathological reply.
PERSONA_ID_MAX_CHARS = 40
PERSONA_AGENT_MAX_CHARS = 40
# There are four persona agents (farm/personas.py). A generous ceiling that
# only fires on a runaway reply, never on a real one.
MAX_PERSONA_SLOTS = 8

# HZ-345: the line budgets for metric and guardrails, from domain/fields.json's
# maxLines. Only the step that owns a field is held to its line budget — the
# items already past steps 1-2 keep their text whatever its length.
LINE_LIMITS = fields.line_limits(fields.FIELDS)
LINE_BUDGETED_STEPS = {"Define how we measure success": "metric", "Set guardrails": "guardrails"}

# The placeholder farm/roles/pm.md carries in place of the numbers. Substituted
# below so the prompt cannot state a budget validate() no longer enforces.
FIELD_LIMITS_PLACEHOLDER = "{{FIELD_LIMITS}}"
LINE_LIMITS_PLACEHOLDER = "{{LINE_LIMITS}}"


def render_role_prompt(source: str, limits: dict) -> str:
    """The PM role prompt with its field-limit line filled in from PATCH_FIELDS.

    Raises if the placeholder is absent rather than returning the text
    unchanged. `str.replace` no-ops silently on a missing needle, so an edit to
    pm.md that dropped the placeholder would leave the agent told nothing at all
    about field limits — and a test asserting only "no {{ survives in the
    output" would still pass. Both halves are checked: this raise, and the
    rendered-output assertion in farm/tests/test_field_limits.py."""
    if FIELD_LIMITS_PLACEHOLDER not in source:
        raise RuntimeError(
            f"farm/roles/pm.md no longer carries {FIELD_LIMITS_PLACEHOLDER} — "
            "the PM agent would be given no field limits at all"
        )
    rendered = ", ".join(f"{column} <={limit} chars" for column, limit in limits.items())
    # HZ-345: the line budgets, from LINE_LIMITS. pm.md is checked for this
    # placeholder below, where ROLE_PROMPT is built.
    lines = ", ".join(f"{column} <={limit} lines" for column, limit in LINE_LIMITS.items())
    return source.replace(FIELD_LIMITS_PLACEHOLDER, rendered).replace(LINE_LIMITS_PLACEHOLDER, lines)


_ROLE_SOURCE = (Path(__file__).parent / "roles" / "pm.md").read_text()
if LINE_LIMITS_PLACEHOLDER not in _ROLE_SOURCE:
    raise RuntimeError(
        f"farm/roles/pm.md no longer carries {LINE_LIMITS_PLACEHOLDER} — "
        "the PM agent would be given no line budgets at all"
    )
ROLE_PROMPT = render_role_prompt(_ROLE_SOURCE, PATCH_FIELDS)

# Write-side: a pathological-payload guard, not a working limit — the agent's
# own artifact must reach the server intact (HZ-29). The server budgets the
# *dispatched* total across artifacts; this only stops a runaway agent output.
WRITE_ARTIFACT_SANITY_CEILING_CHARS = 200_000
# Read-side: defense-in-depth for rendering prior artifacts into a prompt.
# The server already budgets the total it sends (~60k), so this should never
# fire in practice. Once mirrored farm/rules.py's MAX_PROMPT_RULES_CHARS
# backstop when both were flat character slices; rules.py now drops whole
# rules blocks with a note instead (HZ-114), so this is no longer a real
# mirror — flagging the drift rather than leaving a stale claim in place.
MAX_PROMPT_ARTIFACT_CHARS = 100_000
# The cap on this agent's own `summary` — step_run.output on the server side.
# Named once (HZ-156) rather than restated as a literal at each shaping site:
# stamp_notes() reserves room inside exactly this budget, so a cap raised in
# validate() and not in the stamp would silently truncate the notes back off.
SUMMARY_MAX_CHARS = 300


def _render_personas(item: dict) -> str:
    """The item's specialist personas for the prompt, one slot per composing
    agent (HZ-125). Also accepts the pre-HZ-125 flat `persona` string so a task
    file enqueued by an older server still shows the routing it carried."""
    personas = item.get("personas")
    if not isinstance(personas, dict) or not personas:
        legacy = item.get("persona")
        personas = {"eng": legacy} if isinstance(legacy, str) and legacy.strip() else {}
    if not personas:
        return "(not set)"
    return ", ".join(f"{agent}={persona}" for agent, persona in sorted(personas.items()))


# HZ-204 (HZ-115 Stage 1): the explicit project context that replaces session
# memory. The server selects the rows (orchestrator.js buildProjectContext);
# this is the single owner of how they are shaped and capped. The cap covers
# the whole rendered section — header and omission note included.
PROJECT_CONTEXT_MAX_CHARS = 4000
PROJECT_CONTEXT_ID_CHARS = 40
PROJECT_CONTEXT_TITLE_CHARS = 200
PROJECT_CONTEXT_DESC_CHARS = 160
PROJECT_CONTEXT_FEEDBACK_CHARS = 300
PROJECT_CONTEXT_HEADER = (
    "Project context (other recent items in this project, and recent human feedback "
    "on sent-back PM/Architect steps):"
)


def _clip_context_text(value: str, limit: int) -> str:
    """Bound one context field to `limit` chars of content, saying so when
    cut (HZ-114: never a silent slice). Unlike _mark_truncated() this always
    stays bounded — a run-on token is cut mid-token — because the section's
    hard cap must hold."""
    if len(value) <= limit:
        return value
    cut = value[:limit]
    last_space = cut.rfind(" ")
    if last_space > limit // 2:
        cut = cut[:last_space]
    return f"{cut} […{len(value) - len(cut)} chars omitted]"


def _context_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _first_line(value: str) -> str:
    for line in value.splitlines():
        if line.strip():
            return line.strip()
    return ""


_UNDATED = datetime.min.replace(tzinfo=timezone.utc)


def _context_time(value) -> datetime:
    """A row's timestamp as an aware UTC datetime, so the oldest-first drop
    compares instants, not strings — SQLite's `2026-09-30 10:00:00` and an ISO
    `2026-09-30T10:00:00Z` order differently as text. Naive values are UTC
    (SQLite datetime('now')). A missing or unparseable one sorts oldest, so it
    is the first dropped."""
    try:
        parsed = datetime.fromisoformat(_context_str(value))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return _UNDATED


def _context_entries(ctx: dict) -> list[tuple[str, datetime, str]]:
    """(kind, sort key, rendered line) for each well-formed row; malformed
    rows are skipped rather than failing the step."""
    entries = []
    items = ctx.get("items")
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        item_id, title = _context_str(item.get("id")), _context_str(item.get("title"))
        if not item_id or not title:
            continue
        line = (
            f"- {_clip_context_text(item_id, PROJECT_CONTEXT_ID_CHARS)}: "
            f"{_clip_context_text(title, PROJECT_CONTEXT_TITLE_CHARS)}"
        )
        desc = _first_line(_context_str(item.get("desc")))
        if desc:
            line += f" — {_clip_context_text(desc, PROJECT_CONTEXT_DESC_CHARS)}"
        entries.append(("item", _context_time(item.get("updated_at")), line))
    feedback = ctx.get("feedback")
    for row in feedback if isinstance(feedback, list) else []:
        if not isinstance(row, dict):
            continue
        message = " ".join(_context_str(row.get("message")).split())
        if not message:
            continue
        item_id = _clip_context_text(_context_str(row.get("item_id")) or "?", PROJECT_CONTEXT_ID_CHARS)
        target = _clip_context_text(_context_str(row.get("target")) or "?", PROJECT_CONTEXT_ID_CHARS)
        line = f"- [{item_id} · {target}] {_clip_context_text(message, PROJECT_CONTEXT_FEEDBACK_CHARS)}"
        entries.append(("feedback", _context_time(row.get("created_at")), line))
    return entries


def _render_context_entries(kept: list[tuple[str, datetime, str]], omitted: int) -> str:
    lines = [PROJECT_CONTEXT_HEADER]
    items = [line for kind, _, line in kept if kind == "item"]
    feedback = [line for kind, _, line in kept if kind == "feedback"]
    if items:
        lines.append("Recent items:")
        lines.extend(items)
    if feedback:
        lines.append("Recent human feedback:")
        lines.extend(feedback)
    if omitted:
        lines.append(f"[{omitted} older entries omitted to fit {PROJECT_CONTEXT_MAX_CHARS} chars]")
    return "\n".join(lines)


def render_project_context(ctx) -> str:
    """The `Project context` prompt section, or "" when there is nothing to
    show (no field, a malformed field, or no well-formed rows). Over the cap,
    whole entries are dropped oldest first across both lists, and one closing
    line says how many."""
    if not isinstance(ctx, dict):
        return ""
    entries = _context_entries(ctx)
    if not entries:
        return ""
    # Newest first; a stable sort keeps the server's order among equal keys.
    entries.sort(key=lambda entry: entry[1], reverse=True)
    for keep in range(len(entries), 0, -1):
        rendered = _render_context_entries(entries[:keep], len(entries) - keep)
        if len(rendered) <= PROJECT_CONTEXT_MAX_CHARS:
            return rendered
    # Unreachable with the per-field caps above (one entry is far under the
    # cap), but if those caps change, say so rather than overrun or fail.
    return _render_context_entries([], len(entries))


def build_prompt(task: dict) -> str:
    item = task["item"]
    step = task["step"]
    project = task_project(task)
    lines = [
        f"Project: {project['name']}",
        f"Work item {item['id']}: {item['title']}",
        f"  repo: {item.get('repo') or '(none)'}   issue: #{item.get('issue') or '-'}   priority: {item.get('priority')}",
        f"  outcome/description: {item.get('desc') or '(empty)'}",
        f"  success metric: {item.get('metric') or '(empty)'}",
        f"  guardrails: {item.get('guardrails') or '(empty)'}",
        f"  personas: {_render_personas(item)}",
        "",
        f"Step to perform now: \"{step['label']}\" (attempt {task.get('attempt', 1)})",
    ]
    for artifact in task.get("artifacts") or []:
        lines.append("")
        lines.append(f"Prior artifact — {artifact.get('label', 'earlier step')}:")
        lines.append(artifact.get("content", "")[:MAX_PROMPT_ARTIFACT_CHARS])
    feedback = task.get("feedback") or []
    if feedback:
        lines.append("")
        lines.append("Human feedback to address:")
        for fb in feedback:
            lines.append(f"- {fb.get('message', '')}")
    context_section = render_project_context(task.get("project_context"))
    if context_section:
        lines.append("")
        lines.append(context_section)
    rules_section = render_rules_section(task.get("rules"))
    if rules_section:
        lines.append("")
        lines.append(rules_section)
    lines.append("")
    lines.append("Respond with ONLY the JSON object described in your role instructions.")
    return "\n".join(lines)


# Fields that carry prose a human or agent reads, as opposed to `personas` —
# registry-validated routing enums the server drops outright unless each id
# exactly matches a known persona in that agent's bucket, so a marker there
# would decorate a value that's discarded either way.
#
# metric and guardrails stay listed here only for direct callers of validate()
# (farm/tests/test_hz114_no_silent_truncation.py site 3 pins that path).
# Production never marks them: step_agent._execute_pm() validates through
# validate_within_budget(), which rejects an over-budget value before
# validate() could cut it (HZ-264).
MARKED_PATCH_FIELDS = {"desc", "metric", "guardrails"}

# Fields an over-budget reply is REJECTED for rather than cut (HZ-264). A cut
# metric or guardrails silently loses the lines after the boundary, and the
# operator had to repair those items by hand. Budgets are PATCH_FIELDS's, i.e.
# domain/fields.json's.
BUDGETED_PATCH_FIELDS = ("metric", "guardrails")


class FieldOverBudgetError(AgentError):
    """A reply's metric or guardrails is over its domain/fields.json budget.

    An AgentError, so parse_agent_reply() spends its one retry on it with this
    message as the correction, and _repair_ladder() treats it as a failed rung.
    A second over-budget reply propagates and step_agent.main() reports the
    step failed with no patch."""


def _mark_truncated(value: str, limit: int) -> str:
    """Cut `value` to fit `limit`, at a word boundary, and say so — the note
    is appended *after* the cut content (outside the budget it's reporting
    on), the same shape truncate_diff() uses for reviewers
    (farm/step_agent.py): content first, marker after, never interleaved.
    role/pm.md already instructs the agent to stay within budget; this is
    the enforcement for when it doesn't.

    If no word boundary falls at-or-before `limit` (one run-on token longer
    than the budget — a URL or a hash, say), a mid-word cut would violate
    the same "never split a unit in half" principle this item applies to
    rules.py's whole-file drop. Extend to the next space instead — the
    field runs over budget by a bounded amount rather than being corrupted
    mid-token. If there is no next space either (the whole value is one
    token), there is no boundary to cut at anywhere, so the value is
    returned whole and unmarked."""
    if len(value) <= limit:
        return value
    cut = value[:limit]
    last_space = cut.rfind(" ")
    if last_space > 0:
        cut = cut[:last_space]
    else:
        next_space = value.find(" ", limit)
        if next_space == -1:
            return value
        cut = value[:next_space]
    omitted = len(value) - len(cut)
    note = f" […{omitted} chars omitted — agent reply exceeded the {limit}-char budget for this field; do not infer the field is complete.]"
    return f"{cut}{note}"


def _clean_personas(value) -> dict:
    """The reply's proposed {agent: persona id} map, size-capped (HZ-125).

    Shape-checks only — which agents and ids exist is the server's registry
    call, not the PM's. Anything that isn't a flat string->string map
    contributes nothing, so a malformed personas field costs the run its
    persona proposal (which the server would have dropped anyway) rather than
    failing the step.
    """
    if not isinstance(value, dict):
        return {}
    cleaned = {}
    for agent, persona in value.items():
        if not isinstance(agent, str) or not isinstance(persona, str):
            continue
        agent, persona = agent.strip(), persona.strip()
        if not agent or not persona:
            continue
        cleaned[agent[:PERSONA_AGENT_MAX_CHARS]] = persona[:PERSONA_ID_MAX_CHARS]
        if len(cleaned) >= MAX_PERSONA_SLOTS:
            break
    return cleaned


def validate(parsed: dict) -> tuple[str, dict, str | None]:
    summary = str(parsed.get("summary", "")).strip()
    if not summary:
        raise AgentError("agent reply missing 'summary'")
    patch = {}
    raw_patch = parsed.get("patch") if isinstance(parsed.get("patch"), dict) else {}
    for key, limit in PATCH_FIELDS.items():
        value = raw_patch.get(key)
        if isinstance(value, str) and value.strip():
            value = value.strip()
            patch[key] = _mark_truncated(value, limit) if key in MARKED_PATCH_FIELDS else value[:limit]
    personas = _clean_personas(raw_patch.get("personas"))
    if personas:
        patch["personas"] = personas
    artifact = parsed.get("artifact_md")
    artifact = artifact.strip()[:WRITE_ARTIFACT_SANITY_CEILING_CHARS] if isinstance(artifact, str) and artifact.strip() else None
    return summary[:SUMMARY_MAX_CHARS], patch, artifact


def _reject_over_budget(parsed: dict, step_label: str | None = None, current: dict | None = None) -> None:
    """Raise FieldOverBudgetError for the first budgeted field over its limit.

    Measured on the stripped value, the same normalisation validate() applies,
    so whitespace padding never counts against the budget.

    HZ-345: on the step that owns metric or guardrails (LINE_BUDGETED_STEPS),
    that field is also held to its line budget. A reply that leaves an
    over-budget field unpatched is rejected too, or the item would keep every
    line. Every other step is never line-checked, so items already past steps
    1-2 keep their text."""
    raw_patch = parsed.get("patch") if isinstance(parsed, dict) else None
    if not isinstance(raw_patch, dict):
        raw_patch = {}
    for key in BUDGETED_PATCH_FIELDS:
        value = raw_patch.get(key)
        if not isinstance(value, str):
            continue
        length, limit = len(value.strip()), PATCH_FIELDS[key]
        if length > limit:
            raise FieldOverBudgetError(
                f"{key} is {length} chars; budget is {limit} chars (domain/fields.json). "
                "Tighten the wording to fit; do not drop lines"
            )
    key = LINE_BUDGETED_STEPS.get(step_label)
    if key is None:
        return
    limit = LINE_LIMITS[key]
    value = raw_patch.get(key)
    if isinstance(value, str) and value.strip():
        lines = fields.count_criteria_lines(value)
        if lines > limit:
            raise FieldOverBudgetError(
                f"{key} has {lines} lines; budget is {limit} lines (domain/fields.json). "
                "Merge or drop lines and name them in your summary"
            )
        return
    held = fields.count_criteria_lines((current or {}).get(key))
    if held > limit:
        raise FieldOverBudgetError(
            f"{key} has {held} lines in the item and your reply did not patch it; budget is {limit} lines "
            f"(domain/fields.json). Return a merged or trimmed {key} and name the merged or dropped lines "
            "in your summary"
        )


def validate_within_budget(
    parsed: dict, step_label: str | None = None, current: dict | None = None
) -> tuple[str, dict, str | None]:
    """validate(), but an over-budget metric or guardrails is rejected rather
    than cut and marked (HZ-264). The budget check runs FIRST: after validate()
    the value would already be cut, and the cut is what this exists to stop."""
    _reject_over_budget(parsed, step_label, current)
    return validate(parsed)


def stamp_dropped_lines(summary: str, field: str, before, after) -> str:
    """HZ-345: name, in the summary, the input lines a line-budgeted step did
    not keep word for word — merged lines are reworded, so they show here too.
    Written by the script, so the summary names them whatever the model wrote.
    Only fires when the input was over budget; room is reserved inside
    SUMMARY_MAX_CHARS, as stamp_notes() does."""
    before_lines = fields.criteria_lines(before)
    if len(before_lines) <= LINE_LIMITS[field]:
        return summary
    kept = set(fields.criteria_lines(after))
    dropped = [str(n) for n, line in enumerate(before_lines, 1) if line not in kept]
    if not dropped:
        return summary
    stamp = f" — merged or dropped {field} lines {', '.join(dropped)} of {len(before_lines)}"
    if len(stamp) >= SUMMARY_MAX_CHARS:
        return stamp[:SUMMARY_MAX_CHARS]
    return summary[: SUMMARY_MAX_CHARS - len(stamp)] + stamp


def finish(task: dict, summary: str, patch: dict, artifact: str | None, notes: list[str]) -> dict:
    """The PM step's outcome from a validated reply: the feedback stamp, the
    parser notes and the HZ-345 dropped-line stamp. Returns {"summary",
    "patch", "artifacts"?} for step_agent.main() to report."""
    # Script-stamped feedback trail, same as the ephemeral agents.
    feedback = task.get("feedback") or []
    if feedback:
        summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:SUMMARY_MAX_CHARS]
        if artifact:
            header = "\n".join(f"> {fb.get('message', '')}" for fb in feedback)
            artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"[:WRITE_ARTIFACT_SANITY_CEILING_CHARS]

    # Parser notes reach the human on both surfaces this step owns: the
    # run's output line (server/src/orchestrator.js persists `summary` as
    # step_run.output) and the step's artifact. No-ops when empty.
    summary = stamp_notes(summary, notes, SUMMARY_MAX_CHARS)
    if artifact:
        artifact = stamp_notes_artifact(artifact, notes, WRITE_ARTIFACT_SANITY_CEILING_CHARS)
    budgeted = LINE_BUDGETED_STEPS.get(task["step"]["label"])
    if budgeted and budgeted in patch:
        summary = stamp_dropped_lines(summary, budgeted, task["item"].get(budgeted), patch[budgeted])

    outcome = {"summary": summary, "patch": patch}
    if artifact:
        outcome["artifacts"] = {"artifact_md": artifact}
    return outcome
