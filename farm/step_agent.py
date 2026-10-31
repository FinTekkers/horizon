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
import shutil
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
from domain.py import fields, plan_draft, plan_inventory, plan_review, reasons, run_plan, steps
from domain.py import providers as domain_providers
from domain.py.personas import model_agent_for_step

# AgentExhaustedError is this branch's name for main's TurnCapExceeded — the
# same "ran out of turn budget" signal, renamed by the provider refactor. The
# import conflicted while its USE below merged cleanly, so the rename has to be
# applied there too or the merged file references a symbol that no longer exists.
from .agent_runner import (
    AgentError,
    AgentExhaustedError,
    AgentMessageTooLargeError,
    AgentUsageLimitedError,
    effective_provider,
    parse_agent_reply,
    run_agent,
    salvage_truncated_reply,
    stamp_notes,
    stamp_notes_artifact,
    usage_meter,
)
from . import (
    base_check,
    check_record,
    handoff,
    login_env,
    pause,
    plan_bundle,
    read_only_guard,
    review_diff,
    run_plan_requires,
    screenshot_runner,
    screenshots_config,
    task_job,
)
from .checks import HEADLINE_PREFIX, CheckFailure, redact, run_checks, scrub, secret_values
from .config import FARM_PORT, ITEM_LOCK_WAIT_S
from .handoff import HandoffContext, HandoffGuard
from .persona_tools import apply as apply_persona_tools
from .personas import compose_role, project_overlay, provider_for, resolve
from .read_only_guard import ReadOnlyViolation
from .rules import render_rules_section
from .workspaces import ItemBusy, checkout_detached, default_branch, ensure_item_worktree, hub_lock, item_lock

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

OPTIONS_LABEL = "Plan options & trade-offs (pros / cons)"
ENG_PLAN_LABEL = "Draft implementation plan"
ARCH_REVIEW_LABEL = "Architecture review"
QA_PLAN_LABEL = "QA reviews the test plan"
IMPLEMENT_LABEL = "Specialist agent implements"
REVIEW_LABEL = "Automated review (code + QA)"
DEPLOY_LABEL = "Deploy the changes"
# HZ-313: the only step whose reply may carry a cross-repo `split`.
SPLIT_STEP_LABEL = OPTIONS_LABEL

STEP_CONFIG = {
    OPTIONS_LABEL: ("ensemble.md", True, PLANNER_TOOLS, None),
    ENG_PLAN_LABEL: ("eng_plan.md", True, PLANNER_TOOLS, None),
    ARCH_REVIEW_LABEL: ("architect_review.md", True, PLANNER_TOOLS, None),
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
    # HZ-371: the PM step kind — every runsIn "pm" step in domain/steps.json.
    # Only [3] and the kind are read: _execute_pm() takes its role prompt
    # from farm/pm_steps.py's ROLE_PROMPT, which renders roles/pm.md's budgets.
    **{step["label"]: ("pm.md", True, None, None) for step in steps.STEPS if step["runsIn"] == "pm"},
}

# HZ-383: a Task item's planning steps (domain/steps.json's itemKind "task"
# rows on the farm lane). Kept apart from STEP_CONFIG, which stays the change
# kind's table exactly as it was: two kinds may share a label, so a step's
# config is looked up by the item's kind first, then its label (_step_config),
# never by label or index alone. All three are read-only planners — the dry
# run is described in the artifact, never executed, so no tool that can run
# or edit anything is granted (no Bash, Edit or Write).
ASSESS_LABEL = "Assess"
RUN_PLAN_LABEL = "Run plan"
# HZ-502: how many times a Run plan's `requires` gaps go back to the agent
# before the step fails, and how that failure's reason starts.
REQUIRES_REPROMPTS = 2
REQUIRES_GAP_PREFIX = "the run plan needs what the runner lacks: "
IMPACT_REVIEW_LABEL = "Impact review"
VERIFY_REPORT_LABEL = "Verify & report"

TASK_STEP_CONFIG = {
    ASSESS_LABEL: ("task_assess.md", True, PLANNER_TOOLS, None),
    RUN_PLAN_LABEL: ("task_run_plan.md", True, PLANNER_TOOLS, None),
    IMPACT_REVIEW_LABEL: ("task_impact_review.md", True, PLANNER_TOOLS, None),
    VERIFY_REPORT_LABEL: ("task_verify.md", True, PLANNER_TOOLS, "qa"),
    # HZ-413: a Task's steps 0-2 are the PM kind, like the change ones. Only
    # [3] and the kind are read: _execute_pm() takes its role prompt from
    # farm/pm_steps.py's role_prompt_for(), which appends roles/pm_task.md.
    **{step["label"]: ("pm.md", True, None, None) for step in steps.FARM_VIEWS["task"] if step["runsIn"] == "pm"},
}

# HZ-446: a Plan's steps. HZ-447 gives Inventory and Design their prompts and
# HZ-448 gives Draft items its, and HZ-463 the two review rows theirs. Each
# runs with the planner's read-only tools, so a Plan never edits code in any
# repo. Its PM rows run on the PM step kind like every other kind's.
# "File items" is runsIn "server" — Horizon's own code, never the farm — so it
# is not here.
PLAN_INVENTORY_LABEL = "Inventory current state"
PLAN_DESIGN_LABEL = "Design options & recommendation"
PLAN_DRAFT_LABEL = "Draft items"
PLAN_COVERAGE_REVIEW_LABEL = "Review drafts: coverage & overlap"
PLAN_METRICS_REVIEW_LABEL = "Review drafts: metrics & size"
PLAN_FARM_LABELS = (
    PLAN_INVENTORY_LABEL,
    PLAN_DESIGN_LABEL,
    PLAN_DRAFT_LABEL,
    PLAN_COVERAGE_REVIEW_LABEL,
    PLAN_METRICS_REVIEW_LABEL,
)

PLAN_STEP_CONFIG = {
    **{label: ("plan_placeholder.md", True, PLANNER_TOOLS, None) for label in PLAN_FARM_LABELS},
    PLAN_INVENTORY_LABEL: ("plan_inventory.md", True, PLANNER_TOOLS, None),
    PLAN_DESIGN_LABEL: ("plan_design.md", True, PLANNER_TOOLS, None),
    # HZ-448: Draft items writes the Plan's item drafts (domain/planDraft.schema.json).
    PLAN_DRAFT_LABEL: ("plan_draft.md", True, PLANNER_TOOLS, None),
    # HZ-463: the reviews read the server's `Plan review input` artifact.
    PLAN_COVERAGE_REVIEW_LABEL: ("plan_review_coverage.md", True, PLANNER_TOOLS, None),
    PLAN_METRICS_REVIEW_LABEL: ("plan_review_metrics.md", True, PLANNER_TOOLS, None),
    **{step["label"]: ("pm.md", True, None, None) for step in steps.FARM_VIEWS["plan"] if step["runsIn"] == "pm"},
}

STEP_CONFIGS = {"change": STEP_CONFIG, "task": TASK_STEP_CONFIG, "plan": PLAN_STEP_CONFIG}

# HZ-435: a lane's narrower prompts, keyed by the lane the server sends
# (domain/steps.json's `lanes`). Each entry overrides one step its kind
# already runs, with the same tools and persona — only the role file differs.
# A step with no entry here, and every item with no lane, keeps STEP_CONFIGS.
LANE_STEP_CONFIGS = {
    "trivial": {
        ENG_PLAN_LABEL: ("eng_plan_trivial.md", True, PLANNER_TOOLS, None),
        QA_PLAN_LABEL: ("qa_trivial.md", True, PLANNER_TOOLS, "qa"),
    },
}

# HZ-369: these steps follow ONLY the owner's per-step choice. A persona's
# provider and a bare FARM_PROVIDER never move them off today's routing.
# Implement with no choice keeps the HZ-117 lock at runtime. HZ-370: the PM
# steps too — the choice (item, else project default) or today's routing.
CHOICE_ONLY_PROVIDER_STEPS = frozenset(
    {QA_PLAN_LABEL, IMPLEMENT_LABEL, REVIEW_LABEL} | {step["label"] for step in steps.STEPS if step["runsIn"] == "pm"}
)

# HZ-387: the steps the farm holds read-only itself, whichever provider runs
# them (read_only_guard). Named, not inferred from PLANNER_TOOLS: the review
# step uses those tools too, but it is workspaceMutating (prepare_branch
# scrubs its worktree first), so its two passes are guarded one by one inside
# _execute()'s review branch instead.
READ_ONLY_LABELS = frozenset({OPTIONS_LABEL, ENG_PLAN_LABEL, ARCH_REVIEW_LABEL, QA_PLAN_LABEL})
# HZ-383: every Task step on the farm lane is held read-only the same way.
# HZ-413: the Task's PM steps keep no workspace, so they are not listed.
TASK_READ_ONLY_LABELS = frozenset({ASSESS_LABEL, RUN_PLAN_LABEL, IMPACT_REVIEW_LABEL, VERIFY_REPORT_LABEL})
# HZ-446: every Plan step on the farm lane too.
PLAN_READ_ONLY_LABELS = frozenset(PLAN_FARM_LABELS)
# Keyed by kind; a kind with no entry reads the change set, as before.
READ_ONLY_LABELS_BY_KIND = {"change": READ_ONLY_LABELS, "task": TASK_READ_ONLY_LABELS, "plan": PLAN_READ_ONLY_LABELS}
# HZ-383/HZ-446: kinds whose farm steps are held to their tools even with no
# workspace, where a change step runs with no allowlist at all.
TOOLS_WITHOUT_WORKSPACE_KINDS = frozenset({"task", "plan"})
# HZ-447: steps that read every repo in the item's scope from a read-only
# bundle (farm/plan_bundle.py) instead of the item's worktree: no worktree,
# run plan or venv is set up for them, and their tools are the bundle's rules.
BUNDLE_LABELS_BY_KIND = {"plan": frozenset({PLAN_INVENTORY_LABEL, PLAN_DESIGN_LABEL})}

# HZ-158: the ONLY steps whose turn-capped reply may be salvaged — a reply cut
# off mid-string, with every required key present, is accepted instead of
# failing the run. Both are planning steps whose output a later gate reviews.
# Never a step whose output decides a gate: not review or deploy (they emit
# the verdict), not Architecture review or QA reviews the test plan (they emit
# one too), and not implement (its checks are a gate, and _salvage_checkpoint()
# already keeps its code). farm/tests/test_exhaustion_salvage.py pins this set.
#
# HZ-383: this set and CHOICE_ONLY_PROVIDER_STEPS are change-kind labels,
# matched by label alone. HZ-413: a Task's first step now shares its label
# with change step 0 and reaches the farm, and neither set needs a
# kind key for it. Both are read only by _execute(), and execute() sends every
# PM step, of any kind, to _execute_pm() before _execute() runs. _execute_pm()
# takes its provider from the kind's own row (providerOverrideEligible), so it
# is choice-only for every PM step, and it never salvages. Key a set by kind
# before a label in it is shared by a step that _execute() runs.
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


# HZ-383: once per item kind, each against that kind's own farm view.
for _kind, _view in steps.FARM_VIEWS.items():
    _assert_step_config_matches_table(
        set(STEP_CONFIGS.get(_kind, {})), {s["label"] for s in _view if s["runsIn"] in ("farm", "pm")}
    )
# HZ-435: a lane only re-points steps the change table already runs.
for _lane, _overrides in LANE_STEP_CONFIGS.items():
    if not set(_overrides) <= set(STEP_CONFIG):
        raise RuntimeError(
            f"step_agent.LANE_STEP_CONFIGS[{_lane!r}] names steps STEP_CONFIG does not run: "
            f"{sorted(set(_overrides) - set(STEP_CONFIG))}"
        )


def item_kind(item: dict) -> str:
    """HZ-383: the item's kind as the server sent it. A missing one is
    `change`, so a task queued by an older server runs exactly as before."""
    kind = item.get("kind")
    return kind if isinstance(kind, str) and kind else "change"


def item_lane(item: dict) -> str | None:
    """HZ-435: the item's lane as the server sent it, or None. An unknown lane,
    or none at all (an older server), runs the kind's own prompts."""
    lane = item.get("lane")
    return lane if isinstance(lane, str) and lane in LANE_STEP_CONFIGS else None


def _step_config(kind: str, label: str, lane: str | None = None) -> tuple:
    """HZ-383: (role file, needs artifact, tools, persona agent) for this
    kind's step with this label. Raises KeyError for a label that kind does
    not run on the farm — a Task label sent as a change step, say — rather
    than borrowing another kind's runner. HZ-435: a lane's override wins only
    for a step it names; with no lane the result is exactly as before."""
    steps.by_kind_label(kind, label)
    override = LANE_STEP_CONFIGS.get(lane, {}).get(label) if lane is not None else None
    return override or STEP_CONFIGS[kind][label]


def _is_read_only(kind: str, label: str) -> bool:
    """HZ-387/HZ-383: whether the farm holds this step read-only itself."""
    return label in READ_ONLY_LABELS_BY_KIND.get(kind, READ_ONLY_LABELS)


