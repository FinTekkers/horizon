"""Step agent driven end-to-end by fake_claude: this is the automated proof
that a dispatched step completes and produces the branch/artifact the Node
side needs to advance the item ("agents push tasks forward")."""

import json
import subprocess

import pytest

from farm import step_agent
from farm.personas import PERSONA_DIR, PERSONAS
from farm.step_agent import STEP_CONFIG, build_prompt, execute


def make_task(step_index, label, repo=None, feedback=None, artifacts=None):
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "T-1",
            "title": "Test item",
            "desc": "Deliver the thing",
            "metric": "It works",
            "guardrails": "",
            "priority": "Medium",
            "repo": repo,
            "issue": 42 if repo else None,
        },
        "step": {"index": step_index, "label": label, "agent": "Eng"},
        "artifacts": artifacts or [],
        "feedback": feedback or [],
    }


def test_build_prompt_renders_feedback_and_artifacts():
    task = make_task(
        6,
        "Draft implementation plan",
        feedback=[{"message": "use sqlite not postgres"}],
        artifacts=[{"label": "Plan options", "content": "## Options\nA/B/C"}],
    )
    prompt = build_prompt(task)
    assert "Human feedback to address:" in prompt
    assert "- use sqlite not postgres" in prompt
    assert "Prior artifact — Plan options:" in prompt
    assert 'Step to perform now: "Draft implementation plan"' in prompt


def test_planner_step_produces_summary_and_artifact():
    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))
    assert result["summary"].startswith("[fake-claude] completed")
    assert result["artifacts"]["artifact_md"].startswith("# Fake artifact")


def test_feedback_is_stamped_into_summary_and_artifact():
    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)", feedback=[{"message": "address X"}]))
    assert result["summary"].startswith("addressed feedback")
    assert result["artifacts"]["artifact_md"].startswith("## Human feedback addressed in this revision")
    assert "> address X" in result["artifacts"]["artifact_md"]


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


