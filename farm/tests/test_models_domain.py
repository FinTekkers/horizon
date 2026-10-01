"""HZ-192: domain/personas.json's `models` block — loaded identically by both
bindings, covering every agent the farm runs, and pinned to the models
production used before the env vars were removed, so nothing changes model at
merge.

Model ids are spelt out here on purpose: this is the pin. They may appear in
tests and in domain/ only (test_model_call_sites.py scans the rest).
"""

import json
import subprocess
from pathlib import Path

from domain.py import personas, steps

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

OPUS = "claude-opus-5-5"
# Operator-recorded production values, 2026-10-01: PM and every step agent on
# Opus (the retired PM and step model env vars), the concierge on the Sonnet
# its session was created on (its retired env var was unset).
PRODUCTION_MODELS = {
    "agents": {
        "pm": OPUS,
        "concierge": "claude-sonnet-5",
        "eng": OPUS,
        "architect": OPUS,
        "qa": OPUS,
        "devops": OPUS,
        "ensemble": OPUS,
        "review": OPUS,
    },
    "steps": {},
    "personas": {},
}


def plain(models) -> dict:
    return {key: dict(value) for key, value in models.items()}


def js_models() -> dict:
    script = (
        "import('./domain/js/personas.js').then((m) => console.log(JSON.stringify({"
        "MODELS: m.MODELS, CONCIERGE_MODEL_AGENT: m.CONCIERGE_MODEL_AGENT, "
        "CONFLICT_MODEL_AGENT: m.CONFLICT_MODEL_AGENT, CONFLICT_STEP_KEY: m.CONFLICT_STEP_KEY })))"
    )
    out = subprocess.run(["node", "-e", script], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def agent_steps() -> list[dict]:
    """Every agent-kind step in domain/steps.json, both lanes."""
    return list(steps.STEPS)


# ---- metric 1: both bindings load the same block ----


def test_the_python_and_js_bindings_load_the_same_models():
    js = js_models()
    assert js["MODELS"] == plain(personas.MODELS)
    assert js["CONCIERGE_MODEL_AGENT"] == personas.CONCIERGE_MODEL_AGENT
    assert js["CONFLICT_MODEL_AGENT"] == personas.CONFLICT_MODEL_AGENT
    assert js["CONFLICT_STEP_KEY"] == personas.CONFLICT_STEP_KEY


def test_every_agent_the_farm_runs_has_a_default_model():
    """A steps.json agent display name with no models.agents key would raise
    at dispatch; this fails first. The six agents the work item names, plus
    the two lifecycle agents (Ensemble, Review) steps.json also uses."""
    needed = {personas.model_agent_for_step(step["agent"]) for step in agent_steps()}
    needed |= {personas.CONCIERGE_MODEL_AGENT, personas.CONFLICT_MODEL_AGENT}
    assert {"pm", "concierge", "eng", "architect", "qa", "devops"} <= needed
    assert needed - set(personas.MODELS["agents"]) == set()


def test_every_step_override_names_a_live_step():
    """A stale label would make its override silently not apply."""
    live = {step["label"] for step in agent_steps()} | {personas.CONFLICT_STEP_KEY}
    assert set(personas.MODELS["steps"]) - live == set()


def test_agent_step_labels_are_unique_so_a_step_override_is_unambiguous():
    labels = [step["label"] for step in agent_steps()]
    assert len(labels) == len(set(labels))


# ---- metric 4: today's production values, exactly ----


def test_the_models_block_is_pinned_to_production():
    assert plain(personas.MODELS) == PRODUCTION_MODELS
    assert personas.CONFLICT_MODEL_AGENT == "eng"


def test_every_agent_step_runs_on_opus_at_merge():
    """Dict equality alone does not prove it: this is the model each step
    actually resolves to, through the same mapping the farm uses."""
    effective = {
        step["label"]: personas.resolve_model(personas.model_agent_for_step(step["agent"]), step["label"])
        for step in agent_steps()
    }
    assert effective and set(effective.values()) == {OPUS}, effective
    assert personas.model_agent_for_step(steps.by_label("Set guardrails")["agent"]) == "architect"
    assert effective["Set guardrails"] == OPUS


def test_conflict_resolution_runs_on_opus_and_the_concierge_on_sonnet_at_merge():
    assert personas.resolve_model(personas.CONFLICT_MODEL_AGENT, personas.CONFLICT_STEP_KEY) == OPUS
    assert personas.resolve_model(personas.CONCIERGE_MODEL_AGENT) == "claude-sonnet-5"


def test_no_persona_routed_to_another_provider_carries_a_model():
    assert set(personas.MODELS["personas"]) & set(personas.PERSONA_PROVIDERS) == set()