def _reads_bundle(kind: str, label: str) -> bool:
    """HZ-447: whether this step reads the item's repo bundle."""
    return label in BUNDLE_LABELS_BY_KIND.get(kind, frozenset())


def _spawn_field(kind: str, label: str) -> str | None:
    """HZ-379: the reply field this kind's step may file items with —
    domain/steps.json's `spawnsOn` on the authored row — or None."""
    row = next((step for step in steps.steps_for(kind) if step["label"] == label), None)
    field = row.get("spawnsOn") if row else None
    return field if isinstance(field, str) and field else None


def _is_pm_step(label: str, kind: str = "change") -> bool:
    """HZ-371: whether this step is the PM kind, from domain/steps.json's
    runsIn — the same field farmd's PM lane is chosen by. An unknown label is
    not, so it fails in _execute() exactly as it did before. HZ-383: looked
    up in that item kind's own rows."""
    entry = next((step for step in steps.FARM_VIEWS.get(kind, []) if step["label"] == label), None)
    return entry is not None and entry["runsIn"] == "pm"


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
# HZ-456: the work was committed and pushed before the checks, and the
# attempt stopped (time limit, farm restart) before they finished.
CAUSE_UNCHECKED = "unchecked"
# HZ-321: a deploy checkpoint committed but not pushed names itself in this
# file (under the worktree's git dir) as "<branch> <sha>", so the next
# attempt resumes from it instead of scrubbing it (prepare_branch).
UNPUSHED_CHECKPOINT = "horizon-unpushed-checkpoint"
# HZ-456: the farm commit pushed before the checks names itself in this file
# (under the worktree's git dir) as "<sha>\n<cause>\n<digest>". The cause is
# CAUSE_UNCHECKED until the checks fail, then CAUSE_CHECKS_FAILED with their
# digest — the pushed commit is never amended to carry it.
PRECHECK_CHECKPOINT = "horizon-precheck-checkpoint"

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
# HZ-605: 4000 — a failed check's failing-tests list sits above its digest.
ERROR_MAX_CHARS = 4000
# The review prompt's `## Commits under review` block (HZ-420): enough to
# read the branch's story, capped so a long branch can't crowd out the diff.
REVIEW_COMMITS_MAX = 100


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def git(ws: Path, *args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        env=run_env,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def pushed_head(ws: Path, repo: str) -> dict[str, str]:
    """HZ-546: {repo: HEAD} for a step's source_shas, when origin has the
    workspace's HEAD commit; else {}. The UI links code references at this
    sha, and a commit GitHub never received would only 404."""
    head = git(ws, "rev-parse", "HEAD", check=False).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        return {}
    remote = git(ws, "branch", "-r", "--contains", head, check=False)
    return {repo: head} if remote.returncode == 0 and remote.stdout.strip() else {}


def git_bytes(ws: Path, *args: str, check: bool = True, input: bytes | None = None) -> bytes:
    """git's raw stdout (HZ-420). For output that goes back into git or onto
    disk — a path decoded with errors="replace" names a different file — and
    for the review diff, which decides per file how to show bytes."""
    result = subprocess.run(["git", "-C", str(ws), *args], input=input, capture_output=True, timeout=300)
    if check and result.returncode != 0:
        err = result.stderr.decode("utf-8", "replace").strip()[:200]
        raise RuntimeError(f"git {' '.join(args)} failed: {err}")
    return result.stdout


def _shown(path: str) -> str:
    """A path from git_bytes (os.fsdecode'd) as prompt or log text: a byte
    that isn't UTF-8 shows as U+FFFD. Never hand the result back to git."""
    return path.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


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


def step_provider_choice(item: dict, step_index) -> tuple[str, str | None] | None:
    """The owner's per-step choice for this item (HZ-357), as (provider, model
    id or None), or None.

    The server sends `providerChoices` as {"<step index>": "<provider>" |
    "<provider>:<model id>"} (HZ-398; domain/providers.json declares both),
    copied into the task at dispatch, so a choice changed while this step runs
    reaches only the next dispatch. Anything else — no map (an older server),
    no key (Default), an unknown provider or an undeclared model — is None,
    i.e. today's routing. The caller still gates this on
    steps.provider_override_eligible().
    """
    choices = item.get("providerChoices")
    if not isinstance(choices, dict) or step_index is None:
        return None
    return domain_providers.parse_choice(choices.get(str(step_index)))


def _persona_line(task: dict) -> str:
    """The prompt's persona line: the persona this step will actually compose,
    named with its agent, or an explicit "generalist" for the steps that
    compose none. Pre-HZ-125 this printed one resolved id for every step —
    including the generalist planning steps, which never received it."""
    item = task["item"]
    try:
        config = _step_config(item_kind(item), task["step"]["label"], item_lane(item))
    except KeyError:
        config = None
    persona_agent = config[3] if config else None
    if not persona_agent:
        return "  persona: (none — this step is generalist)"
    resolved = resolve(persona_agent, item_personas(task["item"]).get(persona_agent))
    return f"  persona: {persona_agent}/{resolved}"


def _interpreter_line(task: dict) -> str:
    """HZ-431: the interpreter Execute will run the plan's commands with —
    the same resolve_venv() check task_job.py makes at start. Shows only the
    venv path or `system`, never PATH or another env value."""
    try:
        run_plan.resolve_cwd(task.get("repo_dir"), ".", forbid=str(REPO_ROOT))
        venv = run_plan.resolve_venv(task.get("repo_dir"), task.get("venv_dir"), forbid=str(REPO_ROOT))
    except run_plan.CwdRefused as exc:
        reason = str(exc).splitlines()[0] if str(exc) else "refused"
        return f"  interpreter: refused — {reason}. Execute will refuse until the deploy target is fixed"
    if venv:
        return f"  interpreter: {venv}/bin/python (env: {venv})"
    return "  interpreter: system python3 (env: system)"


def _runner_line(task: dict) -> str:
    """HZ-491: where a plan that sets no `runner` runs, as the server sent it
    (store.js defaultRunnerFor): the container only when the repo pins an
    image, else the host."""
    runner = task.get("runner")
    if runner == "container":
        return f"  runner: container ({task.get('container_image')}) — a plan with no `runner` runs in it"
    if runner == "host":
        return "  runner: host (no container image for this repo) — a plan with no `runner` runs on the host"
    return "  runner: unknown — the server sent none; Execute will refuse the job"


def _login_env_line(path) -> str:
    """HZ-494: the repo's test-login variables, by NAME only — the agent
    never sees a value. "" when the repo has no test credentials env file."""
    if not isinstance(path, str) or not path:
        return ""
    names = login_env.login_env_names(path)
    if names is None:
        return (
            f"  test login: the {login_env.COMMAND_LABEL} {path} could not be read on the farm host — "
            "this repo's checks and smoke check will fail until a human fixes it; you cannot fix it"
        )
    shown = ", ".join(names) or "(none)"
    return f"  test login: checks and the smoke check get these variables from a host file: {shown}. You never see the values."


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
    if step.get("label") == RUN_PLAN_LABEL and "repo_dir" in task:
        lines.append(_interpreter_line(task))
        lines.append(_runner_line(task))
        # HZ-416: the image a container plan runs in.
        image = task.get("container_image")
        lines.append(
            f"  container: {image} (repo read-only, writable: /scratch, /tmp, /state, /logs)"
            if image
            else "  container: none pinned — Execute refuses a container plan until the deploy target has an image"
        )
    if item.get("release_tag"):
        lines.append(f"  release: {item['release_tag']}  ({item.get('release_url') or 'no url'}) — already published")
    login_line = _login_env_line(task.get("test_env_file"))
    if login_line:
        lines.append(login_line)
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
    golden = golden_cases_section(task)
    if golden:
        lines += ["", golden]
    return "\n".join(lines)


# ---- golden cases (HZ-541) ----
# The server sets `golden_cases: true` on a task only when the item's project
# has its definitions switch on and the item's snapshot has a golden_cases
# sub-step. Without it nothing is appended, so every other prompt is
# byte-identical. The metric line's token is domain/js/goldenCases.js's
# GOLDEN_CASES_MARKER: the first-gate table links each case to that line.
GOLDEN_CASES_ROLE = "golden_cases.md"
GOLDEN_CASES_ADDENDUM = "golden_cases_addendum.md"
GOLDEN_CASES_OUTPUT = "golden_cases"
# Change "Define how we measure success", Task "How we'll verify", and Eng plan.
GOLDEN_ADDENDUM_LABELS = frozenset({"Define how we measure success", "How we'll verify", ENG_PLAN_LABEL})


def golden_cases_section(task: dict) -> str | None:
    """The golden-cases text a task's prompt ends with, or None. A golden_cases
    sub-step gets the producer contract; the metric steps and Eng plan of an
    item with golden cases get the addendum."""
    if (task.get("substep") or {}).get("output") == GOLDEN_CASES_OUTPUT:
        return (ROLES / GOLDEN_CASES_ROLE).read_text().rstrip("\n")
    if task.get("golden_cases") is True and task["step"].get("label") in GOLDEN_ADDENDUM_LABELS:
        return (ROLES / GOLDEN_CASES_ADDENDUM).read_text().rstrip("\n")
    return None


# ---- screenshot publishing (HZ-63) ----
# Screenshots are gitignored, not committed — two branches that both touch the
# same screen never collide on a binary file. Instead they're force-pushed as
# an orphan commit to a per-item ref that server/src/github.js reads via the
# contents API (naming here — "e2e-artifacts/<item-id>" — must match
# artifactsRef() there). Best-effort: a publish failure never fails the
# implement step.
# HZ-506: the source is .horizon/screenshots.json's outputDir — the farm
# runner's PNGs plus its manifest.json — published under the
# e2e/__screenshots__/ tree path, so server/src/github.js is unchanged.
# HZ-621: that config is the only source. The e2e specs no longer capture
# shots, so a repo without a config publishes nothing (and logs it), and PNGs
# outside outputDir are never published.
# HZ-508: every publish also diffs each shot against e2e-baseline (fetched,
# never pushed) and adds results.json plus diff/<name>.png per changed shot to
# the SAME orphan commit, so the force-push replaces every result of the
# previous publish. server/src/github.js renders the PR body's table from
# results.json. A diff failure only drops results.json; the shots still go.

SHOTS_TREE = "e2e/__screenshots__"
BASELINE_REF = "e2e-baseline"
RESULTS_NAME = "results.json"
RESULTS_VERSION = 1
CHANGED, NEW, REMOVED, SAME = "changed", "new", "removed", "same"
DIFF_CMD = ["node", str(screenshot_runner.CAPTURE_DIR / "diff.mjs")]
DIFF_PACKAGES = ("pixelmatch", "pngjs")
DIFF_TIMEOUT_S = 120


def _baseline_pngs(ws: Path, repo: str) -> tuple[str, dict[str, str]] | None:
    """(commit sha, {shot name: blob sha}) for the top-level PNGs on
    e2e-baseline, or None when the ref does not exist. Only fetches. Not
    recursive, so a promoted ref's diff/ never reads as a baseline shot."""
    with hub_lock(repo):
        probe = git(ws, "ls-remote", "--exit-code", "origin", f"refs/heads/{BASELINE_REF}", check=False)
        if probe.returncode == 2:
            return None
        if probe.returncode != 0:
            raise RuntimeError(f"could not read {BASELINE_REF}: {probe.stderr.strip()[:200]}")
        git(ws, "fetch", "-q", "origin", f"+refs/heads/{BASELINE_REF}:refs/remotes/origin/{BASELINE_REF}")
        sha = git(ws, "rev-parse", f"refs/remotes/origin/{BASELINE_REF}^{{commit}}").stdout.strip()
    pngs: dict[str, str] = {}
    for entry in git_bytes(ws, "ls-tree", "-z", sha, f"{SHOTS_TREE}/").split(b"\0"):
        if not entry:
            continue
        meta, _, path = entry.partition(b"\t")
        _mode, obj_type, blob = meta.decode().split()
        name = os.fsdecode(path).rsplit("/", 1)[-1]
        if obj_type == "blob" and name.endswith(".png"):
            pngs[name[: -len(".png")]] = blob
    return sha, pngs


def _run_diff(pairs: list[dict], out_dir: Path, cfg) -> dict[str, dict]:
    """farm/capture/diff.mjs's result per pair name, checked before use: any
    missing, extra or malformed entry raises. The helper writes its result to
    a file, never stdout, so a stray log line can't corrupt it."""
    if not screenshot_runner.worker_installed(DIFF_PACKAGES):
        raise RuntimeError(f"farm/capture is not installed ({screenshot_runner.INSTALL_HINT})")
    result_file = out_dir.parent / "diff-result.json"
    request = {
        "pairs": pairs,
        "outDir": str(out_dir),
        "resultFile": str(result_file),
        "threshold": cfg["threshold"],
        "ratioTolerance": cfg["ratioTolerance"],
    }
    proc = subprocess.run(
        DIFF_CMD, input=json.dumps(request), capture_output=True, text=True, timeout=DIFF_TIMEOUT_S
    )
    if proc.returncode != 0:
        raise RuntimeError(f"diff helper exited {proc.returncode}: {proc.stderr.strip()[-200:]}")
    if not result_file.is_file():
        raise RuntimeError("diff helper wrote no result")
    shots = json.loads(result_file.read_text(encoding="utf-8")).get("shots")
    if not isinstance(shots, list):
        raise RuntimeError("diff helper returned no shots")
    wanted = {pair["name"] for pair in pairs}
    out: dict[str, dict] = {}
    for shot in shots:
        name = shot.get("name") if isinstance(shot, dict) else None
        if name not in wanted or name in out:
            raise RuntimeError("diff helper returned an unknown or repeated shot")
        status, ratio, error = shot.get("status"), shot.get("diffRatio"), shot.get("error")
        if status not in (CHANGED, SAME) or not (error is None or isinstance(error, str)):
            raise RuntimeError(f"diff helper returned a bad result for {name}")
        if ratio is not None and (isinstance(ratio, bool) or not isinstance(ratio, (int, float))):
            raise RuntimeError(f"diff helper returned a bad ratio for {name}")
        if (status == CHANGED and error is None) != (out_dir / f"{name}.png").is_file():
            raise RuntimeError(f"diff helper's diff PNG for {name} does not match its status")
        out[name] = {"status": status, "diffRatio": ratio, "error": error}
    if set(out) != wanted:
        raise RuntimeError("diff helper skipped a shot")
    return out


def _compute_results(ws: Path, item: dict, shots: dict[str, str], cfg, tmp: Path) -> tuple[dict, dict[str, Path]]:
    """results.json's document and {name: diff PNG on disk} for one publish.
    `shots` maps each published shot's name to its blob sha."""
    baseline = _baseline_pngs(ws, item["repo"])
    base_sha, base_pngs = baseline if baseline else (None, {})
    entries: dict[str, dict] = {}
    pairs: list[dict] = []
    for name in sorted({*shots, *base_pngs}):
        if name not in base_pngs:
            entries[name] = {"status": NEW, "diffRatio": None, "error": None}
        elif name not in shots:
            entries[name] = {"status": REMOVED, "diffRatio": None, "error": None}
        elif shots[name] == base_pngs[name]:
            entries[name] = {"status": SAME, "diffRatio": 0, "error": None}
        else:
            current, base = tmp / "current" / f"{name}.png", tmp / "baseline" / f"{name}.png"
            for path, blob in ((current, shots[name]), (base, base_pngs[name])):
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(git_bytes(ws, "cat-file", "blob", blob))
            pairs.append({"name": name, "current": str(current), "baseline": str(base)})
    out_dir = tmp / "diff"
    out_dir.mkdir()
    if pairs:
        entries.update(_run_diff(pairs, out_dir, cfg))
    diffs: dict[str, Path] = {}
    rows = []
    for name in sorted(entries):
        entry = entries[name]
        diff = None
        if entry["status"] == CHANGED and entry["error"] is None:
            diffs[name] = out_dir / f"{name}.png"
            diff = f"{SHOTS_TREE}/diff/{name}.png"
        rows.append({"name": name, "status": entry["status"], "diffRatio": entry["diffRatio"], "diff": diff, "error": entry["error"]})
    doc = {
        "version": RESULTS_VERSION,
        "baseline": base_sha,
        "threshold": cfg["threshold"],
        "ratioTolerance": cfg["ratioTolerance"],
        "shots": rows,
    }
    return doc, diffs


def _pngs_in(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.png")) if directory.is_dir() else []


def publish_screenshots(ws: Path, item: dict, log=log) -> None:
    try:
        cfg = screenshots_config.load_config(ws)
    except screenshots_config.ConfigError:
        log("publish_screenshots: skipped — invalid config")
        return
    if cfg is None:
        log("publish_screenshots: skipped — no .horizon/screenshots.json")
        return
    shots_dir = ws / cfg.output_dir
    pngs = _pngs_in(shots_dir)
    manifest = shots_dir / screenshot_runner.MANIFEST_NAME
    if not pngs:
        log("publish_screenshots: no screenshots to publish — skipped")
        return
    diff_cfg = {"threshold": cfg.diff_threshold, "ratioTolerance": cfg.diff_ratio_tolerance}
    # NOT ws/".git": per-item worktrees (HZ-50) have a .git FILE containing
    # "gitdir: ...", not a directory, so writing an index inside it raises
    # ENOTDIR. GIT_INDEX_FILE may live anywhere, so use a temp path that is
    # correct for a worktree and a plain clone alike.
    index_fd, index_path = tempfile.mkstemp(prefix="horizon-artifacts-index-")
    os.close(index_fd)
    index_file = Path(index_path)
    env = {"GIT_INDEX_FILE": str(index_file)}
    tmp = None
    try:
        index_file.unlink(missing_ok=True)

        def add(path: Path, tree_path: str) -> str:
            sha = git(ws, "hash-object", "-w", str(path), env=env).stdout.strip()
            git(ws, "update-index", "--add", "--cacheinfo", f"100644,{sha},{tree_path}", env=env)
            return sha

        files = [*pngs, manifest] if manifest.is_file() else pngs
        shots = {}
        for png in files:
            sha = add(png, f"{SHOTS_TREE}/{png.name}")
            if png.suffix == ".png":
                shots[png.stem] = sha
        tmp = Path(tempfile.mkdtemp(prefix="horizon-artifacts-diff-"))
        try:
            results, diffs = _compute_results(ws, item, shots, diff_cfg, tmp)
        except Exception as exc:  # best-effort — the shots still publish
            log(f"publish_screenshots: diffs skipped — {exc}")
        else:
            for name, path in diffs.items():
                add(path, f"{SHOTS_TREE}/diff/{name}.png")
            (tmp / RESULTS_NAME).write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
            add(tmp / RESULTS_NAME, f"{SHOTS_TREE}/{RESULTS_NAME}")
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
            if tmp is not None:
                shutil.rmtree(tmp, ignore_errors=True)
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
    # HZ-456: HEAD is the remote checkpoint rebased onto main, so it no longer
    # contains lease_sha — and may replace it. State, never read from `note`.
    rebased: bool = False


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
    default = default_branch(ws)
    git(ws, "checkout", "-B", branch, unpushed or lease_sha or f"origin/{default}")
    note, rebased = _rebase_checkpoint(ws, default, unpushed or lease_sha) if rebase_checkpoint else ("", False)
    return PreparedBranch(branch, lease_sha, note, rebased)


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


def _rebase_checkpoint(ws: Path, default: str, lease_sha: str) -> tuple[str, bool]:
    """HZ-184: a resumed checkpoint is rebased onto current origin/<default>
    first, so fixes that landed on main since (HZ-125) reach it. A conflicting
    rebase is abandoned and the attempt resumes from the checkpoint as it was —
    the work is never lost to a rebase. Runs only in this item's worktree;
    nothing is pushed here. `lease_sha` is the commit the branch was checked
    out at, which the abort path returns to. Returns (prompt note, whether
    HEAD was rebased)."""
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    if CHECKPOINT_MARKER not in subject:
        return "", False
    if not lease_sha:
        # HEAD came from origin/<default>, so it is no checkpoint of this
        # item's — and the abort path below must never `reset --hard ''`.
        return "", False
    if git(ws, "merge-base", "--is-ancestor", f"origin/{default}", "HEAD", check=False).returncode == 0:
        return "", False  # already on current main
    rebased = git(ws, "rebase", f"origin/{default}", check=False)
    if rebased.returncode == 0:
        log(f"rebased the WIP checkpoint onto origin/{default}")
        return (
            f"\n\nNOTE: the checkpoint was rebased onto current origin/{default} before this attempt "
            "started, so fixes that landed on main since the previous attempt are included."
        ), True
    git(ws, "rebase", "--abort", check=False)
    git(ws, "reset", "--hard", lease_sha)
    log(f"rebasing the WIP checkpoint onto origin/{default} conflicted — resuming it unrebased")
    return (
        f"\n\nNOTE: the checkpoint could not be rebased onto current origin/{default} (the rebase "
        f"conflicted), so this attempt resumes it unrebased, on an older origin/{default}. Fixes that "
        "landed on main since are NOT in this tree."
    ), False


def merge_default_branch(ws: Path) -> list[str]:
    """HZ-188: merge origin/<default> into the freshly prepared item branch
    before the agent starts, so a conflict send-back reworks the code on top
    of today's main instead of the stale base the conflict came from (HZ-125,
    HZ-144). A clean merge is committed; a conflicted one is left IN PROGRESS
    with its markers on disk for the agent to resolve — finalize_branch's
    commit then records it as the merge commit. Returns the conflicted paths
    (empty for a clean merge). Any other merge failure raises: the agent must
    not start on a half-merged tree it was never told about."""
    default = default_branch(ws)
    merged = git(ws, "merge", "--no-edit", f"origin/{default}", check=False)
    if merged.returncode == 0:
        return []
    # -z and raw bytes (HZ-420): these paths are opened on disk, so a byte
    # that isn't UTF-8 must survive, and a space must not split a path.
    listed = git_bytes(ws, "diff", "--name-only", "-z", "--diff-filter=U", check=False)
    conflicted = [os.fsdecode(raw) for raw in listed.split(b"\0") if raw]
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
            left.append(_shown(path))
    return left


def _merge_main_note(conflicted: list[str]) -> str:
    if not conflicted:
        return (
            "\n\nNOTE: this branch's PR conflicted with main. origin/main has already "
            "been merged into it cleanly — build on the merged code as it is now."
        )
    files = "\n".join(f"- {_shown(path)}" for path in conflicted)
    return (
        "\n\nNOTE: this branch's PR conflicted with main. origin/main has been merged "
        "into it and the merge is still in progress: these files have conflict markers "
        f"left in place for you to resolve —\n{files}\n"
        "Resolve every marker keeping the intent of both sides, then carry on with the "
        "step. Do not run `git merge --abort` and do not commit — the harness commits "
        "the merge after you finish."
    )


def _precheck_state(ws: Path) -> tuple[str, str] | None:
    """HZ-456: (cause, digest) of the farm commit pushed before the checks,
    while HEAD is still that commit (see PRECHECK_CHECKPOINT), else None."""
    try:
        sha, _, rest = _git_path(ws, PRECHECK_CHECKPOINT).read_text().partition("\n")
    except OSError:
        return None
    if not _head_is(ws, sha.strip()):
        return None
    cause, _, digest = rest.partition("\n")
    if cause.strip() == CAUSE_CHECKS_FAILED:
        return CAUSE_CHECKS_FAILED, digest.strip()
    return CAUSE_UNCHECKED, ""


def _write_precheck_state(ws: Path, sha: str, cause: str, digest: str = "") -> None:
    _git_path(ws, PRECHECK_CHECKPOINT).write_text(f"{sha}\n{cause}\n{digest}")


def _checkpoint_cause(ws: Path, *, precheck: bool = True) -> tuple[str, str] | None:
    """(cause, detail) of the checkpoint at HEAD, or None when HEAD is not a
    checkpoint. A checkpoint written before HZ-184 has no body and reads as
    (CAUSE_EXHAUSTED, "") — the only cause that existed then.

    HZ-456: a plain farm commit pushed before the checks counts too, read from
    PRECHECK_CHECKPOINT — unless precheck is False (a fix pass, which never
    pushes before its checks, so such a file is another attempt's)."""
    subject = git(ws, "log", "-1", "--format=%s", check=False).stdout.strip()
    if CHECKPOINT_MARKER not in subject:
        return _precheck_state(ws) if precheck else None
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
    stat = git(ws, "diff", "--stat", f"origin/{default_branch(ws)}...HEAD", check=False).stdout.strip()
    if cause == CAUSE_CHECKS_FAILED:
        return (
            "\n\nNOTE: this branch already has a WIP checkpoint commit "
            f'("{subject}") that holds the previous attempt\'s complete work. That attempt '
            "finished, but the repo's checks failed on it:\n\n"
            f"```\n{detail or '(no check output was captured)'}\n```\n\n"
            "Fix those failures on top of the checkpoint — read the diff below. Do not discard "
            f"it or restart from scratch.\n\n```\n{stat}\n```"
        )
    if cause == CAUSE_UNCHECKED:
        return (
            f'\n\nNOTE: this branch\'s last commit ("{subject}") holds the previous attempt\'s '
            "complete work. That attempt finished and committed it, but stopped while the repo's "
            "checks were still running, so they never reported. Re-check the work, fix only what "
            "fails, and do not discard it or restart from scratch — read the diff below."
            f"\n\n```\n{stat}\n```"
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
    problem = delta_base_problem(ws, base, default_branch(ws))
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
    checkpoint = _checkpoint_cause(ws, precheck=False)
    if checkpoint is None or checkpoint[0] != CAUSE_CHECKS_FAILED:
        return ""
    return (
        "\n\nThe previous fix attempt's changes are in the WIP checkpoint at HEAD, but the "
        f"repo's checks failed on them:\n\n```\n{checkpoint[1] or '(no check output was captured)'}\n```"
    )


def _deploy_stop_note(ws: Path) -> str:
    """HZ-321: a fix pass a deploy stopped resumes on its WIP checkpoint."""
    checkpoint = _checkpoint_cause(ws, precheck=False)
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


def commit_work(ws: Path, item: dict, conflicted: list[str] | None = None) -> str:
    """Commits the agent's work locally — never pushes. Returns the new
    commit's sha, or "" when there was nothing to commit.

    HZ-438: the implement step calls this before the repo checks, so a check
    that inspects `git status` sees committed work, and the commit the checks
    ran on is the one finalize_branch() pushes."""
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
    if staged.returncode == 0 and merging.returncode != 0:
        return ""
    git(ws, "commit", "-m", f"{item['id']}: {item['title']} (Horizon Eng agent)")
    return git(ws, "rev-parse", "HEAD").stdout.strip()


def finalize_branch(
    ws: Path,
    item: dict,
    branch: str,
    conflicted: list[str] | None = None,
    *,
    lease_sha: str = "",
    checked_sha: str | None = None,
) -> dict:
    """Pushes the branch. With checked_sha (HZ-438) the work was committed
    before the checks: nothing is added or committed here, and HEAD must
    still be that commit — what was checked is exactly what is pushed."""
    if checked_sha is None:
        commit_work(ws, item, conflicted)
        if _no_code_changes(ws):
            raise RuntimeError("the agent made no code changes — nothing to push")
    else:
        head = git(ws, "rev-parse", "HEAD").stdout.strip()
        if head != checked_sha:
            raise RuntimeError("HEAD moved during the checks — nothing pushed")
        # A file a check left on disk was never checked, so it is not a change.
        if _no_code_changes(ws, ignore_worktree=True):
            raise RuntimeError("the agent made no code changes — nothing to push")
        left = git(ws, "status", "--porcelain", check=False).stdout.rstrip()
        if left:
            paths = ", ".join(line[3:] for line in left.splitlines())
            log(f"finalize: the checks left changes on disk — not pushed: {paths}")
    # HZ-456: after a pre-check push, lease_sha is that same commit — a no-op.
    _push_with_lease(ws, item, branch, lease_sha)
    _git_path(ws, PRECHECK_CHECKPOINT).unlink(missing_ok=True)
    stat = git(ws, "diff", "--stat", f"origin/{default_branch(ws)}...HEAD", check=False).stdout.strip().splitlines()
    return {"branch": branch, "files_changed": stat[-1] if stat else ""}


def _no_code_changes(ws: Path, *, ignore_worktree: bool = False) -> bool:
    """HZ-346: the one "nothing to push" test. finalize_branch() raises on it
    after committing; the implement step reads it before checks to decide
    whether a blocked report may stand. Anything on disk, a merge in progress
    or a commit ahead of the default branch (a WIP checkpoint included) is a
    change, so such a run always takes the normal checks-and-review path.
    ignore_worktree (HZ-438): only commits count — used once the work was
    committed before the checks, when anything on disk came from a check."""
    if not ignore_worktree and git(ws, "status", "--porcelain", check=False).stdout.strip():
        return False
    if git(ws, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).returncode == 0:
        return False
    ahead = git(ws, "rev-list", "--count", f"origin/{default_branch(ws)}..HEAD", check=False).stdout.strip()
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
    farm_commit: str = "",
    pushed: str = "",
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
    caused by main alone (HZ-157) must still carry its digest forward.

    HZ-438: farm_commit is the commit the implement step made before its
    checks. While HEAD is still that commit, the checkpoint amends it — one
    commit per run, a merge keeps both parents — rather than stacking on it;
    it always holds unpushed work, so the outcome is never "nothing".

    HZ-456: pushed is the farm commit already pushed before the checks (its
    failure digest lives in PRECHECK_CHECKPOINT, not in a commit). While HEAD
    is still that commit and nothing new is on disk, the branch already holds
    the work: no commit is made and nothing is pushed. Files a check left on
    disk are stacked on it as one checkpoint commit, never amended into it."""
    try:
        markers = _conflict_markers_left(ws, conflicted or [])
        if markers:
            log(f"salvage: skipped — the merge of main still has conflict markers in {', '.join(markers)}")
            return f"skipped: the merge of main still has conflict markers in {', '.join(markers)}"
        amend = _head_is(ws, farm_commit)
        on_pushed = _head_is(ws, pushed)
        git(ws, "add", "-A")
        _unstage_secrets(ws, *(_parents(ws, "HEAD") if amend else ()))
        staged = git(ws, "diff", "--cached", "--quiet", check=False)
        if staged.returncode == 0 and on_pushed and not amend:
            log(f"salvage: the pre-check checkpoint {pushed[:12]} already holds the work — no commit made, nothing pushed")
            return "saved"
        allow_empty = amend or (cause == CAUSE_CHECKS_FAILED and not on_pushed)
        if staged.returncode == 0 and not allow_empty:
            log("salvage: no uncommitted changes to checkpoint")
            return "nothing"
        body = f"cause: {cause}" + (f"\n\n{detail}" if detail else "")
        git(
            ws,
            "commit",
            *(["--amend"] if amend else []),
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


def _head_is(ws: Path, sha: str) -> bool:
    return bool(sha) and git(ws, "rev-parse", "HEAD", check=False).stdout.strip() == sha


def _parents(ws: Path, rev: str) -> list[str]:
    """rev's parents' shas, first parent first."""
    return git(ws, "rev-list", "--parents", "-n", "1", rev).stdout.split()[1:]


def _unstage_secrets(ws: Path, *bases: str) -> list[str]:
    """Unstages every staged path that looks like a secret (HZ-194), so a
    checkpoint can never push one. Deletions are left staged: removing a
    secret from the branch is never a leak.

    bases (default HEAD) are what the checkpoint's commit will sit on. HZ-438:
    replacing the farm's own commit, they are that commit's parents — a path
    counts as staged only when it differs from every one, so a file a merged
    main brought in is kept; an unstaged path goes back to the first base."""
    secrets: list[str] | None = None
    for base in bases or ("",):
        # Raw bytes (HZ-420): each path goes back to `git reset` exactly as git
        # listed it; os.fsdecode round-trips a byte that isn't UTF-8.
        staged = git_bytes(ws, "diff", "--cached", "--name-only", "--diff-filter=d", "-z", *([base] if base else []), check=False)
        paths = [os.fsdecode(raw) for raw in staged.split(b"\0") if raw]
        found = [path for path in paths if _is_secret_path(path)]
        secrets = found if secrets is None else [path for path in secrets if path in found]
    if secrets:
        git(ws, "reset", "-q", *bases[:1], "--", *secrets)
        log(f"salvage: left out of the checkpoint (secret-looking files): {', '.join(map(_shown, secrets))}")
    return secrets


def _secret_paths(ws: Path, rev: str) -> list[str]:
    """HZ-456: the secret-looking paths rev adds or changes — those that
    differ from every parent, the same rule as _unstage_secrets, so a file a
    merged main brought in is not counted."""
    found: list[str] | None = None
    for parent in _parents(ws, rev) or [""]:
        if parent:
            listed = git_bytes(ws, "diff", "--name-only", "--diff-filter=d", "-z", parent, rev)
        else:
            listed = git_bytes(ws, "ls-tree", "-r", "--name-only", "-z", rev)
        paths = [path for path in (os.fsdecode(raw) for raw in listed.split(b"\0") if raw) if _is_secret_path(path)]
        found = paths if found is None else [path for path in found if path in paths]
    return found or []


def _push_precheck_checkpoint(
    ws: Path, item: dict, branch: str, prepared: PreparedBranch, scope: dict, *, lease_sha: str | None = None
) -> str:
    """HZ-456: pushes the implement step's committed work to the item's own
    branch before the checks run. A step killed during its checks (its time
    limit, a farm restart) runs no handler at all, so only a push made here
    lets the retry's prepare_branch resume from the work.

    The push is lease-protected against what prepare_branch fetched: a commit
    pushed by anyone since fails the lease and is kept. It is skipped when a
    PR is open (fix pass), when origin holds commits HEAD does not contain and
    HEAD is no rebase of them, and when a commit to push adds a secret-looking
    file. Returns the sha the remote now holds for this run (HEAD), or "" when
    nothing was pushed. Never raises: a failed push is logged, and the checks
    run anyway.

    HZ-458: lease_sha is what an earlier check round of this run left on the
    remote (its pushed farm commit, or prepared.lease_sha when nothing was
    pushed). A fix round's commit sits on top of it, so it is the lease."""
    try:
        if scope["mode"] == "fix":
            # Pushing here would put unchecked code on the open PR (and run its CI).
            log(f"checkpoint: skipped — a PR is open on {branch}, nothing pushed before the checks")
            return ""
        own = f"horizon/{item['id'].lower()}"
        default = default_branch(ws)
        if branch != own or branch in (default, "main", "master"):
            log(f"checkpoint: refused — {branch} is not this item's own branch")
            return ""
        if _no_code_changes(ws, ignore_worktree=True):
            log(f"checkpoint: skipped — no commit ahead of origin/{default}")
            return ""
        head = git(ws, "rev-parse", "HEAD").stdout.strip()
        lease = prepared.lease_sha if lease_sha is None else lease_sha
        # Only prepare_branch's own lease can be the checkpoint it rebased.
        rebased = prepared.rebased and lease == prepared.lease_sha
        if head != lease:
            if lease and not rebased:
                if git(ws, "merge-base", "--is-ancestor", lease, head, check=False).returncode != 0:
                    log(f"checkpoint: skipped — origin/{branch} holds commits HEAD does not contain")
                    return ""
            excluded = [f"^origin/{default}", *([f"^{lease}"] if lease else [])]
            unpublished = git(ws, "rev-list", head, *excluded).stdout.split()
            secrets = sorted({path for commit in unpublished for path in _secret_paths(ws, commit)})
            if secrets:
                log(f"checkpoint: skipped — a secret-looking file would be pushed: {', '.join(map(_shown, secrets))}")
                return ""
            _push_with_lease(ws, item, branch, lease)
            log(f"checkpoint: pushed {head[:12]} to {branch} before the checks")
        else:
            log(f"checkpoint: {branch} already holds {head[:12]} — nothing to push before the checks")
    except Exception as exc:
        # A failed push can echo the remote URL, which carries the hub's token.
        detail = redact(_URL_CREDENTIALS.sub("://[redacted]@", str(exc)), secret_values(os.environ))
        log(f"checkpoint: push failed ({detail}) — running the checks anyway")
        return ""
    try:
        _write_precheck_state(ws, head, CAUSE_UNCHECKED)
    except OSError as exc:
        log(f"checkpoint: could not record the pushed commit ({exc}) — a retry resumes from it without a note")
    return head


def _pause_checkpoint(
    ws: Path, item: dict, branch: str, conflicted: list[str], lease_sha: str, scope: dict, farm_commit: str = ""
) -> tuple[str, str]:
    """HZ-194: what a pause saves of a running implement attempt. Every child
    (the claude CLI, check commands) is stopped first so nothing writes while
    the tree is committed, and a git lock a killed git call left behind is
    cleared. Reuses HZ-184's salvage — one checkpoint implementation. Never
    opens or updates a PR through the API, and the run is never reported as
    passed. Returns (outcome, detail) in pause's vocabulary. farm_commit:
    see _salvage_checkpoint (HZ-438)."""
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
        return _deploy_checkpoint(ws, item, branch, conflicted, lease_sha, farm_commit)
    if scope["mode"] == "fix":
        # Pushing here would add commits to the open PR (and run its CI).
        return pause.SKIPPED, f"a PR is open on {branch} — a checkpoint would update it"
    result = _salvage_checkpoint(ws, item, branch, conflicted, cause=CAUSE_PAUSED, lease_sha=lease_sha, farm_commit=farm_commit)
    if result == "saved":
        return pause.SAVED, f"pushed a WIP checkpoint to {branch}"
    if result == "nothing":
        return pause.NOTHING, "no changes since the last commit"
    # The detail reaches the server's activity log. A failed push can echo
    # the remote URL, which carries the hub's token (workspaces.ensure).
    detail = _URL_CREDENTIALS.sub("://[redacted]@", result.partition(": ")[2] or result)
    return pause.FAILED, redact(detail, secret_values(os.environ))


def _deploy_checkpoint(
    ws: Path, item: dict, branch: str, conflicted: list[str] | None, lease_sha: str, farm_commit: str = ""
) -> tuple[str, str]:
    """HZ-321: saves a running attempt a self-deploy is stopping as one WIP
    commit of its whole tree, pushed to the item's own branch — never forced,
    never rewriting a commit, so unlike _salvage_checkpoint (whose lease push
    may replace a rebased branch) it cannot lose anything already pushed.

    The commit's parent is what the remote branch holds when HEAD does not
    already contain it (a resumed checkpoint rebased onto main locally), so
    the push is always a fast-forward and its tree is exactly what was on
    disk. A merge of main in progress keeps MERGE_HEAD as a second parent.
    .gitignore is honoured and SECRET_PATTERNS are never staged.

    HZ-438: while HEAD is farm_commit (the implement step's commit made
    before its checks, never pushed), the WIP commit replaces it: it sits on
    that commit's parents, so the run still pushes one commit. HZ-456: once
    the farm commit was pushed before the checks, the caller passes no
    farm_commit and lease_sha is that commit, so it is stacked on, not replaced.

    If the push fails, the commit stays in this worktree with a marker, and
    the next attempt's prepare_branch resumes from it. Never raises.
    Returns (outcome, detail) in pause's vocabulary."""
    own = f"horizon/{item['id'].lower()}"
    try:
        default = default_branch(ws)
        if branch != own or branch in (default, "main", "master"):
            return pause.SKIPPED, f"refused: {branch} is not this item's own branch"
        markers = _conflict_markers_left(ws, conflicted or [])
        if markers:
            return pause.SKIPPED, f"the merge of main still has conflict markers in {', '.join(markers)}"
        replace = _head_is(ws, farm_commit)
        git(ws, "add", "-A")
        if replace:
            head, *merged = _parents(ws, "HEAD")
            merge_head = merged[0] if merged else ""
            _unstage_secrets(ws, head, *merged)
        else:
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
        if merge_head and not replace:
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
        return pause.FAILED, redact(detail, secret_values(os.environ))


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


def model_persona(persona_agent: str | None, personas: dict, overlay: dict | None = None) -> str | None:
    """HZ-192: the namespaced "<agent>.<persona>" a run_agent() call composes —
    the key domain/personas.json's models.personas overrides by — or None for
    a call that composes no persona. HZ-535: a project persona in `overlay`
    keys as "<agent>.<slug>:<id>", its project file's models entry."""
    if not persona_agent:
        return None
    return f"{persona_agent}.{resolve(persona_agent, personas.get(persona_agent), overlay)}"


def _provenance(reply: dict) -> dict:
    # HZ-398: plus the model that ran, when the reply names one.
    model = {"model": reply["model"]} if reply.get("model") else {}
    return {"provider": reply.get("provider"), **model, "command_id": reply.get("command_id")}


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


def _task_reply_validator(label: str, metric: str | None = None):
    """HZ-383: the reply check a Task step runs inside the retry envelope.
    Run plan's `run_plan` block must satisfy domain/runPlan.schema.json, and
    no part of any Task reply (summary, artifact, rendered block) may carry
    what looks like a literal secret. Raises AgentError, which takes the one
    retry; a second bad reply fails the step. The message and the log name
    the field or the secret's shape, never the value. HZ-503: the block's
    `proof` must name each line of the item's `metric` exactly once; the
    reason names every missing, doubled or out-of-range line."""

    def check(parsed):
        if not isinstance(parsed, dict):
            return parsed  # the required-field check after the call says so
        texts = [parsed.get("summary"), parsed.get("artifact_md")]
        # HZ-379: an object field's text is held to the same rule — Assess's
        # `code_needed` becomes a GitHub issue.
        for value in parsed.values():
            if isinstance(value, dict):
                texts.extend(v for v in value.values() if isinstance(v, str))
        if label == RUN_PLAN_LABEL:
            try:
                block = run_plan.validate(parsed.get("run_plan"))
                gaps = run_plan.unproven(block, metric)
                if gaps:
                    raise ValueError(gaps)
                texts.append(run_plan.render(block))
            except ValueError as exc:
                raise AgentError(f"invalid run plan: {exc}") from None
        found = sorted({name for text in texts for name in run_plan.literal_secrets(text)})
        if found:
            log(f"{label}: reply carries a literal secret ({', '.join(found)}) — rejected")
            raise AgentError(
                f"the reply carries what looks like a literal secret ({', '.join(found)}); "
                "name secrets only as references like $GITHUB_TOKEN"
            )
        return parsed

    return check


def _requires_recheck(kind: str, label: str, task: dict):
    """HZ-502: Run plan's check of its plan's `requires` on the runner
    Execute will use (farm/run_plan_requires.py), or None for every other
    step. A check that cannot run fails the step at once — the agent cannot
    fix a missing Podman — and a plan never passes unchecked. The kind is
    matched by its table, never by name."""
    if STEP_CONFIGS.get(kind) is not TASK_STEP_CONFIG or label != RUN_PLAN_LABEL:
        return None

    def recheck(parsed: dict, deadline: float) -> list[str]:
        try:
            return run_plan_requires.check(
                parsed.get("run_plan"),
                repo_dir=task.get("repo_dir"),
                venv_dir=task.get("venv_dir"),
                runner=task.get("runner"),
                container_image=task.get("container_image"),
                forbid=str(task_job.HORIZON_ROOT),  # Execute's own refusal root
                deadline=deadline,
            )
        except run_plan_requires.Unavailable as exc:
            log(f"{label}: {exc}")
            raise AgentError(str(exc)) from None

    return recheck


def _prior_inventory(task: dict, scope: list[str]) -> dict:
    """HZ-447: the validated Inventory block among the prior artifacts."""
    for artifact in reversed(task.get("artifacts") or []):
        if artifact.get("label") == PLAN_INVENTORY_LABEL:
            try:
                return plan_inventory.extract(artifact.get("content", ""), scope)
            except ValueError as exc:
                raise AgentError(f"Design needs the Inventory block: {exc}") from None
    raise AgentError("Design needs the Inventory artifact, and the task carries none")


def _plan_reply_validator(label: str, task: dict, scope: list[str]):
    """The reply check a Plan step runs inside the retry envelope, extended
    by label. HZ-448: Draft items' `plan_draft` block must satisfy
    domain/planDraft.schema.json and form a DAG (domain/py/plan_draft.py);
    whether a real key exists is the server's check, on ingest. HZ-463: the
    coverage review's `plan_review` must satisfy domain/planReview.schema.json
    (domain/py/plan_review.py); the server decides its findings. HZ-447:
    Inventory's `inventory` block must satisfy domain/planInventory.schema.json
    with one row per in-scope repo; Design's `design` must cite an Inventory
    evidence ref for every repo it changes; no part of either reply may carry
    a literal secret. Design's Inventory block is read here, before any call,
    so a missing one fails the step without spending a run. Raises
    AgentError, which takes the one retry; a second bad reply fails the step."""
    inventory = _prior_inventory(task, scope) if label == PLAN_DESIGN_LABEL else None

    def check(parsed):
        if not isinstance(parsed, dict):
            return parsed  # the required-field check after the call says so
        if label == PLAN_DRAFT_LABEL:
            try:
                plan_draft.validate(parsed.get("plan_draft"))
            except ValueError as exc:
                raise AgentError(f"invalid plan draft: {exc}") from None
            return parsed
        if label == PLAN_COVERAGE_REVIEW_LABEL:
            try:
                plan_review.validate(parsed.get("plan_review"))
            except ValueError as exc:
                raise AgentError(f"invalid plan review: {exc}") from None
            return parsed
        texts = [parsed.get("summary"), parsed.get("artifact_md")]
        try:
            if label == PLAN_INVENTORY_LABEL:
                texts.append(plan_inventory.render(plan_inventory.validate(parsed.get("inventory"), scope)))
            elif inventory is not None:
                uncited = plan_inventory.check_citations(parsed.get("design"), inventory)
                if uncited:
                    raise ValueError(f"the recommendation changes {uncited} but cites no Inventory evidence ref for them")
                texts.append(json.dumps(parsed["design"]))
        except ValueError as exc:
            raise AgentError(f"invalid {label} reply: {exc}") from None
        found = sorted({name for text in texts for name in run_plan.literal_secrets(text)})
        if found:
            log(f"{label}: reply carries a literal secret ({', '.join(found)}) — rejected")
            raise AgentError(
                f"the reply carries what looks like a literal secret ({', '.join(found)}); "
                "name secrets only as references like $GITHUB_TOKEN"
            )
        return parsed

    return check


# The Plan steps that carry a reply check. HZ-463: the metrics review has
# none — its findings are the server's own.
PLAN_VALIDATED_LABELS = frozenset({PLAN_INVENTORY_LABEL, PLAN_DESIGN_LABEL, PLAN_DRAFT_LABEL, PLAN_COVERAGE_REVIEW_LABEL})


def _reply_validator(kind: str, label: str, task: dict | None = None, scope: list[str] | None = None):
    """The reply check a step runs inside the retry envelope, or None. A
    Plan step is picked by its label (HZ-447, HZ-448); every Task step by
    its kind's table (HZ-383). The kind is matched by its table, never by
    name."""
    config = STEP_CONFIGS.get(kind)
    if config is PLAN_STEP_CONFIG and label in PLAN_VALIDATED_LABELS:
        return _plan_reply_validator(label, task or {}, scope or [])
    if config is not TASK_STEP_CONFIG:
        return None
    return _task_reply_validator(label, ((task or {}).get("item") or {}).get("metric"))


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
    model_choice: str | None = None,
    provider_locked: bool = False,
    validate=None,
    disallowed_tools: str | None = None,
    recheck=None,
    overlay: dict | None = None,
) -> tuple[dict, dict, list[str]]:
    """run_agent + the shared reply parser, with one retry-with-feedback on a
    parse failure (HZ-44) — the PM steps' recovery (_execute_pm) too. Asking the
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
    HZ-383: a Task step is the exception — it hands in its own validator
    (_task_reply_validator), so a bad run plan or a literal secret takes the
    one retry and then fails the step. HZ-447: a Plan step too
    (_plan_reply_validator), and disallowed_tools reach run_agent only when
    set.

    HZ-158: required_keys, item_id and guard have no default, so every call
    site must say what its reply needs. They are used only when run_agent
    raises AgentExhaustedError — see _on_exhaustion(). Only the first call may
    be salvaged; an exhaustion inside the retry is handed off and re-raised.
    A salvaged reply's provenance is the provider that ran, no command_id.

    HZ-502: `recheck(parsed, deadline)` returns the gaps in a reply that
    parsed and validated (Run plan's `requires` check). Each gap list goes
    back to the same session, up to REQUIRES_REPROMPTS times, and the new
    reply is parsed and validated again; gaps that remain fail the step,
    naming every one. Every re-prompt shares the first call's deadline.
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
            model_choice=model_choice,
            provider_locked=provider_locked,
            disallowed_tools=disallowed_tools,
            overlay=overlay,
        )
    except AgentExhaustedError as exc:
        parsed, notes = _on_exhaustion(exc, required_keys=required_keys, ctx=ctx, guard=guard, salvage=True)
        model = {"model": exc.model} if getattr(exc, "model", None) else {}
        return parsed, {"provider": exc.provider, **model, "command_id": None}, notes
    produced = reply

    def resume(next_prompt: str, limit_s: int) -> str:
        nonlocal produced
        produced = run_agent(
            next_prompt,
            agent=agent,
            step=step,
            persona=persona,
            session_id=produced.get("session_id"),
            append_system=append_system,
            cwd=cwd,
            max_turns=max_turns,
            timeout_s=limit_s,
            allowed_tools=allowed_tools,
            provider=provider,
            model_choice=model_choice,
            provider_locked=provider_locked,
            disallowed_tools=disallowed_tools,
            overlay=overlay,
        )
        return produced["result"]

    def retry_once(retry_prompt: str) -> str:
        log("invalid reply; retrying once")
        return resume(retry_prompt, timeout_s)

    try:
        text, notes = reply["result"], []
        for reprompt in range(REQUIRES_REPROMPTS + 1):
            parsed, more = parse_agent_reply(text, retry_once, validate=validate)
            notes = [*notes, *more]
            gaps = recheck(parsed, ctx.deadline) if recheck else []
            if not gaps:
                break
            for gap in gaps:
                log(f"{step}: the runner lacks what the plan requires: {gap}")
            remaining = int(ctx.deadline - time.monotonic())
            if reprompt == REQUIRES_REPROMPTS or remaining < 1:
                raise AgentError(REQUIRES_GAP_PREFIX + "; ".join(gaps))
            log(f"{step}: sending the gaps back to the agent ({reprompt + 1}/{REQUIRES_REPROMPTS})")
            text = resume(run_plan_requires.feedback(gaps), min(timeout_s, remaining))
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


def run_smoke_check(url: str, expected_text: str, test_env_file: str | None = None) -> tuple[str, str]:
    """HZ-494: test_env_file is the repo's test-login env file. Its values
    reach check.mjs's environment only, and are redacted from the line this
    returns; a file that cannot be loaded fails the check, naming the path."""
    values: dict[str, str] = {}
    if test_env_file:
        try:
            values = login_env.load_login_env(test_env_file)
        except login_env.LoginEnvError as exc:
            return "fail", f"SMOKE_RESULT=fail: {exc}"
    secrets = {f"login_env:{k}": v for k, v in values.items()}
    try:
        result = subprocess.run(
            ["node", str(SMOKE_CHECK_SCRIPT), url, expected_text],
            capture_output=True,
            text=True,
            timeout=SMOKE_CHECK_TIMEOUT_S,
            cwd=str(REPO_ROOT),
            **({"env": {**os.environ, **values}} if values else {}),
        )
    except subprocess.TimeoutExpired:
        return "fail", f"SMOKE_RESULT=fail: check.mjs timed out after {SMOKE_CHECK_TIMEOUT_S}s ({url})"
    except OSError as exc:
        return "fail", redact(f"SMOKE_RESULT=fail: could not run check.mjs: {exc}", secrets)

    line = next((l for l in result.stdout.splitlines() if l.startswith("SMOKE_RESULT=")), None)
    if line:
        line = redact(line, secrets)
    if result.returncode == 0 and line and line.startswith("SMOKE_RESULT=pass"):
        return "pass", line
    if line:
        return "fail", line
    stderr = redact(result.stderr.strip(), secrets)[:200]
    return "fail", f"SMOKE_RESULT=fail: check.mjs exited {result.returncode} with no result line ({stderr})"


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
    text = scrub(chunk.decode("utf-8", "replace"))
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
    creation can overlap a conflict resolver that owns the item. HZ-387: the
    read-only steps too, since a read-only violation's rollback writes to the
    worktree. Every other step runs unlocked.

    HZ-158: one execute() is one run, so the run's handoff guard is made here.

    HZ-371: a PM step keeps no workspace and has no turn budget of its own,
    so it branches off before any of that."""
    item = task["item"]
    kind, label = item_kind(item), task["step"]["label"]
    if _is_pm_step(label, kind):
        return _execute_pm(task)
    guard = HandoffGuard()
    locked = (kind == "change" and label in {IMPLEMENT_LABEL, REVIEW_LABEL}) or _is_read_only(kind, label)
    if not locked or not item.get("repo"):
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


def _execute_pm(task: dict) -> dict:
    """HZ-371: one PM step (0, 1, 2 or 9), on the shared runner — PM steps
    used to have a runner of their own. The prompt, role prompt, validation
    and field writes are farm/pm_steps.py's; the call and the parse are shared.

    No salvage and no handoff note: no PM step is in SALVAGE_STEPS. main()
    still clears a handoff note on success, which is a no-op here."""
    from . import pm_steps  # lazy: ROLE_PROMPT renders roles/pm.md at import

    label = task["step"]["label"]
    item = task["item"]
    kind = item_kind(item)
    prompt = pm_steps.build_prompt(task)
    # HZ-541: the metric step of an item with golden cases names the set.
    golden = golden_cases_section(task)
    if golden:
        prompt = f"{prompt}\n\n{golden}"
    # HZ-192: run_agent() resolves the model from who is calling — the step's
    # own domain/steps.json agent (PM, or Architect for "Set guardrails").
    model_agent = model_agent_for_step(steps.by_kind_label(kind, label)["agent"])
    # HZ-535: the project's own personas, or None (switch off, no file).
    overlay = project_overlay(task.get("project"))
    persona = model_persona(_step_config(kind, label)[3], item_personas(item), overlay)
    # HZ-370: a PM step is in CHOICE_ONLY_PROVIDER_STEPS — the owner's choice
    # (the server has already merged in the project default) or None, i.e.
    # today's routing. A persona's provider never moves it. No cwd for either
    # provider: a PM step has no workspace, Muse included.
    choice = (
        step_provider_choice(item, task["step"].get("index"))
        if steps.provider_override_eligible(steps.FARM_VIEWS[kind], label)
        else None
    )
    provider, model_choice = choice or (None, None)
    # The reply that parsed, so a retry records its own provenance (HZ-102).
    produced: dict = {}

    def call(text: str) -> dict:
        nonlocal produced
        produced = run_agent(
            text,
            agent=model_agent,
            step=label,
            persona=persona,
            session_id=None,
            append_system=pm_steps.role_prompt_for(kind),
            provider=provider,
            model_choice=model_choice,
            overlay=overlay,
        )
        return produced

    reply = call(prompt)

    # One retry, telling the model exactly what was wrong with its reply.
    # Fresh, like the first call (HZ-212): the task prompt goes first, then
    # the correction. validate= keeps validation inside the retry envelope,
    # so a reply missing 'summary' or with an over-budget metric or
    # guardrails (HZ-264) takes the retry.
    def retry_once(retry_prompt: str) -> str:
        log("invalid reply; retrying once")
        return call(f"{prompt}\n\n{retry_prompt}")["result"]

    # HZ-685: the reply that validated, for its optional `split`.
    accepted: dict = {}

    def validate(parsed):
        result = pm_steps.validate_within_budget(parsed, label, item)
        accepted["split"] = parsed.get("split") if isinstance(parsed, dict) else None
        return result

    (summary, patch, artifact), notes = parse_agent_reply(reply["result"], retry_once, validate=validate)
    outcome = pm_steps.finish(task, summary, patch, artifact, notes, split=accepted.get("split"))
    # HZ-370: step_run.provider is recorded from artifacts.provider, so a
    # reply with no artifact still gets an artifacts dict to carry it.
    if produced.get("provider"):
        outcome["artifacts"] = {**outcome.get("artifacts", {}), **_provenance(produced)}
    return outcome


# ---- fix loop on a red check (HZ-458) ----
# A red repo check used to discard the attempt. Now its failure digest goes
# back to the same agent session, with the work intact, to fix just that
# failure; then the checks re-run. FARM_FIX_LOOP_CAP bounds the fix turns
# (0 restores the single check run). Every fix turn draws on the step's turn
# cap and the agent time left — check time is never counted as agent time —
# and the loop ends only on green or through the same failure path as before.

FIX_TURN_MIN_S = 120
# Added lines that skip a test or silence a check. A fix turn adding one
# fails the attempt; the role and the fix prompt both forbid it.
_LOOSENING_LINE = re.compile(r"\.(skip|only)\(|\bxfail\b|\bskipif\b|eslint-disable|pytest\.mark\.skip\b")
_TEST_PATH = re.compile(r"(^|/)(tests?|__tests__)/|\.(test|spec)\.[^/]+$|(^|/)test_[^/]*\.py$|_test\.py$")
_CHECK_CONFIG_FILES = ("eslint.config.*", ".eslintrc*", "playwright.config.*", "pytest.ini")
_PYPROJECT_CHECK_SECTION = re.compile(r"tool\.(pytest|ruff)")
_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


class CheckedWork(NamedTuple):
    checked_sha: str
    checked_tree: object
    check_note: str
    checks_finished_at: str
    # What the remote branch holds for this run, for finalize_branch's lease.
    lease: str
    fix_loops: int


def _fix_loop_cap() -> int:
    raw = os.environ.get("FARM_FIX_LOOP_CAP", "").strip()
    return max(int(raw), 0) if raw.isdigit() else 2


def _notify_checks(run_id, phase: str) -> None:
    """Tells the server (through farmd) the checks started or ended, so it
    pauses this run's step clock for them. Fails open: a lost call leaves the
    server's clock running, which is how it was before HZ-458."""
    if run_id is None:
        return
    try:
        httpx.post(f"{FARMD}/internal/steps/checks", json={"run_id": run_id, "phase": phase}, timeout=40)
    except Exception as exc:
        log(f"checks clock: the server was not told the checks {phase} ({exc}) — its step clock keeps running")


def _fix_turn_prompt(item: dict, detail: str) -> str:
    return (
        f"The farm committed your work on {item['id']} and ran the repo's checks. A check failed:\n\n"
        f"```\n{detail}\n```\n\n"
        "Fix only this failure, in the code. Do not delete, skip or loosen a test, lint rule or check "
        "config to turn the check green — the farm rejects a fix that does. Run only the tests for "
        "what you change; the farm re-runs every check after you finish. Then reply with the same "
        "final JSON object as before."
    )


def _section_at(lines: list[str], lineno: int) -> str:
    """The TOML table heading in force at 1-based line `lineno`, or ""."""
    for line in reversed(lines[: max(lineno, 0)]):
        heading = re.match(r"\s*\[+([^\]]+)\]+", line)
        if heading:
            return heading.group(1).strip()
    return ""


def _loosened_checks(ws: Path, base: str) -> list[str]:
    """What base..HEAD (one fix turn's work) does to loosen the checks: a
    deleted test file, an added skip/only/xfail/eslint-disable line, a changed
    lint, Playwright or pytest config, a conftest.py that adds collect_ignore,
    or a pyproject.toml change inside [tool.pytest*] or [tool.ruff*]. Empty
    when it does none of these."""
    found: list[str] = []
    for path in _names(ws, f"{base}..HEAD"):
        name = path.rsplit("/", 1)[-1]
        if any(fnmatch.fnmatch(name, pattern) for pattern in _CHECK_CONFIG_FILES):
            found.append(f"changed check config {path}")
    deleted = git(ws, "diff", "--name-only", "--diff-filter=D", "--no-renames", base, "HEAD", check=False).stdout
    found += [f"deleted test file {path}" for path in deleted.splitlines() if _TEST_PATH.search(path)]
    diff = git(
        ws, "-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", base, "HEAD", check=False
    ).stdout
    path, at, toml, header = "", 0, None, False
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            path, toml, header = "", None, True
            continue
        hunk = _HUNK.match(line)
        if hunk:
            at, header = int(hunk.group(1)), False
            continue
        if header:
            # Only a file header names the path: a content line can start with "+++" too.
            if line.startswith("+++ "):
                path = line[6:] if line.startswith("+++ b/") else ""
            continue
        if not path or line[:1] not in ("+", "-"):
            continue
        name = path.rsplit("/", 1)[-1]
        if name == "pyproject.toml":
            if toml is None:
                toml = git(ws, "show", f"HEAD:{path}", check=False).stdout.splitlines()
            section = _section_at(toml, at)
            if _PYPROJECT_CHECK_SECTION.match(section):
                found.append(f"changed [{section}] in {path}")
        elif line.startswith("+") and (
            _LOOSENING_LINE.search(line) or (name == "conftest.py" and "collect_ignore" in line)
        ):
            found.append(f"{path}: added `{line[1:].strip()[:120]}`")
        if line.startswith("+"):
            at += 1
    return list(dict.fromkeys(found))[:20]


def _fail_on_checks(ws, item, branch, conflicted, exc: CheckFailure, *, checkpoint: str, lease: str, unpushed: str) -> None:
    """HZ-184: the finished work is checkpointed with what failed, so the
    next attempt fixes it instead of rebuilding it. The caller re-raises: the
    run still fails, nothing after the checks runs, no PR opens."""
    detail = "\n".join([exc.digest or str(exc), *(_recording()["branch_notes"] or [])])
    if checkpoint:
        # HZ-456: the digest sits beside the pushed commit, not in it.
        try:
            _write_precheck_state(ws, checkpoint, CAUSE_CHECKS_FAILED, detail)
        except OSError as err:
            log(f"checkpoint: could not record the check failure ({err})")
    _salvage_checkpoint(
        ws,
        item,
        branch,
        conflicted,
        cause=CAUSE_CHECKS_FAILED,
        detail=detail,
        lease_sha=lease,
        farm_commit=unpushed,
        pushed=checkpoint,
    )


class FailsOnMain(CheckFailure):
    """HZ-590: the failing tests fail on the default branch too, so the item
    did not cause them. No fix turn runs, and main() reports
    reasons.REASON["FAILS_ON_MAIN"], which the server pauses on."""


def _fails_on_main(failure: CheckFailure, verdict: base_check.BaseVerdict) -> FailsOnMain:
    """The failure, headlined with the tests that fail on main as well. Its
    own message and digest follow, for "Show details". `argv` stays behind."""
    headline = base_check.fails_on_main_headline(verdict.tests)
    return FailsOnMain(
        f"{HEADLINE_PREFIX}{headline}\n{failure}",
        failure.digest,
        command=failure.command,
        tail=failure.tail,
        reason=failure.reason,
        headline=headline,
        failed_tests=failure.failed_tests,
        slot=failure.slot,
    )


def _no_fix_reason(exc: CheckFailure, rounds: int, turns_used, max_turns: int, deadline: float) -> str:
    """Why a red check gets no fix turn, or "" when it gets one."""
    cap = _fix_loop_cap()
    if exc.command == login_env.COMMAND_LABEL:
        # HZ-494: the file lives on the farm host; no code change fixes it.
        return f"the {login_env.COMMAND_LABEL} is a host problem the agent cannot fix"
    if rounds >= cap:
        return f"{rounds} of {cap} fix turn(s) used"
    if exc.reason != "failed":
        return f"the check did not run to a result ({exc.reason})"
    if not isinstance(turns_used, int):
        # Muse reports no turns: a fix turn could overrun the step's turn cap.
        return "the provider reported no turn count, so the turn cap cannot be kept"
    if max_turns - turns_used <= 0:
        return f"all {max_turns} turns used"
    if deadline - time.monotonic() < FIX_TURN_MIN_S:
        return "too little agent time left"
    return ""


def _check_until_green(
    ws: Path,
    task: dict,
    branch: str,
    conflicted: list[str],
    prepared: PreparedBranch,
    scope: dict,
    reply: dict,
    *,
    deadline: float,
    max_turns: int,
    call_agent,
) -> CheckedWork:
    """Commits the agent's work, pushes it (HZ-456) and runs the repo checks;
    on a red check, hands its digest to the same session for a fix turn and
    goes round again. call_agent is the step's own run_agent call, taking
    (prompt, session_id=, max_turns=, timeout_s=). Returns once the checks pass. Raises the CheckFailure,
    after today's salvage, once no fix turn is left — or when a fix turn
    stops or loosens the checks."""
    item = task["item"]
    turns_used = reply.get("num_turns")
    lease, unpushed, rounds = prepared.lease_sha, "", 0
    fix_base: str | None = None
    failure: CheckFailure | None = None
    while True:
        farm_commit = commit_work(ws, item, conflicted)
        checked_sha = git(ws, "rev-parse", "HEAD").stdout.strip()
        if fix_base is not None and failure is not None:
            loosened = _loosened_checks(ws, fix_base)
            if loosened:
                # Drops HZ-590's failed_tests/argv/slot: they are only read
                # before the first fix turn, and this is after one.
                log(f"fix loop: the fix turn loosened the checks — {'; '.join(loosened)}")
                failure = CheckFailure(
                    str(failure),
                    "\n".join(
                        [failure.digest or str(failure), "", "The fix turn loosened the checks, so it was not checked:", *loosened]
                    ),
                    command=failure.command,
                    tail=failure.tail,
                    reason=failure.reason,
                    headline=failure.headline,
                )
                _fail_on_checks(
                    ws, item, branch, conflicted, failure, checkpoint="", lease=lease, unpushed=farm_commit or unpushed
                )
                raise failure
        # HZ-257: the tree the checks are about to test, so the pushed commit
        # can be named as the sha that passed — only if identical.
        checked_tree = check_record.snapshot_tree(ws, log)
        # HZ-456: a step killed mid-check (time limit, farm restart) runs no
        # handler, so the work is pushed to the item's branch first. Once it
        # is, every later push of this run leases against it, and the farm
        # commit is published — never amended or replaced.
        checkpoint = _push_precheck_checkpoint(ws, item, branch, prepared, scope, lease_sha=lease)
        lease = checkpoint or lease
        unpushed = "" if checkpoint else (farm_commit or unpushed)
        # The server pauses the step clock for exactly this window, slot wait
        # included, and the farm's own agent deadline moves by the same span.
        _notify_checks(task.get("run_id"), "start")
        began = time.monotonic()
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
                    # HZ-494: a path from the server; the file is read now.
                    test_env_file=task.get("test_env_file"),
                    # HZ-506: the farm's runner captures a configured repo's
                    # screens here only (never pre-merge, validate or conflicts).
                    capture_screenshots=True,
                    # HZ-327: flakes and per-test results ride on the result.
                    **_recording(),
                )
            return CheckedWork(checked_sha, checked_tree, check_note, check_record.now_iso(), lease, rounds)
        except pause.PauseRequested:
            # HZ-194: the agent's work is finished but unchecked. The checks
            # are stopped and never count as a failure; the code is saved.
            pause.report(*_pause_checkpoint(ws, item, branch, conflicted, lease, scope, unpushed))
            raise
        except CheckFailure as exc:
            failure = exc
        finally:
            deadline += time.monotonic() - began
            _notify_checks(task.get("run_id"), "end")
        why_not = _no_fix_reason(failure, rounds, turns_used, max_turns, deadline)
        if why_not:
            log(f"fix loop: no fix turn — {why_not}")
            _fail_on_checks(ws, item, branch, conflicted, failure, checkpoint=checkpoint, lease=lease, unpushed=unpushed)
            raise failure
        skipped = base_check.skip_reason(failure) if rounds == 0 else "not the first fix turn"
        if rounds == 0 and skipped:
            log(f"base check: skipped — {skipped}")
        if not skipped:
            # HZ-590: before the first fix turn, the failing tests run once on
            # the default branch. Check time like the checks', not agent time.
            _notify_checks(task.get("run_id"), "start")
            began = time.monotonic()
            try:
                with pause.interruptible():
                    on_base = base_check.check_on_base(
                        item["repo"],
                        item["id"],
                        failure,
                        item_ws=ws,
                        configured=task.get("check_commands"),
                        test_env_file=task.get("test_env_file"),
                        deadline=deadline,
                        log=log,
                    )
            except pause.PauseRequested:
                pause.report(*_pause_checkpoint(ws, item, branch, conflicted, lease, scope, unpushed))
                raise
            finally:
                deadline += time.monotonic() - began
                _notify_checks(task.get("run_id"), "end")
            log(f"base check: {on_base.verdict} — {on_base.detail}")
            if on_base.verdict == base_check.FAILS_ON_MAIN:
                failure = _fails_on_main(failure, on_base)
                log(f"fix loop: no fix turn — {failure.headline}")
                _fail_on_checks(ws, item, branch, conflicted, failure, checkpoint=checkpoint, lease=lease, unpushed=unpushed)
                raise failure
        detail = "\n".join([failure.digest or str(failure), *(_recording()["branch_notes"] or [])])
        fix_base = checked_sha
        log(f"fix loop: fix turn {rounds + 1} of {_fix_loop_cap()} — handing the check failure back to the agent")
        try:
            with pause.interruptible():
                fixed = call_agent(
                    _fix_turn_prompt(item, detail),
                    session_id=reply.get("session_id"),
                    max_turns=max_turns - turns_used,
                    timeout_s=int(deadline - time.monotonic()),
                )
        except pause.PauseRequested as exc:
            if not exc.at_entry:
                pause.report(*_pause_checkpoint(ws, item, branch, conflicted, lease, scope, unpushed))
            raise
        except Exception as exc:
            # The fix turn ran out of turns or time, or crashed: the attempt
            # fails on the check it was fixing, its work checkpointed.
            log(f"fix loop: the fix turn stopped ({exc}) — failing on the check")
            _fail_on_checks(ws, item, branch, conflicted, failure, checkpoint=checkpoint, lease=lease, unpushed=unpushed)
            raise failure from exc
        rounds += 1
        reply = {**reply, "session_id": fixed.get("session_id") or reply.get("session_id")}
        used = fixed.get("num_turns")
        turns_used = turns_used + used if isinstance(used, int) else None


def _execute(task: dict, guard: HandoffGuard) -> dict:
    label = task["step"]["label"]
    item = task["item"]
    # HZ-383: the item's kind, then the label, picks the runner — never the
    # label alone, and never the index.
    kind = item_kind(item)
    role_file, wants_artifact, tools, persona_agent = _step_config(kind, label, item_lane(item))
    table = steps.FARM_VIEWS[kind]
    max_turns, timeout_s = steps.budget_for_label(table, label)
    provider_locked = steps.provider_locked_for(table, label)
    role = (ROLES / role_file).read_text()
    personas = item_personas(item)
    # HZ-535: the project's own personas, or None (switch off, no file), which
    # leaves every call below on the global registry exactly.
    overlay = project_overlay(task.get("project"))
    if persona_agent:
        role = compose_role(role, persona_agent, personas.get(persona_agent), overlay)
    # HZ-357: the owner's per-step choice wins over the persona map, which wins
    # over FARM_PROVIDER (run_agent's default). Neither applies to a step that
    # isn't provider_override_eligible, so deploy stays locked. HZ-369: a
    # CHOICE_ONLY_PROVIDER_STEPS step takes the choice alone, and implement
    # with no choice is locked exactly as before.
    override_eligible = steps.provider_override_eligible(table, label)
    choice = step_provider_choice(item, task["step"].get("index")) if override_eligible else None
    # HZ-398: the model half of the choice reaches run_agent() as model_choice
    # and only _model_for() turns it into a model. A persona's provider never
    # carries one.
    chosen_provider, model_choice = choice or (None, None)
    if kind == "change" and label in CHOICE_ONLY_PROVIDER_STEPS:
        provider_override = chosen_provider
        if label == IMPLEMENT_LABEL and choice is None:
            provider_locked = True
    else:
        provider_override = (chosen_provider or provider_for(personas, overlay)) if override_eligible else None
    # HZ-192: who this step's run_agent() calls are; run_agent() resolves the
    # model from these, so it is never chosen here. The agent comes from the
    # step table, like the budget above, not from the task payload.
    model_agent = model_agent_for_step(steps.by_kind_label(kind, label)["agent"])
    persona = model_persona(persona_agent, personas, overlay)
    # HZ-536: the composed project persona's allow-listed tools join the
    # step's fixed string, and its venvs are denied every write. With no
    # overlay (switch off, no project personas), no persona, no tools, or a
    # step without bare Bash, `tools` is unchanged and persona_deny is None.
    tools, persona_deny = apply_persona_tools(
        tools, resolve(persona_agent, personas.get(persona_agent), overlay) if persona_agent else None, overlay
    )

    # HZ-447: a bundle step reads no worktree, so none is set up for it.
    bundle_step = _reads_bundle(kind, label)
    ws = None
    if item.get("repo") and not bundle_step:
        try:
            ws = ensure_item_worktree(item["repo"], item["id"])
        except RuntimeError:
            # Hub not provisioned for this repo (e.g. farm never started
            # cleanly against it) — same "no workspace" fallback as before.
            ws = None
    # HZ-379: a step that waited for its spawned code runs on the deployed
    # commit the server names. Checked out here, before the read-only guard
    # below takes its baseline, so the checkout is never read as a violation.
    # execute() already holds item_lock for a read-only step.
    if ws is not None and isinstance(task.get("checkout_sha"), str) and task["checkout_sha"]:
        checkout_detached(item["repo"], item["id"], task["checkout_sha"])
        log(f"workspace {ws} checked out at {task['checkout_sha'][:12]} (the deployed code it waited for)")

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

        # HZ-458: a fix turn after a red check is the same call, resumed.
        def call_agent(prompt: str, *, session_id: str | None, max_turns: int, timeout_s: int) -> dict:
            return run_agent(
                prompt,
                agent=model_agent,
                step=label,
                persona=persona,
                session_id=session_id,
                append_system=role,
                cwd=str(ws),
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=tools,
                provider=provider_override,
                model_choice=model_choice,
                provider_locked=provider_locked,
                disallowed_tools=persona_deny,
                overlay=overlay,
            )

        try:
            with pause.interruptible():
                reply = call_agent(build_prompt(task) + extra, session_id=None, max_turns=max_turns, timeout_s=timeout_s)
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
        # script, on the agent's work committed locally (HZ-438: a check may
        # read `git status`) and before anything is pushed. A failure fails
        # the run (Node pauses the item with the reason) — no green, no push.
        # HZ-458: a red check first goes back to the same agent session, up to
        # FARM_FIX_LOOP_CAP times, and the checks re-run on its fix.
        checked_sha, checked_tree, check_note, checks_finished_at, lease, fix_loops = _check_until_green(
            ws,
            task,
            branch,
            conflicted,
            prepared,
            scope,
            reply,
            deadline=deadline,
            max_turns=max_turns,
            call_agent=call_agent,
        )
        publish_screenshots(ws, item)
        artifacts = finalize_branch(ws, item, branch, conflicted, lease_sha=lease, checked_sha=checked_sha)
        artifacts.update(check_record.report_fields(ws, checked_tree, check_note, checks_finished_at, log))
        if scope["mode"] == "fix":
            artifacts.update(fix_diff_report(ws, scope.get("base_sha")))
        if manual_checks:
            artifacts["manual_checks"] = manual_checks
        # HZ-546: the pushed HEAD this run's references cite.
        if shas := pushed_head(ws, item["repo"]):
            artifacts["source_shas"] = shas
        # HZ-369: what ran, like the generic path below, so step_run.provider
        # is set for implement too.
        if override_eligible and reply.get("provider"):
            artifacts.update(_provenance(reply))
        # finalize_branch returns branch/files_changed, not an artifact_md, so
        # the summary is this path's only note surface.
        # HZ-349: the branch run's lines join the summary (step 12 reads it)
        # but never check_note, whose exact text check_record reads. The
        # agent's own text is cut first, so those lines are what survives.
        loops = [f"fix loops: {fix_loops}"] if fix_loops else []
        # HZ-505: the screenshots slot's line (summary_notes) joins it too.
        recording = _recording()
        notes_after = [*(recording["branch_notes"] or []), *(recording.get("summary_notes") or [])]
        checked = " · ".join([check_note, *notes_after, *loops])
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
        default = default_branch(ws)
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
        # HZ-420: display-only calls, so core.quotePath=false shows a file
        # name's bytes (U+FFFD where they aren't UTF-8) rather than octal.
        # Never on a call whose output goes back to git.
        commits = git(
            ws, "log", "-n", str(REVIEW_COMMITS_MAX), "--format=%h %s", review_diff.commit_range(rev_range), check=False
        ).stdout.strip()
        diff_stat = git(ws, "-c", "core.quotePath=false", "diff", "--stat", rev_range, check=False).stdout.strip()
        # Bytes, decided per file: a file that is binary to git, or whose own
        # diff isn't UTF-8, becomes one `binary file changed` line.
        diff_full = review_diff.build(ws, rev_range, git_bytes, log=log)
        diff_text, diff_note = truncate_diff(diff_full)
        diff_section = (
            f"## Commits under review\n\n```\n{commits}\n```\n\n"
            f"## Code diff under review\n\n```\n{diff_stat}\n```\n\n```diff\n{diff_text}\n```{diff_note}"
        )
        prompt = (
            build_prompt(task)
            + "\n\n"
            + delta_section
            + diff_section
            + "\n\nRespond with ONLY the JSON object described in your role instructions."
        )

        # HZ-387: each review pass is read-only, though the step itself is
        # workspaceMutating — so each is guarded on its own, after
        # prepare_branch's scrub, not through READ_ONLY_LABELS.
        with read_only_guard.guard(ws, effective_provider(provider_override)) as watch:
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
                model_choice=model_choice,
                provider_locked=provider_locked,
                overlay=overlay,
            )
            watch.provider = code_provenance.get("provider") or watch.provider

        # The item's QA persona, never the Eng one the code pass above used
        # (HZ-125): a reviewer wearing the implementer's specialization reviews
        # the work as the engineer who wrote it.
        qa_role = (ROLES / "qa_review.md").read_text()
        qa_role = compose_role(qa_role, REVIEW_QA_PERSONA_AGENT, personas.get(REVIEW_QA_PERSONA_AGENT), overlay)
        with read_only_guard.guard(ws, effective_provider(provider_override)) as watch:
            qa_parsed, qa_provenance, qa_notes = _run_and_parse(
                prompt,
                agent=model_agent,
                step=label,
                persona=model_persona(REVIEW_QA_PERSONA_AGENT, personas, overlay),
                append_system=qa_role,
                cwd=str(ws),
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=tools,
                required_keys=("verdict",),
                item_id=item["id"],
                guard=guard,
                provider=provider_override,
                model_choice=model_choice,
                provider_locked=provider_locked,
                overlay=overlay,
            )
            watch.provider = qa_provenance.get("provider") or watch.provider

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
        if shas := pushed_head(ws, item["repo"]):
            review_artifacts["source_shas"] = shas
        # HZ-369: what ran, from the code pass (the QA pass matched it above).
        if override_eligible and code_ran_on:
            review_artifacts["provider"] = code_ran_on
            if code_provenance.get("model"):
                review_artifacts["model"] = code_provenance["model"]
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
            disallowed_tools=persona_deny,
        )
        summary = str(parsed.get("summary", "")).strip()[:SUMMARY_MAX_CHARS] or "deploy verification finished"
        artifact_md = str(parsed.get("artifact_md", "")).strip()

        if grpc_url:
            verdict, smoke_line = run_grpc_health_check(grpc_url)
        else:
            url, expected_text = parsed.get("url"), parsed.get("expected_text")
            if not isinstance(url, str) or not url.strip() or not isinstance(expected_text, str) or not expected_text.strip():
                raise AgentError("devops reply missing 'url'/'expected_text' needed for deep verification")
            # HZ-494: the repo's test-login env file, only when one is set.
            login = {"test_env_file": task["test_env_file"]} if task.get("test_env_file") else {}
            verdict, smoke_line = run_smoke_check(url.strip(), expected_text.strip(), **login)
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

    # HZ-387: a read-only step must leave the worktree as it found it.
    read_only_ws = ws if _is_read_only(kind, label) else None
    # HZ-383: a Task step (HZ-446: and a Plan step) is held to its read-only
    # tools even with no workspace, where a change step runs with no
    # allowlist at all.
    allowed_tools = tools if ws or kind in TOOLS_WITHOUT_WORKSPACE_KINDS else None
    disallowed_tools, cwd, prompt_extra = persona_deny, str(ws) if ws else None, ""
    # HZ-447: a bundle step reads every in-scope repo from a read-only copy,
    # held to the copy's tool rules, guarded over the copy and every hub, with
    # its run log scrubbed. Its errors are scrubbed too, and the copy is
    # always removed.
    bundle, out_of_scope, scope = None, [], []
    try:
        with contextlib.ExitStack() as stack:
            if bundle_step:
                entries, out_of_scope = plan_bundle.parse_scope(task.get("plan_scope"))
                scope = [entry["repo"] for entry in entries]
                stack.enter_context(plan_bundle.scrubbed_stdout(out_of_scope))
            validate = _reply_validator(kind, label, task, scope)
            if bundle_step:
                bundle = plan_bundle.build(item["id"], task.get("plan_scope"))
                (allowed_tools, disallowed_tools), cwd = plan_bundle.tool_rules(bundle), str(bundle.root)
                prompt_extra = _bundle_section(bundle)
                watch = stack.enter_context(plan_bundle.guard(bundle, effective_provider(provider_override)))
            else:
                watch = stack.enter_context(read_only_guard.guard(read_only_ws, effective_provider(provider_override)))
            parsed, reply_provenance, notes = _run_and_parse(
                build_prompt(task) + prompt_extra + "\n\nRespond with ONLY the JSON object described in your role instructions.",
                agent=model_agent,
                step=label,
                persona=persona,
                append_system=role,
                cwd=cwd,
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=allowed_tools,
                required_keys=("summary", "artifact_md") if wants_artifact else ("summary",),
                item_id=item["id"],
                guard=guard,
                provider=provider_override,
                model_choice=model_choice,
                provider_locked=provider_locked,
                validate=validate,
                disallowed_tools=disallowed_tools,
                recheck=_requires_recheck(kind, label, task),
                overlay=overlay,
            )
            watch.provider = reply_provenance.get("provider") or watch.provider
        leaks = plan_bundle.leaked_paths(json.dumps(parsed, ensure_ascii=False), bundle) if bundle else []
        if leaks:
            raise ReadOnlyViolation(
                f"Plan scope violated: the reply names {', '.join(leaks)} — nothing was stored", rolled_back=True
            )
    except Exception as exc:
        if bundle_step:
            exc.args = (plan_bundle.scrub(str(exc), out_of_scope),)
        raise
    finally:
        if bundle:
            plan_bundle.remove(bundle)
    summary = str(parsed.get("summary", "")).strip()
    summary = (plan_bundle.scrub(summary, out_of_scope) if bundle_step else summary)[:SUMMARY_MAX_CHARS]
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
        # HZ-383: the validated block rides at the end of the artifact, where
        # HZ-378's Execute reads it back with run_plan.extract().
        if kind == "task" and label == RUN_PLAN_LABEL:
            artifact = f"{artifact}\n\n## Run plan block\n{run_plan.render(parsed['run_plan'])}"
        # HZ-447: Design reads the validated Inventory block back from here.
        if bundle_step and label == PLAN_INVENTORY_LABEL:
            artifact = f"{artifact}\n\n## Inventory block\n{plan_inventory.render(parsed['inventory'])}"
        if bundle_step:
            artifact = plan_bundle.scrub(artifact, out_of_scope)
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
        if reply_provenance.get("model"):
            artifacts["model"] = reply_provenance["model"]
        artifacts["command_id"] = reply_provenance.get("command_id")
    # HZ-313: the Ensemble's optional cross-repo split rides through untouched.
    # The server (server/src/split.js) validates it and files nothing until
    # gate 5 is approved; any other step's or shape's `split` is dropped.
    if label == SPLIT_STEP_LABEL and isinstance(parsed.get("split"), dict):
        result.setdefault("artifacts", {})["split"] = parsed["split"]
    # HZ-379: a step whose row names a `spawnsOn` field passes that field
    # through untouched; the server (server/src/spawn.js) validates it and
    # files the item. Any other step's, or a non-object, is dropped.
    spawn_field = _spawn_field(kind, label)
    if spawn_field and isinstance(parsed.get(spawn_field), dict):
        result.setdefault("artifacts", {})[spawn_field] = parsed[spawn_field]
    # HZ-429: Verify & report's verdict ({verdict, summary}) rides through so
    # the server can record it (orchestrator.normalizeVerifyVerdict). Any
    # other Task step's `verdict` is dropped.
    if label == VERIFY_REPORT_LABEL and isinstance(parsed.get("verdict"), dict):
        result.setdefault("artifacts", {})["verdict"] = parsed["verdict"]
    # HZ-448: the validated drafts ride through; the server re-checks them,
    # saves them as the Plan's draft and files nothing.
    if label == PLAN_DRAFT_LABEL:
        result.setdefault("artifacts", {})["plan_draft"] = parsed["plan_draft"]
    # HZ-463: the validated coverage review rides through; the server
    # re-checks every claim and decides the findings.
    if label == PLAN_COVERAGE_REVIEW_LABEL:
        result.setdefault("artifacts", {})["plan_review"] = parsed["plan_review"]
    # HZ-546: the commit of each repo the step read — a bundle step's export
    # shas, else the workspace's HEAD once origin has it — so the UI links the
    # artifact's code references there. Nothing when there is neither.
    shas = dict(bundle.shas) if bundle else pushed_head(ws, item["repo"]) if ws is not None else {}
    if shas:
        result.setdefault("artifacts", {})["source_shas"] = shas
    return result


