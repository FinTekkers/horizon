"""HO-845: one stage of the per-command checks of an owner's one-command patch.

After an owner patches exactly one command `k` of an approved Task run plan
(HO-843), the server holds k's PIN Approve card until k passes three stages,
in order, each a separate farmd job (POST /commands/check):

- `audit`     — HO-836's contract audit (run_plan_requires.contract_gaps);
- `preflight` — HO-837's preflight (farm/preflight.py run), observe-only;
- `rehearsal` — HO-839's rehearsal in the read-only sandbox (farmd._rehearse).

Every stage runs on a one-command block holding only k (one_command_block),
after re-checking that the plan is the one on record and that k's text still
hashes to the hash the server sent — so no stage ever checks another command
or another text.

Fail closed: a stage that finds anything is `fail`; one that raises is
`error` (the server stores both as a fail). The result is built from an
allowlist only (_result): the stage, status, k's hash, a reason id from
domain/runPlanContract.json `commandCheckReasons`, and a summary of names,
access flags and rehearsal reason ids. Never a command's output, an
exception's text, a secret value or a file's contents.
"""

import json
import re
import time

from domain.py import run_plan

from . import container_runner, preflight, run_plan_requires, task_job

STAGES = tuple(run_plan.CONTRACT["commandCheckStages"])
REASONS = tuple(run_plan.CONTRACT["commandCheckReasons"])
FAILED = "command_check_failed"
ERROR = "command_check_error"
UNAVAILABLE = "command_check_unavailable"
HASH_CHANGED = "command_hash_changed"

# The same patterns server/src/commandChecks.js cleanSummary() accepts.
_NAME = re.compile(r"^[A-Za-z0-9._@+/:~-]{1,200}$")
_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
_PATH = re.compile(r"^[A-Za-z0-9._@+/~-]{1,300}$")
_WHAT = re.compile(r"^[a-z_]+(?: [a-z_]+)*(?: \d+)?(?: \(metric line \d+\))?$")
_GAP_KINDS = frozenset(
    {"container", "cwd", "deploy", "env", "file", "jobs", "login_env", "path", "plan", "precondition", "probe", "runner", "run_user", "service", "tool"}
)
_REHEARSAL_REASONS = frozenset(run_plan.CONTRACT["rehearsalReasons"])
LIST_MAX = 50


def command_hash_of(command: str) -> str:
    """k's hash: sha256 hex of its UTF-8 text, the same function Execute and
    the server's per-command approval use (task_job.command_hash_of)."""
    return task_job.command_hash_of(command)


def one_command_block(block: dict, k: int) -> dict:
    """The plan with only command k (0-based), as command 1. Every other key
    is kept; `proof` and `rehearsal.samples` keep only k's entries,
    renumbered. Raises IndexError for a k outside the plan."""
    command = block["commands"][k]
    one = {key: value for key, value in block.items() if key not in ("commands", "proof", "rehearsal")}
    one["commands"] = [command]
    proof = [dict(entry, command=1) for entry in block.get("proof") or [] if isinstance(entry, dict) and entry.get("command") == k + 1]
    if proof:
        one["proof"] = proof
    rehearsal = block.get("rehearsal")
    if isinstance(rehearsal, dict):
        kept = {key: value for key, value in rehearsal.items() if key != "samples"}
        samples = [dict(s, command=1) for s in rehearsal.get("samples") or [] if isinstance(s, dict) and s.get("command") == k + 1]
        if samples:
            kept["samples"] = samples
        one["rehearsal"] = kept
    return one


def one_command_artifact(block: dict) -> str:
    """A Run plan artifact holding only `block`, for the preflight and
    rehearsal runners, which read a plan from an artifact."""
    return f"## Run plan block\n```{run_plan.FENCE_INFO}\n{json.dumps(block, indent=2)}\n```"


def _gaps(entries) -> list[dict]:
    return [{"kind": e["kind"], "name": e["name"]} for e in entries if e.get("kind") in _GAP_KINDS and _NAME.match(str(e.get("name") or ""))][:LIST_MAX]


