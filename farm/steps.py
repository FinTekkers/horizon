"""HZ-117: the farm's one view of "what is a lifecycle step".

Loads the committed steps_generated.json — produced by
`npm run gen:steps` (server/scripts/gen-steps.mjs) from
server/src/lifecycle.js's STEPS, the single source of truth — instead of
hand-duplicating a second table here. Every farm module that used to hardcode
a step index -> (budget | provider rule | lane | workspace-mutating) mapping
(farm/step_agent.py's STEP_CONFIG/PROVIDER_OVERRIDE_ELIGIBLE_STEPS,
farm/farmd.py's WORKSPACE_MUTATING_STEPS and lane routing) now reads it from
here.

The derivation functions (budget_for_label, provider_override_eligible,
provider_locked_for) take `steps` as their first argument rather than
reading the module-level STEPS global internally — that's what lets a test
fabricate a step table (e.g. with an inserted step) and assert the
derivation follows it, with zero literal indices in the test itself.
"""

import json
from pathlib import Path

STEPS_PATH = Path(__file__).parent / "steps_generated.json"


def _load_steps(path: Path) -> list[dict]:
    try:
        raw = path.read_text()
    except OSError as exc:
        raise RuntimeError(
            f"farm/steps.py: could not read {path} — run `npm run gen:steps` in server/ ({exc})"
        ) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"farm/steps.py: {path} is not valid JSON — regenerate it ({exc})") from exc
    if not isinstance(data, list) or not all(isinstance(entry, dict) for entry in data):
        raise RuntimeError(f"farm/steps.py: {path} must be a JSON array of step objects")
    labels = [entry.get("label") for entry in data]
    dupes = {label for label in labels if labels.count(label) > 1}
    if dupes:
        raise RuntimeError(f"farm/steps.py: {path} has duplicate step label(s): {sorted(dupes)}")
    return data


STEPS: list[dict] = _load_steps(STEPS_PATH)

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
    raise KeyError(f"no step labeled {label!r} in the generated step table — run `npm run gen:steps` in server/")


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
