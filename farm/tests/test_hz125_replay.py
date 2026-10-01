"""HZ-182 metric 5, farm half: HZ-125's attempt-4 rejection through the fix path.

Runs the implement task that server/test/fix-pass-hz125-replay.test.mjs proves
the orchestrator dispatches (fixtures/hz125/dispatch.json), on a repo holding
the recorded `server/src/definitions.js` before and after the fix. The fix run
gets the reduced budget; the delta review then reads only the guard commit.
"""

import json
import subprocess
from pathlib import Path

from farm import step_agent
from farm.step_agent import execute

FIXTURES = Path(__file__).parent / "fixtures" / "hz125"
DISPATCH = json.loads((FIXTURES / "dispatch.json").read_text())


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def task(label, scope, feedback):
    return {
        "run_id": 1,
        "attempt": 5,
        "item": {"id": "HZ-125", "title": "Personas become agent-scoped", "desc": "", "metric": "", "guardrails": "",
                 "priority": "High", "repo": "FinTekkers/horizon", "issue": 125},
        "step": {"index": 0, "label": label, "agent": "Eng"},
        "artifacts": [],
        "feedback": feedback,
        "scope": scope,
    }


def test_hz125_attempt4_rejection_replays_as_a_fix_run_and_a_delta_review(tmp_path, monkeypatch):
    seed = tmp_path / "seed"
    (seed / "server" / "src").mkdir(parents=True)
    git(tmp_path, "init", "-b", "main", "seed")
    git(seed, "config", "user.email", "t@example.com")
    git(seed, "config", "user.name", "T")
    (seed / "README.md").write_text("# horizon\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "main")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    git(ws, "checkout", "-b", "horizon/hz-125")
    # The PR as attempt 4's review read it: the unguarded lookup.
    (ws / "server" / "src").mkdir(parents=True)
    (ws / "server" / "src" / "definitions.js").write_text((FIXTURES / "definitions.reviewed.txt").read_text())
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "HZ-125 attempt 4")
    git(ws, "push", "-u", "origin", "horizon/hz-125")
    reviewed = git(ws, "rev-parse", "HEAD")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    # The dispatched fix task, pointed at this repo's copy of the reviewed commit.
    scope = {**DISPATCH["scope"], "base_sha": reviewed}
    captured = {}

    def fix_agent(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        (ws / "server" / "src" / "definitions.js").write_text((FIXTURES / "definitions.fixed.txt").read_text())
        return {"result": '{"summary": "guarded every persona-registry lookup with isPersona"}'}

    monkeypatch.setattr(step_agent, "run_agent", fix_agent)
    implemented = execute(task(DISPATCH["step"]["label"], scope, [{"message": DISPATCH["feedback_message"]}]))
    assert captured["max_turns"] == 53
    assert "## Fix pass" in captured["prompt"]
    assert "`server/src/definitions.js`" in captured["prompt"]
    assert implemented["artifacts"]["fix_diff_files"] == ["server/src/definitions.js"]
    assert implemented["artifacts"]["fix_diff_lines"] <= 200

    # The review the server dispatches next: a delta over the guard commit.
    prompts = []

    def reviewers(prompt, **kwargs):
        prompts.append(prompt)
        reply = {"verdict": "pass", "findings": [], "previous_findings": [{"index": 0, "resolved": True}]}
        if "QA Reviewer" in (kwargs.get("append_system") or ""):
            reply.update(regression_tests_run=True, new_code_unit_coverage=True, e2e_test_present=True)
        return {"result": json.dumps(reply)}

    monkeypatch.setattr(step_agent, "run_agent", reviewers)
    previous = [{"index": i, **f} for i, f in enumerate(DISPATCH["scope"]["findings"])]
    reviewed_result = execute(
        task("Automated review (code + QA)", {"mode": "delta", "base_sha": reviewed, "previous_findings": previous}, [])
    )
    artifacts = reviewed_result["artifacts"]
    assert artifacts["review_mode"] == "delta"
    assert artifacts["delta_files"] == ["server/src/definitions.js"]
    assert artifacts["verdict"]["previous_findings"] == [{"index": 0, "resolved": True, "detail": ""}]
    diff = prompts[0].split("```diff")[1]
    assert "+  const resolved = isPersona(agent, candidate)" in diff
    assert "-  const resolved = bucket[candidate]" in diff
    # Code the attempt-4 review already passed is not in the delta.
    assert "export function effectivePrompt" not in diff
