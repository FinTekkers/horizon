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

from .claude_runner import ClaudeError, extract_json, run_claude
from .config import FARM_PORT, PM_MODEL, QUEUE_DIR, STATE_DIR, ensure_dirs, slugify

ROLE_PROMPT = (Path(__file__).parent / "roles" / "pm.md").read_text()
PATCH_FIELDS = {"desc": 500, "metric": 400, "guardrails": 400}
FARMD = f"http://127.0.0.1:{FARM_PORT}"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


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
        "",
        f"Step to perform now: \"{step['label']}\" (attempt {task.get('attempt', 1)})",
    ]
    for artifact in task.get("artifacts") or []:
        lines.append("")
        lines.append(f"Prior artifact — {artifact.get('label', 'earlier step')}:")
        lines.append(artifact.get("content", "")[:12000])
    feedback = task.get("feedback") or []
    if feedback:
        lines.append("")
        lines.append("Human feedback to address:")
        for fb in feedback:
            lines.append(f"- {fb.get('message', '')}")
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
    artifact = artifact.strip()[:12000] if isinstance(artifact, str) and artifact.strip() else None
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
                artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"[:12000]

        result = {"run_id": run_id, "ok": True, "summary": summary, "patch": patch}
        if artifact:
            result["artifacts"] = {"artifact_md": artifact}
    except Exception as exc:  # report every failure; farmd forwards to the server
        log(f"run {run_id}: FAILED — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:300]}

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
        process(task, project_slug)
        if args.once:
            return


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted — exiting (farmd's watchdog will restart this agent)")
        sys.exit(130)
