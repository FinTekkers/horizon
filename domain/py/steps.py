"""The farm's one view of "what is a lifecycle step" (HZ-117, relocated by
HZ-128, hand-written since HZ-139).

This module READS domain/steps.json — the only place a step is declared — at
import, so it never hand-duplicates a second table. Every farm module that used
to hardcode a step index -> (budget | provider rule | lane | workspace-mutating)
mapping (farm/step_agent.py's STEP_CONFIG/PROVIDER_OVERRIDE_ELIGIBLE_STEPS,
farm/farmd.py's WORKSPACE_MUTATING_STEPS and lane routing) reads it from here.

STEPS is the farm-shaped projection of the authored table: agent-kind entries
ONLY (both the PM lane and the farm lane — farmd's /steps/run needs runsIn for
both to route correctly), each carrying its own `index` into the full table.
The farm-only fields are None on runsIn 'pm' entries, which never reach
step_agent.py's budget/provider lookups. Gates are absent entirely: the farm
never dispatches one. domain/js/lifecycle.js ships the AUTHORED shape instead —
the difference is deliberate and pinned by
server/test/domain-binding-hygiene.test.mjs.

_SOURCE_PATH is derived from __file__, never from the process's cwd: farm
agents run inside workspace clones, not from the repo root
(farm/tests/test_domain_import.py asserts that).

The derivation functions (budget_for_label, provider_override_eligible,
provider_locked_for) take `steps` as their first argument rather than reading
the module-level STEPS global internally — that's what lets a test fabricate a
step table (e.g. with an inserted step) and assert the derivation follows it,
with zero literal indices in the test itself.
"""

import json
from pathlib import Path

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "steps.json"


def _validate_source(data: object, source: str) -> dict:
    """Shape, cross-field and duplicate-label enforcement for the AUTHORED
    document, applied at import time AND to anything _load_source reads off
    disk. Raises rather than returning a partly-usable table: a duplicate label
    would make _find_by_label silently resolve to whichever entry came first,
    and a phase past the end of `phases` renders as `undefined` in the UI.

    The rules and the message fragments are kept word-for-word in step with
    domain/js/lifecycle.js's assertLifecycleShape — domain/fixtures/
    lifecycle-cases.json drives both, so the two cannot drift apart silently."""
    if not isinstance(data, dict):
        raise RuntimeError(f"domain/py/steps.py: {source} must be a JSON object with phases and steps")
    phases = data.get("phases")
    steps = data.get("steps")
    if (
        not isinstance(phases, list)
        or not phases
        or not all(isinstance(p, str) and p for p in phases)
    ):
        raise RuntimeError(
            f"domain/py/steps.py: {source}: phases must be a non-empty array of non-empty strings"
        )
    if not isinstance(steps, list) or not steps:
        raise RuntimeError(
            f"domain/py/steps.py: {source}: steps must be a non-empty JSON array of step objects"
        )
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            raise RuntimeError(
                f"domain/py/steps.py: {source}: steps must be a non-empty JSON array of step objects"
            )
        phase = step.get("phase")
        # bool is an int subclass in Python; a `"phase": true` must not pass.
        if not isinstance(phase, int) or isinstance(phase, bool) or phase < 0:
            raise RuntimeError(
                f'domain/py/steps.py: {source}: steps[{i}] ("{step.get("label")}") '
                "declares a non-integer or negative phase"
            )
        if step.get("kind") not in ("agent", "gate"):
            raise RuntimeError(
                f'domain/py/steps.py: {source}: steps[{i}] ("{step.get("label")}") declares kind '
                f'"{step.get("kind")}" — expected "agent" or "gate"'
            )
        if not isinstance(step.get("label"), str) or not step["label"]:
            raise RuntimeError(f"domain/py/steps.py: {source}: steps[{i}] has no label")

    labels = [step["label"] for step in steps]
    dupes = {label for label in labels if labels.count(label) > 1}
    if dupes:
        raise RuntimeError(f"domain/py/steps.py: {source} has duplicate step label(s): {sorted(dupes)}")
    for i, step in enumerate(steps):
        if step["phase"] >= len(phases):
            raise RuntimeError(
                f'domain/py/steps.py: {source}: steps[{i}] ("{step["label"]}") declares phase '
                f"{step['phase']}, but only {len(phases)} phase(s) exist"
            )
    return data


