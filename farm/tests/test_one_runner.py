"""HZ-371: one program runs every farm agent step.

The PM steps (runsIn "pm" in domain/steps.json) are a step kind inside
farm/step_agent.py; their own logic lives in farm/pm_steps.py, which holds no
runner code. The old PM runner module is gone, and so is its polling loop.
"""

import ast
import copy
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from domain.py import steps
from domain.py.personas import model_agent_for_step
from farm import agent_runner, pause, pm_steps, step_agent

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "pm_prompts"

# Built by concatenation so this file never matches its own scan.
GONE_NAME = "pm" + "_agent"
GONE_WORDS = (GONE_NAME, "poll" + "_once", "_queued" + "_tasks")

PM_STEPS = [step for step in steps.STEPS if step["runsIn"] == "pm"]
# A planner that, like every PM step, runs without a workspace here.
NON_PM_STEP = next(step for step in steps.STEPS if step["runsIn"] == "farm")
NON_PM_LABEL = NON_PM_STEP["label"]


def _fixture_task(step: dict) -> dict:
    task = json.loads((FIXTURES / "task.json").read_text())
    task["step"] = {"index": step["index"], "label": step["label"]}
    return task


def _write_task(tmp_path: Path, task: dict, monkeypatch) -> Path:
    path = tmp_path / f"{task['run_id']}.json"
    path.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(path)])
    return path


# ---- metric 1: the old PM runner is gone ----


def test_pm_agent_is_gone():
    assert importlib.util.find_spec(f"farm.{GONE_NAME}") is None
    tracked = subprocess.run(
        ["git", "ls-files", "farm", "tests"], cwd=REPO_ROOT, capture_output=True, text=True, check=True, timeout=60
    ).stdout.split()
    assert len(tracked) > 50, "the scan would pass vacuously"
    pattern = re.compile(r"\b(" + "|".join(GONE_WORDS) + r")\b")
    hits = []
    for rel in tracked:
        path = REPO_ROOT / rel
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        hits += [f"{rel}: {m.group(0)}" for m in pattern.finditer(text)]
    assert hits == []


def test_the_scan_matches_whole_words_only():
    """The /farm/status key `pm_agents` is a lane count farmd still serves; a
    substring scan would flag it."""
    pattern = re.compile(r"\b(" + "|".join(GONE_WORDS) + r")\b")
    assert pattern.search(f"farm.{GONE_NAME}.main()")
    assert not pattern.search('body["pm_agents"]')


# ---- metric 5: a PM step runs through step_agent ----


@pytest.mark.parametrize("step", PM_STEPS, ids=lambda step: step["label"])
def test_pm_step_runs_through_step_agent(run_pm_step, step):
    calls = []

    def fake_run_agent(prompt, **kw):
        calls.append({"prompt": prompt, **kw})
        return {"result": json.dumps({"summary": "done"}), "session_id": "s"}

    posted = run_pm_step(_fixture_task(step), fake_run_agent)

    assert posted["ok"] is True
    assert len(calls) == 1
    label = step["label"]
    assert calls[0]["agent"] == model_agent_for_step(steps.by_label(label)["agent"])
    assert calls[0]["persona"] == step_agent.model_persona(step_agent.STEP_CONFIG[label][3], {})
    assert calls[0]["persona"] is None
    assert calls[0]["session_id"] is None
    # Metric 3, at the runner: what step_agent actually sends.
    assert calls[0]["prompt"] == (FIXTURES / f"step_{step['index']}.txt").read_text()
    assert calls[0]["append_system"] == (FIXTURES / "role_prompt.txt").read_text()


@pytest.mark.parametrize("label", [PM_STEPS[0]["label"], NON_PM_LABEL])
def test_a_paused_step_writes_the_same_outcome_and_posts_nothing(tmp_path, monkeypatch, label):
    """A pause during the agent run is handled by step_agent.main() the same
    way for a PM step as for any other step."""
    task = copy.deepcopy(_fixture_task(PM_STEPS[0]))
    task["step"] = {"index": steps.by_label(label)["index"], "label": label}
    task["item"]["repo"] = None  # a planner with no workspace, like a PM step
    path = _write_task(tmp_path, task, monkeypatch)
    posted = []
    monkeypatch.setattr(step_agent, "post_result", posted.append)

    def paused(prompt, **kw):
        raise pause.PauseRequested()

    monkeypatch.setattr(step_agent, "run_agent", paused)

    assert step_agent.main() == 0

    assert posted == []
    outcome = pause.read_outcome(path.with_suffix(".paused"))
    assert outcome == {"outcome": pause.NOTHING, "detail": "the attempt had not started work that could be saved"}


def test_pm_steps_defines_no_runner_helpers():
    tree = ast.parse((REPO_ROOT / "farm" / "pm_steps.py").read_text())
    banned_defs = {"log", "notify_started", "report_failed_task", "run_agent", "retry_once", "process", "main"}
    banned_calls = {"run_agent", "parse_agent_reply"}
    problems = []
    for node in ast.walk(tree):  # nested defs included
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in banned_defs:
            problems.append(f"defines {node.name} (line {node.lineno})")
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in banned_calls:
                problems.append(f"calls {name} (line {node.lineno})")
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name in banned_calls:
                    problems.append(f"imports {alias.name} (line {node.lineno})")
    assert problems == []


# ---- guardrail 1: the PM retry is unchanged ----


def test_an_over_budget_reply_is_retried_once_with_the_prompt_then_the_correction(run_pm_step):
    step = next(s for s in PM_STEPS if s["label"] in pm_steps.LINE_BUDGETED_STEPS)
    task = _fixture_task(step)
    key = pm_steps.LINE_BUDGETED_STEPS[step["label"]]
    over = "\n".join(f"{n}. line {n}" for n in range(1, pm_steps.LINE_LIMITS[key] + 2))
    good = "\n".join(f"{n}. line {n}" for n in range(1, pm_steps.LINE_LIMITS[key] + 1))
    replies = [
        json.dumps({"summary": "first", "patch": {key: over}}),
        json.dumps({"summary": "second", "patch": {key: good}}),
    ]
    calls = []

    def fake_run_agent(prompt, **kw):
        calls.append(prompt)
        return {"result": replies[len(calls) - 1], "session_id": "s"}

    posted = run_pm_step(task, fake_run_agent)

    assert len(calls) == 2
    with pytest.raises(pm_steps.FieldOverBudgetError) as rejected:
        pm_steps.validate_within_budget(json.loads(replies[0]), step["label"], task["item"])
    correction = agent_runner.RETRY_PROMPT.format(exc=rejected.value)
    assert calls[1] == f"{calls[0]}\n\n{correction}"
    assert posted["ok"] is True
    assert posted["patch"][key] == good


# ---- guardrail 2: a non-PM step never loads the PM module ----


def test_a_non_pm_step_never_imports_pm_steps():
    """In a fresh interpreter, so another test's import cannot mask it."""
    script = f"""
import json, sys
from farm import step_agent
step_agent.run_agent = lambda prompt, **kw: {{"result": json.dumps({{"summary": "ok", "artifact_md": "# A"}}), "session_id": "s"}}
task = {{"run_id": 1, "attempt": 1, "item": {{"id": "T-1", "title": "t"}},
        "step": {{"index": {NON_PM_STEP["index"]}, "label": {NON_PM_LABEL!r}}}, "artifacts": [], "feedback": []}}
step_agent.execute(task)
print("farm.pm_steps" in sys.modules)
"""
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=REPO_ROOT, capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "False"