def make_git_workspace(tmp_path):
    """A local origin stands in for GitHub: seed repo -> bare origin -> clone."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(tmp_path, "init", "-b", "main", "seed")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "README.md").write_text("# demo\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True, capture_output=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    return ws, origin


def test_implement_step_pushes_a_branch(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "workspace_path", lambda repo: ws)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["artifacts"]["branch"] == "horizon/t-1"
    # fake_claude wrote its implementation file; the script committed and pushed it.
    branches = subprocess.run(
        ["git", "--git-dir", str(origin), "branch", "--list"], capture_output=True, text=True, check=True
    ).stdout
    assert "horizon/t-1" in branches
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:fake_implementation.txt"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "fake implementation" in shown
    # No checks exist in the seed repo — the run notes that instead of failing.
    assert "no repo checks detected" in result["summary"]


def test_implement_step_fails_when_checks_fail(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "workspace_path", lambda repo: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    try:
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))
        raised = False
    except Exception as exc:
        raised = True
        assert "repo checks failed" in str(exc)
    assert raised, "failing checks must fail the step"

    # Nothing was pushed: guardrails are enforced before the push, not after.
    branches = subprocess.run(
        ["git", "--git-dir", str(origin), "branch", "--list"], capture_output=True, text=True, check=True
    ).stdout
    assert "horizon/t-1" not in branches


# ---- persona injection (HZ-4) ----
# The farm-side link of the success metric: an item tagged python_backend runs
# its specialist steps with the Python persona composed into the role prompt,
# a frontend_ui item with the UI persona — and planning steps stay generalist.


def capture_run_claude(captured):
    def _fake(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        return {"result": '{"summary": "did the step", "artifact_md": "# out"}'}

    return _fake


def persona_md(persona_id):
    return (PERSONA_DIR / PERSONAS[persona_id]).read_text()


def test_qa_step_composes_the_items_persona_into_the_role(monkeypatch):
    captured = {}
    monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
    task = make_task(8, "QA reviews the test plan")
    task["item"]["persona"] = "python_backend"
    execute(task)
    assert "## Your specialization" in captured["append_system"]
    assert persona_md("python_backend") in captured["append_system"]
    assert persona_md("frontend_ui") not in captured["append_system"]


def test_implement_step_composes_the_items_persona(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "workspace_path", lambda repo: ws)
    captured = {}
    monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["persona"] = "frontend_ui"
    # The captured stub edits no files, so the push step correctly balks —
    # the role had already been composed and passed to the model by then.
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    assert persona_md("frontend_ui") in captured["append_system"]


def test_planning_steps_do_not_get_a_persona(monkeypatch):
    for index, label in [
        (4, "Plan options & trade-offs (pros / cons)"),
        (6, "Draft implementation plan"),
        (7, "Architecture review"),
    ]:
        captured = {}
        monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
        task = make_task(index, label)
        task["item"]["persona"] = "python_backend"
        execute(task)
        assert "## Your specialization" not in captured["append_system"], f"step {index} leaked a persona"


def test_step_config_persona_flags_match_the_design():
    wants = {index: config[5] for index, config in STEP_CONFIG.items()}
    assert wants == {4: False, 6: False, 7: False, 8: True, 11: True}


# ---- project rules injection (HZ-9) ----
# farmd stamps `rules` into the task; the prompt (and therefore the tmux
# session log) must carry them verbatim under a "## Project rules" header.


def test_build_prompt_renders_the_project_rules_section():
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["rules"] = "- JAVA_HOME must point at JDK 17 for Gradle"
    prompt = build_prompt(task)
    assert "## Project rules\n- JAVA_HOME must point at JDK 17 for Gradle" in prompt


def test_build_prompt_without_rules_renders_no_header():
    assert "## Project rules" not in build_prompt(make_task(11, "Specialist agent implements"))
    task = make_task(11, "Specialist agent implements")
    task["rules"] = "   \n"
    assert "## Project rules" not in build_prompt(task)


def test_build_prompt_truncates_runaway_rules_at_24k_chars():
    from farm.rules import MAX_PROMPT_RULES_CHARS

    task = make_task(11, "Specialist agent implements")
    task["rules"] = "r" * (MAX_PROMPT_RULES_CHARS + 9000)
    prompt = build_prompt(task)
    assert "r" * MAX_PROMPT_RULES_CHARS in prompt
    assert "r" * (MAX_PROMPT_RULES_CHARS + 1) not in prompt


def test_build_prompt_renders_the_resolved_persona():
    task = make_task(6, "Draft implementation plan")
    task["item"]["persona"] = "python_backend"
    assert "persona: python_backend" in build_prompt(task)


def test_build_prompt_renders_default_persona_never_none():
    prompt = build_prompt(make_task(6, "Draft implementation plan"))
    assert "persona: fullstack" in prompt
    assert "persona: None" not in prompt


# ---- artifact truncation (HZ-29) ----
# The root-cause bug was two independent 12,000-char slices in this file: one
# rendering a *prior* artifact into a new prompt (build_prompt), one capping
# the artifact *this* agent just produced before reporting it back (execute).
# The server now owns the total prompt budget (orchestrator.js's
# budgetArtifacts) — both sites here must only be defensive sanity ceilings,
# never the working limit, or a large plan silently loses its tail again.


def test_build_prompt_does_not_re_truncate_a_large_prior_artifact_at_12k():
    from farm.step_agent import MAX_PROMPT_ARTIFACT_CHARS

    big = "a" * (MAX_PROMPT_ARTIFACT_CHARS - 1)
    task = make_task(11, "Specialist agent implements", artifacts=[{"label": "Draft plan", "content": big}])
    prompt = build_prompt(task)
    assert big in prompt
    assert "a" * 12001 in prompt  # beyond the old flat 12,000-char slice


def test_planner_step_reports_back_a_large_artifact_in_full(monkeypatch):
    big = "z" * 50000  # far past the old 12,000-char write-time slice
    monkeypatch.setattr(
        step_agent,
        "run_claude",
        lambda *a, **k: {"result": json.dumps({"summary": "did the step", "artifact_md": big})},
    )
    result = execute(make_task(6, "Draft implementation plan"))
    assert result["artifacts"]["artifact_md"] == big
