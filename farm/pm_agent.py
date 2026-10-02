"""The PM agent: runs one lifecycle step (0/1/2/9) per process.

HZ-212: farmd's dispatcher claims each PM task into queue/runs/active and
launches `python -m farm.pm_agent --task <file>` in its own
farm-run-<item>-s<step>-a<attempt> tmux session, exactly as it launches
step_agent — so every PM step starts on the code, env and farm/roles/pm.md
present at dispatch. Nothing is resumed: the HZ-204 project-context block in
the prompt is the only memory a step has of other items.

A deliberate *script* around the model: it executes exactly one lifecycle
step per task and reports the result back to farmd. It never decides what
runs next — the Node orchestrator does. The `--project` polling loop is kept
for tests and for a rollback build; farmd no longer launches it.
"""

import argparse
import sys
import time
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
from .config import (
    FARM_PORT,
    PM_MALFORMED_GRACE_S,
    QUEUE_DIR,
    STATE_DIR,
    ensure_dirs,
    slugify,
)
from .rules import render_rules_section
from .task_files import read_task, task_project

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


def notify_started(run_id) -> bool:
    """Tells the server this run's agent actually started (HZ-57) — same
    queue-watchdog-to-execution-timer handoff the ephemeral dispatcher does
    via farmd's own _notify_started, routed through farmd (this process only
    talks to FARMD, never HORIZON_URL directly). Fails open: a farmd/network
    hiccup here must not strand a legitimate task — the server's own timers
    are the real backstop."""
    try:
        res = httpx.post(f"{FARMD}/internal/steps/started", json={"run_id": run_id}, timeout=15)
        if res.status_code == 200:
            return bool(res.json().get("active", True))
    except Exception as exc:
        log(f"run {run_id}: started notify failed: {exc}")
    return True


# HZ-130: the reason an unusable task file is reported under. Declared retryable
# in domain/reasons.json, so the step is auto-retried rather than paused for a
# human, and no server change is needed to report one — see the test that reads
# that flag back out of the declaration.
#
# Reached through the binding's constant rather than typed as a string. HZ-130
# added this as a literal, which left farm/pm_agent.py holding the one reason
# literal HZ-132 had just finished removing from the farm — and
# server/test/domain-reason-literals.test.mjs failing. Same value, one
# declaration: reasons.REASON raises KeyError on a typo, a literal does not.
UNUSABLE_TASK_REASON = reasons.REASON["UNREACHABLE"]


def report_failed_task(run_id: str, error: str) -> bool:
    """HZ-130: reports a task file the PM could never use, over the same farmd
    channel process() reports every other failure through.

    Returns whether the report was ACCEPTED — i.e. whether the run is now the
    server's problem and our copy of the file can be released. Anything that
    leaves us unsure (farmd down, the Node server unreachable, a 5xx) returns
    False so the file stays on disk and the next poll retries: an unreachable
    server is not evidence the run was handled, and the same rule
    _report_run_dead follows on the farmd side (farm/farmd.py).

    notify_started() is deliberately NOT called on this path. The server's own
    /fail handler owns the transition out of `active`; telling it the agent
    started, only to immediately fail, would just arm the execution timer.
    """
    payload = {"run_id": run_id, "ok": False, "error": error[:300], "reason": UNUSABLE_TASK_REASON}
    try:
        res = httpx.post(f"{FARMD}/internal/steps/result", json=payload, timeout=30)
    except Exception as exc:
        log(f"run {run_id}: could not report unusable task file: {exc} — keeping it to retry")
        return False
    if res.status_code != 200:
        log(f"run {run_id}: farmd rejected the failure report ({res.status_code}) — keeping it to retry")
        return False
    try:
        forwarded = int(res.json().get("forwarded", 0))
    except Exception:
        forwarded = 0
    if 200 <= forwarded < 300:
        return True
    if forwarded == 404:
        # The run no longer exists server-side; there is nothing left to
        # report it to, so holding the file would strand it on disk forever.
        log(f"run {run_id}: unknown server-side (404) — releasing the unusable task file")
        return True
    log(f"run {run_id}: failure report not accepted (forwarded {forwarded}) — keeping it to retry")
    return False