def _load_source(path: Path) -> dict:
    """Reads the authored step document off disk and validates it. This is how
    the production table below is built — not a test-only helper."""
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(f"domain/py/steps.py: could not read {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"domain/py/steps.py: {path} is not valid JSON ({exc})") from exc
    return _validate_source(data, str(path))


def _project_farm_view(steps: list[dict]) -> list[dict]:
    """Farm-shaped view of the authored table: every agent-kind step (both the
    PM lane and the farm lane — farmd's /steps/run needs runsIn for BOTH to
    route correctly), with every field this module needs to derive lane
    routing, budgets and provider rules. The farm-only fields are None on
    runsIn 'pm' entries, which never reach step_agent.py's budget/provider
    lookups. `requires` is deliberately dropped: it gates a server-side
    dispatch decision, never a farm one."""
    return [
        {
            "index": index,
            "label": step["label"],
            "agent": step.get("agent"),
            "runsIn": step.get("runsIn"),
            "workspaceMutating": step.get("workspaceMutating"),
            "providerOverrideEligible": step.get("providerOverrideEligible"),
            "providerLocked": step.get("providerLocked"),
            "maxTurns": step.get("maxTurns"),
            "timeoutS": step.get("timeoutS"),
        }
        for index, step in enumerate(steps)
        if step.get("kind") == "agent"
    ]


_SOURCE: dict = _load_source(_SOURCE_PATH)

PHASES: list[str] = _SOURCE["phases"]
STEPS: list[dict] = _project_farm_view(_SOURCE["steps"])

# Safe .get()-only lookup — farmd's dispatch loop reads task payloads off the
# network and must never raise on an unknown/stale index.
STEP_BY_INDEX: dict[int, dict] = {entry["index"]: entry for entry in STEPS}


def _find_by_label(steps: list[dict], label: str) -> dict:
    """The one step entry with this label. Raises KeyError naming the label
    (never returns a wrong/blank result) if it isn't in the table — e.g. the
    label was renamed on one side of the JS/Python boundary but not the
    other."""
    for entry in steps:
        if entry["label"] == label:
            return entry
    raise KeyError(f"no step labeled {label!r} in the step table")


def by_label(label: str) -> dict:
    """Convenience wrapper over the module's own STEPS — real call sites use
    this; tests that need a fabricated table call the pure functions below
    directly with their own `steps` list instead."""
    return _find_by_label(STEPS, label)


def budget_for_label(steps: list[dict], label: str) -> tuple[int, int]:
    """(max_turns, timeout_s) for a farm-run step."""
    entry = _find_by_label(steps, label)
    return entry["maxTurns"], entry["timeoutS"]


def provider_override_eligible(steps: list[dict], label: str) -> bool:
    """Whether a persona-forced provider override (farm/personas.py's
    provider_for()) is honored for this step. HZ-102 guardrail: this must be
    False for implement/deploy no matter what a persona maps to — enforced
    here by construction (their table entries carry providerOverrideEligible:
    false), not by a separate allowlist that could drift from STEPS."""
    return bool(_find_by_label(steps, label)["providerOverrideEligible"])


def provider_locked_for(steps: list[dict], label: str) -> bool:
    """Whether this step must refuse ANY non-default provider, including a
    bare FARM_PROVIDER env override — closes the hole a persona-only check
    would miss. Passed into every run_agent() call the step makes."""
    return bool(_find_by_label(steps, label)["providerLocked"])
