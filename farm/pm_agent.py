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

from .claude_runner import ClaudeError, ClaudeExhaustedError, extract_json, run_claude
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
# fire in practice — mirrors farm/rules.py's MAX_PROMPT_RULES_CHARS backstop.
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


def validate(parsed: dict) -> tuple[str, dict, str | None]:
    summary = str(parsed.get("summary", "")).strip()
    if not summary:
        raise ClaudeError("agent reply missing 'summary'")
    patch = {}
    for key, limit in PATCH_FIELDS.items():
        value = parsed.get("patch", {}).get(key) if isinstance(parsed.get("patch"), dict) else None
        if isinstance(value, str) and value.strip():
            patch[key] = value.strip()[:limit]
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
        reply = run_claude(prompt, session_id=session_id, append_system=ROLE_PROMPT, model=PM_MODEL)
        if reply.get("session_id"):
            sid_path.write_text(reply["session_id"])

        try:
            summary, patch, artifact = validate(extract_json(reply["result"]))
        except (ClaudeError, json.JSONDecodeError) as exc:
            # One retry, telling the model exactly what was wrong with its reply.
            log(f"run {run_id}: invalid reply ({exc}); retrying once")
            retry = run_claude(
                f"Your previous reply was invalid: {exc}. "
                "Respond again with ONLY the JSON object, no other text.",
                session_id=sid_path.read_text().strip() if sid_path.exists() else None,
                append_system=ROLE_PROMPT,
                model=PM_MODEL,
            )
            summary, patch, artifact = validate(extract_json(retry["result"]))

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
        # HZ-33: PM-queue steps never run repo checks, so the only distinct
        # category possible here is turn_cap (budget exhaustion) vs. infra —
        # decided from the exception type, same as step_agent.py's own agents.
        category = "turn_cap" if isinstance(exc, ClaudeExhaustedError) else "infra"
        log(f"run {run_id}: FAILED [{category}] — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:300], "category": category}

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