def session_file(project_slug: str) -> Path:
    return STATE_DIR / f"pm-session-{project_slug}.txt"


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
# Production never marks them: process() validates through
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
    A second over-budget reply propagates and process() reports the step
    failed with no patch."""


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


def _reject_over_budget(parsed: dict) -> None:
    """Raise FieldOverBudgetError for the first budgeted field over its limit.

    Measured on the stripped value, the same normalisation validate() applies,
    so whitespace padding never counts against the budget."""
    raw_patch = parsed.get("patch") if isinstance(parsed, dict) else None
    if not isinstance(raw_patch, dict):
        return
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


def validate_within_budget(parsed: dict) -> tuple[str, dict, str | None]:
    """validate(), but an over-budget metric or guardrails is rejected rather
    than cut and marked (HZ-264). The budget check runs FIRST: after validate()
    the value would already be cut, and the cut is what this exists to stop."""
    _reject_over_budget(parsed)
    return validate(parsed)


def process(task: dict, project_slug: str) -> bool:
    """Runs one PM step and reports it. Returns whether farmd accepted the
    result; a post that raises (farmd down) propagates to the caller.

    HZ-212: never resumes a session. Any stored session id is ignored — the
    HZ-204 context block is the only cross-item memory. The returned id is
    still written to the session file so a rollback build finds one."""
    run_id = task["run_id"]
    sid_path = session_file(project_slug)

    try:
        prompt = build_prompt(task)
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        # HZ-192: run_agent() resolves the model from who is calling — the
        # step's own domain/steps.json agent (PM, or Architect for "Set
        # guardrails") and its label.
        step_label = task["step"]["label"]
        model_agent = model_agent_for_step(steps.by_label(step_label)["agent"])
        reply = run_agent(prompt, agent=model_agent, step=step_label, session_id=None, append_system=ROLE_PROMPT)
        if reply.get("session_id"):
            sid_path.write_text(reply["session_id"])

        # One retry, telling the model exactly what was wrong with its reply.
        # Fresh, like the first call (HZ-212): it used to resume the session
        # the first call had just written, so the bare correction was enough.
        # With no resume the task prompt goes first, then the correction.
        # validate= keeps validation inside the retry envelope, so a reply that
        # parses but is missing 'summary' takes the retry exactly as it always did,
        # and so does an over-budget metric or guardrails (HZ-264).
        def retry_once(retry_prompt: str) -> str:
            log(f"run {run_id}: invalid reply; retrying once")
            retry = run_agent(
                f"{prompt}\n\n{retry_prompt}",
                agent=model_agent,
                step=step_label,
                session_id=None,
                append_system=ROLE_PROMPT,
            )
            return retry["result"]

        (summary, patch, artifact), notes = parse_agent_reply(
            reply["result"], retry_once, validate=validate_within_budget
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

    res = httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
    log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")
    return 200 <= res.status_code < 300


def _queued_tasks(queue: Path) -> list[Path]:
    """Queued task files, oldest first.

    A file can be unlinked between the glob and the stat — /steps/cancel drops
    PM-queue files (farm/farmd.py) — and an unhandled FileNotFoundError here
    would take the whole PM session down mid-poll. A vanished file simply
    sorts out of this batch instead.
    """
    dated = []
    for path in queue.glob("*.json"):
        try:
            dated.append((path.stat().st_mtime, path))
        except OSError:
            continue
    return [path for _mtime, path in sorted(dated, key=lambda pair: pair[0])]


def _past_report_bound(path: Path) -> bool:
    """Whether an unusable file has earned a report instead of another retry.

    Two conditions guard a report, and only the second is checked here.

    At least one failed read in *this* process, so a file caught mid-write is
    never reported on sight — enforced by the caller, by construction: this is
    only ever called from poll_once immediately after a read of `path` failed,
    and the failure counter is incremented before the call. There is
    deliberately no `attempts` check here; it could never be false.

    And an age past PM_MALFORMED_GRACE_S, checked here, which — unlike an
    in-memory counter that the watchdog's PM revival resets — a restart cannot
    rewind. That is the whole reason the bound is measured from mtime.
    """
    try:
        return time.time() - path.stat().st_mtime >= PM_MALFORMED_GRACE_S
    except OSError:
        return False  # vanished under us (a cancel): nothing to report


def _report_unusable(path: Path, why: str, attempts: int, failures: dict) -> bool:
    """Reports an unusable task file and releases it only if the report was
    accepted. The run_id comes from the filename stem — the contents are, by
    definition, not something we can read one out of.

    This unlink is the ONE case where a file that never parsed is removed, and
    it happens strictly after the server has acknowledged the failure. Keeping
    it instead would hold the run alive forever in farmd's /runs/alive, which
    is the stall this item exists to close.
    """
    run_id = path.stem
    error = f"pm_agent: task file {path.name} was unusable after {attempts} poll(s): {why}"
    log(f"run {run_id}: {error}")
    if not report_failed_task(run_id, error):
        return False
    path.unlink(missing_ok=True)
    failures.pop(path.name, None)
    log(f"run {run_id}: reported the unusable task file and released it")
    return True


def poll_once(queue: Path, project_slug: str, failures: dict) -> str:
    """One pass over the PM queue. Never sleeps — main() owns the pacing, so
    tests can drive polls back to back without patching time.

    Returns exactly one of:
      "processed" — a task parsed, was claimed, and ran
      "reported"  — an unusable task file was reported to the server
      "stale"     — a claimed task the server no longer considers active
      "skipped"   — only unusable files are queued; they stay on disk
      "idle"      — the queue is empty

    `failures` maps filename -> consecutive failed reads and is owned by the
    caller so the bound spans polls. Keys for files that are gone (processed,
    reported, or cancelled out from under us) are pruned every poll — this
    dict lives as long as the farm does.

    An unusable file is walked PAST, not stopped on: it is no longer deleted,
    so stopping at the head of the queue would let one corrupt file block
    every newer task for the whole grace window. Its own bound is checked as
    we walk past, so a busy queue can never starve the report either.

    A report that is not accepted returns "skipped", so the next poll retries
    it at main()'s pacing — the file is held, and the attempt is logged, until
    either the server takes it or a human does.
    """
    tasks = _queued_tasks(queue)
    present = {p.name for p in tasks}
    for name in [n for n in failures if n not in present]:
        failures.pop(name, None)
    if not tasks:
        return "idle"

    task = None
    task_path = None
    for candidate in tasks:
        parsed, why = read_task(candidate)
        if parsed is not None:
            task, task_path = parsed, candidate
            break
        attempts = failures.get(candidate.name, 0) + 1
        failures[candidate.name] = attempts
        if attempts == 1:  # log once per file, not once per poll
            log(f"keeping unusable task file {candidate.name} for the next poll: {why}")
        # The "one failed read in this process" half of the bound is satisfied
        # right here, by the read above; _past_report_bound only checks age.
        if _past_report_bound(candidate) and _report_unusable(candidate, why, attempts, failures):
            return "reported"
    if task is None:
        return "skipped"

    failures.pop(task_path.name, None)
    task_path.unlink(missing_ok=True)  # claim before work: no double-processing
    run_id = task["run_id"]
    if not notify_started(run_id):
        log(f"run {run_id}: no longer active server-side — skipping")
        return "stale"
    process(task, project_slug)
    return "processed"


def run_task(path: Path) -> int:
    """HZ-212: runs the one claimed task farmd launched this process for.

    The file is released only once farmd has accepted the result. Any other
    ending — an unreadable file, a result post that raised or was rejected —
    keeps it in queue/runs/active and exits non-zero; farmd's reconcile then
    finds the session gone and fails the run once with a retryable reason
    (or releases it quietly if the server already has the result)."""
    task, why = read_task(path)
    if task is None:
        log(f"task file {path.name} is unusable: {why} — keeping it for farmd's reconcile")
        return 1
    try:
        delivered = process(task, slugify(task_project(task)["name"]))
    except Exception as exc:
        log(f"run {task['run_id']}: result not delivered ({exc}) — keeping the task file for farmd's reconcile")
        return 1
    if not delivered:
        log(f"run {task['run_id']}: farmd did not accept the result — keeping the task file for farmd's reconcile")
        return 1
    path.unlink(missing_ok=True)
    return 0


def main() -> int | None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--task", help="run this one claimed task file and exit (how farmd launches PM steps)")
    mode.add_argument("--project", help="legacy polling loop over queue/pm (tests and rollback only)")
    parser.add_argument("--once", action="store_true", help="process one task and exit (testing)")
    args = parser.parse_args()
    if args.task:
        return run_task(Path(args.task))
    project_slug = slugify(args.project)

    ensure_dirs()
    queue = QUEUE_DIR / "pm"
    log(f"PM agent up for project '{args.project}' (queue: {queue})")

    failures: dict = {}
    while True:
        outcome = poll_once(queue, project_slug, failures)
        if args.once and outcome in ("processed", "reported", "stale"):
            return
        if outcome == "idle":
            time.sleep(1 if args.once else 2)
        elif outcome == "skipped":
            # Only unusable files are queued and none has earned a report yet.
            # Without this the loop would spin at 100% CPU now that the file
            # survives the poll instead of being deleted.
            time.sleep(2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted — exiting")
        sys.exit(130)
