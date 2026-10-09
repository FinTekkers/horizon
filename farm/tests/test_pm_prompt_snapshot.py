"""HZ-371 metric 3: the PM prompt is unchanged, byte for byte.

farm/tests/fixtures/pm_prompts/ holds what the PM runner on main built for a
fixed task, captured before that runner was folded into step_agent (see
regen.py there). farm/tests/test_one_runner.py checks the same fixtures
against what step_agent actually hands run_agent.
"""

import json
from pathlib import Path

import pytest

from domain.py import steps
from farm import pm_steps

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "pm_prompts"
PM_STEPS = [step for step in steps.STEPS if step["runsIn"] == "pm"]


def _task(step: dict) -> dict:
    task = json.loads((FIXTURES / "task.json").read_text())
    task["step"] = {"index": step["index"], "label": step["label"]}
    return task


def test_every_pm_step_has_a_fixture():
    assert len(PM_STEPS) == 4
    for step in PM_STEPS:
        assert (FIXTURES / f"step_{step['index']}.txt").is_file()


@pytest.mark.parametrize("step", PM_STEPS, ids=lambda step: step["label"])
def test_build_prompt_matches_the_snapshot(step):
    assert pm_steps.build_prompt(_task(step)) == (FIXTURES / f"step_{step['index']}.txt").read_text()


@pytest.mark.parametrize("step", PM_STEPS, ids=lambda step: step["label"])
def test_the_snapshot_renders_every_prompt_section(step):
    """A fixture built from an empty task would pass the byte check and prove
    nothing, so each one must carry every section build_prompt can render."""
    text = (FIXTURES / f"step_{step['index']}.txt").read_text()
    assert f'Step to perform now: "{step["label"]}"' in text
    assert "  personas: eng=python, qa=web" in text
    assert "Prior artifact — Draft implementation plan:" in text
    assert "Human feedback to address:\n- Keep the role file unchanged." in text
    assert pm_steps.PROJECT_CONTEXT_HEADER in text
    assert "Recent items:" in text and "Recent human feedback:" in text
    assert "## Project rules" in text


def test_the_role_prompt_matches_the_snapshot():
    assert pm_steps.ROLE_PROMPT == (FIXTURES / "role_prompt.txt").read_text()
