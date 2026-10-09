"""Ephemeral step agent: executes exactly one lifecycle step, reports, exits.

Spawned by farmd in tmux session farm-run-<item>-s<step>-a<attempt>. Planning
steps (Ensemble / Eng plan / Architect review / QA) read the workspace when
one exists and produce a markdown artifact. The implement step works on the
item's branch in the workspace; the *script* owns git (branch, commit, push)
— the model only edits files.
"""

import argparse
import contextlib
import contextvars
import fnmatch
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

import httpx

# HZ-128: the step model lives in domain/, not in farm/ — an absolute import
# off the repo root (already on sys.path, since farmd runs as
# `python -m farm.farmd` from there and farm/tests/conftest.py inserts it).
# HZ-132 put the failure-reason vocabulary there too, so the reason this script
# reports is a constant the server already knows, never a string typed here.
from domain.py import fields, reasons, steps
from domain.py.personas import model_agent_for_step

# AgentExhaustedError is this branch's name for main's TurnCapExceeded — the
# same "ran out of turn budget" signal, renamed by the provider refactor. The
# import conflicted while its USE below merged cleanly, so the rename has to be
# applied there too or the merged file references a symbol that no longer exists.
from .agent_runner import (
    AgentError,
    AgentExhaustedError,
    parse_agent_reply,
    run_agent,
    salvage_truncated_reply,
    stamp_notes,
    stamp_notes_artifact,
)
from . import check_record, handoff, pause
from .checks import CheckFailure, redact, run_checks
from .config import FARM_PORT, ITEM_LOCK_WAIT_S
from .handoff import HandoffContext, HandoffGuard
from .personas import compose_role, provider_for, resolve
from .rules import render_rules_section
from .workspaces import ItemBusy, ensure_item_worktree, hub_lock, item_lock

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
# The cap on this script's own `summary` — step_run.output on the server side.
# Named once (HZ-156) rather than restated as a literal at each shaping site:
# stamp_notes() reserves room inside exactly this budget, so a cap raised in
# one place and not the other would silently truncate the notes back off.
SUMMARY_MAX_CHARS = 600
# HZ-346: the caps on a blocked report's two fields. server/src/ruleBlock.js
# holds the same numbers for the /blocked route, so a capped report is never
# refused there. HZ-365: `needs` carries the agent's full explanation.
RULE_MAX_CHARS = 300
NEEDS_MAX_CHARS = 4000

# step label -> (role file, needs JSON artifact, tool access, persona agent).
# HZ-117: keyed by label (the table's own primary key, see domain/steps.json),
# never index — an insertion elsewhere in the table can't repoint one of
# these at the wrong step. Turn budgets and timeouts moved to
# steps.budget_for_label(); provider eligibility to
# steps.provider_override_eligible()/provider_locked_for() — all three read
# the generated table instead of a second hand-maintained mapping here.
# Personas specialize only the steps that act on the item's stack — QA and
# implement; the planning steps stay generalist.
#
# HZ-125: the last field used to be a bool ("wants a persona"). Personas are
# now scoped by agent, so it names WHICH agent's persona bucket this step
# composes from — None for the steps that compose none. The same three steps
# compose as before; only the sentinel's shape changed, and it is now
# load-bearing: a QA step can no longer be handed an Eng persona because the
# agent is what selects the bucket.
PLANNER_TOOLS = "Read,Glob,Grep"
IMPLEMENT_TOOLS = "Read,Glob,Grep,Edit,Write,Bash"
# DevOps investigates and can hit live URLs (curl, gh cli, etc.) but never
# edits code — same read-only rationale as the reviewer, one step below.
DEVOPS_TOOLS = "Read,Glob,Grep,Bash"

QA_PLAN_LABEL = "QA reviews the test plan"
IMPLEMENT_LABEL = "Specialist agent implements"
REVIEW_LABEL = "Automated review (code + QA)"
DEPLOY_LABEL = "Deploy the changes"
# HZ-313: the only step whose reply may carry a cross-repo `split`.
SPLIT_STEP_LABEL = "Plan options & trade-offs (pros / cons)"

STEP_CONFIG = {
    "Plan options & trade-offs (pros / cons)": ("ensemble.md", True, PLANNER_TOOLS, None),
    "Draft implementation plan": ("eng_plan.md", True, PLANNER_TOOLS, None),
    "Architecture review": ("architect_review.md", True, PLANNER_TOOLS, None),
    QA_PLAN_LABEL: ("qa.md", True, PLANNER_TOOLS, "qa"),
    IMPLEMENT_LABEL: ("eng_implement.md", False, IMPLEMENT_TOOLS, "eng"),
    # code_review.md is loaded here for the first (code) pass and composes the
    # item's ENG persona (it reviews the code as an engineer); qa_review.md is
    # loaded separately inside execute()'s review branch for the second pass
    # and composes the item's QA persona. Read-only tools: the reviewer can
    # never edit, push, merge or approve the human gate (HZ-30) — enforced
    # here, not by prompt alone.
    REVIEW_LABEL: ("code_review.md", True, PLANNER_TOOLS, "eng"),
    # DevOps is a role, not a persona (HZ-22 architecture review) — it is
    # project-scoped via farm/rules/projects/*.md, not stack-scoped, so it
    # never gets a persona composed in.
    DEPLOY_LABEL: ("devops.md", True, DEVOPS_TOOLS, None),
}

# HZ-369: these steps follow ONLY the owner's per-step choice. A persona's
# provider and a bare FARM_PROVIDER never move them off today's routing.
# Implement with no choice keeps the HZ-117 lock at runtime.
CHOICE_ONLY_PROVIDER_STEPS = frozenset({QA_PLAN_LABEL, IMPLEMENT_LABEL, REVIEW_LABEL})

# HZ-158: the ONLY steps whose turn-capped reply may be salvaged — a reply cut
# off mid-string, with every required key present, is accepted instead of
# failing the run. Both are planning steps whose output a later gate reviews.
# Never a step whose output decides a gate: not review or deploy (they emit
# the verdict), not Architecture review or QA reviews the test plan (they emit
# one too), and not implement (its checks are a gate, and _salvage_checkpoint()
# already keeps its code). farm/tests/test_exhaustion_salvage.py pins this set.
SALVAGE_STEPS = frozenset({"Plan options & trade-offs (pros / cons)", "Draft implementation plan"})

# The agent whose persona the review step's second (QA) pass composes. Named
# here rather than inlined because it is the fix HZ-125 exists for: both passes
# used to compose the item's single flat persona, so the QA reviewer was handed
# the Eng specialization of the engineer whose diff it was reviewing.
REVIEW_QA_PERSONA_AGENT = "qa"

def _assert_step_config_matches_table(config_labels: set[str], table_labels: set[str]) -> None:
    """The actual Python-side enforcement of "an inserted/renamed step must
    fail loudly, not silently repoint an index" (HZ-117). Raises naming every
    mismatched label in both directions — pure-set, no import-time state, so
    a test can call this directly with a fabricated mismatch."""
    missing_from_config = table_labels - config_labels
    missing_from_table = config_labels - table_labels
    if not missing_from_config and not missing_from_table:
        return
    problems = []
    if missing_from_config:
        problems.append(f"in the generated steps table but missing from STEP_CONFIG: {sorted(missing_from_config)}")
    if missing_from_table:
        problems.append(f"in STEP_CONFIG but missing from the generated steps table: {sorted(missing_from_table)}")
    raise RuntimeError("step_agent.STEP_CONFIG has drifted from domain/steps.json — " + "; ".join(problems))


_assert_step_config_matches_table(
    set(STEP_CONFIG), {s["label"] for s in steps.STEPS if s["runsIn"] == "farm"}
)

# Diff shown to both review passes is capped — a defensive bound on prompt
# size, not a claim that larger diffs can't happen. 20k was below the size of
# an ordinary change: HZ-76's 14-file diff was 35k, so the reviewer saw 57% of
# it, cut mid-statement, and failed the item for looking incomplete. The code
# was fine; the input wasn't. When this DOES bite, truncate_diff below says so
# in the prompt — a reviewer must distrust the cut, never the code.
REVIEW_DIFF_CHARS = 200_000

# Subject-line marker for a salvage commit (HZ-31) — written by
# _salvage_checkpoint() and detected by _checkpoint_resume_note() so the next
# attempt's prompt can name it instead of silently continuing from it.
# HZ-184: a checks-failed checkpoint carries the same subject, so every
# existing reader still finds it; the "attempt exhausted" wording is kept for
# that compatibility only. The commit body's `cause:` line is what says why.
CHECKPOINT_MARKER = "WIP checkpoint — attempt exhausted"
CAUSE_EXHAUSTED = "exhausted"
CAUSE_CHECKS_FAILED = "checks-failed"
# HZ-194: an operator paused the item while this attempt was running.
CAUSE_PAUSED = "paused"
# HZ-321: a Horizon self-deploy stopped this attempt (see _deploy_checkpoint).
CAUSE_DEPLOY = "deploy"
# HZ-321: a deploy checkpoint committed but not pushed names itself in this
# file (under the worktree's git dir) as "<branch> <sha>", so the next
# attempt resumes from it instead of scrubbing it (prepare_branch).
UNPUSHED_CHECKPOINT = "horizon-unpushed-checkpoint"

# HZ-194: files a checkpoint never commits, matched on the basename at any
# depth (config/.env, deploy/id_rsa). .gitignore is already honoured by
# `git add -A`; this catches secrets a repo forgot to ignore.
SECRET_PATTERNS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    "*credentials*.json",
    "*.p12",
)
SECRET_PATTERN_EXCEPTIONS = ("*.example", "*.sample", "*.template")
_URL_CREDENTIALS = re.compile(r"://[^/@\s]+@")

# The error main() reports. Must not exceed the server's /fail route limit
# (`error: maxLength` in server/src/app.js): over it, Fastify rejects the whole
# report and the run sits active until the step watchdog times it out, losing
# the failure (HZ-184). farm/tests/test_step_agent.py pins the two together.
ERROR_MAX_CHARS = 2000


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def git(ws: Path, *args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=300, env=run_env)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def item_personas(item: dict) -> dict:
    """The item's {agent: persona id} map (HZ-125).

    Falls back to reading the pre-HZ-125 flat `persona` field as the item's Eng
    persona. The server translates legacy rows before dispatch, so this only
    matters for a task file enqueued by an older server and claimed after this
    shipped — a real window on a single-host deploy, and cheap to survive:
    resolve() accepts the legacy id (farm/personas.py's LEGACY_PERSONA_IDS).
    """
    personas = item.get("personas")
    if isinstance(personas, dict):
        return personas
    legacy = item.get("persona")
    return {"eng": legacy} if isinstance(legacy, str) and legacy.strip() else {}


STEP_PROVIDER_CHOICES = ("claude", "muse")


def step_provider_choice(item: dict, step_index) -> str | None:
    """The owner's per-step provider choice for this item (HZ-357), or None.

    The server sends `providerChoices` as {"<step index>": "claude" | "muse"},
    copied into the task at dispatch, so a choice changed while this step runs
    reaches only the next dispatch. Anything else — no map (an older server),
    no key (Default), an unknown value — is None, i.e. today's routing. The
    caller still gates this on steps.provider_override_eligible().
    """
    choices = item.get("providerChoices")
    if not isinstance(choices, dict) or step_index is None:
        return None
    choice = choices.get(str(step_index))
    return choice if choice in STEP_PROVIDER_CHOICES else None


def _persona_line(task: dict) -> str:
    """The prompt's persona line: the persona this step will actually compose,
    named with its agent, or an explicit "generalist" for the steps that
    compose none. Pre-HZ-125 this printed one resolved id for every step —
    including the generalist planning steps, which never received it."""
    config = STEP_CONFIG.get(task["step"]["label"])
    persona_agent = config[3] if config else None
    if not persona_agent:
        return "  persona: (none — this step is generalist)"
    resolved = resolve(persona_agent, item_personas(task["item"]).get(persona_agent))
    return f"  persona: {persona_agent}/{resolved}"