def _result(stage: str, command_hash, status: str, reason: str | None = None, summary: dict | None = None) -> dict:
    return {
        "stage": stage,
        "status": status,
        "command_hash": command_hash if isinstance(command_hash, str) else "",
        "reason": reason if reason in REASONS else (None if status == "pass" else ERROR),
        "summary": summary or {},
    }


def _preflight_summary(unmet: list) -> dict:
    found = [u for u in unmet if isinstance(u, dict)]
    return {
        "gaps": _gaps(found),
        "env": [{"name": u["name"], "set": False} for u in found if u.get("kind") == "env" and _ENV_NAME.match(str(u.get("name") or ""))][:LIST_MAX],
        "files": [{"path": u["name"], "readable": False} for u in found if u.get("kind") == "file" and _PATH.match(str(u.get("name") or ""))][:LIST_MAX],
    }


def _rehearsal_summary(result: dict) -> dict:
    failures = []
    for f in result.get("failures") or []:
        if not isinstance(f, dict) or f.get("reason") not in _REHEARSAL_REASONS or not _WHAT.match(str(f.get("what") or "")):
            continue
        exit_code = f.get("exit")
        failures.append({"what": f["what"], "reason": f["reason"], "exit": exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None})
    return {"failures": failures[:LIST_MAX]}


def run_stage(stage: str, task: dict, *, rehearse) -> dict:
    """One stage of k's checks, as the server's callback body. `task` is the
    server's payload (plan_artifact, plan_hash, command_index, command_hash,
    runner, the checkout fields) with farmd's preflight context stamped on.
    `rehearse(task) -> result` is farmd's sandbox rehearsal. Never raises."""
    command_hash = task.get("command_hash")
    try:
        if stage not in STAGES:
            return _result(str(stage), command_hash, "error", ERROR)
        artifact = task.get("plan_artifact") or ""
        if not task.get("plan_hash") or task_job.plan_hash_of(artifact) != task.get("plan_hash"):
            return _result(stage, command_hash, "fail", HASH_CHANGED)
        block = run_plan.extract(artifact)
        k = task.get("command_index")
        if not isinstance(k, int) or isinstance(k, bool) or not 0 <= k < len(block["commands"]):
            return _result(stage, command_hash, "fail", HASH_CHANGED)
        if command_hash_of(block["commands"][k]) != command_hash:
            return _result(stage, command_hash, "fail", HASH_CHANGED)
        one = one_command_block(block, k)
        if stage == "audit":
            gaps = run_plan_requires.contract_gaps(one)
            return _result(stage, command_hash, "fail" if gaps else "pass", FAILED if gaps else None, {"gaps": _gaps(gaps)})
        one_task = dict(task, plan_artifact=one_command_artifact(one))
        one_task["plan_hash"] = task_job.plan_hash_of(one_task["plan_artifact"])
        if stage == "preflight":
            checked = preflight.run(one_task, deadline=time.monotonic() + preflight.CAP_S)
            passed = checked.get("passed") is True
            return _result(stage, command_hash, "pass" if passed else "fail", None if passed else FAILED, _preflight_summary(checked.get("unmet") or []))
        rehearsed = rehearse(one_task)
        clean = isinstance(rehearsed, dict) and rehearsed.get("clean") is True and not rehearsed.get("failures")
        return _result(stage, command_hash, "pass" if clean else "fail", None if clean else FAILED, _rehearsal_summary(rehearsed if isinstance(rehearsed, dict) else {}))
    except container_runner.Unavailable:
        return _result(stage, command_hash, "error", UNAVAILABLE)
    except run_plan_requires.Unavailable:
        return _result(stage, command_hash, "error", UNAVAILABLE)
    except Exception:  # noqa: BLE001 — fail closed; an exception's text could hold a value
        return _result(stage, command_hash, "error", ERROR)
