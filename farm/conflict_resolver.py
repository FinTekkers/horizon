"""HZ-92: deterministic, LLM-free merge-conflict resolution.

A PR that only needs a mechanical merge conflict resolved (renames,
deletions, non-overlapping edits) today has exactly one lever: send the item
back to the full "Specialist agent implements" step — a fresh agent, fresh
context, 15-40 minutes, for maybe ten minutes of mechanical work.

This module is the fast path: plain `git merge` of the PR's target branch
into the item's existing branch, in its existing worktree, gated on the
repo's own test suite actually passing — no agent, no judgment call. It
NEVER uses `--ours`/`--theirs` (that would silently discard one side's
changes) and never force-pushes: a clean merge is a fast-forward from the
branch's previous tip by construction, so a plain `git push` is always
sufficient and safe.

Escalation (falling back to the full implement cycle) happens whenever this
script cannot be certain the result is correct:
  - real, overlapping conflicts git itself could not resolve
  - the merge resolves cleanly but the repo's own tests then fail

Conflict detection reads git's own index state (`git status --porcelain`),
never a text search for `<<<<<<<` — a file that legitimately contains that
string (a diff fixture, a markdown doc about git) must never be misread as a
live conflict marker.

HZ-154 adds ONE narrow middle path between "git merged it" and "re-implement
the whole item": _scoped_resolve(). An overlapping conflict small enough to
fit the caps in config.py is resolved hunk-by-hunk — deterministically where
both sides only added lines, by a tool-restricted agent otherwise — and then
reviewed on the *resolution delta* alone, not on the whole PR diff again.
Everything the mechanical path does above stays byte-for-byte unchanged, and
the scoped path keeps its own guarantees in code, not in a prompt:

  - every non-conflict byte is compared against a reference text this process
    generated from git's index stages (farm/conflict_hunks.py)
  - no file outside the conflicted set may differ (a before/after snapshot)
  - the repo's checks must actually RUN and pass — no green, no push
  - the push is --force-with-lease against the exact head that was resolved,
    after re-verifying origin has not moved
  - it only ever returns the item to the Accept gate for a human; it never
    approves a gate, never touches a step_run row, never bypasses a PIN

HZ-256: a self-deploy can stop a running resolve before horizon-server
restarts (farmd's POST /conflicts/cancel -> request_cancel()). Each run
registers a cancel event while it runs; once that is set, the run checks it
between stages, at every escalation and inside hub_lock just before any push,
and raises Cancelled instead of escalating or pushing. Nothing sets the event
except that route, so with no deploy running every check is a no-op.
"""

import contextlib
import contextvars
import os
import subprocess
import threading
from pathlib import Path

from domain.py.personas import CONFLICT_MODEL_AGENT, CONFLICT_STEP_KEY

from . import agent_runner, check_record, conflict_hunks
from .agent_runner import AgentError
from .check_slots import WaitCancelled
from .checks import CheckFailure, run_checks
from .conflict_hunks import MarkerRemaining, ScopeViolation, UnsupportedConflict
from .config import CONFLICT_AGENT_TIMEOUT_S, CONFLICT_REVIEW_TIMEOUT_S, CONFLICT_SCOPED_ENABLED

# HZ-154: the roles directory and the fail-closed verdict shaping the
# automated review step already uses — imported rather than copied, so
# "anything that is not exactly 'pass' is a fail" keeps exactly one definition
# in this codebase. step_agent does not import this module, so the dependency
# stays one-directional; nothing in it is modified by this file.
from .step_agent import ROLES, _code_review_section as _review_section
from .workspaces import ensure_item_worktree, hub_lock

# Bounded like every other git subprocess in this codebase (step_agent.py,
# workspaces.py) — a hung git process must not hang the resolution forever.
GIT_TIMEOUT_S = 300

# The cap every escalation detail and scoped-review summary already carried.
# Named rather than repeated as a bare 400, because _with_notes() has to
# reserve room INSIDE it: a parser note appended and then sliced off the end is
# a note that did not arrive, which is the silent repair HZ-157 forbids.
DETAIL_LIMIT = 400

# Whose reply a note describes. The resolution agent's notes are stamped by
# _escalate() onto details that may ALREADY carry the scoped review's own notes,
# so the two groups need telling apart. Both contain "parser notes".
RESOLUTION_NOTE_LABEL = "resolution reply parser notes"

# Index status codes from `git status --porcelain=v1` that mean "still
# unmerged" — any code with a 'U' in either column, plus the two "both sides
# touched it the same way" pairs that porcelain reports without a 'U'.
_UNMERGED_CODES = {"AA", "DD"}

# HZ-154 (scoped path only). The resolution agent gets Edit but never Write
# (no new files) and never Bash (no git, so it cannot stage, commit, push, or
# hide an edit from the before/after snapshot). The reviewer is read-only,
# like the automated review step's own tools.
RESOLUTION_TOOLS = "Read,Glob,Grep,Edit"
REVIEW_TOOLS = "Read,Glob,Grep"
RESOLUTION_MAX_TURNS = 12
REVIEW_MAX_TURNS = 6