def build_prompt(task: dict) -> str:
    item, step = task["item"], task["step"]
    lines = [
        f"Work item {item['id']}: {item['title']}",
        f"  repo: {item.get('repo') or '(none — no code workspace for this item)'}   issue: #{item.get('issue') or '-'}   priority: {item.get('priority')}",
        f"  outcome: {item.get('desc') or '(empty)'}",
        f"  success metric: {item.get('metric') or '(empty)'}",
        f"  guardrails: {item.get('guardrails') or '(defaults only)'}",
        _persona_line(task),
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
    note = handoff.read_note(str(item.get("id", "")), str(step.get("label", "")))
    if note:
        lines += [
            "",
            "## Handoff note from a previous attempt — UNVERIFIED",
            "Written by the previous attempt's session as it ran out of turns. Check every "
            "claim against the code before relying on it.",
            "",
            note,
        ]
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


def truncate_diff(diff_full: str) -> tuple[str, str]:
    """Cap the diff shown to a reviewer, and SAY SO when it is cut.

    A silently truncated diff ends mid-statement, so a competent reviewer reads
    it as broken code and fails the item — which sends it back to Eng, which
    finds nothing wrong, which re-runs review against the same truncated diff.
    Observed looping HZ-76 three times at ~15 minutes a cycle, each one ending
    in a verdict ("Diff cuts off at `if (FARM_URL)`") that described the prompt
    rather than the change.

    Returning the note separately keeps it OUTSIDE the ```diff fence, so it
    cannot be mistaken for part of the patch.
    """
    if len(diff_full) <= REVIEW_DIFF_CHARS:
        return diff_full, ""
    shown = diff_full[:REVIEW_DIFF_CHARS]
    omitted = len(diff_full) - len(shown)
    note = (
        f"\n\n**DIFF TRUNCATED — {omitted:,} of {len(diff_full):,} characters were omitted.**\n"
        "The patch above ends where the cap fell, NOT where the change ends, so it "
        "will look unfinished. Do not treat the cut as a defect: judge only what is "
        "shown, and if the truncation prevents a confident verdict, say the diff was "
        "truncated and that review is incomplete — do not fail the change for it. "
        "The file list above this diff shows the change's true extent."
    )
    return shown, note


class PreparedBranch(NamedTuple):
    branch: str
    # origin/<branch>'s sha as fetched — the expected value for every push of
    # this attempt (see _push_with_lease). Empty when the branch is new.
    lease_sha: str
    # Prompt text describing a checkpoint rebase, or "".
    note: str


def prepare_branch(ws: Path, item: dict, *, rebase_checkpoint: bool = False) -> PreparedBranch:
    branch = f"horizon/{item['id'].lower()}"
    # A superseded/killed attempt leaves uncommitted edits behind; every new
    # attempt starts from a scrubbed tree (pushed branches are the only state
    # that survives an attempt). reset/clean only ever touch this item's own
    # worktree — no lock needed. fetch mutates the hub's shared
    # refs/remotes/origin/* (every item's worktree reads those), so it's
    # serialized against every other item's fetch/push on this repo.
    git(ws, "reset", "--hard")
    git(ws, "clean", "-fd")
    # HZ-321: a deploy checkpoint whose push failed lives only in this
    # worktree — resume from it, once, rather than from origin.
    unpushed = _take_unpushed_checkpoint(ws, branch)
    #
    # HZ-184: the lease sha is read INSIDE the lock. Another item's fetch moves
    # the same shared origin/<branch> ref, so a bare --force-with-lease later
    # would compare against whatever that fetch saw, not what this attempt
    # built on — and could overwrite a remote change.
    with hub_lock(item["repo"]):
        git(ws, "fetch", "origin", "--prune")
        remote_branch = git(ws, "rev-parse", "--verify", f"origin/{branch}", check=False)
    lease_sha = remote_branch.stdout.strip() if remote_branch.returncode == 0 else ""
    default = _default_branch(ws)
    git(ws, "checkout", "-B", branch, unpushed or lease_sha or f"origin/{default}")
    note = _rebase_checkpoint(ws, default, unpushed or lease_sha) if rebase_checkpoint else ""
    return PreparedBranch(branch, lease_sha, note)


def _git_path(ws: Path, name: str) -> Path:
    path = Path(git(ws, "rev-parse", "--git-path", name).stdout.strip())
    return path if path.is_absolute() else ws / path


def _take_unpushed_checkpoint(ws: Path, branch: str) -> str:
    """The sha of an unpushed deploy checkpoint left for `branch` (see
    _deploy_checkpoint), or "". The marker is removed either way: it is
    resumed from at most once."""
    marker = _git_path(ws, UNPUSHED_CHECKPOINT)
    try:
        named, _, sha = marker.read_text().strip().partition(" ")
    except OSError:
        return ""
    marker.unlink(missing_ok=True)
    if named != branch or not sha:
        return ""
    if git(ws, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode != 0:
        return ""
    log(f"resuming the unpushed deploy checkpoint {sha[:12]}")
    return sha


def _rebase_checkpoint(ws: Path, default: str, lease_sha: str) -> str:
    """HZ-184: a resumed checkpoint is rebased onto current origin/<default>
    first, so fixes that landed on main since (HZ-125) reach it. A conflicting
    rebase is abandoned and the attempt resumes from the checkpoint as it was —
    the work is never lost to a rebase. Runs only in this item's worktree;
    nothing is pushed here. `lease_sha` is the commit the branch was checked
    out at, which the abort path returns to."""
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    if CHECKPOINT_MARKER not in subject:
        return ""
    if not lease_sha:
        # HEAD came from origin/<default>, so it is no checkpoint of this
        # item's — and the abort path below must never `reset --hard ''`.
        return ""
    if git(ws, "merge-base", "--is-ancestor", f"origin/{default}", "HEAD", check=False).returncode == 0:
        return ""  # already on current main
    rebased = git(ws, "rebase", f"origin/{default}", check=False)
    if rebased.returncode == 0:
        log(f"rebased the WIP checkpoint onto origin/{default}")
        return (
            f"\n\nNOTE: the checkpoint was rebased onto current origin/{default} before this attempt "
            "started, so fixes that landed on main since the previous attempt are included."
        )
    git(ws, "rebase", "--abort", check=False)
    git(ws, "reset", "--hard", lease_sha)
    log(f"rebasing the WIP checkpoint onto origin/{default} conflicted — resuming it unrebased")
    return (
        f"\n\nNOTE: the checkpoint could not be rebased onto current origin/{default} (the rebase "
        f"conflicted), so this attempt resumes it unrebased, on an older origin/{default}. Fixes that "
        "landed on main since are NOT in this tree."
    )


def merge_default_branch(ws: Path) -> list[str]:
    """HZ-188: merge origin/<default> into the freshly prepared item branch
    before the agent starts, so a conflict send-back reworks the code on top
    of today's main instead of the stale base the conflict came from (HZ-125,
    HZ-144). A clean merge is committed; a conflicted one is left IN PROGRESS
    with its markers on disk for the agent to resolve — finalize_branch's
    commit then records it as the merge commit. Returns the conflicted paths
    (empty for a clean merge). Any other merge failure raises: the agent must
    not start on a half-merged tree it was never told about."""
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    default = head.rsplit("/", 1)[-1] if head else "main"
    merged = git(ws, "merge", "--no-edit", f"origin/{default}", check=False)
    if merged.returncode == 0:
        return []
    conflicted = git(ws, "diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
    if not conflicted:
        raise RuntimeError(f"merging origin/{default} failed: {(merged.stderr or merged.stdout).strip()[:300]}")
    return conflicted


def _conflict_markers_left(ws: Path, paths: list[str]) -> list[str]:
    """The paths merge_default_branch left conflicted that still hold a
    `<<<<<<<` or `>>>>>>>` marker line. Only those paths are scanned: git
    wrote markers into nothing else, and a repo may carry marker-looking text
    elsewhere on purpose (conflict test fixtures)."""
    left = []
    for path in paths:
        try:
            text = (ws / path).read_text(errors="replace")
        except (FileNotFoundError, IsADirectoryError):
            continue  # the agent resolved it by deleting the file
        if any(line.startswith(("<<<<<<<", ">>>>>>>")) for line in text.splitlines()):
            left.append(path)
    return left


def _merge_main_note(conflicted: list[str]) -> str:
    if not conflicted:
        return (
            "\n\nNOTE: this branch's PR conflicted with main. origin/main has already "
            "been merged into it cleanly — build on the merged code as it is now."
        )
    files = "\n".join(f"- {path}" for path in conflicted)
    return (
        "\n\nNOTE: this branch's PR conflicted with main. origin/main has been merged "
        "into it and the merge is still in progress: these files have conflict markers "
        f"left in place for you to resolve —\n{files}\n"
        "Resolve every marker keeping the intent of both sides, then carry on with the "
        "step. Do not run `git merge --abort` and do not commit — the harness commits "
        "the merge after you finish."
    )


def _checkpoint_cause(ws: Path) -> tuple[str, str] | None:
    """(cause, detail) of the checkpoint at HEAD, or None when HEAD is not a
    checkpoint. A checkpoint written before HZ-184 has no body and reads as
    (CAUSE_EXHAUSTED, "") — the only cause that existed then."""
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    if CHECKPOINT_MARKER not in subject:
        return None
    body = git(ws, "log", "-1", "--format=%b", check=False).stdout.strip()
    first, _, detail = body.partition("\n")
    if not first.startswith("cause: "):
        return CAUSE_EXHAUSTED, ""
    return first[len("cause: "):].strip(), detail.strip()


def _checkpoint_resume_note(ws: Path) -> str | None:
    """If HEAD is a salvage checkpoint left by a prior attempt (prepare_branch()
    already based this branch off origin/<branch>, so a pushed checkpoint is
    HEAD by construction), returns prompt text pointing the next attempt at it
    and saying why that attempt stopped. Returns None for a normal,
    non-checkpoint HEAD."""
    checkpoint = _checkpoint_cause(ws)
    if checkpoint is None:
        return None
    cause, detail = checkpoint
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    stat = git(ws, "diff", "--stat", f"origin/{_default_branch(ws)}...HEAD", check=False).stdout.strip()
    if cause == CAUSE_CHECKS_FAILED:
        return (
            "\n\nNOTE: this branch already has a WIP checkpoint commit "
            f'("{subject}") that holds the previous attempt\'s complete work. That attempt '
            "finished, but the repo's checks failed on it:\n\n"
            f"```\n{detail or '(no check output was captured)'}\n```\n\n"
            "Fix those failures on top of the checkpoint — read the diff below. Do not discard "
            f"it or restart from scratch.\n\n```\n{stat}\n```"
        )
    if cause == CAUSE_DEPLOY:
        return (
            "\n\nNOTE: this branch already has a WIP checkpoint commit "
            f'("{subject}") saved when a Horizon deploy stopped the previous attempt mid-run. '
            "That work is unfinished and was never checked — a file may even have been cut off "
            "mid-edit. Continue it: read the diff below and pick up where it left off. Do not "
            f"discard it or restart from scratch.\n\n```\n{stat}\n```"
        )
    if cause == CAUSE_PAUSED:
        return (
            "\n\nNOTE: this branch already has a WIP checkpoint commit "
            f'("{subject}") saved when an operator paused the previous attempt mid-run. '
            "That work is unfinished and was never checked — a file may even have been cut off "
            "mid-edit. Continue it: read the diff below and pick up where it left off. Do not "
            f"discard it or restart from scratch.\n\n```\n{stat}\n```"
        )
    return (
        "\n\nNOTE: this branch already has a WIP checkpoint commit from a prior "
        f'attempt that ran out of turns/time ("{subject}"). Continue that work — '
        "read the diff below and pick up where it left off. Do not discard it or "
        f"restart from scratch.\n\n```\n{stat}\n```"
    )


# ---- fix pass + delta review (HZ-182) ----
# After a review rejection the server dispatches the implement step with
# scope {"mode": "fix", "base_sha", "max_turns", "timeout_s", "findings"} and
# the review after it with {"mode": "delta", "base_sha", "previous_findings"}.
# Every decision is the server's; this side only executes the scope and
# reports what it actually did, so the server can fall back to full.


def scope_of(task: dict) -> dict:
    scope = task.get("scope")
    return scope if isinstance(scope, dict) and scope.get("mode") in ("fix", "delta") else {"mode": "full"}


def _default_branch(ws: Path) -> str:
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    return head.rsplit("/", 1)[-1] if head else "main"


def _names(ws: Path, rev_range: str) -> list[str]:
    out = git(ws, "diff", "--name-only", rev_range, check=False).stdout
    return [line for line in out.splitlines() if line.strip()]


def delta_base_problem(ws: Path, base: str | None, default: str) -> str | None:
    """Why `base..HEAD` is NOT a trustworthy delta, or None when it is.

    The last reviewed commit must still exist AND be an ancestor of HEAD. A
    force-with-lease push after a rebase leaves the old commit in the object
    store, so existence alone would diff against a dead commit and produce a
    wrong delta rather than an empty one. A merge from main that changed files
    the PR touches also disqualifies the delta: main's changes would ride in it.
    """
    # A commit sha, nothing else — the value reaches git argv.
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{7,64}", base):
        return "base_missing"
    if git(ws, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}", check=False).returncode != 0:
        return "base_missing"
    if git(ws, "merge-base", "--is-ancestor", base, "HEAD", check=False).returncode != 0:
        return "base_not_ancestor"
    old_mb = git(ws, "merge-base", base, f"origin/{default}", check=False).stdout.strip()
    new_mb = git(ws, "merge-base", "HEAD", f"origin/{default}", check=False).stdout.strip()
    if old_mb and new_mb and old_mb != new_mb:
        if set(_names(ws, f"{old_mb}..{new_mb}")) & set(_names(ws, f"origin/{default}...HEAD")):
            return "main_merged"
    return None


def fix_diff_report(ws: Path, base: str | None) -> dict:
    """The fix pass's size, for the server's full-review threshold — or why
    it could not be measured, which the server treats as oversize."""
    problem = delta_base_problem(ws, base, _default_branch(ws))
    if problem:
        return {"scope_fallback": problem}
    lines = 0
    for row in git(ws, "diff", "--numstat", f"{base}..HEAD", check=False).stdout.splitlines():
        added, removed = (row.split("\t") + ["", ""])[:2]
        # Binary files report "-"; count each as one changed line.
        lines += (int(added) if added.isdigit() else 1) + (int(removed) if removed.isdigit() else 1)
    return {"fix_diff_lines": lines, "fix_diff_files": _names(ws, f"{base}..HEAD")}


def _last_check_failure(ws: Path) -> str:
    """Fix-scope counterpart of _checkpoint_resume_note: only what failed, as
    no "continue the WIP" text may contradict the fix-only instruction."""
    checkpoint = _checkpoint_cause(ws)
    if checkpoint is None or checkpoint[0] != CAUSE_CHECKS_FAILED:
        return ""
    return (
        "\n\nThe previous fix attempt's changes are in the WIP checkpoint at HEAD, but the "
        f"repo's checks failed on them:\n\n```\n{checkpoint[1] or '(no check output was captured)'}\n```"
    )


def _deploy_stop_note(ws: Path) -> str:
    """HZ-321: a fix pass a deploy stopped resumes on its WIP checkpoint."""
    checkpoint = _checkpoint_cause(ws)
    if checkpoint is None or checkpoint[0] != CAUSE_DEPLOY:
        return ""
    return (
        "\n\nThis fix pass was stopped by a Horizon deploy and its unfinished, unchecked changes "
        "are in the WIP checkpoint at HEAD. Continue from them; do not discard them."
    )


def fix_pass_section(scope: dict) -> str:
    """The scope rule for a fix-pass implement prompt. The findings themselves
    arrive once, as the "Human feedback to address" list above."""
    files = sorted({f["file"] for f in scope.get("findings") or [] if isinstance(f, dict) and isinstance(f.get("file"), str)})
    involved = ", ".join(f"`{f}`" for f in files) or "(none named)"
    return (
        "\n\n## Fix pass\n"
        f"This is a fix pass after an automated review rejection. Everything up to commit "
        f"`{scope.get('base_sha')}` already passed review. Fix ONLY the blocking findings in the "
        "feedback above. Do not refactor, restyle or extend anything else.\n"
        f"Files the findings involve: {involved}.\n"
        "Change no other file unless the fix needs it; if it does, name each such file and say "
        "why in your summary. The next review sees every line you change."
    )


def _merge_previous_findings(previous: list, replies: list[dict]) -> list[dict]:
    """ONE previous_findings array from both reviewers, fail-closed: a finding
    is resolved only when every reviewer reports it `resolved: true`. A
    reviewer that omits it, or returns no list at all, leaves it unresolved."""
    merged = []
    for prev in previous:
        index = prev.get("index") if isinstance(prev, dict) else None
        if not isinstance(index, int):
            continue
        resolved, details = True, []
        for reply in replies:
            entries = reply.get("previous_findings")
            entry = next(
                (e for e in entries if isinstance(e, dict) and e.get("index") == index), None
            ) if isinstance(entries, list) else None
            if entry is None or entry.get("resolved") is not True:
                resolved = False
            if entry is not None and isinstance(entry.get("detail"), str) and entry["detail"].strip():
                details.append(entry["detail"].strip())
        merged.append({"index": index, "resolved": resolved, "detail": "; ".join(details)})
    return merged


def delta_review_section(scope: dict, base: str, delta_files: list[str]) -> str:
    lines = [
        "## Fix-pass delta review",
        f"This is a re-review after a rejection. The diff below is ONLY the change since `{base}`, "
        "the last reviewed commit. Everything else in the PR already passed review.",
        'Report every previous finding below in "previous_findings", by index, with `resolved` true or false.',
        "",
        "Previous findings:",
    ]
    finding_files = set()
    for prev in scope.get("previous_findings") or []:
        if not isinstance(prev, dict):
            continue
        loc = prev.get("file") or "general"
        if prev.get("file"):
            finding_files.add(prev["file"])
            if prev.get("line"):
                loc = f"{loc}:{prev['line']}"
        lines.append(f"- [{prev.get('index')}] `{loc}` — {prev.get('detail', '')}")
    outside = [f for f in delta_files if f not in finding_files]
    if outside:
        lines += [
            "",
            "Changed outside the findings — the implement summary must explain each; block if it does not:",
            *[f"- `{f}`" for f in outside],
        ]
    return "\n".join(lines)


def _push_with_lease(ws: Path, item: dict, branch: str, lease_sha: str) -> None:
    """Agent work branches are single-writer (the implement mutex): a rebase
    rewriting earlier attempts is legitimate, so this force-pushes — but only
    over the exact sha prepare_branch() checked out (empty: the branch must
    not exist yet), the same explicit lease conflict_resolver uses. Same
    hub-shared-refs lock as the fetch in prepare_branch."""
    with hub_lock(item["repo"]):
        git(ws, "push", f"--force-with-lease=refs/heads/{branch}:{lease_sha}", "-u", "origin", branch)


def finalize_branch(
    ws: Path, item: dict, branch: str, conflicted: list[str] | None = None, *, lease_sha: str = ""
) -> dict:
    # A merge of main still carrying conflict markers must never be committed:
    # GitHub would then call the PR mergeable with the markers in it, and no
    # later send-back would be told which files still hold them.
    markers = _conflict_markers_left(ws, conflicted or [])
    if markers:
        raise RuntimeError(f"conflict markers left unresolved in: {', '.join(markers)} — nothing committed or pushed")
    git(ws, "add", "-A")
    staged = git(ws, "diff", "--cached", "--quiet", check=False)
    # An in-progress merge of main (merge_default_branch) must be committed
    # even when its resolution kept this branch's side verbatim — otherwise
    # the push leaves main unmerged and the conflict survives.
    merging = git(ws, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False)
    if staged.returncode != 0 or merging.returncode == 0:
        git(ws, "commit", "-m", f"{item['id']}: {item['title']} (Horizon Eng agent)")
    if _no_code_changes(ws):
        raise RuntimeError("the agent made no code changes — nothing to push")
    _push_with_lease(ws, item, branch, lease_sha)
    stat = git(ws, "diff", "--stat", f"origin/{_default_branch(ws)}...HEAD", check=False).stdout.strip().splitlines()
    return {"branch": branch, "files_changed": stat[-1] if stat else ""}


def _default_branch(ws: Path) -> str:
    head = git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    return head.rsplit("/", 1)[-1] if head else "main"


def _no_code_changes(ws: Path) -> bool:
    """HZ-346: the one "nothing to push" test. finalize_branch() raises on it
    after committing; the implement step reads it before checks to decide
    whether a blocked report may stand. Anything on disk, a merge in progress
    or a commit ahead of the default branch (a WIP checkpoint included) is a
    change, so such a run always takes the normal checks-and-review path."""
    if git(ws, "status", "--porcelain", check=False).stdout.strip():
        return False
    if git(ws, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).returncode == 0:
        return False
    ahead = git(ws, "rev-list", "--count", f"origin/{_default_branch(ws)}..HEAD", check=False).stdout.strip()
    return ahead == "0"


def _blocked_report(parsed) -> dict | None:
    """HZ-346: the implement role's `{"blocked": {"rule", "needs"}}` reply,
    stripped and capped, or None when either field is missing or blank —
    such a reply is treated as no report at all."""
    block = parsed.get("blocked") if isinstance(parsed, dict) else None
    if not isinstance(block, dict):
        return None
    rule, needs = block.get("rule"), block.get("needs")
    if not isinstance(rule, str) or not isinstance(needs, str):
        return None
    rule, needs = rule.strip()[:RULE_MAX_CHARS].strip(), needs.strip()[:NEEDS_MAX_CHARS].strip()
    if not rule or not needs:
        return None
    return {"rule": rule, "needs": needs}


# ---- checkpoint salvage on turn/time exhaustion (HZ-31) ----
# run_agent raises AgentError (AgentExhaustedError on exhaustion) when the
# implement step hits its max-turns or timeout cap (farm/agent_runner.py).
# Left alone, that exception propagates straight to main()'s catch-all and
# the workspace's uncommitted edits are destroyed by the *next* attempt's
# prepare_branch() (reset --hard + clean -fd) — a Sisyphus loop that can
# never converge on a job bigger than one budget. Salvage checkpoints
# whatever was on disk so the next attempt continues instead of restarting
# from zero.
#
# HZ-184: a finished run whose repo checks fail is checkpointed the same way
# (cause checks-failed, with the failure digest in the body), instead of
# being scrubbed by the next attempt. A checkpoint is still a failed run: the
# exception propagates, finalize_branch never runs and no PR is opened.


def _salvage_checkpoint(
    ws: Path,
    item: dict,
    branch: str,
    conflicted: list[str] | None = None,
    *,
    cause: str = CAUSE_EXHAUSTED,
    detail: str = "",
    lease_sha: str = "",
) -> str:
    """Best-effort: never raises. A salvage failure (e.g. a concurrent push
    winning the --force-with-lease race) just means this attempt's partial
    work is lost — the caller's original exception is what must still
    propagate and fail the run, unchanged from pre-HZ-31 behavior.

    HZ-194: returns what happened, for the pause path to report — "saved",
    "nothing", "skipped: <why>" or "failed: <error>". The HZ-31/HZ-184
    callers ignore it. Files matching SECRET_PATTERNS are never committed.

    HZ-188: a half-resolved merge of main is never checkpointed. Committing
    it would push conflict markers to the PR branch and make GitHub report it
    mergeable, so the next send-back would not merge main or name the files.
    Dropping it is safe: that send-back merges main again from scratch.

    A checks-failed checkpoint is committed even with no changes: a failure
    caused by main alone (HZ-157) must still carry its digest forward."""
    try:
        markers = _conflict_markers_left(ws, conflicted or [])
        if markers:
            log(f"salvage: skipped — the merge of main still has conflict markers in {', '.join(markers)}")
            return f"skipped: the merge of main still has conflict markers in {', '.join(markers)}"
        git(ws, "add", "-A")
        _unstage_secrets(ws)
        staged = git(ws, "diff", "--cached", "--quiet", check=False)
        allow_empty = cause == CAUSE_CHECKS_FAILED
        if staged.returncode == 0 and not allow_empty:
            log("salvage: no uncommitted changes to checkpoint")
            return "nothing"
        body = f"cause: {cause}" + (f"\n\n{detail}" if detail else "")
        git(
            ws,
            "commit",
            *(["--allow-empty"] if allow_empty else []),
            "--cleanup=verbatim",
            "-m",
            f"{item['id']}: {CHECKPOINT_MARKER} (Horizon Eng agent)",
            "-m",
            body,
        )
        _push_with_lease(ws, item, branch, lease_sha)
        log(f"salvage: pushed WIP checkpoint ({cause}) to {branch}")
        return "saved"
    except Exception as exc:
        log(f"salvage: failed to checkpoint ({exc}) — work is lost, next attempt starts clean")
        return f"failed: {exc}"


def _is_secret_path(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    if any(fnmatch.fnmatch(name, pattern) for pattern in SECRET_PATTERN_EXCEPTIONS):
        return False
    return any(fnmatch.fnmatch(name, pattern) for pattern in SECRET_PATTERNS)


def _unstage_secrets(ws: Path) -> list[str]:
    """Unstages every staged path that looks like a secret (HZ-194), so a
    checkpoint can never push one. Deletions are left staged: removing a
    secret from the branch is never a leak."""
    staged = git(ws, "diff", "--cached", "--name-only", "--diff-filter=d", "-z", check=False).stdout
    secrets = [path for path in staged.split("\0") if path and _is_secret_path(path)]
    if secrets:
        git(ws, "reset", "-q", "--", *secrets)
        log(f"salvage: left out of the checkpoint (secret-looking files): {', '.join(secrets)}")
    return secrets


def _pause_checkpoint(ws: Path, item: dict, branch: str, conflicted: list[str], lease_sha: str, scope: dict) -> tuple[str, str]:
    """HZ-194: what a pause saves of a running implement attempt. Every child
    (the claude CLI, check commands) is stopped first so nothing writes while
    the tree is committed, and a git lock a killed git call left behind is
    cleared. Reuses HZ-184's salvage — one checkpoint implementation. Never
    opens or updates a PR through the API, and the run is never reported as
    passed. Returns (outcome, detail) in pause's vocabulary."""
    stopped = pause.kill_descendants()
    if stopped:
        log(f"pause: stopped {stopped} child process(es)")
    lock = git(ws, "rev-parse", "--git-path", "index.lock", check=False).stdout.strip()
    if lock:
        lock_path = Path(lock) if Path(lock).is_absolute() else ws / lock
        if lock_path.exists():
            lock_path.unlink(missing_ok=True)
            log("pause: removed a stale git index.lock left by a stopped git call")
    if pause.stop_reason() == pause.STOP_DEPLOY:
        # HZ-321: a deploy is not an operator's choice, so the work is saved
        # even on an open PR — the item is at implement, nothing can merge it.
        return _deploy_checkpoint(ws, item, branch, conflicted, lease_sha)
    if scope["mode"] == "fix":
        # Pushing here would add commits to the open PR (and run its CI).
        return pause.SKIPPED, f"a PR is open on {branch} — a checkpoint would update it"
    result = _salvage_checkpoint(ws, item, branch, conflicted, cause=CAUSE_PAUSED, lease_sha=lease_sha)
    if result == "saved":
        return pause.SAVED, f"pushed a WIP checkpoint to {branch}"
    if result == "nothing":
        return pause.NOTHING, "no changes since the last commit"
    # The detail reaches the server's activity log. A failed push can echo
    # the remote URL, which carries the hub's token (workspaces.ensure).
    detail = _URL_CREDENTIALS.sub("://[redacted]@", result.partition(": ")[2] or result)
    return pause.FAILED, redact(detail, os.environ)


def _deploy_checkpoint(ws: Path, item: dict, branch: str, conflicted: list[str] | None, lease_sha: str) -> tuple[str, str]:
    """HZ-321: saves a running attempt a self-deploy is stopping as one WIP
    commit of its whole tree, pushed to the item's own branch — never forced,
    never rewriting a commit, so unlike _salvage_checkpoint (whose lease push
    may replace a rebased branch) it cannot lose anything already pushed.

    The commit's parent is what the remote branch holds when HEAD does not
    already contain it (a resumed checkpoint rebased onto main locally), so
    the push is always a fast-forward and its tree is exactly what was on
    disk. A merge of main in progress keeps MERGE_HEAD as a second parent.
    .gitignore is honoured and SECRET_PATTERNS are never staged.

    If the push fails, the commit stays in this worktree with a marker, and
    the next attempt's prepare_branch resumes from it. Never raises.
    Returns (outcome, detail) in pause's vocabulary."""
    own = f"horizon/{item['id'].lower()}"
    try:
        default = _default_branch(ws)
        if branch != own or branch in (default, "main", "master"):
            return pause.SKIPPED, f"refused: {branch} is not this item's own branch"
        markers = _conflict_markers_left(ws, conflicted or [])
        if markers:
            return pause.SKIPPED, f"the merge of main still has conflict markers in {', '.join(markers)}"
        git(ws, "add", "-A")
        _unstage_secrets(ws)
        head = git(ws, "rev-parse", "HEAD").stdout.strip()
        merging = git(ws, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False)
        merge_head = merging.stdout.strip() if merging.returncode == 0 else ""
        staged = git(ws, "diff", "--cached", "--quiet", check=False).returncode != 0
        published = lease_sha or f"origin/{default}"
        pushed_already = git(ws, "merge-base", "--is-ancestor", head, published, check=False).returncode == 0
        if not staged and not merge_head and pushed_already:
            return pause.NOTHING, "no changes since the last push"
        contains_remote = not lease_sha or git(ws, "merge-base", "--is-ancestor", lease_sha, head, check=False).returncode == 0
        parents = [head if contains_remote else lease_sha] + ([merge_head] if merge_head else [])
        tree = git(ws, "write-tree").stdout.strip()
        wip = git(
            ws,
            "commit-tree",
            tree,
            *[arg for parent in parents for arg in ("-p", parent)],
            "-m",
            f"{item['id']}: {CHECKPOINT_MARKER} (Horizon Eng agent)",
            "-m",
            f"cause: {CAUSE_DEPLOY}",
        ).stdout.strip()
        if merge_head:
            git(ws, "merge", "--quit")
        git(ws, "update-ref", "HEAD", wip)
        marker = _git_path(ws, UNPUSHED_CHECKPOINT)
        marker.write_text(f"{own} {wip}\n")
        with hub_lock(item["repo"]):
            git(ws, "push", "origin", f"{wip}:refs/heads/{own}")
            remote = git(ws, "ls-remote", "origin", f"refs/heads/{own}").stdout.split()
        if not remote or remote[0] != wip:
            raise RuntimeError("the remote branch does not hold the checkpoint after the push")
        marker.unlink(missing_ok=True)
        log(f"deploy: pushed WIP checkpoint {wip[:12]} to {own}")
        return pause.SAVED, f"pushed a WIP checkpoint to {own}"
    except Exception as exc:
        log(f"deploy: checkpoint not pushed ({exc}) — kept in the worktree for the next attempt")
        # The detail reaches the server's activity log; a failed push can
        # echo the remote URL, which carries the hub's token.
        detail = _URL_CREDENTIALS.sub("://[redacted]@", str(exc))
        return pause.FAILED, redact(detail, os.environ)


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


# ---- guardrails block on a quoted violation, never on paperwork (HZ-345) ----
# The review prompts ask for violation-only guardrail findings; this is the
# check in code. A block finding about a guardrail stays a block only when it
# quotes the guardrail from the item AND a changed (+/-) line of the diff, both
# verbatim. Anything else ("no evidence the guardrail held") becomes a note.
# A block on a metric line marked Manual becomes a note when the implement
# step's `## Manual checks` holds a statement for that line. Every downgrade is
# recorded, so a human at "Accept the code" still sees it.

_NO_EVIDENCE = re.compile(r"no evidence|not verified|unverified|not shown|not demonstrated", re.IGNORECASE)
_MANUAL_LINE = re.compile(r"^manual\b|\(manual\)", re.IGNORECASE)
_LEADING_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
MANUAL_CHECKS_HEADING = "## Manual checks"
MANUAL_CHECKS_MAX_CHARS = 3000
# A diff_line shorter than this must match a whole changed line; a longer one
# may be part of one. Stops a quote like "}" matching anywhere.
_MIN_PARTIAL_DIFF_QUOTE = 12
_QA_FLAGS = ("regression_tests_run", "new_code_unit_coverage", "e2e_test_present")


def _squash(text) -> str:
    return " ".join(str(text or "").split())


def _changed_lines(diff: str) -> list[str]:
    """The content of every added or removed line, whitespace-collapsed."""
    changed = []
    for line in (diff or "").splitlines():
        if line.startswith(("+++ ", "--- ")) or not line.startswith(("+", "-")):
            continue
        content = _squash(line[1:])
        if content:
            changed.append(content)
    return changed


def _diff_line_found(quote, changed: list[str]) -> bool:
    if not isinstance(quote, str):
        return False
    q = _squash(quote)
    if q[:1] in ("+", "-"):
        q = q[1:].strip()
    if not q:
        return False
    return any(q == line or (len(q) >= _MIN_PARTIAL_DIFF_QUOTE and q in line) for line in changed)


def _guardrail_found(quote, guardrails: str) -> bool:
    if not isinstance(quote, str):
        return False
    q = _squash(_LEADING_MARKER.sub("", quote))
    return bool(q) and q in _squash(guardrails)


def manual_metric_lines(metric) -> dict[int, str]:
    """{line number: text} for each metric line marked Manual, numbered the way
    domain/py/fields.py's criteria_lines() counts them."""
    return {n: line for n, line in enumerate(fields.criteria_lines(metric), 1) if _MANUAL_LINE.search(line)}


def manual_checks_text(artifacts) -> str:
    """The `## Manual checks` section of the implement step's output — the
    statements the server also put in the PR body."""
    for artifact in artifacts or []:
        if not isinstance(artifact, dict) or artifact.get("label") != IMPLEMENT_LABEL:
            continue
        content = str(artifact.get("content") or "")
        start = content.find(MANUAL_CHECKS_HEADING)
        if start == -1:
            return ""
        body = content[start + len(MANUAL_CHECKS_HEADING) :]
        following = re.search(r"^## ", body, re.MULTILINE)
        return body[: following.start()] if following else body
    return ""


def _has_statement(manual_checks: str, line_no: int) -> bool:
    pattern = rf"^\s*(?:[-*+]\s*)?line\s+{line_no}\s*[:.)—-]\s*\S"
    return re.search(pattern, manual_checks, re.IGNORECASE | re.MULTILINE) is not None


def _metric_line(finding: dict) -> int | None:
    value = finding.get("metric_line")
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _is_block(finding) -> bool:
    # Fail-closed: a finding with no readable severity counts as a block.
    return not isinstance(finding, dict) or finding.get("severity") != "note"


def _judge_finding(finding: dict, *, guardrails: str, changed: list[str], manual: dict, manual_checks: str):
    """(downgrade reason or None, the finding to keep)."""
    detail = str(finding.get("detail") or "")
    line_no = _metric_line(finding)
    if line_no is not None and "guardrail" not in finding:
        manual_line = manual.get(line_no)
        if manual_line is None:
            return None, finding  # an automated metric line still needs its test
        if _has_statement(manual_checks, line_no):
            return f"Manual metric line {line_no} has a statement under `{MANUAL_CHECKS_HEADING}`", finding
        named = f"Manual line {line_no} has no statement under `{MANUAL_CHECKS_HEADING}`: {manual_line}"
        return None, finding if named in detail else {**finding, "detail": f"{detail} — {named}".lstrip(" —")}
    if not isinstance(finding.get("guardrail"), str) and not (line_no is None and "guardrail" in detail.lower()):
        return None, finding  # not about a guardrail: a defect or plan finding is judged as written
    quoted = _guardrail_found(finding.get("guardrail"), guardrails)
    if quoted and _diff_line_found(finding.get("diff_line"), changed):
        return None, finding  # a quoted violation always blocks
    if _NO_EVIDENCE.search(detail):
        return "asks for evidence a guardrail held; only a quoted violation blocks", finding
    if not quoted:
        return "does not quote the guardrail verbatim from the item", finding
    return "`diff_line` is not an added or removed line of the diff", finding


def downgrade_unproven_findings(
    section: dict, *, guardrails: str, metric: str, diff: str, manual_checks: str, qa: bool
) -> tuple[dict, list[dict]]:
    """The section with unproven guardrail blocks (and stated Manual lines)
    turned into notes, plus one record per downgrade. A section left with no
    block flips to pass — for QA only when all three checks are true. A fail
    that had no findings to start with stays a fail."""
    changed = _changed_lines(diff)
    manual = manual_metric_lines(metric)
    kept, downgrades = [], []
    for index, finding in enumerate(section.get("findings") or []):
        if not _is_block(finding):
            kept.append(finding)
            continue
        reason, finding = _judge_finding(
            finding, guardrails=guardrails, changed=changed, manual=manual, manual_checks=manual_checks
        )
        if reason is None:
            kept.append(finding)
            continue
        kept.append({**finding, "severity": "note", "downgraded": reason})
        downgrades.append({"index": index, "reason": reason, "detail": str(finding.get("detail") or "")[:300]})
    result = {**section, "findings": kept}
    if downgrades and result.get("verdict") == "fail" and not any(_is_block(f) for f in kept):
        if not qa or all(result.get(flag) is True for flag in _QA_FLAGS):
            result["verdict"] = "pass"
    return result, downgrades


def _downgrades_md(downgrades: list[dict]) -> str:
    lines = [f"## Guardrail downgrades\nDowngraded {len(downgrades)} finding(s) to a note:"]
    for d in downgrades:
        lines.append(f"- {d['pass']} finding {d['index']}: {d['reason']} — {d['detail']}")
    return "\n".join(lines)


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
    return summary[:SUMMARY_MAX_CHARS]


def model_persona(persona_agent: str | None, personas: dict) -> str | None:
    """HZ-192: the namespaced "<agent>.<persona>" a run_agent() call composes —
    the key domain/personas.json's models.personas overrides by — or None for
    a call that composes no persona."""
    if not persona_agent:
        return None
    return f"{persona_agent}.{resolve(persona_agent, personas.get(persona_agent))}"


def _provenance(reply: dict) -> dict:
    return {"provider": reply.get("provider"), "command_id": reply.get("command_id")}


# ---- turn-cap salvage and handoff (HZ-158) ----
# Every branch below ends in the ORIGINAL AgentExhaustedError, re-raised as is,
# unless a salvage passed every check — so main() still tags it with the
# turn-cap reason and the orchestrator still auto-retries it. Never a plain
# AgentError, which would pause the item for a human.


def _handoff_once(exc: AgentExhaustedError, ctx: HandoffContext, guard: HandoffGuard, ws: Path | None) -> None:
    """Ask the exhausted session for one note for the next attempt, at most
    once per run. Never raises: the caller's exhaustion must propagate."""
    try:
        if not guard.claim():
            log("handoff: already requested once this run — not asking again")
            return
        handoff.write_note(ctx.item_id, ctx.step, handoff.request_note(exc, ctx, ws))
    except Exception as err:
        log(f"handoff: failed ({type(err).__name__}: {str(err)[:200]}) — the next attempt starts without a note")


def _on_exhaustion(
    exc: AgentExhaustedError,
    *,
    required_keys: tuple[str, ...],
    ctx: HandoffContext,
    guard: HandoffGuard,
    salvage: bool,
) -> tuple[dict, list[str]]:
    """Salvage a cut-off reply on a SALVAGE_STEPS step, or hand off and
    re-raise `exc` itself. Returns (parsed, notes) only for a salvage."""
    if salvage and ctx.step in SALVAGE_STEPS:
        try:
            salvaged = salvage_truncated_reply(exc.partial_text, required_keys)
        except Exception as err:
            log(f"salvage: the truncated-reply check raised ({type(err).__name__}: {err}) — not salvaging")
            salvaged = None
        if salvaged is not None:
            parsed, note = salvaged
            log("salvage: accepted a reply cut off mid-string with every required key present")
            return parsed, [note]
        log("salvage: the partial reply did not pass — failing the run as a turn-cap exhaustion")
    _handoff_once(exc, ctx, guard, Path(ctx.cwd) if ctx.cwd else None)
    raise exc


def _run_and_parse(
    prompt: str,
    *,
    agent: str,
    step: str,
    persona: str | None,
    append_system: str | None,
    cwd: str | None,
    max_turns: int,
    timeout_s: int,
    allowed_tools: str | None,
    required_keys: tuple[str, ...],
    item_id: str,
    guard: HandoffGuard,
    provider: str | None = None,
    provider_locked: bool = False,
) -> tuple[dict, dict, list[str]]:
    """run_agent + the shared reply parser, with one retry-with-feedback on a
    parse failure (HZ-44) — mirrors pm_agent.process()'s recovery. Asking the
    model to re-emit valid JSON is lossless; a genuine second failure still
    propagates so the run cancels and the item pauses, unchanged.

    Returns (parsed_json, provenance, notes). Provenance is {"provider",
    "command_id"} from whichever run_agent() call actually produced the JSON
    that parsed (HZ-102), so a caller can record which provider really ran —
    hence the `produced` rebind in the closure rather than reading `reply`
    after the fact. Notes are the shared parser's reporting channel (HZ-156).

    No validate= is handed to the parser, deliberately. Every required-field
    check on this side (a missing 'summary', a deploy reply with no 'url', a
    review reply with no verdict) stays exactly where it has always been —
    after this call returns. Moving one inside the retry envelope would buy a
    second full agent run for a reply that costs nothing to reject today, and
    on the review path a retry could flip a deliberately fail-closed gate.

    HZ-158: required_keys, item_id and guard have no default, so every call
    site must say what its reply needs. They are used only when run_agent
    raises AgentExhaustedError — see _on_exhaustion(). Only the first call may
    be salvaged; an exhaustion inside the retry is handed off and re-raised.
    A salvaged reply's provenance is the provider that ran, no command_id.
    """
    ctx = HandoffContext(
        item_id=item_id,
        step=step,
        agent=agent,
        persona=persona,
        append_system=append_system,
        cwd=cwd,
        deadline=time.monotonic() + timeout_s,
        provider_locked=provider_locked,
    )
    try:
        reply = run_agent(
            prompt,
            agent=agent,
            step=step,
            persona=persona,
            append_system=append_system,
            cwd=cwd,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
            provider=provider,
            provider_locked=provider_locked,
        )
    except AgentExhaustedError as exc:
        parsed, notes = _on_exhaustion(exc, required_keys=required_keys, ctx=ctx, guard=guard, salvage=True)
        return parsed, {"provider": exc.provider, "command_id": None}, notes
    produced = reply

    def retry_once(retry_prompt: str) -> str:
        nonlocal produced
        log("invalid reply; retrying once")
        produced = run_agent(
            retry_prompt,
            agent=agent,
            step=step,
            persona=persona,
            session_id=reply.get("session_id"),
            append_system=append_system,
            cwd=cwd,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
            provider=provider,
            provider_locked=provider_locked,
        )
        return produced["result"]

    try:
        parsed, notes = parse_agent_reply(reply["result"], retry_once)
    except AgentExhaustedError as exc:
        _on_exhaustion(exc, required_keys=required_keys, ctx=ctx, guard=guard, salvage=False)
        raise  # never reached: _on_exhaustion always raises when salvage=False
    return parsed, _provenance(produced), notes


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


# A grpc-health deploy target serves gRPC only, so the browser check above
# can't load it. Its gate is the standard gRPC health check
# (grpc.health.v1.Health/Check), sent with curl over HTTP/2 cleartext, the
# same probe the target's deploy script uses. A SERVING reply passes.
GRPC_HEALTH_REQUEST = b"\x00\x00\x00\x00\x00"  # empty HealthCheckRequest frame
GRPC_HEALTH_SERVING = b"\x00\x00\x00\x00\x02\x08\x01"  # status: SERVING


def run_grpc_health_check(health_url: str) -> tuple[str, str]:
    base = health_url.rstrip("/")
    try:
        result = subprocess.run(
            [
                "curl", "-sS", "--http2-prior-knowledge", "--max-time", "10",
                "-H", "content-type: application/grpc", "-H", "te: trailers",
                "--data-binary", "@-", f"{base}/grpc.health.v1.Health/Check",
            ],
            input=GRPC_HEALTH_REQUEST,
            capture_output=True,
            timeout=SMOKE_CHECK_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return "fail", f"SMOKE_RESULT=fail: gRPC health check timed out ({base})"
    except OSError as exc:
        return "fail", f"SMOKE_RESULT=fail: could not run curl for the gRPC health check: {exc}"
    if result.returncode == 0 and result.stdout == GRPC_HEALTH_SERVING:
        return "pass", f"SMOKE_RESULT=pass: gRPC health SERVING at {base}"
    detail = result.stderr.decode(errors="replace").strip()[:200] or f"reply bytes {result.stdout.hex() or 'none'}"
    return "fail", f"SMOKE_RESULT=fail: gRPC health not SERVING at {base} ({detail})"


# ---- HZ-275: wait for the item's own release before the smoke check ----
# The release is published before this step is dispatched, but the deploy it
# triggers takes minutes (ui-service's npm ci + build ran ~8 min on
# 2026-10-02), and a smoke check run meanwhile tests the PREVIOUS version —
# US-191's passed against the old fintekkers.org that way. So the step first
# waits, bounded, until the target's last-good-tag names this release, and
# fails with the deploy log's tail if the log records DEPLOY FAILED for it or
# the wait runs out. Read-only: it never runs a deploy script or writes the
# state dir.

DEFAULT_DEPLOY_WAIT_S = 1200
# A hard cap, so no payload can make the wait unbounded.
DEPLOY_WAIT_MAX_S = 7200
DEPLOY_POLL_S = 5
# The log grows forever: no read takes more than this many bytes off its end.
DEPLOY_LOG_READ_BYTES = 64 * 1024
DEPLOY_LOG_TAIL_LINES = 20
DEPLOY_LOG_LINE_MAX_CHARS = 160
# Fits inside ERROR_MAX_CHARS with the reason in front of it.
DEPLOY_LOG_TAIL_MAX_CHARS = 1500
# `NAME=value` for a secret-looking NAME, even one this process's env lacks
# (the farm never holds $GITHUB_WEBHOOK_SECRET, so redact() can't know it).
_SECRET_ASSIGNMENT = re.compile(
    r"\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)=(\S+)", re.IGNORECASE
)


class ReleaseWait(NamedTuple):
    outcome: str  # "live", "failed" or "expired"
    detail: str


class DeployNotLiveError(RuntimeError):
    pass


def deploy_wait_bound(value) -> float:
    """The wait bound from the task payload: anything not a positive number
    (0, negative, NaN, non-numeric, null) means the default; never above the cap."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return DEFAULT_DEPLOY_WAIT_S
    if math.isnan(seconds) or seconds <= 0:
        return DEFAULT_DEPLOY_WAIT_S
    return min(seconds, DEPLOY_WAIT_MAX_S)


def _release_is_live(tag: str, state_dir: Path) -> bool:
    """last-good-tag reads `refs/tags/<tag>:<commit>`. Exact match only — a
    missing, unreadable or empty file, origin/main, or a neighbouring tag
    (deploy-hz-10, deploy-hz-1-2 for deploy-hz-1) is not live."""
    try:
        content = (state_dir / "last-good-tag").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return False
    ref = content.split(":", 1)[0].strip()
    return ref.removeprefix("refs/tags/") == tag


def _read_log_end(path: Path, offset: int = 0) -> tuple[bytes, int] | None:
    """The bytes after `offset`, at most DEPLOY_LOG_READ_BYTES off the end,
    and the file size. A file shorter than `offset` was truncated or rotated:
    read from its start again. None when it can't be read."""
    try:
        with open(path, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size < offset:
                offset = 0
            start = max(offset, size - DEPLOY_LOG_READ_BYTES)
            f.seek(start)
            return f.read(size - start), size
    except OSError:
        return None


def wait_for_release(
    tag: str,
    state_dir: str,
    timeout_s: float = DEFAULT_DEPLOY_WAIT_S,
    *,
    poll_s: float | None = None,
    clock=None,
    sleep=None,
) -> ReleaseWait:
    """Polls until `tag` is live, the log records DEPLOY FAILED for it, or
    `timeout_s` runs out (an explicit 0 checks once). Each poll reads only the
    log bytes added since the last one."""
    clock = clock or time.monotonic
    sleep = sleep or time.sleep
    poll_s = DEPLOY_POLL_S if poll_s is None else poll_s
    timeout_s = min(timeout_s, DEPLOY_WAIT_MAX_S) if timeout_s >= 0 else 0  # NaN fails >= too
    state = Path(state_dir)
    log_path = state / "self-deploy.log"
    # Both log forms: `(tag=<TAG>)` before checkout, `(tag=refs/tags/<TAG> commit=...)` after.
    failed_line = re.compile(r"DEPLOY FAILED: .*\(tag=(?:refs/tags/)?" + re.escape(tag) + r"[) ]")
    offset = 0
    deadline = clock() + timeout_s
    while True:
        if _release_is_live(tag, state):
            return ReleaseWait("live", f"last-good-tag names {tag}")
        read = _read_log_end(log_path, offset)
        if read is not None:
            chunk, size = read
            # Only whole lines: a line still being written is read next poll.
            whole = chunk[: chunk.rfind(b"\n") + 1]
            offset = size - len(chunk) + len(whole)
            for line in whole.decode("utf-8", "replace").splitlines():
                if failed_line.search(line):
                    return ReleaseWait("failed", "the deploy log records DEPLOY FAILED for this tag")
        remaining = deadline - clock()
        if remaining <= 0:
            return ReleaseWait("expired", f"the {timeout_s:g}s wait ran out with last-good-tag still on another version")
        sleep(min(poll_s, remaining))


def _deploy_ok_line(tag: str) -> re.Pattern:
    """The deploy script's DEPLOY OK line for exactly `tag`: a neighbour such
    as `<tag>0` never matches. The tag ends at a space or the line's end."""
    return re.compile(r"DEPLOY OK tag=(?:refs/tags/)?" + re.escape(tag) + r"(?: |$)")


def _deploy_log_lines(tag: str, state_dir: str) -> list[str]:
    """The end of self-deploy.log as lines; empty when unreadable or unnamed."""
    read = _read_log_end(Path(state_dir) / "self-deploy.log") if tag and state_dir else None
    return read[0].decode("utf-8", "replace").splitlines() if read is not None else []


def _verified_deploy_result(release: str, done: str, summary_tail: str, how: str) -> dict:
    """The pass result for a target whose deploy script is its own health
    check: no page or port to load, so the verdict is the script's DEPLOY OK."""
    smoke_line = f"SMOKE_RESULT=pass: {release} {done}; {how}"
    return {
        "summary": f"{release} {done}{summary_tail}"[:SUMMARY_MAX_CHARS],
        "artifacts": {
            "artifact_md": f"## Verdict\n**pass** — {release} {done}.\n\n## Machine-checked result\n`{smoke_line}`",
            "verdict": {"verdict": "pass"},
        },
    }


def registry_publish_result(tag: str, state_dir: str) -> dict:
    """The Deploy step's result for a library (health check type
    registry-publish). Its deploy script records DEPLOY OK only after the
    publish workflows for the new version succeeded, and wait_until_release_live
    has already seen that, so there is no page or port to check: the verdict is
    a pass naming the version from the script's DEPLOY OK line."""
    version = None
    ok_line = _deploy_ok_line(tag)
    for line in _deploy_log_lines(tag, state_dir):
        match = ok_line.search(line)
        if match:
            found = re.search(r"version=(\S+)", line[match.end() :])
            if found:
                version = found.group(1)
    release = f"release {tag}" if tag else "the release"
    published = f"published {version}" if version else "published"
    return _verified_deploy_result(
        release, published, " to the package registries", "the deploy script verified the registry workflows"
    )


def deploy_log_result(tag: str, state_dir: str) -> dict:
    """HZ-353: the Deploy step's result for a code-only target (health check
    type deploy-log, e.g. market-data-inputs). Its deploy script checks out the
    tag, installs and runs the repo's offline tests, and only then records
    DEPLOY OK for the tag; nothing restarts. Pass only on that line: without
    it the verdict is a fail with the log tail."""
    release = f"release {tag}" if tag else "the release"
    ok_line = _deploy_ok_line(tag)
    if tag and any(ok_line.search(line) for line in _deploy_log_lines(tag, state_dir)):
        return _verified_deploy_result(
            release, "deployed (code only)", "", "the deploy script installed it and its offline tests passed"
        )
    tail = deploy_log_tail(state_dir) if state_dir else "--- self-deploy.log: no state dir ---"
    smoke_line = f"SMOKE_RESULT=fail: no DEPLOY OK for {release} in the deploy log"
    return {
        "summary": f"{release} not deployed: no DEPLOY OK for it in the deploy log"[:SUMMARY_MAX_CHARS],
        "artifacts": {
            "artifact_md": f"## Verdict\n**fail** — no DEPLOY OK for {release}.\n\n## Machine-checked result\n`{smoke_line}`\n\n```\n{tail}\n```",
            "verdict": {"verdict": "fail"},
        },
    }


def deploy_log_tail(state_dir: str) -> str:
    """The newest lines of self-deploy.log, bounded (DEPLOY_LOG_TAIL_LINES
    lines, DEPLOY_LOG_TAIL_MAX_CHARS chars) and redacted before any line is
    cut, so a cut can never leave half a token unrecognised."""
    read = _read_log_end(Path(state_dir) / "self-deploy.log")
    if read is None:
        return "--- self-deploy.log: not readable ---"
    chunk, size = read
    if len(chunk) < size:
        # Read from mid-file: the first line is partial, and could hold half a token.
        chunk = chunk[chunk.find(b"\n") + 1 :]
    text = redact(chunk.decode("utf-8", "replace"), os.environ)
    text = _SECRET_ASSIGNMENT.sub(r"\1=[redacted]", text)
    lines = [line.rstrip()[:DEPLOY_LOG_LINE_MAX_CHARS] for line in text.splitlines() if line.strip()]
    lines = lines[-DEPLOY_LOG_TAIL_LINES:]
    while lines and sum(len(line) + 1 for line in lines) > DEPLOY_LOG_TAIL_MAX_CHARS:
        lines.pop(0)
    if not lines:
        return "--- self-deploy.log: empty ---"
    return f"--- self-deploy.log (last {len(lines)} lines, redacted) ---\n" + "\n".join(lines)


def wait_until_release_live(task: dict) -> None:
    """Returns once the item's release is live; raises DeployNotLiveError
    otherwise. An item with no release_tag had no release published (the
    server fails the run itself when publishing fails), so there is nothing
    to wait for."""
    item = task["item"]
    tag = item.get("release_tag")
    if not tag:
        return
    wait = task.get("deploy_wait")
    state_dir = wait.get("state_dir") if isinstance(wait, dict) else None
    if not isinstance(state_dir, str) or not state_dir:
        # Fail closed: with nothing to wait on, a smoke check would test
        # whatever version was there before.
        raise DeployNotLiveError(
            f"release {tag} cannot be verified: no deploy target for {item.get('repo')}, so there is no deploy to wait for"
        )
    bound = deploy_wait_bound(wait.get("timeout_s"))
    log(f"waiting up to {bound:g}s for release {tag} to go live ({state_dir})")
    result = wait_for_release(tag, state_dir, bound)
    if result.outcome == "live":
        log(f"release {tag} is live: {result.detail}")
        return
    raise DeployNotLiveError(f"release {tag} did not go live: {result.detail}\n{deploy_log_tail(state_dir)}")


def execute(task: dict) -> dict:
    """HZ-188: the implement and review steps scrub, check out and (for
    implement) push in the item's worktree, so they hold item_lock for the
    whole step — taken before ensure_item_worktree, so not even the worktree's
    creation can overlap a conflict resolver that owns the item. Every other
    step only reads the workspace and runs unlocked.

    HZ-158: one execute() is one run, so the run's handoff guard is made here."""
    item = task["item"]
    guard = HandoffGuard()
    if task["step"]["label"] not in (IMPLEMENT_LABEL, REVIEW_LABEL) or not item.get("repo"):
        return _execute(task, guard)
    lock = item_lock(
        item["repo"],
        item["id"],
        wait_s=ITEM_LOCK_WAIT_S,
        on_wait=lambda: log(f"workspace for {item['id']} is busy (conflict resolution running) — waiting up to {ITEM_LOCK_WAIT_S}s"),
    )
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(lock)
        except ItemBusy:
            raise RuntimeError("workspace busy: conflict resolution still running") from None
        return _execute(task, guard)


def _execute(task: dict, guard: HandoffGuard) -> dict:
    label = task["step"]["label"]
    role_file, wants_artifact, tools, persona_agent = STEP_CONFIG[label]
    max_turns, timeout_s = steps.budget_for_label(steps.STEPS, label)
    provider_locked = steps.provider_locked_for(steps.STEPS, label)
    role = (ROLES / role_file).read_text()
    item = task["item"]
    personas = item_personas(item)
    if persona_agent:
        role = compose_role(role, persona_agent, personas.get(persona_agent))
    # HZ-357: the owner's per-step choice wins over the persona map, which wins
    # over FARM_PROVIDER (run_agent's default). Neither applies to a step that
    # isn't provider_override_eligible, so deploy stays locked. HZ-369: a
    # CHOICE_ONLY_PROVIDER_STEPS step takes the choice alone, and implement
    # with no choice is locked exactly as before.
    override_eligible = steps.provider_override_eligible(steps.STEPS, label)
    choice = step_provider_choice(item, task["step"].get("index")) if override_eligible else None
    if label in CHOICE_ONLY_PROVIDER_STEPS:
        provider_override = choice
        if label == IMPLEMENT_LABEL and choice is None:
            provider_locked = True
    else:
        provider_override = (choice or provider_for(personas)) if override_eligible else None
    # HZ-192: who this step's run_agent() calls are; run_agent() resolves the
    # model from these, so it is never chosen here. The agent comes from the
    # step table, like the budget above, not from the task payload.
    model_agent = model_agent_for_step(steps.by_label(label)["agent"])
    persona = model_persona(persona_agent, personas)

    ws = None
    if item.get("repo"):
        try:
            ws = ensure_item_worktree(item["repo"], item["id"])
        except RuntimeError:
            # Hub not provisioned for this repo (e.g. farm never started
            # cleanly against it) — same "no workspace" fallback as before.
            ws = None

    # Implement step without a repo/workspace: nothing real to build.
    if label == IMPLEMENT_LABEL:
        if ws is None:
            if item.get("repo"):
                raise RuntimeError("workspace not provisioned for this repo — restart the farm")
            return {"summary": "no repository attached — implementation skipped (demo item)"}
        scope = scope_of(task)
        # HZ-182: a fix pass is never rebased — rewriting history would break
        # the server's base_sha..HEAD diff.
        prepared = prepare_branch(ws, item, rebase_checkpoint=scope["mode"] != "fix")
        branch = prepared.branch
        log(f"workspace {ws} on branch {branch}")
        if scope["mode"] == "fix":
            # HZ-182: the server's reduced budget, clamped — never raised —
            # against the step's own. A "continue your WIP" note would
            # contradict a fix-only instruction, so it is not added.
            if isinstance(scope.get("max_turns"), int) and scope["max_turns"] > 0:
                max_turns = min(max_turns, scope["max_turns"])
            if isinstance(scope.get("timeout_s"), int) and scope["timeout_s"] > 0:
                timeout_s = min(timeout_s, scope["timeout_s"])
            log(f"fix pass from {scope.get('base_sha')}: {max_turns} turns, {timeout_s}s")
            extra = fix_pass_section(scope) + _last_check_failure(ws) + _deploy_stop_note(ws)
        else:
            extra = _checkpoint_resume_note(ws) or ""
            if extra:
                log("resuming a prior attempt's WIP checkpoint")
            extra += prepared.note
        # After the resume check: a merge commit would hide the checkpoint's
        # subject from it.
        conflicted: list[str] = []
        if task.get("merge_main"):
            conflicted = merge_default_branch(ws)
            log(f"merged origin/main into {branch}" + (f" — {len(conflicted)} conflicted file(s) left for the agent" if conflicted else " cleanly"))
            extra += _merge_main_note(conflicted)
        deadline = time.monotonic() + timeout_s
        try:
            with pause.interruptible():
                reply = run_agent(
                    build_prompt(task) + extra,
                    agent=model_agent,
                    step=label,
                    persona=persona,
                    append_system=role,
                    cwd=str(ws),
                    max_turns=max_turns,
                    timeout_s=timeout_s,
                    allowed_tools=tools,
                    provider=provider_override,
                    provider_locked=provider_locked,
                )
        except pause.PauseRequested as exc:
            # HZ-194: an operator paused the item mid-run. Save the work as a
            # checkpoint BEFORE farmd kills the session. at_entry: the pause
            # came before the agent started, and was already reported as
            # "nothing to save".
            if not exc.at_entry:
                pause.report(*_pause_checkpoint(ws, item, branch, conflicted, prepared.lease_sha, scope))
            raise
        except Exception as exc:
            # SALVAGE (HZ-31): the run hit its turn/time cap (or any other
            # run_agent failure) — checkpoint whatever's on disk instead of
            # letting the next attempt's prepare_branch scrub it away. Still
            # re-raises unchanged: a failed attempt still fails and pauses,
            # no checks run, no PR opens, nothing advances.
            _salvage_checkpoint(ws, item, branch, conflicted, lease_sha=prepared.lease_sha)
            # HZ-158: a handoff note only, never a reply salvage — the code is
            # what _salvage_checkpoint() keeps. It runs after the checkpoint,
            # with read-only tools, and never raises over `exc`.
            if isinstance(exc, AgentExhaustedError):
                _handoff_once(
                    exc,
                    HandoffContext(
                        item_id=item["id"],
                        step=label,
                        agent=model_agent,
                        persona=persona,
                        append_system=role,
                        cwd=str(ws),
                        deadline=deadline,
                        provider_locked=provider_locked,
                    ),
                    guard,
                    ws,
                )
            raise
        # The summary is reporting, not the deliverable — the code in the
        # workspace is. Never torch a completed implement run over a
        # malformed final message; fall back and let checks judge the work.
        # No retry= here on purpose: this step must not gain one. Its fallback
        # below is what a malformed final message costs, and that is cheaper
        # than a second full implement run.
        notes: list[str] = []
        blocked = None
        manual_checks = ""
        try:
            parsed, notes = parse_agent_reply(reply["result"])
            blocked = _blocked_report(parsed)
            summary = str(parsed.get("summary", "")).strip()[:SUMMARY_MAX_CHARS]
            # HZ-345: one statement per Manual metric line; the server puts it
            # in the PR body and the review reads it back.
            if isinstance(parsed.get("manual_checks"), str):
                manual_checks = parsed["manual_checks"].strip()[:MANUAL_CHECKS_MAX_CHARS]
            if not summary:
                # Parsed, but carried nothing usable. Without a note the run
                # would report a bare "implementation finished" — indistinguishable
                # from a clean run, with the only evidence that the reply was junk
                # thrown away. The except branch below says so for an unparseable
                # reply; this says so for a parseable but empty one.
                summary = "implementation finished"
                notes = [*notes, "agent's final message carried no 'summary' — see session log"]
        except Exception:
            summary = "implementation finished (agent's final message was not valid JSON — see session log)"
        # HZ-346: the agent stopped on a rule and changed nothing. Nothing is
        # committed, pushed or reviewed, so no check is skipped by returning
        # before them; the server records the run as blocked, not failed. Any
        # change at all ignores the report and takes the normal path below.
        if blocked is not None and _no_code_changes(ws):
            log(f"blocked by a rule with no code changes: {blocked['rule'][:120]}")
            return {"blocked": blocked}
        # Guardrail enforcement: the repo's own tests/linters run here, by the
        # script, before anything is committed or pushed. A failure fails the
        # run (Node pauses the item with the reason) — no green, no push.
        # HZ-257: the tree the checks are about to test, so the commit made
        # after them can be named as the sha that passed — only if identical.
        checked_tree = check_record.snapshot_tree(ws, log)
        try:
            with pause.interruptible():
                # HZ-245: the repo's Admin-configured commands, from the task dict
                # parsed at startup — never re-read after the agent has run.
                check_note = run_checks(
                    ws,
                    log,
                    run_id=task.get("run_id"),
                    item_id=item["id"],
                    configured=task.get("check_commands"),
                    repo=item.get("repo"),
                    # HZ-304: from the server, like check_commands.
                    checks_waiver=task.get("checks_waiver"),
                    # HZ-327: flakes and per-test results ride on the result.
                    **_recording(),
                )
            checks_finished_at = check_record.now_iso()
        except pause.PauseRequested:
            # HZ-194: the agent's work is finished but unchecked. The checks
            # are stopped and never count as a failure; the code is saved.
            pause.report(*_pause_checkpoint(ws, item, branch, conflicted, prepared.lease_sha, scope))
            raise
        except CheckFailure as exc:
            # HZ-184: the finished work is checkpointed with what failed, so
            # the next attempt fixes it instead of rebuilding it. Re-raised:
            # the run still fails, nothing below runs, no PR opens.
            _salvage_checkpoint(
                ws,
                item,
                branch,
                conflicted,
                cause=CAUSE_CHECKS_FAILED,
                detail="\n".join([exc.digest or str(exc), *(_recording()["branch_notes"] or [])]),
                lease_sha=prepared.lease_sha,
            )
            raise
        publish_screenshots(ws, item)
        artifacts = finalize_branch(ws, item, branch, conflicted, lease_sha=prepared.lease_sha)
        artifacts.update(check_record.report_fields(ws, checked_tree, check_note, checks_finished_at, log))
        if scope["mode"] == "fix":
            artifacts.update(fix_diff_report(ws, scope.get("base_sha")))
        if manual_checks:
            artifacts["manual_checks"] = manual_checks
        # HZ-369: what ran, like the generic path below, so step_run.provider
        # is set for implement too.
        if override_eligible and reply.get("provider"):
            artifacts.update(_provenance(reply))
        # finalize_branch returns branch/files_changed, not an artifact_md, so
        # the summary is this path's only note surface.
        # HZ-349: the branch run's lines join the summary (step 12 reads it)
        # but never check_note, whose exact text check_record reads. The
        # agent's own text is cut first, so those lines are what survives.
        checked = " · ".join([check_note, *(_recording()["branch_notes"] or [])])
        summary = f"{summary[: max(SUMMARY_MAX_CHARS - len(checked) - 3, 0)]} · {checked}"[:SUMMARY_MAX_CHARS]
        summary = stamp_notes(summary, notes, SUMMARY_MAX_CHARS)
        if provider_override:
            log(f"HZ-102 provenance: provider={reply.get('provider')} command_id={reply.get('command_id')}")
        return {"summary": summary, "artifacts": artifacts}

    # Automated review (HZ-30): two independent read-only passes over the
    # actual diff — code correctness against guardrails/the approved plan,
    # then test coverage against the implement step's own check-runner
    # evidence (delivered via task["artifacts"], widened server-side to
    # include the implement step's output). The merged, structured verdict
    # below is what the orchestrator's loop-cap logic reads — never prose.
    if label == REVIEW_LABEL:
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
        branch = prepare_branch(ws, item).branch
        log(f"workspace {ws} on branch {branch} — reviewing diff")
        default = _default_branch(ws)
        # HZ-182: a delta review reads only base..HEAD — unless the base is
        # gone, no longer an ancestor, or main was merged over the PR's files,
        # in which case it falls back to the full PR and says so.
        scope = scope_of(task)
        review_extra = {"reviewed_sha": git(ws, "rev-parse", "HEAD").stdout.strip(), "review_mode": "full"}
        delta_section = ""
        rev_range = f"origin/{default}...HEAD"
        if scope["mode"] == "delta":
            base = scope.get("base_sha")
            problem = delta_base_problem(ws, base, default)
            if problem:
                log(f"delta review falling back to a full review: {problem}")
                review_extra["scope_fallback"] = problem
            else:
                rev_range = f"{base}..HEAD"
                delta_files = _names(ws, rev_range)
                review_extra.update(review_mode="delta", delta_files=delta_files)
                delta_section = delta_review_section(scope, base, delta_files) + "\n\n"
        diff_stat = git(ws, "diff", "--stat", rev_range, check=False).stdout.strip()
        diff_full = git(ws, "diff", rev_range, check=False).stdout
        diff_text, diff_note = truncate_diff(diff_full)
        diff_section = f"## Code diff under review\n\n```\n{diff_stat}\n```\n\n```diff\n{diff_text}\n```{diff_note}"
        prompt = (
            build_prompt(task)
            + "\n\n"
            + delta_section
            + diff_section
            + "\n\nRespond with ONLY the JSON object described in your role instructions."
        )

        code_parsed, code_provenance, code_notes = _run_and_parse(
            prompt,
            agent=model_agent,
            step=label,
            persona=persona,
            append_system=role,
            cwd=str(ws),
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=tools,
            required_keys=("verdict",),
            item_id=item["id"],
            guard=guard,
            provider=provider_override,
            provider_locked=provider_locked,
        )

        # The item's QA persona, never the Eng one the code pass above used
        # (HZ-125): a reviewer wearing the implementer's specialization reviews
        # the work as the engineer who wrote it.
        qa_role = (ROLES / "qa_review.md").read_text()
        qa_role = compose_role(qa_role, REVIEW_QA_PERSONA_AGENT, personas.get(REVIEW_QA_PERSONA_AGENT))
        qa_parsed, qa_provenance, qa_notes = _run_and_parse(
            prompt,
            agent=model_agent,
            step=label,
            persona=model_persona(REVIEW_QA_PERSONA_AGENT, personas),
            append_system=qa_role,
            cwd=str(ws),
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=tools,
            required_keys=("verdict",),
            item_id=item["id"],
            guard=guard,
            provider=provider_override,
            provider_locked=provider_locked,
        )

        # HZ-369: one step run records one provider. Passes that name different
        # ones fail the step rather than record a half-true provenance; a pass
        # that names none (an older reply) never trips this.
        code_ran_on, qa_ran_on = code_provenance.get("provider"), qa_provenance.get("provider")
        if code_ran_on and qa_ran_on and code_ran_on != qa_ran_on:
            raise AgentError(f"review passes ran on different providers: code={code_ran_on} qa={qa_ran_on}")

        evidence = {
            "guardrails": item.get("guardrails") or "",
            "metric": item.get("metric") or "",
            "diff": diff_full,
            "manual_checks": manual_checks_text(task.get("artifacts")),
        }
        code_section, code_downgrades = downgrade_unproven_findings(
            _code_review_section(code_parsed), qa=False, **evidence
        )
        qa_section, qa_downgrades = downgrade_unproven_findings(_qa_review_section(qa_parsed), qa=True, **evidence)
        verdict = {"code_review": code_section, "qa_review": qa_section}
        downgrades = [{"pass": "code_review", **d} for d in code_downgrades] + [
            {"pass": "qa_review", **d} for d in qa_downgrades
        ]
        if downgrades:
            verdict["guardrail_downgrades"] = downgrades
        if review_extra["review_mode"] == "delta":
            verdict["previous_findings"] = _merge_previous_findings(
                scope.get("previous_findings") or [], [code_parsed, qa_parsed]
            )
        artifact_md = "\n\n".join(
            part.strip()
            for part in (
                code_parsed.get("artifact_md"),
                qa_parsed.get("artifact_md"),
                _downgrades_md(downgrades) if downgrades else None,
            )
            if isinstance(part, str) and part.strip()
        )
        summary = _review_summary(verdict)
        feedback = task.get("feedback") or []
        if feedback:
            summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:SUMMARY_MAX_CHARS]
        # Both passes' notes, in the order they ran.
        notes = code_notes + qa_notes
        review_artifacts = {
            "artifact_md": stamp_notes_artifact(
                artifact_md[:WRITE_ARTIFACT_SANITY_CEILING_CHARS], notes, WRITE_ARTIFACT_SANITY_CEILING_CHARS
            ),
            "verdict": verdict,
            **review_extra,
        }
        # HZ-369: what ran, from the code pass (the QA pass matched it above).
        if override_eligible and code_ran_on:
            review_artifacts["provider"] = code_ran_on
            review_artifacts["command_id"] = code_provenance.get("command_id")
        return {"summary": stamp_notes(summary, notes, SUMMARY_MAX_CHARS), "artifacts": review_artifacts}

    # Deploy (HZ-22): the release is already published by the time this runs
    # (the JS orchestrator holds the GitHub token, not the farm — see
    # dispatchToFarm in server/src/orchestrator.js). This step is purely the
    # DevOps agent's deep post-deploy verification.
    if label == DEPLOY_LABEL:
        if not item.get("repo") or item.get("issue") is None:
            return {
                "summary": "no repository attached — deploy verification skipped (demo item)",
                "artifacts": {
                    "artifact_md": "## Verdict\n**pass** — no repository attached; nothing to verify.",
                    "verdict": {"verdict": "pass"},
                },
            }

        # HZ-275: never verify before this item's own release is live.
        wait_until_release_live(task)

        wait = task.get("deploy_wait") if isinstance(task.get("deploy_wait"), dict) else {}
        if wait.get("health_check_type") == "registry-publish":
            return registry_publish_result(item.get("release_tag") or "", str(wait.get("state_dir") or ""))
        if wait.get("health_check_type") == "deploy-log":
            return deploy_log_result(item.get("release_tag") or "", str(wait.get("state_dir") or ""))
        grpc_url = wait.get("health_url") if wait.get("health_check_type") == "grpc-health" else None

        prompt = (
            build_prompt(task)
            + "\n\nRespond with ONLY the JSON object described in your role instructions. Your "
            '"url" and "expected_text" fields are what this script independently re-verifies '
            "with e2e/smoke/check.mjs — pick an expected_text that is actually visible on that "
            "page right now."
        )
        if grpc_url:
            prompt = (
                build_prompt(task)
                + "\n\nRespond with ONLY the JSON object described in your role instructions. This "
                f"service is gRPC-only at {grpc_url}: this script gates the deploy on its gRPC health "
                "check, so 'url' and 'expected_text' are not used and may be omitted."
            )
        parsed, _deploy_provenance, notes = _run_and_parse(
            prompt,
            agent=model_agent,
            step=label,
            persona=persona,
            append_system=role,
            cwd=None,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=tools,
            required_keys=("summary",) if grpc_url else ("summary", "url", "expected_text"),
            item_id=item["id"],
            guard=guard,
            provider_locked=provider_locked,
        )
        summary = str(parsed.get("summary", "")).strip()[:SUMMARY_MAX_CHARS] or "deploy verification finished"
        artifact_md = str(parsed.get("artifact_md", "")).strip()

        if grpc_url:
            verdict, smoke_line = run_grpc_health_check(grpc_url)
        else:
            url, expected_text = parsed.get("url"), parsed.get("expected_text")
            if not isinstance(url, str) or not url.strip() or not isinstance(expected_text, str) or not expected_text.strip():
                raise AgentError("devops reply missing 'url'/'expected_text' needed for deep verification")
            verdict, smoke_line = run_smoke_check(url.strip(), expected_text.strip())
        artifact_md = f"{artifact_md}\n\n## Machine-checked result\n`{smoke_line}`".strip()
        return {
            "summary": stamp_notes(f"{summary} · {smoke_line}"[:SUMMARY_MAX_CHARS], notes, SUMMARY_MAX_CHARS),
            "artifacts": {
                "artifact_md": stamp_notes_artifact(
                    artifact_md[:WRITE_ARTIFACT_SANITY_CEILING_CHARS], notes, WRITE_ARTIFACT_SANITY_CEILING_CHARS
                ),
                # Wrapped in an object, not a bare string: validateDeployVerdict in
                # server/src/orchestrator.js requires `typeof v === 'object'` with a
                # `.verdict` field — same wire contract the review step's verdict
                # already uses. See server/test/deploy-gate.test.mjs.
                "verdict": {"verdict": verdict},
            },
        }

    parsed, reply_provenance, notes = _run_and_parse(
        build_prompt(task) + "\n\nRespond with ONLY the JSON object described in your role instructions.",
        agent=model_agent,
        step=label,
        persona=persona,
        append_system=role,
        cwd=str(ws) if ws else None,
        max_turns=max_turns,
        timeout_s=timeout_s,
        allowed_tools=tools if ws else None,
        required_keys=("summary", "artifact_md") if wants_artifact else ("summary",),
        item_id=item["id"],
        guard=guard,
        provider=provider_override,
        provider_locked=provider_locked,
    )
    summary = str(parsed.get("summary", "")).strip()[:SUMMARY_MAX_CHARS]
    if not summary:
        raise AgentError("agent reply missing 'summary'")

    # The feedback that drove a rework is stamped into the record by the
    # script — visible in the activity feed and at the top of the artifact —
    # so nobody has to guess what a revision was responding to.
    feedback = task.get("feedback") or []
    if feedback:
        summary = f"addressed feedback (“{feedback[0].get('message', '')[:80]}”) — {summary}"[:SUMMARY_MAX_CHARS]

    # HZ-102: when an override (the owner's per-step choice, HZ-357, or a
    # persona's provider) picked the provider for this step, stamp what
    # actually ran into the run log and summary — visible to a human without
    # inspecting config. An explicit Claude choice is an override too.
    if provider_override:
        note = f"provider={reply_provenance.get('provider')} command_id={reply_provenance.get('command_id')}"
        log(f"HZ-102 provenance: {note}")
        summary = f"{summary} [{note}]"[:SUMMARY_MAX_CHARS]

    result = {"summary": stamp_notes(summary, notes, SUMMARY_MAX_CHARS)}
    if wants_artifact and isinstance(parsed.get("artifact_md"), str) and parsed["artifact_md"].strip():
        artifact = parsed["artifact_md"].strip()
        if feedback:
            header = "\n".join(f"> {fb.get('message', '')}" for fb in feedback)
            artifact = f"## Human feedback addressed in this revision\n{header}\n\n{artifact}"
        result["artifacts"] = {
            "artifact_md": stamp_notes_artifact(
                artifact[:WRITE_ARTIFACT_SANITY_CEILING_CHARS], notes, WRITE_ARTIFACT_SANITY_CEILING_CHARS
            )
        }
    # HZ-357: every run of an eligible step sends what ran, Default included,
    # so the server persists it on step_run.provider/command_id
    # (server/src/orchestrator.js) and the item page can show "Ran on …". Only
    # when the reply named a provider, so a reply without one adds no keys.
    if override_eligible and reply_provenance.get("provider"):
        artifacts = result.setdefault("artifacts", {})
        artifacts["provider"] = reply_provenance.get("provider")
        artifacts["command_id"] = reply_provenance.get("command_id")
    # HZ-313: the Ensemble's optional cross-repo split rides through untouched.
    # The server (server/src/split.js) validates it and files nothing until
    # gate 5 is approved; any other step's or shape's `split` is dropped.
    if label == SPLIT_STEP_LABEL and isinstance(parsed.get("split"), dict):
        result.setdefault("artifacts", {})["split"] = parsed["split"]
    return result


# HZ-275: a Horizon self-deploy restarts farmd just before last-good-tag is
# written, so the Deploy step's result can reach a farmd still booting. Its
# tmux session survives the restart; the post retries, bounded, until farmd
# answers.
RESULT_POST_ATTEMPTS = 12
RESULT_POST_RETRY_S = 10

# HZ-327: what this run's implement-step checks recorded — {"flakes": [],
# "test_runs": []}, made by main() for its one run, so nothing can leak into
# another — carried on the result to farmd (farmd._forward_result): flakes on
# /complete or /fail, test_runs to the server's test-runs route. None (no
# main(), e.g. a test calling execute()) records nothing. HZ-349:
# branch_notes (the branch run's lines) go into the step summary instead and
# never ride on the result.
_RECORDED: contextvars.ContextVar[dict | None] = contextvars.ContextVar("step_recorded", default=None)


def _recording() -> dict:
    """run_checks()'s flakes/test_runs/branch_notes arguments for this run."""
    recorded = _RECORDED.get()
    return {"flakes": None, "test_runs": None, "branch_notes": None} if recorded is None else recorded


def post_result(result: dict) -> None:
    for attempt in range(1, RESULT_POST_ATTEMPTS + 1):
        try:
            httpx.post(f"{FARMD}/internal/steps/result", json=result, timeout=30)
            return
        except httpx.TransportError as exc:
            if attempt == RESULT_POST_ATTEMPTS:
                raise
            log(f"run {result['run_id']}: farmd unreachable ({exc}) — retrying in {RESULT_POST_RETRY_S}s")
            time.sleep(RESULT_POST_RETRY_S)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    task_path = Path(args.task)
    task = json.loads(task_path.read_text())
    run_id = task["run_id"]
    # HZ-194: farmd pauses a run by SIGTERM to this pid, then waits for the
    # outcome file. Neither name ends in .json, so no task-file glob in
    # farmd ever reads them; farmd removes both once the pause is done.
    pid_path = task_path.with_suffix(".pid")
    outcome_path = task_path.with_suffix(".paused")
    pid_path.write_text(str(os.getpid()))
    pause.install_sigterm_handler(outcome_path)

    recorded = {"flakes": [], "test_runs": [], "branch_notes": []}
    token = _RECORDED.set(recorded)
    try:
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        outcome = execute(task)
        result = {"run_id": run_id, "ok": True, **outcome}
        # HZ-158: a handoff note is for the attempt after an exhausted one;
        # once the step succeeds it must not reach a later re-run.
        handoff.clear_note(str(task["item"].get("id", "")), str(task["step"].get("label", "")))
    except pause.PauseRequested:
        # The server already closed this run as cancelled when the operator
        # paused it: there is no result to report, and a pause is never a
        # failure. farmd kills the session once the outcome file exists.
        if not pause.reported():
            pause.report(pause.NOTHING, "the attempt had not started work that could be saved")
        log(f"run {run_id}: paused by an operator — not reporting a result")
        return 0
    except Exception as exc:
        log(f"run {run_id}: FAILED — {exc}")
        result = {"run_id": run_id, "ok": False, "error": str(exc)[:ERROR_MAX_CHARS]}
        # HZ-76: tag the one failure cause the orchestrator is willing to
        # auto-retry from this side (running out of turn budget) — anything
        # else (a checks failure, a malformed reply, ...) reports no reason
        # and the server pauses for a human exactly as before.
        if isinstance(exc, AgentExhaustedError):
            result["reason"] = reasons.REASON["TURN_CAP"]
    finally:
        _RECORDED.reset(token)
    # A flake on one command survives a real failure on a later one.
    result.update({key: value for key, value in recorded.items() if value and key != "branch_notes"})

    if pause.pending() and not pause.reported():
        # The pause landed after the work's last interruptible region (e.g.
        # during finalize's push): the attempt ran to its end and its own
        # result stands; the server ignores it for the already-closed run.
        if result["ok"]:
            pause.report(pause.SAVED, "the attempt had already finished and pushed its work")
        else:
            pause.report(pause.FAILED, f"the attempt ended before the pause took effect: {result['error'][:300]}")
    post_result(result)
    log(f"run {run_id}: reported {'ok' if result['ok'] else 'failure'}")
    task_path.unlink(missing_ok=True)
    if not pause.pending():
        pid_path.unlink(missing_ok=True)  # a pausing farmd still reads it
    return 0


if __name__ == "__main__":
    sys.exit(main())
