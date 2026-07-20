"""Step agent driven end-to-end by fake_claude: this is the automated proof
that a dispatched step completes and produces the branch/artifact the Node
side needs to advance the item ("agents push tasks forward")."""

import subprocess

from farm import step_agent
from farm.step_agent import build_prompt, execute


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


def test_implement_step_pushes_a_branch(tmp_path, monkeypatch):
    # A local origin stands in for GitHub: seed repo -> bare origin -> workspace clone.
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