# Every reason resolve() can report, in one place. server/src/orchestrator.js's
# CONFLICT_ESCALATION_REASONS must hold a human message for each — enforced by
# server/test/orchestrator-conflict-reason-parity.test.mjs, because a typo here
# would otherwise fall through to the raw detail string in the item's feedback.
#
# Deliberately NOT in domain/reasons.json: that vocabulary is the step-run
# failure/retry contract (retryable flags, three bindings, HZ-132). These are a
# farmd -> orchestrator detail of one gate action, with no retry semantics.
ESCALATION_REASONS = (
    # mechanical path (HZ-92), unchanged
    "merge_conflict",
    "tests_failed",
    "branch_missing",
    "push_rejected",
    # scoped path (HZ-154)
    "conflict_unsupported",
    "conflict_too_large",
    "resolution_unsure",
    "resolution_out_of_scope",
    "markers_remaining",
    "scoped_review_rejected",
    "scoped_checks_failed",
)


# ---- HZ-256: cancelling a run for a self-deploy ----


class Cancelled(Exception):
    """The run was cancelled (farmd's /conflicts/cancel). Raised instead of an
    escalation or a push; the worktree is already reset when it propagates."""


# One event per running resolve(), keyed by (repo, lowercased item id) like
# item_lock(). item_lock is held around every resolve(), so a key has at most
# one entry.
_ACTIVE: dict[tuple[str, str], threading.Event] = {}
_ACTIVE_GUARD = threading.Lock()
# The running resolve()'s event, read by _check_cancelled() anywhere below it
# on the same thread. None outside resolve() — a direct _scoped_resolve() call
# can never be cancelled.
_CANCEL: contextvars.ContextVar[threading.Event | None] = contextvars.ContextVar("conflict_cancel", default=None)


def _key(repo_full: str, item_id: str) -> tuple[str, str]:
    return (repo_full, item_id.lower())


def request_cancel(repo_full: str, item_id: str) -> bool:
    """Sets the running resolve()'s cancel event for this item only. False
    when no resolve() is running for it (nothing changes)."""
    with _ACTIVE_GUARD:
        ev = _ACTIVE.get(_key(repo_full, item_id))
    if ev is None:
        return False
    ev.set()
    return True


def is_active(repo_full: str, item_id: str) -> bool:
    with _ACTIVE_GUARD:
        return _key(repo_full, item_id) in _ACTIVE


@contextlib.contextmanager
def cancel_scope(repo_full: str, item_id: str):
    """Registers one run's cancel event for its duration. Any exception that
    leaves a cancelled run (a git command or a check that the cancel's process
    sweep killed) becomes Cancelled, so the caller never reads it as an
    infrastructure failure."""
    ev = threading.Event()
    key = _key(repo_full, item_id)
    with _ACTIVE_GUARD:
        _ACTIVE[key] = ev
    token = _CANCEL.set(ev)
    try:
        yield ev
    except Cancelled:
        raise
    except Exception as exc:
        if ev.is_set():
            raise Cancelled(f"{item_id}: conflict resolution cancelled") from exc
        raise
    finally:
        _CANCEL.reset(token)
        with _ACTIVE_GUARD:
            if _ACTIVE.get(key) is ev:
                del _ACTIVE[key]


def _check_cancelled(ws: Path | None = None, pre_merge_sha: str | None = None) -> None:
    """Raises Cancelled once this run's cancel event is set, after resetting
    the worktree to the branch's own tip when the merge has started."""
    ev = _CANCEL.get()
    if ev is None or not ev.is_set():
        return
    if ws is not None and pre_merge_sha is not None:
        _abort_and_clean(ws, pre_merge_sha)
    raise Cancelled("conflict resolution cancelled")


def _push_guarded(ws: Path, pre_merge_sha: str, *args: str) -> None:
    """The ONLY `git push` in this module (test_conflict_cancel.py checks its
    AST). Called inside the caller's hub_lock: /conflicts/cancel takes that
    same lock after setting the event, so a push either finished before the
    cancel or sees the event here and never starts."""
    _check_cancelled(ws, pre_merge_sha)
    git(ws, "push", *args)


# HZ-327: one resolve()'s {"flakes": [], "test_runs": []}, which every
# check run in it records into and every reply it returns carries. HZ-349:
# plus "branch_notes", which go into a resolved reply's summary instead.
_RECORDED: contextvars.ContextVar[dict | None] = contextvars.ContextVar("conflict_recorded", default=None)


def _run_checks(ws: Path, pre_merge_sha: str, log, **kwargs) -> str:
    """run_checks(), with this run's cancel event ending a check-slot wait.
    A cancelled wait is a cancel, not a check failure."""
    recorded = _RECORDED.get()
    if recorded is not None:
        kwargs = {
            **kwargs,
            "flakes": recorded["flakes"],
            "test_runs": recorded["test_runs"],
            "branch_notes": recorded["branch_notes"],
        }
    ev = _CANCEL.get()
    if ev is None:
        return run_checks(ws, log, **kwargs)
    try:
        return run_checks(ws, log, cancel=ev, **kwargs)
    except WaitCancelled:
        _check_cancelled(ws, pre_merge_sha)
        raise