def _bundle_section(bundle: plan_bundle.Bundle) -> str:
    """HZ-447: where each in-scope repo is in the bundle."""
    lines = [
        "",
        "",
        "## Repos in this Plan's scope",
        f"Your working directory is `{bundle.root}`. You may read only inside it.",
    ]
    for repo, branch in bundle.branches.items():
        folder = repo.replace("/", "__")
        lines.append(f"- `{repo}`: files at `{folder}/` ({branch}); branches, tags and its last check in `_refs/{folder}`")
    return "\n".join(lines)


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
# never ride on the result; so do HZ-505's summary_notes.
_RECORDED: contextvars.ContextVar[dict | None] = contextvars.ContextVar("step_recorded", default=None)


def _recording() -> dict:
    """run_checks()'s flakes/test_runs/branch_notes (and, from main(),
    summary_notes) arguments for this run."""
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


def _bad_byte(exc: UnicodeDecodeError) -> str:
    data = exc.object
    if isinstance(data, (bytes, bytearray)) and 0 <= exc.start < len(data):
        return f"byte 0x{data[exc.start]:02x} at position {exc.start}"
    return f"position {exc.start}"


def _attach_usage(result: dict, meter) -> None:
    """HZ-550: artifacts.usage for the server's step_run columns, and the
    provider and model of a step that did not name them (Deploy, the Task and
    Plan steps) — from the run's last call, so after a fallback it is the
    provider that actually ran. Never raises and logs nothing: capture must
    not change the result it rides on."""
    try:
        usage = meter.report()
        ran = meter.last_ran()
        artifacts = result.get("artifacts")
        if not isinstance(artifacts, dict):
            artifacts = {}
        artifacts = {**artifacts, "usage": usage}
        if ran and not artifacts.get("provider"):
            artifacts["provider"] = ran[0]
            if ran[1]:
                artifacts["model"] = ran[1]
        result["artifacts"] = artifacts
    except Exception:
        pass


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

    recorded = {"flakes": [], "test_runs": [], "branch_notes": [], "summary_notes": []}
    token = _RECORDED.set(recorded)
    try:
        log(f"run {run_id}: {task['step']['label']} for {task['item']['id']}")
        # HZ-550: the run's usage, summed over every agent call execute() makes.
        with usage_meter() as meter:
            outcome = execute(task)
        result = {"run_id": run_id, "ok": True, **outcome}
        _attach_usage(result, meter)
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
        error = str(exc)
        if isinstance(exc, UnicodeDecodeError):
            # HZ-420: the last resort for output nobody decoded safely — name
            # the step and the byte, never Python's bare codec message.
            error = f"{task['step'].get('label', 'step')}: output isn't valid UTF-8 ({_bad_byte(exc)})"
        log(f"run {run_id}: FAILED — {error}")
        result = {"run_id": run_id, "ok": False, "error": error[:ERROR_MAX_CHARS]}
        # HZ-76: tag the one failure cause the orchestrator is willing to
        # auto-retry from this side (running out of turn budget) — anything
        # else (a checks failure, a malformed reply, ...) reports no reason
        # and the server pauses for a human exactly as before.
        if isinstance(exc, AgentExhaustedError):
            result["reason"] = reasons.REASON["TURN_CAP"]
        # HZ-387: non-retryable, so the item pauses and no next step runs.
        elif isinstance(exc, ReadOnlyViolation):
            result["reason"] = reasons.REASON["READ_ONLY_VIOLATED"]
        # HZ-590: non-retryable — main must be fixed first, so the item pauses.
        elif isinstance(exc, FailsOnMain):
            result["reason"] = reasons.REASON["FAILS_ON_MAIN"]
        # HZ-424: retryable — the next attempt runs with the same higher cap.
        elif isinstance(exc, AgentMessageTooLargeError):
            result["reason"] = reasons.REASON["SDK_MESSAGE_TOO_LARGE"]
        # HZ-422: retryable without using an attempt — the server re-runs the
        # step on the next model in the fallback chain, or waits for the reset.
        elif isinstance(exc, AgentUsageLimitedError):
            result["reason"] = reasons.REASON["USAGE_LIMITED"]
            result.update({key: getattr(exc, key) for key in ("reset_at", "provider", "model") if getattr(exc, key)})
    finally:
        _RECORDED.reset(token)
    # A flake on one command survives a real failure on a later one.
    result.update({key: value for key, value in recorded.items() if value and key not in ("branch_notes", "summary_notes")})

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
