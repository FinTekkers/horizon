"""Ephemeral step agent: executes exactly one lifecycle step, reports, exits.

Spawned by farmd in tmux session farm-run-<item>-s<step>-a<attempt>. Planning
steps (Ensemble / Eng plan / Architect review / QA) read the workspace when
one exists and produce a markdown artifact. The implement step works on the
item's branch in the workspace; the *script* owns git (branch, commit, push)
— the model only edits files.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import httpx

from .agent_runner import AgentError, extract_json, run_agent
from .checks import run_checks
from .config import FARM_PORT
from .personas import compose_role, resolve
from .rules import render_rules_section
from .workspaces import ensure_item_worktree, hub_lock

FARMD = f"http://127.0.0.1:{FARM_PORT}"
ROLES = Path(__file__).parent / "roles"
REPO_ROOT = Path(__file__).resolve().parent.parent
SMOKE_CHECK_SCRIPT = REPO_ROOT / "e2e" / "smoke" / "check.mjs"
SMOKE_CHECK_TIMEOUT_S = 60

# Write-side: a pathological-payload guard, not a working limit — the agent's
# own artifact must reach the server intact (HZ-29). The server budgets the
# *dispatched* total across artifacts; this only stops a runaway agent output.
WRITE_ARTIFACT_SANITY_CEILING_CHARS = 200_000
# Read-side: defense-in-depth for rendering prior artifacts into a prompt.
# The server already budgets the total it sends (~60k), so this should never
# fire in practice — mirrors farm/rules.py's MAX_PROMPT_RULES_CHARS backstop.
MAX_PROMPT_ARTIFACT_CHARS = 100_000

# step index -> (role file, needs JSON artifact, tool access, max turns,
#                timeout seconds, wants persona)
# Personas specialize only the steps that act on the item's stack — QA (8) and
# implement (11); the planning steps stay generalist.
PLANNER_TOOLS = "Read,Glob,Grep"
IMPLEMENT_TOOLS = "Read,Glob,Grep,Edit,Write,Bash"
# DevOps investigates and can hit live URLs (curl, gh cli, etc.) but never
# edits code — same read-only rationale as the reviewer, one step below.
DEVOPS_TOOLS = "Read,Glob,Grep,Bash"
STEP_CONFIG = {
    4: ("ensemble.md", True, PLANNER_TOOLS, 40, 1140, False),
    6: ("eng_plan.md", True, PLANNER_TOOLS, 40, 1140, False),
    7: ("architect_review.md", True, PLANNER_TOOLS, 40, 1140, False),
    8: ("qa.md", True, PLANNER_TOOLS, 40, 1140, True),
    11: ("eng_implement.md", False, IMPLEMENT_TOOLS, 160, 2700, True),
    # code_review.md is loaded here for the first (code) pass; qa_review.md
    # is loaded separately inside execute()'s step_index == 12 branch for the
    # second pass. Read-only tools: the reviewer can never edit, push, merge
    # or approve the human gate (HZ-30) — enforced here, not by prompt alone.
    12: ("code_review.md", True, PLANNER_TOOLS, 60, 1800, True),
    # DevOps is a role, not a persona (HZ-22 architecture review) — it is
    # project-scoped via farm/rules/projects/*.md, not stack-scoped, so it
    # never gets a persona composed in.
    14: ("devops.md", True, DEVOPS_TOOLS, 40, 900, False),
}

# Diff shown to both review passes is capped — a defensive bound on prompt
# size, not a claim that larger diffs can't happen.
REVIEW_DIFF_CHARS = 20000

# Subject-line marker for a salvage commit (HZ-31) — written by
# _salvage_checkpoint() and detected by _checkpoint_resume_note() so the next
# attempt's prompt can name it instead of silently continuing from it.
CHECKPOINT_MARKER = "WIP checkpoint — attempt exhausted"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def git(ws: Path, *args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=300, env=run_env)
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
    ]
    if item.get("release_tag"):
        lines.append(f"  release: {item['release_tag']}  ({item.get('release_url') or 'no url'}) — already published")
    lines += [
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
    return "\n".join(lines)


# ---- screenshot publishing (HZ-63) ----
# e2e/__screenshots__/*.png are gitignored, not committed — two branches that
# both touch the same journey no longer collide on a binary file. Instead
# they're force-pushed as an orphan commit to a per-item ref that
# server/src/github.js reads via the same contents-API path it already used
# for the PR-branch screenshots (naming here — "e2e-artifacts/<item-id>" —
# must match artifactsRef() there). Best-effort: a publish failure never fails
# the implement step, mirroring captureScreenshot's own warn-and-continue
# philosophy in e2e/fixtures/test-base.js.


def publish_screenshots(ws: Path, item: dict, log=log) -> None:
    shots_dir = ws / "e2e" / "__screenshots__"
    pngs = sorted(shots_dir.glob("*.png")) if shots_dir.is_dir() else []
    if not pngs:
        log("publish_screenshots: no screenshots to publish — skipped")
        return
    # NOT ws/".git": per-item worktrees (HZ-50) have a .git FILE containing
    # "gitdir: ...", not a directory, so writing an index inside it raises
    # ENOTDIR. GIT_INDEX_FILE may live anywhere, so use a temp path that is
    # correct for a worktree and a plain clone alike.
    index_fd, index_path = tempfile.mkstemp(prefix="horizon-artifacts-index-")
    os.close(index_fd)
    index_file = Path(index_path)
    env = {"GIT_INDEX_FILE": str(index_file)}
    try:
        index_file.unlink(missing_ok=True)
        for png in pngs:
            sha = git(ws, "hash-object", "-w", str(png), env=env).stdout.strip()
            git(ws, "update-index", "--add", "--cacheinfo", f"100644,{sha},e2e/__screenshots__/{png.name}", env=env)
        tree = git(ws, "write-tree", env=env).stdout.strip()
        commit = git(ws, "commit-tree", tree, "-m", f"{item['id']}: e2e screenshots").stdout.strip()
        ref = f"e2e-artifacts/{item['id'].lower()}"
        with hub_lock(item["repo"]):
            git(ws, "push", "origin", "--force", f"{commit}:refs/heads/{ref}")
        log(f"publish_screenshots: pushed {len(pngs)} screenshot(s) to {ref}")
    except Exception as exc:  # best-effort — never blocks the implement step
        log(f"publish_screenshots: skipped after a failure — {exc}")
    finally:
        # The cleanup must not raise either. A finally that throws escapes the
        # except above and fails the whole implement step — which is exactly
        # how the ENOTDIR above killed real runs despite this function being
        # documented as never blocking the step.
        try:
            index_file.unlink(missing_ok=True)
        except OSError as exc:
            log(f"publish_screenshots: could not remove temp index — {exc}")


def prepare_branch(ws: Path, item: dict) -> str:
    branch = f"horizon/{item['id'].lower()}"
    # A superseded/killed attempt leaves uncommitted edits behind; every new
    # attempt starts from a scrubbed tree (pushed branches are the only state
    # that survives an attempt). reset/clean only ever touch this item's own
    # worktree — no lock needed. fetch mutates the hub's shared
    # refs/remotes/origin/* (every item's worktree reads those), so it's
    # serialized against every other item's fetch/push on this repo.
    git(ws, "reset", "--hard")
    git(ws, "clean", "-fd")
    with hub_lock(item["repo"]):
        git(ws, "fetch", "origin", "--prune")
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    default = head.rsplit("/", 1)[-1] if head else "main"
    remote_branch = git(ws, "rev-parse", "--verify", f"origin/{branch}", check=False)
    base = f"origin/{branch}" if remote_branch.returncode == 0 else f"origin/{default}"
    git(ws, "checkout", "-B", branch, base)
    return branch


def _checkpoint_resume_note(ws: Path) -> str | None:
    """If HEAD is a salvage checkpoint left by a prior exhausted attempt
    (prepare_branch() already based this branch off origin/<branch>, so a
    pushed checkpoint is HEAD by construction), returns prompt text pointing
    the next attempt at it. Returns None for a normal, non-checkpoint HEAD."""
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    if CHECKPOINT_MARKER not in subject:
        return None
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    default = head.rsplit("/", 1)[-1] if head else "main"
    stat = git(ws, "diff", "--stat", f"origin/{default}...HEAD", check=False).stdout.strip()
    return (
        "\n\nNOTE: this branch already has a WIP checkpoint commit from a prior "
        f'attempt that ran out of turns/time ("{subject}"). Continue that work — '
        "read the diff below and pick up where it left off. Do not discard it or "
        f"restart from scratch.\n\n```\n{stat}\n```"
    )


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
    # Agent work branches are single-writer (the implement mutex): a rebase
    # rewriting earlier attempts is legitimate, so push with lease protection
    # rather than failing on non-fast-forward. Same hub-shared-refs lock as
    # the fetch in prepare_branch.
    with hub_lock(item["repo"]):
        git(ws, "push", "--force-with-lease", "-u", "origin", branch)
    stat = git(ws, "diff", "--stat", f"origin/{default}...HEAD", check=False).stdout.strip().splitlines()
    return {"branch": branch, "files_changed": stat[-1] if stat else ""}


# ---- checkpoint salvage on turn/time exhaustion (HZ-31) ----
# run_agent raises AgentError (AgentExhaustedError on exhaustion) when the
# implement step hits its max-turns or timeout cap (farm/agent_runner.py).
# Left alone, that exception propagates straight to main()'s catch-all and
# the workspace's uncommitted edits are destroyed by the *next* attempt's
# prepare_branch() (reset --hard + clean -fd) — a Sisyphus loop that can
# never converge on a job bigger than one budget. Salvage checkpoints
# whatever was on disk so the next attempt continues instead of restarting
# from zero.


def _salvage_checkpoint(ws: Path, item: dict, branch: str) -> None:
    """Best-effort: never raises. A salvage failure (e.g. a concurrent push
    winning the --force-with-lease race) just means this attempt's partial
    work is lost — the caller's original exception is what must still
    propagate and fail the run, unchanged from pre-HZ-31 behavior."""
    try:
        git(ws, "add", "-A")
        staged = git(ws, "diff", "--cached", "--quiet", check=False)
        if staged.returncode == 0:
            log("salvage: no uncommitted changes to checkpoint")
            return
        git(ws, "commit", "-m", f"{item['id']}: {CHECKPOINT_MARKER} (Horizon Eng agent)")
        with hub_lock(item["repo"]):
            git(ws, "push", "--force-with-lease", "-u", "origin", branch)
        log(f"salvage: pushed WIP checkpoint to {branch}")
    except Exception as exc:
        log(f"salvage: failed to checkpoint ({exc}) — work is lost, next attempt starts clean")


# ---- automated review verdict shaping (HZ-30) ----
# Defensive normalization of the two review passes' raw JSON into the shape
# server/src/orchestrator.js's validateVerdict() requires. Malformed fields
# default FAIL-CLOSED (never silently pass) — an agent returning garbage must
# not be read as approval; server-side validateVerdict is still the real gate.

_QA_AUTO_PASS = {
    "verdict": "pass",
    "regression_tests_run": True,
    "new_code_unit_coverage": True,
    "e2e_test_present": True,
    "findings": [],
}


def _findings(parsed: dict) -> list:
    findings = parsed.get("findings")
    return findings if isinstance(findings, list) else []


def _code_review_section(parsed: dict) -> dict:
    verdict = parsed.get("verdict")
    return {"verdict": verdict if verdict in ("pass", "fail") else "fail", "findings": _findings(parsed)}


def _qa_review_section(parsed: dict) -> dict:
    verdict = parsed.get("verdict")
    return {
        "verdict": verdict if verdict in ("pass", "fail") else "fail",
        "regression_tests_run": parsed.get("regression_tests_run") is True,
        "new_code_unit_coverage": parsed.get("new_code_unit_coverage") is True,
        "e2e_test_present": parsed.get("e2e_test_present") is True,
        "findings": _findings(parsed),
    }


def _review_summary(verdict: dict) -> str:
    parts = [
        f"code review {'passed' if verdict['code_review']['verdict'] == 'pass' else 'failed'}",
        f"QA review {'passed' if verdict['qa_review']['verdict'] == 'pass' else 'failed'}",
    ]
    summary = "; ".join(parts)
    for key in ("code_review", "qa_review"):
        section = verdict[key]
        if section["verdict"] != "fail" or not section["findings"]:
            continue
        first = section["findings"][0]
        detail = first.get("detail") if isinstance(first, dict) else None
        if detail:
            summary = f"{summary} — {detail}"
            break
    return summary[:600]


def _run_and_parse(
    prompt: str,
    *,
    append_system: str | None,
    cwd: str | None,
    max_turns: int,
    timeout_s: int,
    allowed_tools: str | None,
) -> dict:
    """run_agent + extract_json with one retry-with-feedback on a parse
    failure (HZ-44) — mirrors pm_agent.process()'s recovery. Asking the model
    to re-emit valid JSON is lossless; a genuine second failure still
    propagates so the run cancels and the item pauses, unchanged."""
    reply = run_agent(
        prompt, append_system=append_system, cwd=cwd, max_turns=max_turns, timeout_s=timeout_s, allowed_tools=allowed_tools
    )
    try:
        return extract_json(reply["result"])
    except (AgentError, json.JSONDecodeError) as exc:
        log(f"invalid reply ({exc}); retrying once")
        retry = run_agent(
            f"Your previous reply was invalid: {exc}. Respond again with ONLY the JSON object, no other text.",
            session_id=reply.get("session_id"),
            append_system=append_system,
            cwd=cwd,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
        )
        return extract_json(retry["result"])


# ---- deploy deep-verification (HZ-22) ----
# The DevOps agent picks the url/expected_text from the project rules — it
# knows the topology, this script doesn't — but the pass/fail GATE itself is
# decided HERE, by actually running e2e/smoke/check.mjs and reading its real
# exit code. Mirrors run_checks() at the implement step: a real subprocess
# result, never the model's own self-reported verdict, is what a production
# deploy gate trusts.


def run_smoke_check(url: str, expected_text: str) -> tuple[str, str]:
    try:
        result = subprocess.run(
            ["node", str(SMOKE_CHECK_SCRIPT), url, expected_text],
            capture_output=True,
            text=True,
            timeout=SMOKE_CHECK_TIMEOUT_S,
            cwd=str(REPO_ROOT),
        )
    except subprocess.TimeoutExpired:
        return "fail", f"SMOKE_RESULT=fail: check.mjs timed out after {SMOKE_CHECK_TIMEOUT_S}s ({url})"
    except OSError as exc:
        return "fail", f"SMOKE_RESULT=fail: could not run check.mjs: {exc}"

    line = next((l for l in result.stdout.splitlines() if l.startswith("SMOKE_RESULT=")), None)
    if result.returncode == 0 and line and line.startswith("SMOKE_RESULT=pass"):
        return "pass", line
    if line:
        return "fail", line
    return "fail", f"SMOKE_RESULT=fail: check.mjs exited {result.returncode} with no result line ({result.stderr.strip()[:200]})"


def execute(task: dict) -> dict:
    step_index = task["step"]["index"]
    role_file, wants_artifact, tools, max_turns, timeout_s, wants_persona = STEP_CONFIG[step_index]
    role = (ROLES / role_file).read_text()
    item = task["item"]
    if wants_persona:
        role = compose_role(role, item.get("persona"))

    ws = None
    if item.get("repo"):
        try:
            ws = ensure_item_worktree(item["repo"], item["id"])
        except RuntimeError:
            # Hub not provisioned for this repo (e.g. farm never started
            # cleanly against it) — same "no workspace" fallback as before.
            ws = None

    # Implement step without a repo/workspace: nothing real to build.
    if step_index == 11:
        if ws is None:
            if item.get("repo"):
                raise RuntimeError("workspace not provisioned for this repo — restart the farm")
            return {"summary": "no repository attached — implementation skipped (demo item)"}
        branch = prepare_branch(ws, item)
        log(f"workspace {ws} on branch {branch}")
        resume_note = _checkpoint_resume_note(ws)
        if resume_note:
            log("resuming a prior attempt's WIP checkpoint")
        try:
            reply = run_agent(
                build_prompt(task) + (resume_note or ""),
                append_system=role,
                cwd=str(ws),
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=tools,
            )
        except Exception:
            # SALVAGE (HZ-31): the run hit its turn/time cap (or any other
            # run_agent failure) — checkpoint whatever's on disk instead of
            # letting the next attempt's prepare_branch scrub it away. Still
            # re-raises unchanged: a failed attempt still fails and pauses,
            # no checks run, no PR opens, nothing advances.
            _salvage_checkpoint(ws, item, branch)
            raise
        # The summary is reporting, not the deliverable — the code in the
        # workspace is. Never torch a completed implement run over a
        # malformed final message; fall back and let checks judge the work.
        try:
            summary = str(extract_json(reply["result"]).get("summary", "implementation finished")).strip()[:600]
        except Exception:
            summary = "implementation finished (agent's final message was not valid JSON — see session log)"
        # Guardrail enforcement: the repo's own tests/linters run here, by the
        # script, before anything is committed or pushed. A failure fails the
        # run (Node pauses the item with the reason) — no green, no push.
        check_note = run_checks(ws, log)
        publish_screenshots(ws, item)
        artifacts = finalize_branch(ws, item, branch)
        return {"summary": f"{summary} · {check_note}"[:600], "artifacts": artifacts}

    # Automated review (HZ-30): two independent read-only passes over the
    # actual diff — code correctness against guardrails/the approved plan,
    # then test coverage against the implement step's own check-runner
    # evidence (delivered via task["artifacts"], widened server-side to
    # include the implement step's output). The merged, structured verdict
    # below is what the orchestrator's loop-cap logic reads — never prose.
    if step_index == 12:
        if ws is None:
            verdict = {"code_review": {"verdict": "pass", "findings": []}, "qa_review": dict(_QA_AUTO_PASS)}
            return {
                "summary": "no repository attached — automated review skipped (demo item)",
                "artifacts": {
                    "artifact_md": "## Code review\n**pass** — no repository attached.\n\n"
                    "## QA review\n**pass** — no repository attached.",
                    "verdict": verdict,
                },
            }

        # Reuse the implement step's own branch resolution: this item's
        # worktree is isolated from every other item's (HZ-50), but a
        # superseded/killed implement attempt on THIS item can still leave
        # uncommitted leftovers in it — scrub before reading the diff.
        branch = prepare_branch(ws, item)
        log(f"workspace {ws} on branch {branch} — reviewing diff")
        head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
        default = head.rsplit("/", 1)[-1] if head else "main"
        diff_stat = git(ws, "diff", "--stat", f"origin/{default}...HEAD", check=False).stdout.strip()
        diff_text = git(ws, "diff", f"origin/{default}...HEAD", check=False).stdout[:REVIEW_DIFF_CHARS]
        diff_section = f"## Code diff under review\n\n```\n{diff_stat}\n```\n\n```diff\n{diff_text}\n```"
        prompt = (
            build_prompt(task)
            + "\n\n"
            + diff_section
            + "\n\nRespond with ONLY the JSON object described in your role instructions."
        )

        code_parsed = _run_and_parse(
            prompt, append_system=role, cwd=str(ws), max_turns=max_turns, timeout_s=timeout_s, allowed_tools=tools
        )

        qa_role = (ROLES / "qa_review.md").read_text()
        if wants_persona:
            qa_role = compose_role(qa_role, item.get("persona"))
        qa_parsed = _run_and_parse(
            prompt, append_system=qa_role, cwd=str(ws), max_turns=max_turns, timeout_s=timeout_s, allowed_tools=tools
        )

        verdict = {"code_review": _code_review_section(code_parsed), "qa_review": _qa_review_section(qa_parsed)}
        artifact_md = "\n\n".join(
            part.strip()
            for part in (code_parsed.get("artifact_md"), qa_parsed.get("artifact_md"))
            if isinstance(part, str) and part.strip()
        )
        summary = _review_summary(verdict)
        feedback = task.get("feedback") or []
        if feedback:
            summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:600]
        return {
            "summary": summary,
            "artifacts": {"artifact_md": artifact_md[:WRITE_ARTIFACT_SANITY_CEILING_CHARS], "verdict": verdict},
        }

    # Deploy (HZ-22): the release is already published by the time this runs
    # (the JS orchestrator holds the GitHub token, not the farm — see
    # dispatchToFarm in server/src/orchestrator.js). This step is purely the
    # DevOps agent's deep post-deploy verification.
    if step_index == 14:
        if not item.get("repo") or item.get("issue") is None:
            return {
                "summary": "no repository attached — deploy verification skipped (demo item)",
                "artifacts": {
                    "artifact_md": "## Verdict\n**pass** — no repository attached; nothing to verify.",
                    "verdict": {"verdict": "pass"},
                },
            }

        prompt = (
            build_prompt(task)
            + "\n\nRespond with ONLY the JSON object described in your role instructions. Your "
            '"url" and "expected_text" fields are what this script independently re-verifies '
            "with e2e/smoke/check.mjs — pick an expected_text that is actually visible on that "
            "page right now."
        )
        parsed = _run_and_parse(
            prompt, append_system=role, cwd=None, max_turns=max_turns, timeout_s=timeout_s, allowed_tools=tools
        )
        summary = str(parsed.get("summary", "")).strip()[:600] or "deploy verification finished"
        artifact_md = str(parsed.get("artifact_md", "")).strip()

        url, expected_text = parsed.get("url"), parsed.get("expected_text")
        if not isinstance(url, str) or not url.strip() or not isinstance(expected_text, str) or not expected_text.strip():
            raise AgentError("devops reply missing 'url'/'expected_text' needed for deep verification")

        verdict, smoke_line = run_smoke_check(url.strip(), expected_text.strip())
        artifact_md = f"{artifact_md}\n\n## Machine-checked result\n`{smoke_line}`".strip()
        return {
            "summary": f"{summary} · {smoke_line}"[:600],
            "artifacts": {
                "artifact_md": artifact_md[:WRITE_ARTIFACT_SANITY_CEILING_CHARS],
                # Wrapped in an object, not a bare string: validateDeployVerdict in
                # server/src/orchestrator.js requires `typeof v === 'object'` with a
                # `.verdict` field — same wire contract the review step's verdict
                # already uses. See server/test/deploy-gate.test.mjs.
                "verdict": {"verdict": verdict},
            },
        }

    parsed = _run_and_parse(
        build_prompt(task) + "\n\nRespond with ONLY the JSON object described in your role instructions.",
        append_system=role,
        cwd=str(ws) if ws else None,
        max_turns=max_turns,
        timeout_s=timeout_s,
        allowed_tools=tools if ws else None,
    )
    summary = str(parsed.get("summary", "")).strip()[:600]
    if not summary:
        raise AgentError("agent reply missing 'summary'")

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
        result["artifacts"] = {"artifact_md": artifact[:WRITE_ARTIFACT_SANITY_CEILING_CHARS]}
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
