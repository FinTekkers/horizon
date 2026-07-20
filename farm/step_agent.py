"""Ephemeral step agent: executes exactly one lifecycle step, reports, exits.

Spawned by farmd in tmux session farm-run-<item>-s<step>-a<attempt>. Planning
steps (Ensemble / Eng plan / Architect review / QA) read the workspace when
one exists and produce a markdown artifact. The implement step works on the
item's branch in the workspace; the *script* owns git (branch, commit, push)
— the model only edits files.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import httpx

from .checks import run_checks
from .claude_runner import ClaudeError, extract_json, run_claude
from .config import FARM_PORT
from .personas import compose_role, resolve
from .workspaces import workspace_path

FARMD = f"http://127.0.0.1:{FARM_PORT}"
ROLES = Path(__file__).parent / "roles"

# step index -> (role file, needs JSON artifact, tool access, max turns,
#                timeout seconds, wants persona)
# Personas specialize only the steps that act on the item's stack — QA (8) and
# implement (11); the planning steps stay generalist.
PLANNER_TOOLS = "Read,Glob,Grep"
IMPLEMENT_TOOLS = "Read,Glob,Grep,Edit,Write,Bash"
STEP_CONFIG = {
    4: ("ensemble.md", True, PLANNER_TOOLS, 16, 900, False),
    6: ("eng_plan.md", True, PLANNER_TOOLS, 16, 900, False),
    7: ("architect_review.md", True, PLANNER_TOOLS, 16, 900, False),
    8: ("qa.md", True, PLANNER_TOOLS, 16, 900, True),
    11: ("eng_implement.md", False, IMPLEMENT_TOOLS, 80, 2400, True),
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def git(ws: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=300)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def build_prompt(task: dict) -> str:
    item, step = task["item"], task["step"]
    lines = [
        f"Work item {item['id']}: {item['title']}",
        f"  repo: {item.get('repo') or '(none — no code workspace for this item)'}   issue: #{item.get('issue') or '-'}   priority: {item.get('priority')}",
        f"  outcome: {item.get('desc') or '(empty)'}",
        f"  success metric: {item.get('metric') or '(empty)'}",
        f"  guardrails: {item.get('guardrails') or '(defaults only)'}",
        f"  persona: {resolve(item.get('persona'))}",
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
    return "\n".join(lines)


def prepare_branch(ws: Path, item: dict) -> str:
    branch = f"horizon/{item['id'].lower()}"
    git(ws, "fetch", "origin", "--prune")
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    default = head.rsplit("/", 1)[-1] if head else "main"
    remote_branch = git(ws, "rev-parse", "--verify", f"origin/{branch}", check=False)
    base = f"origin/{branch}" if remote_branch.returncode == 0 else f"origin/{default}"
    git(ws, "checkout", "-B", branch, base)
    return branch


def finalize_branch(ws: Path, item: dict, branch: str) -> dict:
    git(ws, "add", "-A")
    staged = git(ws, "diff", "--cached", "--quiet", check=False)
    if staged.returncode != 0:  # there are staged changes
        git(ws, "commit", "-m", f"{item['id']}: {item['title']} (Horizon Eng agent)")
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    default = head.rsplit("/", 1)[-1] if head else "main"
    ahead = git(ws, "rev-list", "--count", f"origin/{default}..HEAD", check=False).stdout.strip()
    if ahead == "0":
        raise RuntimeError("the agent made no code changes — nothing to push")
    git(ws, "push", "-u", "origin", branch)
    stat = git(ws, "diff", "--stat", f"origin/{default}...HEAD", check=False).stdout.strip().splitlines()
    return {"branch": branch, "files_changed": stat[-1] if stat else ""}


def execute(task: dict) -> dict:
    step_index = task["step"]["index"]
    role_file, wants_artifact, tools, max_turns, timeout_s, wants_persona = STEP_CONFIG[step_index]
    role = (ROLES / role_file).read_text()
    item = task["item"]
    if wants_persona:
        role = compose_role(role, item.get("persona"))

    ws = workspace_path(item["repo"]) if item.get("repo") else None
    if ws is not None and not (ws / ".git").exists():
        ws = None

    # Implement step without a repo/workspace: nothing real to build.
    if step_index == 11:
        if ws is None:
            if item.get("repo"):
                raise RuntimeError("workspace not provisioned for this repo — restart the farm")
            return {"summary": "no repository attached — implementation skipped (demo item)"}
        branch = prepare_branch(ws, item)
        log(f"workspace {ws} on branch {branch}")
        reply = run_claude(
            build_prompt(task),
            append_system=role,
            cwd=str(ws),
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=tools,
        )
        summary = str(extract_json(reply["result"]).get("summary", "implementation finished")).strip()[:600]
        # Guardrail enforcement: the repo's own tests/linters run here, by the
        # script, before anything is committed or pushed. A failure fails the
        # run (Node pauses the item with the reason) — no green, no push.
        check_note = run_checks(ws, log)
        artifacts = finalize_branch(ws, item, branch)
        return {"summary": f"{summary} · {check_note}"[:600], "artifacts": artifacts}

    reply = run_claude(
        build_prompt(task) + "\n\nRespond with ONLY the JSON object described in your role instructions.",
        append_system=role,
        cwd=str(ws) if ws else None,
        max_turns=max_turns,
        timeout_s=timeout_s,
        allowed_tools=tools if ws else None,
    )
    parsed = extract_json(reply["result"])
    summary = str(parsed.get("summary", "")).strip()[:600]
    if not summary:
        raise ClaudeError("agent reply missing 'summary'")

    # The feedback that drove a rework is stamped into the record by the
    # script — visible in the activity feed and at the top of the artifact —
    # so nobody has to guess what a revision was responding to.
    feedback = task.get("feedback") or []
    if feedback:
        summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:600]

    result = {"summary": summary}
    if wants_artifact and isinstance(parsed.get("artifact_md"), str) and parsed["artifact_md"].strip():
        artifact = parsed["artifact_md"].strip()
        if feedback:
            header = "\n".join(f"> {fb.get('message', '')}" for fb in feedback)
            artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"
        result["artifacts"] = {"artifact_md": artifact[:12000]}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    task = json.loads(Path(args.task).read_text())
    run_id = task["run_id"]

    try:
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        outcome = execute(task)
        result = {"run_id": run_id, "ok": True, **outcome}
    except Exception as exc:
        log(f"run {run_id}: FAILED — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:300]}

    httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
    log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")
    Path(args.task).unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