def _branch_suffix() -> str:
    """HZ-349: this resolve()'s branch-run lines, for a summary."""
    recorded = _RECORDED.get()
    return "".join(f" · {note}" for note in (recorded or {}).get("branch_notes") or [])


def git(ws: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=GIT_TIMEOUT_S
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def _default_branch(ws: Path) -> str:
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    return head.rsplit("/", 1)[-1] if head else "main"


def _unmerged_paths(ws: Path) -> list[str]:
    """Conflict detection via git's own index state, not marker text — see
    module docstring. Returns the list of still-conflicted paths (empty if
    the working tree is clean)."""
    status = git(ws, "status", "--porcelain=v1", check=False).stdout
    paths = []
    for line in status.splitlines():
        if len(line) < 3:
            continue
        code = line[:2]
        if "U" in code or code in _UNMERGED_CODES:
            paths.append(line[3:].strip())
    return paths


def resolve(
    repo_full: str,
    item_id: str,
    branch: str | None = None,
    base_branch: str | None = None,
    log=print,
    configured=None,
    checks_waiver=None,
) -> dict:
    """Attempt a mechanical merge-conflict resolution for one item's PR
    branch, in that item's existing worktree.

    Returns one of:
      {"resolved": True,  "files": "<diffstat>", "summary": "..."}
      {"resolved": True,  "files": ..., "summary": ..., "mode": "scoped",
       "resolution": {...}, "review": {...}}          # HZ-154, scoped path only
      {"resolved": False, "reason": <one of ESCALATION_REASONS>, "detail": "..."}

    The three extra keys appear ONLY on the scoped path: the mechanical
    path's success shape is exactly what it was before HZ-154, so nothing
    downstream can mistake a plain `git merge` for an agent-resolved hunk.

    Never raises for an ordinary escalation — only for something the caller
    (the farmd route) should treat as an infrastructure failure (worktree not
    provisioned, a git command failing outside the merge itself).

    HZ-256: raises Cancelled when request_cancel() stopped the run; nothing
    was pushed and the worktree is back at the branch's own tip.
    """
    recorded = {"flakes": [], "test_runs": [], "branch_notes": []}
    token = _RECORDED.set(recorded)
    try:
        with cancel_scope(repo_full, item_id):
            result = _resolve(repo_full, item_id, branch, base_branch, log, configured, checks_waiver)
    finally:
        _RECORDED.reset(token)
    # HZ-327: on every reply, resolved or escalated; the server records them.
    return {**result, **{key: value for key, value in recorded.items() if value and key != "branch_notes"}}


def _resolve(repo_full, item_id, branch, base_branch, log, configured, checks_waiver=None) -> dict:
    branch = branch or f"horizon/{item_id.lower()}"
    ws = ensure_item_worktree(repo_full, item_id)

    # Scrub before touching anything — mirrors step_agent.prepare_branch:
    # a superseded/killed prior attempt may have left uncommitted edits.
    git(ws, "reset", "--hard")
    git(ws, "clean", "-fd")
    with hub_lock(repo_full):
        git(ws, "fetch", "origin", "--prune")
    _check_cancelled()

    remote_branch = git(ws, "rev-parse", "--verify", f"origin/{branch}", check=False)
    if remote_branch.returncode != 0:
        _check_cancelled()
        return {"resolved": False, "reason": "branch_missing", "detail": f"origin/{branch} not found"}
    git(ws, "checkout", "-B", branch, f"origin/{branch}")
    pre_merge_sha = git(ws, "rev-parse", "HEAD").stdout.strip()

    default = base_branch or _default_branch(ws)
    log(f"conflict_resolver: merging origin/{default} into {branch}")
    git(ws, "merge", "--no-edit", f"origin/{default}", check=False)
    _check_cancelled(ws, pre_merge_sha)

    unmerged = _unmerged_paths(ws)
    if unmerged:
        if _scoped_enabled():
            # HZ-154: the narrow middle path. Owns its own cleanup and returns
            # a fully-formed result either way — resolved, or escalated with a
            # reason naming exactly why it refused.
            return _scoped_resolve(
                ws, repo_full, branch, default, unmerged, pre_merge_sha, log, configured=configured, checks_waiver=checks_waiver
            )
        log(f"conflict_resolver: {len(unmerged)} unmerged path(s) — escalating, aborting merge")
        return _escalate(
            ws, pre_merge_sha, "merge_conflict", f"conflicts in: {', '.join(sorted(unmerged))}", log
        )

    diffstat = git(ws, "diff", "--stat", f"{pre_merge_sha}..HEAD", check=False).stdout.strip()

    try:
        # HZ-144: post-merge checks take a check slot like any other, and are
        # labelled `conflict_resolver` so the measurement can separate them
        # from agent runs. Deliberately NOT exempt: this runs the same repo
        # suite on the same 2 vCPUs as an agent's checks, so exempting it
        # would mean the real concurrent-check population is the configured
        # limit plus one, which is the oversubscription the limit exists to
        # prevent. It runs in farmd's own process, inside a synchronous
        # request from the Node server, so the slot wait is bounded twice:
        # by FARM_CHECK_SLOT_WAIT_MAX_S here, and by
        # FARM_CONFLICT_RESOLVE_TIMEOUT_MS (50 min) on the caller's side.
        checked_tree = check_record.snapshot_tree(ws, log)
        check_note = _run_checks(
            ws, pre_merge_sha, log, item_id=item_id, caller="conflict_resolver", configured=configured, repo=repo_full,
            checks_waiver=checks_waiver,
        )
        checks_finished_at = check_record.now_iso()
    except CheckFailure as exc:
        return _escalate(ws, pre_merge_sha, "tests_failed", str(exc), log)
    _check_cancelled(ws, pre_merge_sha)

    # A clean merge is a fast-forward of the branch's own previous tip (its
    # first parent is exactly pre_merge_sha) — a plain push is always
    # sufficient and never discards a commit this run did not itself create.
    try:
        with hub_lock(repo_full):
            _push_guarded(ws, pre_merge_sha, "origin", branch)
    except RuntimeError as exc:
        _check_cancelled(ws, pre_merge_sha)
        # Someone else pushed to this branch while we were merging/testing —
        # refuse rather than force over it.
        log(f"conflict_resolver: push rejected — escalating ({exc})")
        return {"resolved": False, "reason": "push_rejected", "detail": str(exc)[:DETAIL_LIMIT]}

    log(f"conflict_resolver: merged origin/{default} into {branch} and pushed — {check_note}")
    return {
        "resolved": True,
        "files": diffstat,
        "summary": f"merged origin/{default} into {branch}; {check_note}{_branch_suffix()}",
        # HZ-257: the pushed commit the checks passed on, when exactly named.
        **check_record.report_fields(ws, checked_tree, check_note, checks_finished_at, log),
    }


# ---- HZ-154: the scoped path ----


def _scoped_enabled() -> bool:
    """Read at call time, not import time, so the rollback lever works on a
    restart without a code change (and a test can flip it)."""
    raw = os.environ.get("FARM_CONFLICT_SCOPED_ENABLED")
    return CONFLICT_SCOPED_ENABLED if raw is None else raw.strip().lower() in ("1", "true", "yes")


def _abort_and_clean(ws: Path, pre_merge_sha: str) -> None:
    """The ONE cleanup path. Every escalation exit — mechanical or scoped,
    and there are eleven of them now — goes through here, so no branch can be
    the one that forgets and hands the next full implement cycle a dirty
    worktree. `merge --abort` no-ops harmlessly once the merge is committed."""
    git(ws, "merge", "--abort", check=False)
    git(ws, "reset", "--hard", pre_merge_sha)
    git(ws, "clean", "-fd")


def _escalate(
    ws: Path,
    pre_merge_sha: str,
    reason: str,
    detail: str,
    log,
    notes: list[str] | None = None,
    review_notes: list[str] | None = None,
) -> dict:
    """The ONE escalation exit of the scoped path, and where a repaired reply's
    parser notes reach the run output (HZ-157).

    `notes` is parse_agent_reply's repair notes for the resolution reply this
    run already consumed. EVERY escalation after that reply passes them — not
    only the ones whose `detail` came out of it. An escalation for a reason the
    reply had nothing to do with (the checks went red, the branch moved) still
    ran off bytes the parser had to edit, the counter already recorded that a
    repair happened, and a run output that does not say which reply was repaired
    is the silent repair HZ-124 attempt 9 was rejected for.

    The notes also get a log line of their own, emitted BEFORE the escalation
    line that `detail` is sliced into: a note that only rode inside a string
    someone later truncates is a note that did not arrive.

    `review_notes` is the scoped review reply's own notes, for the one
    escalation whose `detail` is that review's summary. They are passed RAW,
    never pre-stamped into `detail`, so the cap below reserves room for both
    groups together — a pre-stamped group sits inside the text the cap cuts.

    HZ-256: a cancelled run never escalates. A killed agent or check looks
    like an ordinary failure to the code that called it, so the check is
    here, on the one exit every escalation takes.
    """
    _check_cancelled(ws, pre_merge_sha)
    if reason not in ESCALATION_REASONS:
        # A reason the Node side has no message for would surface as a raw
        # detail string in the item's feedback. Report the generic one and say
        # loudly that this is a bug — never crash an escalation over it.
        log(f"conflict_resolver: BUG — unknown escalation reason {reason!r}; reporting merge_conflict")
        reason, detail = "merge_conflict", f"{reason}: {detail}"
    if notes:
        log(f"conflict_resolver: the resolution reply was repaired to parse — {'; '.join(notes)}")
    detail = _with_note_groups(
        str(detail),
        [("parser notes", review_notes or []), (RESOLUTION_NOTE_LABEL, notes or [])],
        DETAIL_LIMIT,
    )
    log(f"conflict_resolver: escalating ({reason}) — {detail[:200]}")
    _abort_and_clean(ws, pre_merge_sha)
    return {"resolved": False, "reason": reason, "detail": detail}


def _worktree_dirty_paths(ws: Path) -> set[str]:
    """Paths whose working-tree content differs from the index, plus untracked
    files. Snapshotted before the resolution and compared after: git has
    already written every cleanly-merged file into BOTH index and worktree, so
    a file appearing here that wasn't here before is an edit outside the
    conflicted set. The resolution agent has no Bash tool, so it cannot stage
    an edit to hide it from this comparison."""
    changed = git(ws, "diff", "--name-only", check=False).stdout.splitlines()
    untracked = git(ws, "ls-files", "--others", "--exclude-standard", check=False).stdout.splitlines()
    return {p.strip() for p in changed + untracked if p.strip()}


def _conflict_files(ws: Path, unmerged: list[str]) -> list[conflict_hunks.ConflictFile]:
    """One ConflictFile per conflicted path, built from git's index stages.
    Raises UnsupportedConflict for anything this path must not touch."""
    files = []
    for path in sorted(unmerged):
        conflict_hunks.check_attr(git, ws, path)
        files.append(conflict_hunks.build_conflict_file(git, ws, path))
    return files


def _scoped_resolve(ws, repo_full, branch, default, unmerged, pre_merge_sha, log, configured=None, checks_waiver=None) -> dict:
    """Resolve only the conflicted hunks, review only what the resolution
    changed, and push only behind a green check suite.

    Returns the same two shapes resolve() documents. Never raises for an
    ordinary refusal: every exit either pushes or escalates with a reason.

    HZ-157: `resolution_notes` is declared before the first escalation and
    handed to EVERY `_escalate()` call below, including the two that run before
    any agent could have been dispatched (where it is still empty, and
    _with_notes() is a no-op). One unconditional rule, no per-branch judgement:
    test_conflict_scoped.py reads this function's own AST and fails any
    `_escalate()` call here that omits `notes=`, because the first cut of this
    item passed it on three branches out of eleven and the eight that dropped it
    all looked fine in review.
    """
    resolution_notes: list[str] = []
    try:
        files = _conflict_files(ws, unmerged)
    except UnsupportedConflict as exc:
        return _escalate(ws, pre_merge_sha, "conflict_unsupported", str(exc), log, notes=resolution_notes)

    too_large = conflict_hunks.exceeds_caps(files)
    if too_large:
        # Checked before any dispatch: an oversized conflict must not cost an
        # agent call before being sent to the full cycle.
        return _escalate(ws, pre_merge_sha, "conflict_too_large", too_large, log, notes=resolution_notes)

    hunk_count = sum(len(f.hunks) for f in files)
    paths = [f.path for f in files]
    log(f"conflict_resolver: scoped path — {hunk_count} hunk(s) in {len(files)} file(s): {', '.join(paths)}")

    # git merge writes 2-way markers; every comparison below is against the
    # diff3 reference THIS process generated. The agent must therefore read
    # and edit that same text, or every scope check would compare two
    # different documents and fail.
    for cf in files:
        (ws / cf.path).write_text(cf.reference)
    dirty_before = _worktree_dirty_paths(ws)

    stage_zero = {cf.path: [conflict_hunks.deterministic_resolve(h) for h in cf.hunks] for cf in files}
    every_hunk_is_mechanical = all(r is not None for per_file in stage_zero.values() for r in per_file)

    if every_hunk_is_mechanical:
        # Stage zero: the two sides edited different lines of every hunk, so
        # applying both is the only answer — deterministically, no agent, and
        # therefore the same result on every replay.
        strategy = "deterministic"
        for cf in files:
            (ws / cf.path).write_text(conflict_hunks.apply_resolution(cf, stage_zero[cf.path]))
    else:
        strategy = "agent"
        agent = _run_resolution_agent(ws, files, log)
        _check_cancelled(ws, pre_merge_sha)
        resolution_notes = agent["notes"]
        if not agent["resolved"]:
            return _escalate(
                ws, pre_merge_sha, "resolution_unsure", agent["detail"], log, notes=resolution_notes
            )

    stray = sorted(_worktree_dirty_paths(ws) - dirty_before)
    if stray:
        return _escalate(
            ws,
            pre_merge_sha,
            "resolution_out_of_scope",
            f"files changed outside the conflict: {', '.join(stray)}",
            log,
            notes=resolution_notes,
        )

    novel: list[tuple[str, str]] = []
    dropped: list[tuple[str, str]] = []
    for cf in files:
        try:
            regions = conflict_hunks.assert_in_scope(cf, (ws / cf.path).read_text())
        except MarkerRemaining as exc:
            return _escalate(
                ws, pre_merge_sha, "markers_remaining", str(exc), log, notes=resolution_notes
            )
        except ScopeViolation as exc:
            return _escalate(
                ws, pre_merge_sha, "resolution_out_of_scope", str(exc), log, notes=resolution_notes
            )
        except UnsupportedConflict as exc:
            return _escalate(
                ws, pre_merge_sha, "conflict_unsupported", str(exc), log, notes=resolution_notes
            )
        delta = conflict_hunks.resolution_delta(cf, regions)
        novel.extend(delta.novel)
        dropped.extend(delta.dropped)

    delta = conflict_hunks.Delta(novel=tuple(novel), dropped=tuple(dropped))
    if delta.is_empty:
        # Nothing was invented and nothing was discarded: the result is a
        # selection of lines both parents already had. There is no reviewable
        # input, so demanding a verdict would make the deterministic case
        # model-dependent. Said plainly, so nobody reads the event log as an
        # agent having approved something.
        review = {
            "verdict": "pass",
            "reviewed": False,
            "summary": "no agent review — the resolution used only parent lines, kept every side's own",
        }
    else:
        review = _run_scoped_review(ws, files, delta, log)
        _check_cancelled(ws, pre_merge_sha)
        # Popped, not read: the review dict lands in the run result as-is, and
        # these two exist only so the rejection below can cap the detail
        # without cutting either reply's notes. review["summary"] stays the
        # stamped copy for that result.
        review_detail = review.pop("detail", review["summary"])
        review_notes = review.pop("notes", [])
        if review["verdict"] != "pass":
            # Two groups — the REVIEW reply's notes and the RESOLUTION reply's —
            # labelled differently (see _with_notes) and capped together.
            return _escalate(
                ws,
                pre_merge_sha,
                "scoped_review_rejected",
                review_detail,
                log,
                notes=resolution_notes,
                review_notes=review_notes,
            )

    git(ws, "add", "--", *paths)
    if _unmerged_paths(ws):
        # Defensive: staging every conflicted path resolves the index, so this
        # should be impossible. Never commit a half-merged index.
        return _escalate(
            ws,
            pre_merge_sha,
            "merge_conflict",
            "paths still unmerged after staging the resolution",
            log,
            notes=resolution_notes,
        )
    git(ws, "commit", "--no-edit")
    _check_cancelled(ws, pre_merge_sha)

    try:
        # This path pushes a merge no human has read. "No green, no push"
        # means a check suite that actually ran — run_checks() raises when
        # none did (HZ-304: on every path now, not just this one).
        checked_tree = check_record.snapshot_tree(ws, log)
        check_note = _run_checks(
            ws, pre_merge_sha, log, caller="conflict_resolver", configured=configured, repo=repo_full,
            checks_waiver=checks_waiver,
        )
        checks_finished_at = check_record.now_iso()
    except CheckFailure as exc:
        return _escalate(
            ws, pre_merge_sha, "scoped_checks_failed", str(exc), log, notes=resolution_notes
        )
    _check_cancelled(ws, pre_merge_sha)

    try:
        with hub_lock(repo_full):
            # The Node side abandons this request at FARM_CONFLICT_RESOLVE_TIMEOUT_MS
            # and escalates; two agent calls make that window likelier to be
            # hit than it was for a bare merge. Re-verify the head we resolved
            # is still the head on the remote, THEN push with a lease naming
            # it — so a branch that moved meanwhile is never overwritten.
            git(ws, "fetch", "origin", "--prune")
            remote_now = git(ws, "rev-parse", f"origin/{branch}", check=False).stdout.strip()
            if remote_now != pre_merge_sha:
                return _escalate(
                    ws,
                    pre_merge_sha,
                    "push_rejected",
                    f"origin/{branch} moved to {remote_now[:8]} while resolving (resolved {pre_merge_sha[:8]})",
                    log,
                    notes=resolution_notes,
                )
            _push_guarded(ws, pre_merge_sha, f"--force-with-lease=refs/heads/{branch}:{pre_merge_sha}", "origin", branch)
    except RuntimeError as exc:
        return _escalate(
            ws, pre_merge_sha, "push_rejected", str(exc), log, notes=resolution_notes
        )

    diffstat = git(ws, "diff", "--stat", f"{pre_merge_sha}..HEAD", check=False).stdout.strip()
    log(f"conflict_resolver: pushed the scoped resolution of {branch} ({strategy}) — {check_note}")
    return {
        "resolved": True,
        "mode": "scoped",
        "files": diffstat,
        # The resolution agent's parser notes ride the summary, which is the
        # run output the orchestrator records for this gate action. Uncapped:
        # nothing downstream slices this string, and a note cut in half is a
        # note that did not arrive.
        "summary": _with_notes(
            f"resolved {hunk_count} conflicted hunk(s) in {len(files)} file(s) "
            f"while merging origin/{default} ({strategy}); {check_note}{_branch_suffix()}",
            resolution_notes,
        ),
        "resolution": {
            "strategy": strategy,
            "hunks": hunk_count,
            "paths": paths,
            "hunk_labels": [h.label for cf in files for h in cf.hunks],
        },
        "review": review,
        # HZ-257: the pushed commit the checks passed on, when exactly named.
        **check_record.report_fields(ws, checked_tree, check_note, checks_finished_at, log),
    }


def _hunk_brief(cf: conflict_hunks.ConflictFile) -> str:
    out = []
    for h in cf.hunks:
        out.append(
            f"- {h.label}: {len(h.base)} base line(s), {len(h.ours)} on the PR branch, {len(h.theirs)} on the base branch"
        )
    return "\n".join(out)


def _run_resolution_agent(ws: Path, files, log) -> dict:
    """Dispatch the one resolution agent. Returns
    {"resolved": bool, "detail": str, "notes": list[str]} — "cannot be sure" is
    a first-class reply, not a failure to parse.

    `detail` is RAW: the parser's repair notes ride `notes` only, and the caller
    stamps them exactly once — _escalate() on every escalation, _scoped_resolve()'s
    own summary on success. Folding them into `detail` here as well would double
    them on the one branch whose detail is an escalation detail, and would still
    miss the eight escalations that never look at `detail` at all.

    Deliberately called through the agent_runner MODULE, not a `from ... import
    run_agent` binding: the mechanical path's "never dispatches an agent" test
    patches agent_runner.run_agent, and a bound name would sail straight past
    that patch and report a false green.
    """
    role = (ROLES / "conflict_resolution.md").read_text()
    prompt = _resolution_prompt(files)
    log(f"conflict_resolver: dispatching the resolution agent for {len(files)} file(s)")
    try:
        reply = agent_runner.run_agent(
            prompt,
            agent=CONFLICT_MODEL_AGENT,
            step=CONFLICT_STEP_KEY,
            append_system=role,
            cwd=str(ws),
            allowed_tools=RESOLUTION_TOOLS,
            max_turns=RESOLUTION_MAX_TURNS,
            timeout_s=CONFLICT_AGENT_TIMEOUT_S,
            # Same lock as the implement step: this call edits code.
            provider_locked=True,
        )
        parsed, notes = agent_runner.parse_agent_reply(reply.get("result") or "")
    except (AgentError, ValueError) as exc:
        # Nothing parsed, so there are no notes to carry — the exception IS the
        # report.
        return {
            "resolved": False,
            "detail": f"the resolution agent did not return a usable answer: {exc}",
            "notes": [],
        }
    if not isinstance(parsed, dict) or parsed.get("resolved") is not True:
        unsure = ""
        if isinstance(parsed, dict):
            unsure = str(parsed.get("unsure_reason") or parsed.get("summary") or "")
        return {
            "resolved": False,
            # HZ-157: `resolved: false` is an ORDINARY outcome, not an edge
            # case, so it is exactly the branch a dropped note would hide on —
            # and _escalate() is what stamps it, for every branch alike.
            "detail": unsure or "the agent reported it could not be sure of the resolution",
            "notes": notes,
        }
    return {
        "resolved": True,
        "detail": str(parsed.get("summary") or "resolved the conflicted hunks"),
        "notes": notes,
    }


def _with_notes(
    text: str, notes: list[str], limit: int | None = None, *, label: str = "parser notes"
) -> str:
    """Carry parse_agent_reply's repair notes into the text the orchestrator
    records, so a repaired reply is never silently accepted.

    EVERY branch that consumes a parse_agent_reply result goes through here —
    including the plain `resolved: false` and no-verdict-object outcomes, and
    every escalation that happens after a reply was parsed (see _escalate). A
    reply whose bytes the parser had to change is not an edge case, and dropping
    the note on an ordinary branch is the silent repair HZ-157 exists to prevent.

    `label` names WHOSE reply was repaired. One escalation detail can carry two
    groups — the scoped review's own notes are already inside the summary that
    becomes the detail — and two groups under one identical heading would read
    as a bug rather than as two repaired replies. Every label contains "parser
    notes", so one substring still finds any of them.

    `limit` reserves room for the notes rather than letting a later slice cut
    them off the end — the same rule, for the same reason, as
    agent_runner.stamp_notes(). None means the caller imposes no cap.
    """
    return _with_note_groups(text, [(label, notes)], limit)


def _with_note_groups(text: str, groups: list[tuple[str, list[str]]], limit: int | None = None) -> str:
    """_with_notes for several labelled groups at once. The room for EVERY
    group is reserved before `text` is cut, so no group can be the one a cap
    slices in half."""
    suffix = "".join(f" ({label}: {'; '.join(notes)})" for label, notes in groups if notes)
    if not suffix:
        return text
    if limit is None:
        return text + suffix
    if len(suffix) >= limit:
        return suffix[:limit]  # pathological notes: the note wins, not the text
    return text[: limit - len(suffix)] + suffix


def _resolution_prompt(files) -> str:
    listing = "\n\n".join(f"{cf.path}\n{_hunk_brief(cf)}" for cf in files)
    return (
        "Resolve the merge conflicts in these files, and nothing else.\n\n"
        f"{listing}\n\n"
        "Each file on disk currently holds git's diff3-marked merge: "
        f"`{conflict_hunks.MARKER_OURS}` (this PR's branch), `{conflict_hunks.MARKER_BASE}` "
        f"(the common ancestor), `{conflict_hunks.MARKER_SPLIT}`, "
        f"`{conflict_hunks.MARKER_THEIRS}` (the branch being merged in).\n\n"
        "For every marked region: replace the whole region — markers included — with the lines that "
        "keep BOTH sides' intent. Change nothing outside a marked region, and no other file: a "
        "verification step compares the result against both parents byte-for-byte and rejects the run "
        "if anything else moved.\n\n"
        "Respond with ONLY a JSON object (no prose, no fences):\n"
        '{"resolved": true|false, "summary": "<what you kept, <=200 chars>", '
        '"unsure_reason": "<why you could not be sure, if resolved is false>"}'
    )


def _run_scoped_review(ws: Path, files, delta, log) -> dict:
    """Review the RESOLUTION, not the PR.

    The prompt is built only from the delta and the three stages of each
    conflicted hunk — the rest of the PR's diff and the base branch's own
    changes never enter it. That is the whole point: HZ-124 passed review at
    attempt 7 and then lost two cycles to re-reviews of a 3,000-line diff.

    Fails closed: an AgentError, unparseable prose, or any verdict that is not
    exactly "pass" is a reject.
    """
    role = (ROLES / "conflict_review.md").read_text()
    prompt = _review_prompt(files, delta)
    log("conflict_resolver: dispatching the scoped review of the resolution delta")
    try:
        reply = agent_runner.run_agent(
            prompt,
            agent=CONFLICT_MODEL_AGENT,
            step=CONFLICT_STEP_KEY,
            append_system=role,
            cwd=str(ws),
            allowed_tools=REVIEW_TOOLS,
            max_turns=REVIEW_MAX_TURNS,
            timeout_s=CONFLICT_REVIEW_TIMEOUT_S,
        )
        parsed, notes = agent_runner.parse_agent_reply(reply.get("result") or "")
    except (AgentError, ValueError) as exc:
        return {"verdict": "fail", "reviewed": True, "summary": f"the scoped review returned no usable verdict: {exc}"}
    if notes:
        # The run output's own line for this reply's repair (HZ-157): the
        # summary below is capped and may later be cut again, a log line is not.
        log(f"conflict_resolver: the scoped review reply was repaired to parse — {'; '.join(notes)}")
    if not isinstance(parsed, dict):
        # Repaired bytes that parsed to a non-object still had their bytes
        # changed — the note belongs on this branch too (HZ-157).
        detail = "the scoped review returned no verdict object"
        return {
            "verdict": "fail",
            "reviewed": True,
            "summary": _with_notes(detail, notes, DETAIL_LIMIT),
            "detail": detail,
            "notes": notes,
        }
    section = _review_section(parsed)
    summary = str(parsed.get("summary") or "")
    if section["verdict"] != "pass" and section["findings"]:
        first = section["findings"][0]
        finding = first.get("detail") if isinstance(first, dict) else None
        if finding:
            summary = f"{summary} — {finding}" if summary else str(finding)
    summary = (summary or "no summary given")[:DETAIL_LIMIT]
    return {
        "verdict": section["verdict"],
        "reviewed": True,
        # The notes are stamped AFTER the text is assembled, and _with_notes
        # reserves their room inside the cap, so no slice can cut them.
        "summary": _with_notes(summary, notes, DETAIL_LIMIT),
        # RAW summary and notes, for _escalate() to cap together with the
        # resolution reply's notes. _scoped_resolve() pops both.
        "detail": summary,
        "notes": notes,
        "findings": section["findings"],
    }


def _review_prompt(files, delta) -> str:
    sections = []
    for cf in files:
        for hunk in cf.hunks:
            sections.append(
                f"### {hunk.label}\n"
                f"common ancestor:\n```\n{''.join(hunk.base)}```\n"
                f"this PR's side:\n```\n{''.join(hunk.ours)}```\n"
                f"the base branch's side:\n```\n{''.join(hunk.theirs)}```"
            )
    novel = "".join(f"{label}: {line}" for label, line in delta.novel) or "(none)\n"
    dropped = "".join(f"{label}: {line}" for label, line in delta.dropped) or "(none)\n"
    return (
        "Review one merge-conflict resolution. This is the ENTIRE change under review — "
        "the rest of the pull request already passed review and is not yours to judge.\n\n"
        "## The conflicted hunks\n\n" + "\n\n".join(sections) + "\n\n"
        "## Lines the resolution introduced that neither side wrote\n\n"
        f"```\n{novel}```\n\n"
        "## Lines a side wrote that the resolution did not keep\n\n"
        f"```\n{dropped}```\n"
    )
