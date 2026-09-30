"""The long-running PM agent loop. Runs inside tmux session farm-pm-<project>.

A deliberate *script* around the model: it takes tasks from the filesystem
queue (written by farmd), executes exactly one lifecycle step per task via a
resumed Claude session (context accumulates across items for the life of the
farm), and reports the result back to farmd. It never decides what runs next
— the Node orchestrator does.
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

from .agent_runner import AgentError, AgentExhaustedError, parse_agent_reply, read_and_clear_handoff_note, run_agent
from .config import FARM_PORT, PM_MODEL, QUEUE_DIR, STATE_DIR, ensure_dirs, slugify
from .rules import render_rules_section

ROLE_PROMPT = (Path(__file__).parent / "roles" / "pm.md").read_text()
# persona: specialist routing tag (HZ-4) — the server registry-validates it
# and drops re-proposals over a set value, so the limit is just a size cap.
PATCH_FIELDS = {"desc": 500, "metric": 400, "guardrails": 400, "persona": 40}
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


def session_file(project_slug: str) -> Path:
    return STATE_DIR / f"pm-session-{project_slug}.txt"


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
        f"  persona: {item.get('persona') or '(not set)'}",
        "",
        f"Step to perform now: \"{step['label']}\" (attempt {task.get('attempt', 1)})",
    ]
    handoff_note = read_and_clear_handoff_note(item["id"], step["index"])
    if handoff_note:
        lines.append("")
        lines.append(
            "NOTE (unverified): the previous attempt ran out of turn/time budget "
            f"partway through. It reported: {handoff_note}"
        )
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
    rules_section = render_rules_section(task.get("rules"))
    if rules_section:
        lines.append("")
        lines.append(rules_section)
    lines.append("")
    lines.append("Respond with ONLY the JSON object described in your role instructions.")
    return "\n".join(lines)


# Fields that carry prose a human or agent reads, as opposed to `persona` — a
# registry-validated routing enum the server drops outright unless it exactly
# matches a known persona id, so a marker there would decorate a value that's
# discarded either way.
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


def validate(parsed: dict) -> tuple[str, dict, str | None]:
    summary = str(parsed.get("summary", "")).strip()
    if not summary:
        raise AgentError("agent reply missing 'summary'")
    patch = {}
    for key, limit in PATCH_FIELDS.items():
        value = parsed.get("patch", {}).get(key) if isinstance(parsed.get("patch"), dict) else None
        if isinstance(value, str) and value.strip():
            value = value.strip()
            patch[key] = _mark_truncated(value, limit) if key in MARKED_PATCH_FIELDS else value[:limit]
    artifact = parsed.get("artifact_md")
    artifact = artifact.strip()[:WRITE_ARTIFACT_SANITY_CEILING_CHARS] if isinstance(artifact, str) and artifact.strip() else None
    return summary[:300], patch, artifact


def process(task: dict, project_slug: str) -> None:
    run_id = task["run_id"]
    sid_path = session_file(project_slug)
    session_id = sid_path.read_text().strip() if sid_path.exists() else None

    try:
        prompt = build_prompt(task)
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        parsed, reply_meta, notes = parse_agent_reply(
            prompt,
            run_agent_fn=run_agent,
            session_id=session_id,
            append_system=ROLE_PROMPT,
            model=PM_MODEL,
            handoff_item_id=task["item"]["id"],
            handoff_step_index=task["step"]["index"],
        )
        if reply_meta.get("session_id"):
            sid_path.write_text(reply_meta["session_id"])

        # Guardrail: any repair that altered bytes gets a note in BOTH the
        # run's output line and the artifact — never a silent rewrite.
        for note in notes:
            log(f"run {run_id}: repair — {note}")

        summary, patch, artifact = validate(parsed)
        if notes:
            note_line = f"Repairs applied: {'; '.join(notes)}"
            artifact = f"{artifact}\n\n---\n{note_line}" if artifact else note_line

        # Script-stamped feedback trail, same as the ephemeral agents.
        feedback = task.get("feedback") or []
        if feedback:
            summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:300]
            if artifact:
                header = "\n".join(f"> {fb.get('message', '')}" for fb in feedback)
                artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"[:WRITE_ARTIFACT_SANITY_CEILING_CHARS]

        result = {"run_id": run_id, "ok": True, "summary": summary, "patch": patch}
        if artifact:
            result["artifacts"] = {"artifact_md": artifact}
    except Exception as exc:  # report every failure; farmd forwards to the server
        log(f"run {run_id}: FAILED — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:300]}
        # HZ-76/HZ-124: tag the one failure cause the orchestrator auto-retries
        # from this side (running out of turn/time budget) — mirrors
        # step_agent.main()'s identical tagging.
        if isinstance(exc, AgentExhaustedError):
            result["reason"] = "turn_cap"

    httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
    log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--once", action="store_true", help="process one task and exit (testing)")
    args = parser.parse_args()
    project_slug = slugify(args.project)

    ensure_dirs()
    queue = QUEUE_DIR / "pm"
    log(f"PM agent up for project '{args.project}' (queue: {queue})")

    while True:
        tasks = sorted(queue.glob("*.json"), key=lambda p: p.stat().st_mtime)
        if not tasks:
            if args.once:
                time.sleep(1)
                continue
            time.sleep(2)
            continue
        task_path = tasks[0]
        try:
            task = json.loads(task_path.read_text())
        except json.JSONDecodeError:
            log(f"dropping unreadable task file {task_path.name}")
            task_path.unlink(missing_ok=True)
            continue
        task_path.unlink(missing_ok=True)  # claim before work: no double-processing
        if not notify_started(task["run_id"]):
            log(f"run {task['run_id']}: no longer active server-side — skipping")
            if args.once:
                return
            continue
        process(task, project_slug)
        if args.once:
            return


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted — exiting (farmd's watchdog will restart this agent)")
        sys.exit(130)
