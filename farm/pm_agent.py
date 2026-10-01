"""The PM agent: one PM-lane step (steps 0/1/2/9) per process.

HZ-204 (HZ-115 Option B): farmd's dispatcher launches this once per task, in
its own farm-run-<item>-s<step>-a<attempt> session — exactly like
step_agent.py — so every PM step runs the code, farm/roles/pm.md and farm.env
present at dispatch. There is no long-lived PM session and no resumed Claude
session any more: what that session used to remember across items now rides
in the task as an explicit `project_context` block (render_project_context).

A deliberate *script* around the model: it executes exactly one lifecycle step
and reports the result back to farmd. It never decides what runs next — the
Node orchestrator does.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from domain.py import fields, reasons, steps
from domain.py.personas import model_agent_for_step

from .agent_runner import (
    AgentError,
    AgentExhaustedError,
    parse_agent_reply,
    run_agent,
    stamp_notes,
    stamp_notes_artifact,
)
from .config import FARM_PORT
from .rules import render_rules_section

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

# The placeholder farm/roles/pm.md carries in place of the numbers. Substituted
# below so the prompt cannot state a budget validate() no longer enforces.
FIELD_LIMITS_PLACEHOLDER = "{{FIELD_LIMITS}}"


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
    return source.replace(FIELD_LIMITS_PLACEHOLDER, rendered)


ROLE_PROMPT = render_role_prompt((Path(__file__).parent / "roles" / "pm.md").read_text(), PATCH_FIELDS)
FARMD = f"http://127.0.0.1:{FARM_PORT}"

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


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def report_result(result: dict) -> bool:
    """Posts this run's result to farmd and returns whether it was ACCEPTED —
    i.e. whether the run is now the server's problem and the task file can be
    released. Anything that leaves us unsure (farmd down or restarting
    mid-deploy, the Node server unreachable, a non-2xx) returns False, so the
    caller keeps the file: farmd's reconciler then reports the run
    `unreachable` once this session is gone, and the server retries it. An
    unreachable server is not evidence the run was handled — the same rule
    farmd's _report_run_dead follows.

    A forwarded 404 counts as accepted: the run no longer exists server-side,
    so there is nothing left to report to and holding the file would strand it.
    """
    run_id = result["run_id"]
    try:
        res = httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
    except Exception as exc:
        log(f"run {run_id}: could not report the result: {exc} — keeping the task file")
        return False
    if res.status_code != 200:
        log(f"run {run_id}: farmd rejected the result ({res.status_code}) — keeping the task file")
        return False
    try:
        forwarded = int(res.json().get("forwarded", 0))
    except Exception:
        forwarded = 0
    if 200 <= forwarded < 300 or forwarded == 404:
        return True
    log(f"run {run_id}: result not accepted (forwarded {forwarded}) — keeping the task file")
    return False


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
    project = task.get("project") or {}
    lines = [
        f"Project: {project.get('name', 'unknown')}",
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
MARKED_PATCH_FIELDS = {"desc", "metric", "guardrails"}


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


def process(task: dict) -> bool:
    """Runs one PM step and reports it. Returns whether the report was
    accepted (see report_result). No Claude session is resumed (HZ-204): the
    prompt's Project context section is the cross-item memory."""
    run_id = task["run_id"]

    try:
        prompt = build_prompt(task)
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        # HZ-192: run_agent() resolves the model from who is calling — the
        # step's own domain/steps.json agent (PM, or Architect for "Set
        # guardrails") and its label.
        step_label = task["step"]["label"]
        model_agent = model_agent_for_step(steps.by_label(step_label)["agent"])
        reply = run_agent(prompt, agent=model_agent, step=step_label, append_system=ROLE_PROMPT)

        # One retry, telling the model exactly what was wrong with its reply.
        # validate= keeps validation inside the retry envelope, so a reply
        # that parses but is missing 'summary' takes the retry exactly as it
        # always did.
        def retry_once(prompt: str) -> str:
            log(f"run {run_id}: invalid reply; retrying once")
            retry = run_agent(prompt, agent=model_agent, step=step_label, append_system=ROLE_PROMPT)
            return retry["result"]

        (summary, patch, artifact), notes = parse_agent_reply(
            reply["result"], retry_once, validate=validate
        )

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

        result = {"run_id": run_id, "ok": True, "summary": summary, "patch": patch}
        if artifact:
            result["artifacts"] = {"artifact_md": artifact}
    except Exception as exc:  # report every failure; farmd forwards to the server
        log(f"run {run_id}: FAILED — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:300]}
        # HZ-156: tag the one failure cause the orchestrator auto-retries from
        # this side, exactly as the ephemeral step agent already does in
        # step_agent.main() — a PM step that ran out of turn budget was
        # pausing for a human where the identical failure on a step agent
        # retried itself. Anything else still reports no reason and pauses.
        if isinstance(exc, AgentExhaustedError):
            result["reason"] = reasons.REASON["TURN_CAP"]

    accepted = report_result(result)
    if accepted:
        log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")
    return accepted


def main() -> int:
    """Runs the one task at --task (a claimed file in queue/runs/active) and
    releases it only once its result was accepted.

    Hidden coupling, by design: this does NOT tell the server the run started.
    farmd's _claim_and_launch() already did (_notify_started), and dropped the
    task without launching if the server had given up on it — notifying again
    here would arm the execution timer twice.

    The file is unlinked strictly after an accepted report. If this process is
    killed first (farmd restart, a deploy), or the report is not accepted, the
    file stays in runs/active and the exit is non-zero: farmd's reconciler
    reports the run `unreachable` once this session is gone, and the server
    retries it — a claimed PM task is never lost.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    task_path = Path(args.task)
    task = json.loads(task_path.read_text())
    if not process(task):
        return 1
    task_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
