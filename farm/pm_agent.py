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

from domain.py import reasons

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
    PM_MODEL,
    QUEUE_DIR,
    STATE_DIR,
    ensure_dirs,
    slugify,
)
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


# HZ-130: the reason an unusable task file is reported under. Already in the
# server's AUTO_RETRY_REASONS (server/src/orchestrator.js), so the step is
# auto-retried rather than paused for a human, and no server change is needed
# to report one — see the test that reads that set back out of the server.
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
        reply = run_agent(prompt, session_id=session_id, append_system=ROLE_PROMPT, model=PM_MODEL)
        if reply.get("session_id"):
            sid_path.write_text(reply["session_id"])

        # One retry, telling the model exactly what was wrong with its reply.
        # The session is re-read inside the closure, as it was before the
        # parse path moved into agent_runner — the helper parses, this module
        # still owns the run and the session file. validate= keeps validation
        # inside the retry envelope, so a reply that parses but is missing
        # 'summary' takes the retry exactly as it always did.
        def retry_once(prompt: str) -> str:
            log(f"run {run_id}: invalid reply; retrying once")
            retry = run_agent(
                prompt,
                session_id=sid_path.read_text().strip() if sid_path.exists() else None,
                append_system=ROLE_PROMPT,
                model=PM_MODEL,
            )
            return retry["result"]

        (summary, patch, artifact), notes = parse_agent_reply(
            reply["result"], retry_once, validate=validate
        )

        # Script-stamped feedback trail, same as the ephemeral agents.
        feedback = task.get("feedback") or []
        if feedback:
            summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:300]
            if artifact:
                header = "\n".join(f"> {fb.get('message', '')}" for fb in feedback)
                artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"[:WRITE_ARTIFACT_SANITY_CEILING_CHARS]

        # Parser notes reach the human on both surfaces this step owns: the
        # run's output line (server/src/orchestrator.js persists `summary` as
        # step_run.output) and the step's artifact. No-ops when empty.
        summary = stamp_notes(summary, notes, 300)
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

    httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
    log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")


def read_task(path: Path) -> tuple[dict | None, str]:
    """HZ-130: reads one queued task file WITHOUT ever deleting it.

    Returns `(task, "")` when the file is usable, or `(None, reason)` when it
    is not: a truncated or corrupt payload, a file we could not read at all,
    or valid JSON missing the one field the PM cannot proceed without.

    OSError is caught alongside JSONDecodeError on purpose, and that does not
    turn this into "catch wider and continue" — the caller retries a bounded
    number of times and then *reports*, so a file we cannot read still ends in
    a report rather than in silence.

    `run_id` is validated here, at the boundary, rather than being trusted
    deeper in: process() reads it before its own try block, so a task file
    that parses but carries no run_id used to kill the loop with a KeyError
    *after* the file had already been unlinked — the same silent-loss shape as
    the malformed case, on a neighbouring input. Nothing else is validated
    here: any other missing field surfaces inside process(), which reports it.
    """
    try:
        task = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return None, f"unparseable JSON ({exc})"
    except OSError as exc:
        return None, f"unreadable ({exc})"
    if not isinstance(task, dict):
        return None, f"not a JSON object (got {type(task).__name__})"
    if task.get("run_id") in (None, ""):
        return None, "no run_id field"
    return task, ""


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--once", action="store_true", help="process one task and exit (testing)")
    args = parser.parse_args()
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
        log("interrupted — exiting (farmd's watchdog will restart this agent)")
        sys.exit(130)
