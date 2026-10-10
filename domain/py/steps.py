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
    # Per-kind phase lists (HZ-377). Optional, so a minimal table without
    # `kinds` still validates as one kind; when present, the change list must
    # mirror the top-level one rather than drift from it.
    kinds = data.get("kinds")
    if kinds is None:
        kinds = {"change": {"phases": phases}}
    if not isinstance(kinds, dict):
        raise RuntimeError(
            f"domain/py/steps.py: {source}: kinds must be a JSON object mapping each item kind to its phases"
        )
    for kind, entry in kinds.items():
        kind_phases = entry.get("phases") if isinstance(entry, dict) else None
        if (
            not isinstance(kind_phases, list)
            or not kind_phases
            or not all(isinstance(p, str) and p for p in kind_phases)
        ):
            raise RuntimeError(
                f"domain/py/steps.py: {source}: kinds.{kind}.phases must be a non-empty array of non-empty strings"
            )
        # HZ-382: the kind's display copy. Optional, but never blank when present.
        for field in ("label", "description"):
            if field in entry and not (isinstance(entry[field], str) and entry[field]):
                raise RuntimeError(f"domain/py/steps.py: {source}: kinds.{kind}.{field} must be a non-empty string")
    if "change" in kinds and kinds["change"]["phases"] != phases:
        raise RuntimeError(f"domain/py/steps.py: {source}: kinds.change.phases must equal the top-level phases")
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
        item_kind = step.get("itemKind")
        if item_kind is None:
            item_kind = "change"
        if not isinstance(item_kind, str) or item_kind not in kinds:
            raise RuntimeError(
                f'domain/py/steps.py: {source}: steps[{i}] ("{step.get("label")}") '
                f'names unknown item kind "{item_kind}"'
            )

    # Both cross-field rules below are per item kind: two kinds may open with
    # the same row, and each kind numbers its own phases.
    seen = set()
    dupes = set()
    for step in steps:
        item_kind = step.get("itemKind")
        if item_kind is None:
            item_kind = "change"
        key = (item_kind, step["label"])
        if key in seen:
            dupes.add(step["label"])
        else:
            seen.add(key)
    if dupes:
        raise RuntimeError(f"domain/py/steps.py: {source} has duplicate step label(s): {sorted(dupes)}")
    for i, step in enumerate(steps):
        item_kind = step.get("itemKind")
        if item_kind is None:
            item_kind = "change"
        kind_phases = kinds[item_kind]["phases"]
        if step["phase"] >= len(kind_phases):
            raise RuntimeError(
                f'domain/py/steps.py: {source}: steps[{i}] ("{step["label"]}") declares phase '
                f"{step['phase']}, but only {len(kind_phases)} phase(s) exist"
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


def _step_kind(step: dict) -> str:
    """The item kind a step row belongs to. A missing marker means `change`,
    so the untagged rows stay byte-identical to the one-kind table."""
    item_kind = step.get("itemKind")
    return item_kind if item_kind is not None else "change"


def _project_farm_view(steps: list[dict], kind: str = "change") -> list[dict]:
    """Farm-shaped view of the authored table: every agent-kind step on a real
    lane (the PM lane, the farm lane and the job lane — farmd's /steps/run
    needs runsIn for all three to route correctly), with every field this
    module needs to derive lane routing, budgets and provider rules. The
    farm-only fields are None on runsIn 'pm' entries, which never reach
    step_agent.py's budget lookups — except providerOverrideEligible, which a
    PM step may declare (HZ-370). They are None on runsIn 'job' entries too
    (HZ-378 forbids agent budgets there). `requires` is deliberately dropped:
    it gates a server-side dispatch decision, never a farm one. runsIn 'none'
    rows are dropped too (HZ-377): a step with no runner is dispatched by no
    lane, so the farm never sees it.

    HZ-383: one item kind's rows only, `change` by default. Two kinds may share
    a label, so a view mixing them would let a label lookup resolve to the
    other kind's row; each kind gets its own view instead (FARM_VIEWS)."""
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
        if step.get("kind") == "agent" and step.get("runsIn") != "none" and _step_kind(step) == kind
    ]


_SOURCE: dict = _load_source(_SOURCE_PATH)

_KINDS: dict = _SOURCE.get("kinds") or {"change": {"phases": _SOURCE["phases"]}}

PHASES: list[str] = _SOURCE["phases"]
STEPS: list[dict] = _project_farm_view(_SOURCE["steps"])
# HZ-383: every kind's farm view, STEPS (the `change` one) included. A kind
# with no farm-run rows gets an empty view, never a missing key.
FARM_VIEWS: dict[str, list[dict]] = {
    kind: STEPS if kind == "change" else _project_farm_view(_SOURCE["steps"], kind) for kind in _KINDS
}


def _assert_item_kind(kind: str) -> None:
    if not isinstance(kind, str) or kind not in _KINDS:
        expected = ", ".join(_KINDS)
        raise KeyError(f"unknown item kind {kind!r} — expected one of {expected}")


def phases_for(kind: str = "change") -> list[str]:
    """That item kind's phase list, in order."""
    _assert_item_kind(kind)
    return _KINDS[kind]["phases"]


def steps_for(kind: str = "change") -> list[dict]:
    """That item kind's authored rows, each carrying its global `index` — the
    cursor value that points at it."""
    _assert_item_kind(kind)
    return [
        {**step, "index": index}
        for index, step in enumerate(_SOURCE["steps"])
        if _step_kind(step) == kind
    ]


def first_step_index(kind: str = "change") -> int:
    """The global index of that item kind's first row."""
    _assert_item_kind(kind)
    for index, step in enumerate(_SOURCE["steps"]):
        if _step_kind(step) == kind:
            return index
    raise KeyError(f"item kind {kind!r} has no steps in domain/steps.json")

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
    False for deploy no matter what a persona maps to — enforced here by
    construction (its table entry carries providerOverrideEligible: false),
    not by a separate allowlist that could drift from STEPS. HZ-369: QA plan
    review, implement and review are eligible, but follow only the owner's
    choice (farm/step_agent.py's CHOICE_ONLY_PROVIDER_STEPS)."""
    return bool(_find_by_label(steps, label)["providerOverrideEligible"])


def provider_locked_for(steps: list[dict], label: str) -> bool:
    """Whether this step must refuse ANY non-default provider, including a
    bare FARM_PROVIDER env override — closes the hole a persona-only check
    would miss. Passed into every run_agent() call the step makes."""
    return bool(_find_by_label(steps, label)["providerLocked"])


def by_kind_label(kind: str, label: str) -> dict:
    """HZ-383: the farm-view row with this label in that item kind's own rows.
    Raises KeyError for an unknown kind, or a label that kind does not run on
    a lane — a Task label never resolves to a `change` row, or the reverse."""
    _assert_item_kind(kind)
    try:
        return _find_by_label(FARM_VIEWS[kind], label)
    except KeyError:
        raise KeyError(f"no step labeled {label!r} for item kind {kind!r} in the step table") from None


def entry_for_dispatch(index, kind: str, label: str) -> dict:
    """HZ-383: the row a dispatched task names, checked three ways. farmd's
    /steps/run sends `step.index`, `step.label` and `item.kind`; the row at
    that index must belong to that kind and carry that label, or this raises
    KeyError rather than routing the task by its index alone."""
    entry = by_kind_label(kind, label)
    if entry["index"] != index:
        raise KeyError(f"step {index!r} is not {label!r} for item kind {kind!r}")
    return entry
