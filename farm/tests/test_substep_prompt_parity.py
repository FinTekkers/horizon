"""HZ-539 metric 4 and guardrail 1, the farm half: a task with no `substep`
key gets exactly main's prompt and persona line.

The tasks are the golden /steps/run bodies the server parity test holds every
variant to (server/test/fixtures/substep-parity/steps-run.json, written on main
by server/scripts/substep-parity-golden.mjs). The expected build_prompt and
_persona_line output was captured on main by running this module:

    python -m farm.tests.test_substep_prompt_parity
"""

import json
import sys
from pathlib import Path

import pytest

from farm import step_agent

REPO = Path(__file__).resolve().parents[2]
GOLDEN_TASKS = REPO / "server" / "test" / "fixtures" / "substep-parity" / "steps-run.json"
PROMPTS = Path(__file__).resolve().parent / "fixtures" / "substep_parity_prompts.json"


def _tasks() -> dict[str, dict]:
    """Every golden agent-step task with a prompt, by step index. Execute is a
    job: its runner gets the plan, never a prompt."""
    steps = json.loads(GOLDEN_TASKS.read_text())["steps"]
    return {index: bodies[0] for index, bodies in steps.items() if "plan_artifact" not in bodies[0]}


def _render(task: dict) -> dict:
    return {"persona_line": step_agent._persona_line(task), "prompt": step_agent.build_prompt(task)}


EXPECTED = json.loads(PROMPTS.read_text()) if PROMPTS.exists() else {}


def test_the_fixture_covers_every_golden_prompt_step():
    tasks = _tasks()
    assert sorted(EXPECTED, key=int) == sorted(tasks, key=int)
    assert all("substep" not in task for task in tasks.values())
    assert "11" in tasks, "Implement is an audit anchor"


@pytest.mark.parametrize("index", sorted(EXPECTED, key=int))
def test_a_task_with_no_substep_gets_mains_prompt_and_persona_line(index):
    assert _render(_tasks()[index]) == EXPECTED[index]


if __name__ == "__main__":
    rendered = {index: _render(task) for index, task in _tasks().items()}
    PROMPTS.write_text(json.dumps(rendered, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {PROMPTS}", file=sys.stderr)
