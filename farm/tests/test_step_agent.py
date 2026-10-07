"""Step agent driven end-to-end by fake_claude: this is the automated proof
that a dispatched step completes and produces the branch/artifact the Node
side needs to advance the item ("agents push tasks forward")."""

import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from farm import checks, step_agent
from farm.agent_runner import AgentError, AgentExhaustedError
from farm.personas import DEFAULT_PERSONAS, PERSONA_DIR, PERSONAS
from farm.step_agent import (
    STEP_CONFIG,
    _assert_step_config_matches_table,
    build_prompt,
    execute,
    publish_screenshots,
    truncate_diff,
)


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
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

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
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    with pytest.raises(RuntimeError, match="repo checks failed"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    # Guardrails are enforced before the finalize push, not after: the only
    # thing pushed is a WIP checkpoint of the work (HZ-184), never the
    # finished commit a PR is opened from.
    log_text = subprocess.run(
        ["git", "--git-dir", str(origin), "log", "--format=%s", "horizon/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert log_text.splitlines()[0] == f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"
    assert "T-1: Test item (Horizon Eng agent)" not in log_text


def test_implement_step_runs_exactly_the_tasks_configured_check_commands(tmp_path, monkeypatch):
    """HZ-245: the task's check_commands (install + test only) are what the
    implement checks run — two `sh -c` argvs, and no auto-detected npm or
    pytest command even though the workspace has a package.json with test
    and lint scripts."""
    ws, origin = make_git_workspace(tmp_path)
    (ws / "package.json").write_text(json.dumps({"scripts": {"test": "node --test", "lint": "eslint ."}}))
    (ws / "pytest.ini").write_text("[pytest]\n")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    ran = []
    monkeypatch.setattr(
        checks,
        "_run_bounded",
        lambda cmd, ws, timeout_s, env: ran.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""),
    )
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["check_commands"] = {"install": "npm install --ignore-scripts", "test": "npm test", "lint": None, "e2e": None}

    result = execute(task)

    assert ran == [["sh", "-c", "npm install --ignore-scripts"], ["sh", "-c", "npm test"]]
    assert "2 repo check(s) passed" in result["summary"]


def test_implement_step_passes_the_items_repo_to_run_checks(tmp_path, monkeypatch):
    """HZ-249: without repo=, the dependency cache stays inert in production."""
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    seen = []
    monkeypatch.setattr(step_agent, "run_checks", lambda ws, log, **kw: seen.append(kw.get("repo")) or "1 repo check(s) passed")

    execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert seen == ["acme/demo"]


# ---- screenshot publishing (HZ-63) ----
# Screenshots are gitignored now (no more committed PNGs), published instead
# to a per-item git ref so two branches touching the same journey never
# conflict on a binary file.


def test_publish_screenshots_works_inside_a_git_WORKTREE_not_just_a_clone(tmp_path):
    """Regression: per-item worktrees (HZ-50) have a .git FILE, not a directory.

    publish_screenshots used to write its temporary git index at
    ws/.git/horizon-artifacts-index, which is ENOTDIR in a worktree. Worse, the
    unlink in its `finally` raised the same error OUTSIDE the except that makes
    this function best-effort, so a screenshot publish failure killed the whole
    implement step. Observed on real runs before the fix.

    make_git_workspace() produces a plain clone, where .git IS a directory —
    which is why no existing test caught this. This one uses a real worktree.
    """
    ws, origin = make_git_workspace(tmp_path)
    worktree = tmp_path / "item-worktree"
    git(ws, "worktree", "add", "--detach", str(worktree))
    assert (worktree / ".git").is_file(), "a worktree's .git must be a file for this test to mean anything"

    write_fake_screenshot(worktree, "board")
    publish_screenshots(worktree, {"id": "T-9", "repo": "acme/demo"})

    refs = origin_refs(origin)
    assert "refs/heads/e2e-artifacts/t-9" in refs


def test_a_diff_within_the_cap_is_passed_through_untouched_and_unannotated():
    diff = "diff --git a/x b/x\n+one line\n"
    text, note = truncate_diff(diff)
    assert text == diff
    assert note == ""


def test_an_oversized_diff_is_announced_as_truncated_not_silently_cut():
    """Regression: a silently cut diff ends mid-statement, so a reviewer reads
    it as broken code and fails the item. HZ-76 looped three times that way —
    its 14-file, 35k diff was cut at 20k and every verdict described the prompt
    ("Diff cuts off at `if (FARM_URL)`") rather than the change."""
    diff = "x" * (step_agent.REVIEW_DIFF_CHARS + 5000)
    text, note = truncate_diff(diff)

    assert len(text) == step_agent.REVIEW_DIFF_CHARS, "the cap must still bound prompt size"
    assert note, "a truncated diff MUST carry a note — silence is what caused the loop"
    assert "TRUNCATED" in note
    assert "5,000" in note, "say how much was omitted"
    assert "do not fail the change for it" in note.lower(), \
        "the reviewer must be told not to fail the item over the cut"


def test_the_truncation_note_sits_outside_the_diff_fence():
    """The note must not be mistakable for part of the patch."""
    diff = "y" * (step_agent.REVIEW_DIFF_CHARS + 10)
    text, note = truncate_diff(diff)
    assert "TRUNCATED" not in text, "the note belongs beside the diff, never inside it"
    assert note.startswith("\n\n")


def test_reviewer_roles_stop_instead_of_judging_truncated_input():
    """HZ-105/HZ-102: architect_review.md already had this instruction; qa.md
    lacked it — the actual gap that let QA report a required test plan as
    absent (it had only seen a quarter of it) and still return a verdict on
    the partial content. This pins the instruction so it can't regress in
    either reviewer role. The server-side gate (orchestrator.js's
    missingRequiredInputs) already stops a REQUIRED truncated artifact from
    ever reaching the farm — this instruction covers the remaining case: a
    non-required prior artifact riding along truncated."""
    phrase = "do not review the partial content as if it were complete"
    for role_file in ("architect_review.md", "qa.md"):
        text = (step_agent.ROLES / role_file).read_text()
        normalized = " ".join(text.split())  # role files wrap prose across lines
        assert phrase in normalized, f"{role_file} is missing the stop-on-truncation instruction"


# HZ-191: the PM's step-9 digest carries a binding Test contract. The label is
# read off domain/steps.json so a rename can't leave these roles pointing at a
# section that no longer exists.
def _role_text(role_file):
    return " ".join((step_agent.ROLES / role_file).read_text().split())


def _contract_step_label():
    from domain.py import steps as domain_steps

    step = domain_steps.STEP_BY_INDEX[9]
    assert step["agent"] == "PM"
    return step["label"]


def test_implement_role_treats_test_contract_as_binding():
    text = _role_text("eng_implement.md")
    assert f'The `## Test contract` in the "{_contract_step_label()}" artifact is the binding test list.' in text
    assert "It overrides the Required list in QA's plan review." in text
    assert "Optional cases are allowed only if cheap." in text
    assert "each Test contract case needs a test that would fail without your change." in text


def test_qa_review_role_checks_coverage_against_the_test_contract():
    text = _role_text("qa_review.md")
    assert f'Check coverage against the `## Test contract` in the "{_contract_step_label()}" artifact.' in text
    assert "A missing contract case is **block**." in text
    assert "Do not add required tests unless the contract leaves a metric line or guardrail unverified." in text


def test_qa_review_role_keeps_manual_verification_and_fail_closed_rules():
    text = _role_text("qa_review.md")
    assert '"Manually verified" is never acceptable evidence.' in text
    assert 'You are a GATE, not an observer: "Manually verified" is NEVER acceptable evidence' in text
    assert 'If your input appears truncated or inconsistent, do NOT proceed silently: say so in the summary and set verdict to "fail".' in text


def write_fake_screenshot(ws, name):
    shots = ws / "e2e" / "__screenshots__"
    shots.mkdir(parents=True, exist_ok=True)
    (shots / f"{name}.png").write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode())


def origin_refs(origin):
    return subprocess.run(
        ["git", "--git-dir", str(origin), "for-each-ref", "--format=%(refname)"], capture_output=True, text=True, check=True
    ).stdout


def test_publish_screenshots_pushes_an_orphan_commit_to_a_per_item_ref(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    write_fake_screenshot(ws, "board")
    write_fake_screenshot(ws, "gates")

    publish_screenshots(ws, {"id": "T-1", "repo": "acme/demo"})

    refs = origin_refs(origin)
    assert "refs/heads/e2e-artifacts/t-1" in refs
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", "e2e-artifacts/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "e2e/__screenshots__/board.png" in shown
    assert "e2e/__screenshots__/gates.png" in shown
    # It's an orphan commit — no parent, so it never carries the code branch's history.
    parents = subprocess.run(
        ["git", "--git-dir", str(origin), "log", "--format=%P", "-1", "e2e-artifacts/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert parents == ""


def test_publish_screenshots_does_not_touch_the_working_tree_or_index(tmp_path):
    ws, _origin = make_git_workspace(tmp_path)
    write_fake_screenshot(ws, "board")

    publish_screenshots(ws, {"id": "T-1", "repo": "acme/demo"})

    status = subprocess.run(["git", "-C", str(ws), "status", "--porcelain"], capture_output=True, text=True, check=True).stdout
    # The screenshot file itself is untracked (it's gitignored elsewhere), but
    # nothing was staged into the branch's own index/HEAD.
    assert subprocess.run(["git", "-C", str(ws), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip() == "main"
    head_files = subprocess.run(["git", "-C", str(ws), "ls-tree", "-r", "--name-only", "HEAD"], capture_output=True, text=True, check=True).stdout
    assert "e2e/__screenshots__" not in head_files
    assert "?? e2e/" in status


def test_publish_screenshots_is_a_noop_with_no_screenshots(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    publish_screenshots(ws, {"id": "T-1", "repo": "acme/demo"})
    assert "e2e-artifacts" not in origin_refs(origin)


def test_publish_screenshots_never_raises_on_push_failure(tmp_path):
    ws, _origin = make_git_workspace(tmp_path)
    write_fake_screenshot(ws, "board")
    subprocess.run(["git", "-C", str(ws), "remote", "set-url", "origin", "/no/such/path"], check=True)
    publish_screenshots(ws, {"id": "T-1", "repo": "acme/demo"})  # must not raise


def test_implement_step_publishes_screenshots_without_polluting_the_code_branch(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    # A repo that has adopted HZ-63 already ignores the screenshots dir —
    # seed that onto main so the branch under test inherits it, same as a
    # real target repo would.
    (ws / ".gitignore").write_text("e2e/__screenshots__/\n")
    subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(ws), "commit", "-m", "add gitignore"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(ws), "push", "origin", "main"], check=True, capture_output=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    # prepare_branch() resets/cleans the worktree before the agent runs, so the
    # screenshot must appear as a side effect of the (fake) e2e run, same as a
    # real Playwright run would produce it after the branch is already checked out.
    def fake_run_agent(prompt, **kwargs):
        (ws / "note.txt").write_text("real code change\n")
        write_fake_screenshot(ws, "board")
        return {"result": '{"summary": "did the step"}'}

    monkeypatch.setattr(step_agent, "run_agent", fake_run_agent)

    execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "refs/heads/e2e-artifacts/t-1" in origin_refs(origin)
    code_files = subprocess.run(
        ["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", "horizon/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "e2e/__screenshots__" not in code_files


# ---- persona injection (HZ-4, agent-scoped since HZ-125) ----
# The farm-side link of the success metric: an item tagged eng/python runs its
# implement step with the Python persona composed into the role prompt, an
# eng/ui item with the UI persona — and planning steps stay generalist.
# HZ-125 adds the second half: each composing step reads the slot for ITS OWN
# agent, so a QA step can never wear the Eng specialization.


def capture_run_agent(captured):
    def _fake(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        return {"result": '{"summary": "did the step", "artifact_md": "# out"}'}

    return _fake


def persona_md(agent, persona_id):
    return (PERSONA_DIR / PERSONAS[agent][persona_id]).read_text()


def test_qa_step_composes_the_items_qa_persona_into_the_role(monkeypatch):
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(8, "QA reviews the test plan")
    task["item"]["personas"] = {"eng": "python", "qa": "e2e_journey"}
    execute(task)
    assert "## Your specialization" in captured["append_system"]
    assert persona_md("qa", "e2e_journey") in captured["append_system"]
    assert persona_md("qa", "data_integrity") not in captured["append_system"]


def test_a_qa_step_never_receives_an_eng_persona(monkeypatch):
    """HZ-125 success metric 5, and the bug the item exists for: an item
    carrying only an Eng persona leaves the QA step wearing the QA default,
    never the Eng specialization of whoever writes the code."""
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(8, "QA reviews the test plan")
    task["item"]["personas"] = {"eng": "python"}
    execute(task)
    composed = captured["append_system"]
    for eng_persona in PERSONAS["eng"]:
        assert persona_md("eng", eng_persona) not in composed, f"QA step composed the eng/{eng_persona} persona"
    assert persona_md("qa", DEFAULT_PERSONAS["qa"]) in composed


def test_implement_step_composes_the_items_persona(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["personas"] = {"eng": "ui"}
    # The captured stub edits no files, so the push step correctly balks —
    # the role had already been composed and passed to the model by then.
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    assert persona_md("eng", "ui") in captured["append_system"]


def test_implement_step_still_composes_a_legacy_flat_persona_value(tmp_path, monkeypatch):
    """HZ-125 guardrail 3 / success metric 12, farm side: a task file enqueued
    before personas were agent-scoped carries a flat `persona` string. The item
    must still run, and still run as the specialist it was routed to — not
    silently demoted to the generalist."""
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["persona"] = "python_backend"  # the pre-HZ-125 field, verbatim
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    assert persona_md("eng", "python") in captured["append_system"]
    assert persona_md("eng", DEFAULT_PERSONAS["eng"]) not in captured["append_system"]


def test_planning_steps_do_not_get_a_persona(monkeypatch):
    for index, label in [
        (4, "Plan options & trade-offs (pros / cons)"),
        (6, "Draft implementation plan"),
        (7, "Architecture review"),
    ]:
        captured = {}
        monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
        task = make_task(index, label)
        task["item"]["personas"] = {"eng": "python"}
        execute(task)
        assert "## Your specialization" not in captured["append_system"], f"step {index} leaked a persona"


def test_step_config_persona_agents_match_the_design():
    """HZ-125 guardrail 2: exactly the same three steps compose a persona as
    before, and each one names the agent whose bucket it composes from. DevOps
    ("Deploy the changes") is a role, not a persona (HZ-22 architecture
    review): it is project-scoped via farm/rules/projects/*.md, not
    stack-scoped, so it never gets a persona composed in — same as the other
    planning steps."""
    agents = {label: config[3] for label, config in STEP_CONFIG.items()}
    assert agents == {
        "Plan options & trade-offs (pros / cons)": None,
        "Draft implementation plan": None,
        "Architecture review": None,
        "QA reviews the test plan": "qa",
        "Specialist agent implements": "eng",
        "Automated review (code + QA)": "eng",
        "Deploy the changes": None,
    }
    # Every named agent is a real persona bucket — a typo here would silently
    # compose nothing at all (compose_role never raises).
    for label, agent in agents.items():
        assert agent is None or agent in PERSONAS, f"{label} names unknown persona agent {agent!r}"
    # No DevOps personas, ever (HZ-125 guardrail 1).
    assert "devops" not in PERSONAS


# ---- STEP_CONFIG / generated-table drift detection (HZ-117) ----
# _assert_step_config_matches_table is the actual Python-side enforcement of
# "an inserted or renamed step must fail loudly, not silently repoint an
# index" — it's called once at step_agent import time against the real
# STEP_CONFIG and steps.STEPS, but it's a pure function over two plain sets,
# so the raise path itself is exercised directly here with a fabricated
# mismatch, no importlib.reload needed.


def test_assert_step_config_matches_table_passes_when_the_label_sets_agree():
    _assert_step_config_matches_table({"A", "B"}, {"B", "A"})  # must not raise


def test_assert_step_config_matches_table_raises_naming_the_mismatched_label_in_both_directions():
    with pytest.raises(RuntimeError) as exc_info:
        _assert_step_config_matches_table(
            {"Only In STEP_CONFIG", "Shared Step"},
            {"Only In Generated Table", "Shared Step"},
        )
    message = str(exc_info.value)
    assert "Only In STEP_CONFIG" in message
    assert "Only In Generated Table" in message
    assert "Shared Step" not in message  # the agreeing label is never flagged as a mismatch


def test_assert_step_config_matches_table_raises_for_a_renamed_label():
    """A label rename looks exactly like a one-sided mismatch: the old name
    disappears from the generated table, the new name never made it into
    STEP_CONFIG."""
    with pytest.raises(RuntimeError, match="Old Name"):
        _assert_step_config_matches_table({"Old Name"}, {"New Name"})


def test_the_drift_check_is_actually_wired_to_the_real_relocated_table():
    """HZ-128: the three tests above are pure-set, so they would keep passing if
    the import-time call were pointed at the wrong table — or at nothing. This
    asserts the WIRING: STEP_CONFIG's labels equal the farm-lane labels of the
    real table in its new home, which is exactly what step_agent asserts at
    import."""
    from domain.py import steps as domain_steps

    farm_lane = {entry["label"] for entry in domain_steps.STEPS if entry["runsIn"] == "farm"}
    assert farm_lane, "the relocated table declares no farm-lane steps"
    assert set(STEP_CONFIG) == farm_lane


def test_the_drift_message_names_the_models_new_home():
    """Criterion 12: the guarantee holds "from its new home". The old message
    named farm/steps_generated.json, a file this item deletes — a drift error
    pointing at a file that does not exist is not actionable."""
    with pytest.raises(RuntimeError) as exc_info:
        _assert_step_config_matches_table({"Only In STEP_CONFIG"}, set())
    message = str(exc_info.value)
    assert "domain/steps.json" in message
    assert "steps_generated" not in message


# ---- persona -> provider override (HZ-102 / HZ-121) ----
# PERSONA_PROVIDERS ships empty; these tests register a test-only fixture
# persona (conftest.py's muse_smoke_test_persona) mapped to a non-default
# provider to prove the override mechanism itself, and only on the
# pure-planning steps — proven here the same way persona-into-role
# composition is proven above: by asserting the kwarg run_agent() actually
# received. That's the farm's normal dispatch path (execute() ->
# run_agent()), never a direct call into farm.providers.muse — that boundary
# is covered separately in test_providers_muse.py.


def test_muse_smoke_test_persona_dispatches_with_provider_muse_on_eligible_steps(monkeypatch, muse_smoke_test_personas):
    for index, label in [
        (4, "Plan options & trade-offs (pros / cons)"),
        (6, "Draft implementation plan"),
        (7, "Architecture review"),
    ]:
        captured = {}
        monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
        task = make_task(index, label)
        task["item"]["personas"] = muse_smoke_test_personas
        execute(task)
        assert captured.get("provider") == "muse", f"step {index} did not dispatch with provider=muse"


def test_real_personas_never_force_a_provider_override(monkeypatch):
    """Driven off the registry, not a hand-listed set of ids: provider_for()
    scans every agent slot (HZ-125), so a new persona in any bucket must be
    covered the moment it is registered rather than when someone remembers to
    extend this list."""
    for agent, bucket in PERSONAS.items():
        for persona in bucket:
            captured = {}
            monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
            task = make_task(4, "Plan options & trade-offs (pros / cons)")
            task["item"]["personas"] = {agent: persona}
            execute(task)
            assert captured.get("provider") is None, (
                f"persona {agent}.{persona} must never force a provider"
            )


def test_muse_smoke_test_persona_never_forces_a_provider_on_qa(monkeypatch, muse_smoke_test_personas):
    """HZ-102 guardrail, code-enforced: QA (8) is a real specialist step, not
    a pure-planning one, so the override must never apply even if an item
    somehow carries the test persona."""
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(8, "QA reviews the test plan")
    task["item"]["personas"] = muse_smoke_test_personas
    execute(task)
    assert captured.get("provider") is None


def test_muse_smoke_test_persona_never_forces_a_provider_on_deploy(monkeypatch, muse_smoke_test_personas):
    """HZ-102 guardrail, code-enforced: never route deploy to Muse, even if
    an item somehow carries the test persona."""
    captured = {}

    def fake_run_agent(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        return devops_run_agent(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        )(prompt, **kwargs)

    monkeypatch.setattr(step_agent, "run_agent", fake_run_agent)
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: ("pass", 'SMOKE_RESULT=pass — "Horizon" rendered'))
    task = make_task(14, "Deploy the changes", repo="acme/demo")
    task["item"]["personas"] = muse_smoke_test_personas
    execute(task)
    assert captured.get("provider") is None


def test_muse_smoke_test_persona_never_forces_a_provider_on_implement(tmp_path, monkeypatch, muse_smoke_test_personas):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["personas"] = muse_smoke_test_personas
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    assert captured.get("provider") is None


# ---- provider lock (HZ-117): closes the bare-FARM_PROVIDER hole ----
# Before HZ-117, the provider guardrail only ever ran on the persona-forced
# override path (the old PROVIDER_OVERRIDE_ELIGIBLE_STEPS allowlist above) —
# a bare `FARM_PROVIDER=muse` env var, with no persona involved at all,
# reached implement/deploy completely unguarded. These go through the real
# run_agent() (never mocked) so the guardrail's actual dispatch chokepoint
# (farm/agent_runner.py) is what's under test, not a stub standing in for it.


def test_implement_refuses_a_bare_farm_provider_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    with pytest.raises(AgentError, match="provider-locked"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))


def test_deploy_refuses_a_bare_farm_provider_env_override(monkeypatch):
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    with pytest.raises(AgentError, match="provider-locked"):
        execute(make_task(14, "Deploy the changes", repo="acme/demo"))


def test_muse_smoke_test_provenance_is_stamped_into_summary_and_artifacts(monkeypatch, muse_smoke_test_personas):
    """The success metric's human-readability bar: a human reading the run
    log (this summary) or the artifact can tell Muse ran without inspecting
    config."""

    def fake_run_agent(prompt, **kwargs):
        return {
            "result": '{"summary": "did the step", "artifact_md": "# out"}',
            "session_id": "sess-1",
            "provider": "muse",
            "command_id": "the-real-command-id",
        }

    monkeypatch.setattr(step_agent, "run_agent", fake_run_agent)
    task = make_task(4, "Plan options & trade-offs (pros / cons)")
    task["item"]["personas"] = muse_smoke_test_personas

    result = execute(task)

    assert "provider=muse" in result["summary"]
    assert "command_id=the-real-command-id" in result["summary"]
    assert result["artifacts"]["provider"] == "muse"
    assert result["artifacts"]["command_id"] == "the-real-command-id"


def test_muse_smoke_test_dispatch_goes_through_the_real_muse_provider_module(monkeypatch, muse_smoke_test_personas):
    """End-to-end through the actual provider seam, not a stand-in: only the
    OS-level `muse` subprocess is faked (the same boundary
    test_providers_muse.py mocks at) — execute() -> run_agent() ->
    agent_runner._PROVIDERS['muse'] -> farm.providers.muse.run() -> a real
    (mocked) subprocess.run call with the real headless-safety argv."""
    from farm.providers import muse as muse_provider

    captured_cmd = {}

    def fake_subprocess_run(cmd, **kwargs):
        captured_cmd["cmd"] = cmd
        line = json.dumps(
            {
                "payload_type": "run.terminal.completed",
                "payload": {
                    "terminal": "completed",
                    "text": json.dumps({"summary": "muse smoke test ran", "artifact_md": "# Muse ran this"}),
                    "command_id": "muse-smoke-command-id",
                },
            }
        )
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=line, stderr="")

    monkeypatch.setattr(muse_provider.subprocess, "run", fake_subprocess_run)

    task = make_task(4, "Plan options & trade-offs (pros / cons)")
    task["item"]["personas"] = muse_smoke_test_personas

    result = execute(task)

    # Real headless-safety flags, not a stub — the same argv
    # test_providers_muse.py's own tests assert.
    cmd = captured_cmd["cmd"]
    assert "--approval-mode" in cmd and cmd[cmd.index("--approval-mode") + 1] == "never"
    assert "--user-input-auto-resolve" in cmd
    assert result["summary"].startswith("muse smoke test ran")
    assert result["artifacts"]["artifact_md"] == "# Muse ran this"
    assert result["artifacts"]["provider"] == "muse"
    assert result["artifacts"]["command_id"] == "muse-smoke-command-id"


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


def test_build_prompt_drops_a_runaway_rules_block_whole_instead_of_slicing_it():
    # HZ-114: this used to assert "r" * MAX_PROMPT_RULES_CHARS survived in
    # the prompt — i.e. it locked in the raw-slice bug. An oversized block
    # must now be absent entirely, with a marked, non-inference note in its
    # place, not half the block silently cut mid-word.
    from farm.rules import MAX_PROMPT_RULES_CHARS

    task = make_task(11, "Specialist agent implements")
    task["rules"] = ["r" * (MAX_PROMPT_RULES_CHARS + 9000)]
    prompt = build_prompt(task)
    assert "r" * 1000 not in prompt
    assert "## Project rules" in prompt
    assert "1 rules block(s) omitted" in prompt
    assert "do not infer" in prompt.lower()


def test_build_prompt_renders_the_resolved_persona_for_a_composing_step():
    task = make_task(11, "Specialist agent implements")
    task["item"]["personas"] = {"eng": "python"}
    assert "persona: eng/python" in build_prompt(task)


def test_build_prompt_names_the_step_agents_own_persona_not_another_agents():
    task = make_task(8, "QA reviews the test plan")
    task["item"]["personas"] = {"eng": "python", "qa": "data_integrity"}
    prompt = build_prompt(task)
    assert "persona: qa/data_integrity" in prompt
    assert "python" not in prompt.split("persona:")[1].splitlines()[0]


def test_build_prompt_says_generalist_for_a_step_that_composes_none():
    """Pre-HZ-125 this line printed a resolved Eng persona for every step,
    including the planning steps that never receive one."""
    task = make_task(6, "Draft implementation plan")
    task["item"]["personas"] = {"eng": "python"}
    prompt = build_prompt(task)
    assert "persona: (none — this step is generalist)" in prompt
    assert "persona: eng/python" not in prompt


def test_build_prompt_renders_default_persona_never_none():
    prompt = build_prompt(make_task(11, "Specialist agent implements"))
    assert f"persona: eng/{DEFAULT_PERSONAS['eng']}" in prompt
    assert "persona: None" not in prompt


# ---- automated review (HZ-30) ----
# The reviewer is READ-ONLY (STEP_CONFIG[12] grants only PLANNER_TOOLS — no
# Edit/Write/Bash) and runs two independent passes — code_review.md then
# qa_review.md — merging into one structured verdict the orchestrator's
# loop-cap logic reads. These tests drive execute() directly with a fake
# run_agent so each pass's JSON is controlled independently.


def two_pass_run_agent(code_json, qa_json, captured_calls):
    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        is_qa = "QA Reviewer agent" in kwargs.get("append_system", "")
        return {"result": json.dumps(qa_json if is_qa else code_json)}

    return _fake


def test_review_step_is_read_only():
    assert STEP_CONFIG["Automated review (code + QA)"][2] == "Read,Glob,Grep"  # PLANNER_TOOLS — no Edit/Write/Bash


def test_review_step_merges_two_passes_into_one_structured_verdict(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    code_json = {
        "summary": "code review done",
        "verdict": "fail",
        "findings": [{"file": "app.py", "line": 1, "severity": "block", "detail": "no guardrail check"}],
        "artifact_md": "## Code review\n**fail**",
    }
    qa_json = {
        "summary": "qa review done",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
        "artifact_md": "## QA review\n**pass**",
    }
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(code_json, qa_json, calls))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 2  # exactly one code-review pass, one QA pass
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"] == {"verdict": "fail", "findings": code_json["findings"]}
    assert verdict["qa_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["e2e_test_present"] is True
    assert "code review failed" in result["summary"]
    assert "QA review passed" in result["summary"]
    assert "no guardrail check" in result["summary"]
    assert "## Code review" in result["artifacts"]["artifact_md"]
    assert "## QA review" in result["artifacts"]["artifact_md"]


def test_review_step_defaults_a_malformed_pass_to_fail_closed(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    # Neither pass returns a "verdict" field at all (e.g. a model that ignored
    # the schema) — must default to "fail", never silently "pass".
    junk = {"summary": "not the right shape"}
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(junk, junk, []))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["regression_tests_run"] is False


def test_review_step_without_a_repo_auto_passes_without_calling_claude(monkeypatch):
    called = []
    monkeypatch.setattr(step_agent, "run_agent", lambda *a, **k: called.append(1))
    result = execute(make_task(12, "Automated review (code + QA)"))
    assert called == []
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"
    assert "no repository attached" in result["summary"]


# ---- deploy deep-verification (HZ-22) ----
# The DevOps agent only PICKS the url/expected_text to check (it knows the
# project's topology, the script doesn't) — the pass/fail gate itself is
# decided by run_smoke_check's real exit code, never the agent's own claim.
# The execute()-level tests below stub run_smoke_check directly to prove
# execute() trusts THAT result, not anything the fake agent reply might also
# say. run_smoke_check itself — the subprocess invocation, timeout, and
# SMOKE_RESULT= parsing — is exercised for real (no monkeypatch) further
# down, against the actual e2e/smoke/check.mjs, in
# test_run_smoke_check_against_the_real_check_script below.


def devops_run_agent(reply_json):
    def _fake(prompt, **kwargs):
        return {"result": json.dumps(reply_json)}

    return _fake


# Mirrors validateDeployVerdict in server/src/orchestrator.js exactly (down to
# the pass/fail enum). Node's process reads execute()'s "verdict" field over
# the wire as JSON with no shape translation in between, so a Python-side
# assertion of equality to a literal dict is not enough on its own — a
# previous revision shipped `"verdict": "pass"` here while the JS side
# required `{"verdict": "pass"}`, and every test on both sides still passed
# because each side only checked its own (different) assumed shape. Asserting
# against this mirrored predicate, not just literal equality, is what would
# have caught that class of bug.
def assert_valid_deploy_verdict(v):
    assert isinstance(v, dict) and v.get("verdict") in ("pass", "fail"), v


def test_deploy_step_without_a_repo_passes_without_calling_claude(monkeypatch):
    called = []
    monkeypatch.setattr(step_agent, "run_agent", lambda *a, **k: called.append(1))
    result = execute(make_task(14, "Deploy the changes"))
    assert called == []
    # Wrapped object, not a bare string — validateDeployVerdict in
    # server/src/orchestrator.js requires typeof v === 'object' with a
    # .verdict field. See server/test/deploy-gate.test.mjs.
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])
    assert "no repository attached" in result["summary"]


def test_deploy_step_trusts_the_real_smoke_check_not_the_agents_own_verdict(monkeypatch):
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        devops_run_agent(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        ),
    )
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: ("fail", "SMOKE_RESULT=fail: text never appeared"))

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))

    # The script's own check said fail — that's the verdict, full stop, even
    # though the fake agent reply above never claimed anything was broken.
    # Wrapped object shape — see the comment on test_deploy_step_without_a_repo above.
    assert result["artifacts"]["verdict"] == {"verdict": "fail"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])
    assert "SMOKE_RESULT=fail" in result["summary"]
    assert "SMOKE_RESULT=fail" in result["artifacts"]["artifact_md"]


def test_deploy_step_passes_when_the_real_smoke_check_passes(monkeypatch):
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        devops_run_agent(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        ),
    )
    monkeypatch.setattr(
        step_agent, "run_smoke_check", lambda url, text: ("pass", 'SMOKE_RESULT=pass — "Horizon" rendered')
    )

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])


def test_deploy_step_fails_closed_when_the_agent_omits_url_or_expected_text(monkeypatch):
    monkeypatch.setattr(step_agent, "run_agent", devops_run_agent({"summary": "did stuff", "artifact_md": "n/a"}))
    called = []
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda *a: called.append(1))

    with pytest.raises(Exception, match="url.*expected_text"):
        execute(make_task(14, "Deploy the changes", repo="acme/demo"))
    assert called == []  # never reaches the real check without both fields


# ---- run_smoke_check against the real check.mjs (HZ-22) ----
# Every test above monkeypatches run_smoke_check itself, so none of them ever
# exercises its actual subprocess call, timeout, or SMOKE_RESULT= parsing —
# exactly the "trust a real exit code, not the model's self-report" mechanism
# the whole ticket is built around. These drive the unmodified function
# against the real e2e/smoke/check.mjs and two throwaway local HTTP servers,
# mirroring e2e/smoke/check.test.mjs's pass/fail/unreachable cases plus a
# timeout case that script alone can't prove.


class _StallableHandler(BaseHTTPRequestHandler):
    html = b"<html><body><h1>Item Board</h1></body></html>"
    delay_s = 0
    release: threading.Event  # set at teardown, so a stalled handler exits now

    def do_GET(self):
        if self.delay_s:
            self.release.wait(self.delay_s)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(self.html)
        except (BrokenPipeError, ConnectionResetError):
            # The timeout case: check.mjs was killed before the page answered.
            # Raising here would print from a server thread — at interpreter
            # shutdown that is a fatal "_enter_buffered_busy" crash.
            pass

    def log_message(self, *args):
        pass  # keep test output quiet


def serve_html(html: bytes, delay_s: float = 0):
    # Threading, not the plain single-request-at-a-time HTTPServer: the
    # timeout test's handler stalls past run_smoke_check's own timeout, and a
    # single-threaded server's shutdown() would block on that same handler.
    # Handler threads are non-daemon so server_close() joins them; the stall
    # waits on `release`, which stop() sets first, so that join is immediate
    # and no handler is left running past its test.
    release = threading.Event()
    handler = type("Handler", (_StallableHandler,), {"html": html, "delay_s": delay_s, "release": release})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop():
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    return stop, f"http://127.0.0.1:{server.server_port}/"


# check.mjs imports @playwright/test from e2e/node_modules. That workspace is
# only installed by `npm run test:e2e`, which farm/checks.py skips on a host
# without Chromium. Without it check.mjs exits at import, so these two fail for
# want of an install, not a bug — and (HZ-183) would redden every pre-merge
# check on such a host. The two "fails" cases between them reach the same
# verdict either way and stay unconditional.
requires_e2e_workspace = pytest.mark.skipif(
    not (step_agent.REPO_ROOT / "e2e" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="e2e/node_modules is not installed (npm --prefix e2e install) — check.mjs cannot load Playwright",
)


@pytest.fixture
def smoke_check_tmpdir(tmp_path, monkeypatch):
    """HZ-238: Chromium puts its profile and playwright-artifacts dirs in
    TMPDIR. The timeout case SIGKILLs check.mjs mid-launch, so those dirs are
    never cleaned up by Playwright — point them at this test's own tmp_path,
    which pytest removes, instead of the run's sandbox."""
    monkeypatch.setenv("TMPDIR", str(tmp_path))


@requires_e2e_workspace
@pytest.mark.usefixtures("smoke_check_tmpdir")
def test_run_smoke_check_passes_against_a_real_rendering_page():
    stop_server, url = serve_html(b"<html><body><h1>Item Board</h1><p>3 items in flight</p></body></html>")
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        stop_server()
    assert verdict == "pass"
    assert line.startswith("SMOKE_RESULT=pass")


@pytest.mark.usefixtures("smoke_check_tmpdir")
def test_run_smoke_check_fails_against_a_page_missing_the_expected_text():
    stop_server, url = serve_html(b"<html><body><h1>Something went wrong</h1></body></html>")
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        stop_server()
    assert verdict == "fail"
    assert line.startswith("SMOKE_RESULT=fail:")


@pytest.mark.usefixtures("smoke_check_tmpdir")
def test_run_smoke_check_fails_when_the_url_is_unreachable():
    # Port 1 is reserved and nothing answers on it — same case
    # check.test.mjs's "url never responds" test covers for check.mjs alone.
    verdict, line = step_agent.run_smoke_check("http://127.0.0.1:1/", "Item Board")
    assert verdict == "fail"
    assert line.startswith("SMOKE_RESULT=fail:")


@requires_e2e_workspace
@pytest.mark.usefixtures("smoke_check_tmpdir")
def test_run_smoke_check_fails_when_the_subprocess_itself_times_out(monkeypatch):
    # A page that never finishes responding — check.mjs's own NAV_TIMEOUT_MS
    # (15s) would eventually catch this too, but shrinking
    # SMOKE_CHECK_TIMEOUT_S proves run_smoke_check's *own* TimeoutExpired
    # handling fires, not just that check.mjs eventually gives up.
    monkeypatch.setattr(step_agent, "SMOKE_CHECK_TIMEOUT_S", 2)
    stop_server, url = serve_html(b"<html><body><h1>Item Board</h1></body></html>", delay_s=30)
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        stop_server()
    assert verdict == "fail"
    assert "timed out" in line


def test_review_step_composes_each_pass_with_its_own_agents_persona(tmp_path, monkeypatch):
    """HZ-125's headline fix. The review step runs two passes — code review in
    the Eng voice, QA review in the QA voice — and both used to compose the
    item's single flat persona, so the QA reviewer was handed the
    specialization of the engineer whose diff it was reviewing."""
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []
    ok = {
        "summary": "ok",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
    }
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(ok, ok, calls))

    task = make_task(12, "Automated review (code + QA)", repo="acme/demo")
    task["item"]["personas"] = {"eng": "python", "qa": "data_integrity"}
    execute(task)

    assert len(calls) == 2
    code_pass = next(c for c in calls if "QA Reviewer agent" not in c["append_system"])
    qa_pass = next(c for c in calls if "QA Reviewer agent" in c["append_system"])

    assert persona_md("eng", "python") in code_pass["append_system"]
    assert persona_md("qa", "data_integrity") not in code_pass["append_system"]

    assert persona_md("qa", "data_integrity") in qa_pass["append_system"]
    for eng_persona in PERSONAS["eng"]:
        assert persona_md("eng", eng_persona) not in qa_pass["append_system"]


def test_review_step_reuses_prepare_branch_to_scrub_a_superseded_attempts_leftovers(tmp_path, monkeypatch):
    """HZ-50: every item gets its own git worktree, so a sibling item's run
    can no longer repoint this item's checkout at all (see
    test_concurrent_runs_on_different_items_do_not_clobber_each_other in
    test_workspaces.py for that guarantee). Within THIS item's own worktree,
    a superseded/killed implement attempt can still leave uncommitted
    leftovers — reusing prepare_branch (the same call the implement step
    makes) still needs to scrub those before review reads the diff."""
    ws, origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")

    # Simulate a superseded attempt on this same item leaving junk behind.
    (ws / "leftover.txt").write_text("uncommitted junk from a superseded attempt\n")

    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    ok = {
        "summary": "ok",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
    }
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(ok, ok, []))

    execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    branch = subprocess.run(
        ["git", "-C", str(ws), "branch", "--show-current"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert branch == "horizon/t-1"
    assert not (ws / "leftover.txt").exists()  # the other item's junk was scrubbed


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
        "run_agent",
        lambda *a, **k: {"result": json.dumps({"summary": "did the step", "artifact_md": big})},
    )
    result = execute(make_task(6, "Draft implementation plan"))
    assert result["artifacts"]["artifact_md"] == big


# ---- retry-on-parse-failure (HZ-44) ----
# A step agent's JSON reply can fail to parse for reasons unrelated to the
# quality of its work — e.g. an artifact_md that quotes a JSON example
# verbatim, leaving raw double quotes inside a JSON string value (the exact
# shape that discarded a passing Architecture review on HZ-43). One
# retry-with-feedback, mirroring pm_agent.process()'s recovery, turns that
# into a completed step instead of a cancelled run.


def sequenced_run_agent(replies, captured_calls):
    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        return replies[len(captured_calls) - 1]

    return _fake


def test_hz43_unescaped_quotes_in_artifact_md_recover_on_retry(monkeypatch):
    calls = []
    bad = (
        '{"summary": "reviewed", "artifact_md": "swap `{"items":[]}` for '
        '`{"ok":true,"itemCount":0}`..."}'
    )
    good = '{"summary": "reviewed, ok", "artifact_md": "# Architecture review\\npass-with-notes"}'
    replies = [{"result": bad, "session_id": "sess-1"}, {"result": good, "session_id": "sess-1"}]
    monkeypatch.setattr(step_agent, "run_agent", sequenced_run_agent(replies, calls))

    result = execute(make_task(7, "Architecture review"))

    assert len(calls) == 2
    assert result["summary"] == "reviewed, ok"
    assert result["artifacts"]["artifact_md"] == "# Architecture review\npass-with-notes"


def test_hz44_real_subprocess_recovers_from_the_hz43_quote_bug():
    """The tests above monkeypatch run_agent, so they never actually drive a
    `claude` invocation. This one doesn't monkeypatch anything: it runs the
    real subprocess path (fake_claude stands in for the `claude` binary, the
    same substitution every other unmocked test in this file relies on — see
    module docstring), through the real extract_json and the real retry in
    step_agent._run_and_parse. fake_claude reproduces the exact HZ-43 shape
    on its first reply, then a clean one once resumed."""
    task = make_task(7, "Architecture review")
    task["item"]["desc"] = "HZ44_QUOTE_BUG " + task["item"]["desc"]

    result = execute(task)

    assert result["summary"] == "reviewed, ok"
    assert result["artifacts"]["artifact_md"] == "# Architecture review\npass-with-notes"


def test_retry_is_bounded_at_one_and_a_second_failure_still_raises(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'  # truncated — unparseable both times
    monkeypatch.setattr(
        step_agent, "run_agent", sequenced_run_agent([{"result": bad}, {"result": bad}], calls)
    )

    with pytest.raises(Exception):
        execute(make_task(7, "Architecture review"))

    assert len(calls) == 2  # exactly one retry — no retry loop, run still cancels


def test_retry_reuses_session_id_and_the_original_call_budget(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'
    good = '{"summary": "ok"}'
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        sequenced_run_agent([{"result": bad, "session_id": "sess-abc"}, {"result": good}], calls),
    )

    execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert len(calls) == 2
    first, retry = calls
    assert retry["session_id"] == "sess-abc"  # HZ-44: reuse the session, don't resend the prompt
    for key in ("max_turns", "timeout_s", "allowed_tools", "append_system"):
        assert retry[key] == first[key]  # no budget growth on retry


def test_retry_feedback_message_matches_pm_agent_wording(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'
    good = '{"summary": "ok"}'
    monkeypatch.setattr(
        step_agent, "run_agent", sequenced_run_agent([{"result": bad}, {"result": good}], calls)
    )

    execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    retry_prompt = calls[1]["prompt"]
    assert retry_prompt.startswith("Your previous reply was invalid:")
    assert retry_prompt.endswith("Respond again with ONLY the JSON object, no other text.")


def test_implement_step_does_not_retry_on_a_malformed_final_reply(tmp_path, monkeypatch):
    """Step 11 already tolerates a malformed final message without failing
    the step (HZ-29) — the code in the workspace is the deliverable, not the
    summary. The HZ-44 retry machinery must not apply here."""
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []

    def _fake(prompt, **kwargs):
        calls.append(kwargs)
        (ws / "fake_implementation.txt").write_text("fake implementation\n")
        return {"result": "not json at all"}

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert len(calls) == 1  # no retry for the implement step
    assert "not valid JSON" in result["summary"]


def two_pass_run_agent_with_retries(code_results, qa_results, captured_calls):
    counters = {"code": 0, "qa": 0}

    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        is_qa = "QA Reviewer agent" in kwargs.get("append_system", "")
        key = "qa" if is_qa else "code"
        results = qa_results if is_qa else code_results
        idx = min(counters[key], len(results) - 1)
        counters[key] += 1
        return {"result": results[idx]}

    return _fake


def test_review_step_code_pass_recovers_independently_of_a_healthy_qa_pass(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    bad_code = '{"summary": "code review done", "verdict": "fail"'  # unparseable
    good_code = json.dumps(
        {
            "summary": "code review done",
            "verdict": "fail",
            "findings": [{"file": "app.py", "line": 1, "severity": "block", "detail": "x"}],
            "artifact_md": "## Code review\n**fail**",
        }
    )
    qa_json = json.dumps(
        {
            "summary": "qa review done",
            "verdict": "pass",
            "regression_tests_run": True,
            "new_code_unit_coverage": True,
            "e2e_test_present": True,
            "findings": [],
            "artifact_md": "## QA review\n**pass**",
        }
    )
    monkeypatch.setattr(
        step_agent, "run_agent", two_pass_run_agent_with_retries([bad_code, good_code], [qa_json], calls)
    )

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 3  # code pass retried once, QA pass succeeded first try
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["verdict"] == "pass"


def test_review_step_qa_pass_recovers_independently_of_a_healthy_code_pass(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    code_json = json.dumps({"summary": "code review done", "verdict": "pass", "findings": []})
    bad_qa = '{"summary": "qa review done", "verdict": "pass"'  # unparseable
    good_qa = json.dumps(
        {
            "summary": "qa review done",
            "verdict": "pass",
            "regression_tests_run": True,
            "new_code_unit_coverage": True,
            "e2e_test_present": True,
            "findings": [],
        }
    )
    monkeypatch.setattr(
        step_agent, "run_agent", two_pass_run_agent_with_retries([code_json], [bad_qa, good_qa], calls)
    )

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 3  # QA pass retried once, code pass succeeded first try
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"


def test_review_step_code_pass_exhausting_its_retry_still_cancels_the_run(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    bad_code = '{"summary": "code review done", "verdict": "fail"'  # unparseable, both attempts
    qa_json = json.dumps({"summary": "qa review done", "verdict": "pass"})
    monkeypatch.setattr(
        step_agent, "run_agent", two_pass_run_agent_with_retries([bad_code, bad_code], [qa_json], calls)
    )

    with pytest.raises(Exception):
        execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    # the code pass fails before the QA pass is ever attempted
    assert len(calls) == 2
    assert all("QA Reviewer agent" not in c.get("append_system", "") for c in calls)


# ---- checkpoint salvage on turn/time exhaustion (HZ-31) ----
# A run that hits its max-turns/timeout cap must not lose its uncommitted
# work: the next attempt's prepare_branch() would otherwise scrub the
# worktree (reset --hard + clean -fd) before starting from zero with the
# same budget — a Sisyphus loop that can never converge on an oversized item.


def origin_log(origin):
    return subprocess.run(
        ["git", "--git-dir", str(origin), "log", "--format=%s", "horizon/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def test_implement_step_pushes_a_checkpoint_when_run_agent_raises(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    def _fake(prompt, **kwargs):
        (ws / "fake_implementation.txt").write_text("partial work\n")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(AgentError, match="timed out"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    log_text = origin_log(origin)
    assert step_agent.CHECKPOINT_MARKER in log_text
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:fake_implementation.txt"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "partial work" in shown


def test_implement_step_does_not_checkpoint_a_kill_before_any_edit(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    def _fake(prompt, **kwargs):
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(AgentError):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    branches = subprocess.run(
        ["git", "--git-dir", str(origin), "branch", "--list"], capture_output=True, text=True, check=True
    ).stdout
    assert "horizon/t-1" not in branches


def origin_body(origin, ref="horizon/t-1"):
    return subprocess.run(
        ["git", "--git-dir", str(origin), "log", "-1", "--format=%b", ref],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def finished_run(ws, filename="fake_implementation.txt", text="finished work\n"):
    """A run_agent that completes normally after writing one file."""

    def _fake(prompt, **kwargs):
        if filename:
            (ws / filename).write_text(text)
        return {"result": '{"summary": "built it"}'}

    return _fake


def test_checks_failure_after_finished_run_pushes_checkpoint_and_next_attempt_resumes(tmp_path, monkeypatch):
    """HZ-184 metric 1 + guardrail "never push a checkpoint as if it passed":
    the finished work is checkpointed with what failed, finalize and the
    screenshot publish never run, and the next attempt starts on that work
    with the failure in its prompt."""
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'ok 1 - fine'; echo 'not ok 2 - widget renders'; echo '# fail 1'; exit 1")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))
    spies = []
    monkeypatch.setattr(step_agent, "finalize_branch", lambda *a, **k: spies.append("finalize_branch"))
    monkeypatch.setattr(step_agent, "publish_screenshots", lambda *a, **k: spies.append("publish_screenshots"))

    with pytest.raises(step_agent.CheckFailure, match="repo checks failed"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert spies == []
    assert origin_log(origin).splitlines()[0] == f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"
    body = origin_body(origin)
    assert body.startswith("cause: checks-failed")
    assert "not ok 2 - widget renders" in body
    assert "# fail 1" in body  # a '#' line survives the commit message cleanup

    # Attempt 2: checks now pass. Leftovers in the worktree are scrubbed, but
    # attempt 1's work is there before the agent starts — from the checkpoint.
    monkeypatch.undo()
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    (ws / "fake_implementation.txt").unlink()
    seen = {}

    def attempt_2(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["file"] = (ws / "fake_implementation.txt").read_text()
        (ws / "more.txt").write_text("the fix\n")
        return {"result": '{"summary": "fixed the widget"}'}

    monkeypatch.setattr(step_agent, "run_agent", attempt_2)
    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert seen["file"] == "finished work\n"
    assert "not ok 2 - widget renders" in seen["prompt"]
    assert "holds the previous attempt's complete work" in seen["prompt"]
    assert result["artifacts"]["branch"] == "horizon/t-1"


def test_checks_failure_with_no_edits_still_checkpoints_the_failure(tmp_path, monkeypatch):
    """A failure caused by main alone (HZ-157): no diff, but the next attempt
    must still learn what failed — so the checkpoint is committed empty."""
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "echo 'FAILED tests/test_main.py::test_broken_on_main'; exit 1")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws, filename=None))

    with pytest.raises(step_agent.CheckFailure):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert step_agent.CHECKPOINT_MARKER in origin_log(origin).splitlines()[0]
    body = origin_body(origin)
    assert body.startswith("cause: checks-failed")
    assert "FAILED tests/test_main.py::test_broken_on_main" in body
    changed = subprocess.run(
        ["git", "--git-dir", str(origin), "diff", "--name-only", "main", "horizon/t-1"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert changed == ""


def test_exhaustion_checkpoint_records_its_cause(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    def _fake(prompt, **kwargs):
        (ws / "fake_implementation.txt").write_text("partial work\n")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    with pytest.raises(AgentError):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert origin_body(origin).strip() == "cause: exhausted"


def test_check_output_secrets_never_reach_the_commit_body_or_log(tmp_path, monkeypatch, capsys):
    """A farm secret the scrubbed check env doesn't even carry, printed by the
    check from a file, is redacted from everything that leaves the run."""
    ws, origin = make_git_workspace(tmp_path)
    secret = "ghp_" + "Z9" * 18
    secret_file = tmp_path / "leak"
    secret_file.write_text(secret)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("GITHUB_TOKEN", secret)
    monkeypatch.setattr(checks, "_check_env", lambda: {k: v for k, v in os.environ.items() if k != "GITHUB_TOKEN"})
    monkeypatch.setenv("FARM_CHECK_CMD", f"echo \"not ok 1 - auth with $(cat {secret_file})\"; exit 1")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))

    with pytest.raises(step_agent.CheckFailure) as err:
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert secret not in str(err.value) and "not ok 1 - auth with [redacted]" in str(err.value)
    assert secret not in err.value.digest
    assert secret not in origin_body(origin) and "[redacted]" in origin_body(origin)
    assert secret not in capsys.readouterr().out


def make_checkpoint(ws, origin, *, cause="checks-failed", detail="not ok 7 - x", path="wip.txt", text="wip\n"):
    """Pushes a checkpoint commit to origin/horizon/t-1 the way salvage writes
    it (cause=None: a pre-HZ-184 checkpoint, with no body at all) and returns
    its sha."""
    git(ws, "checkout", "-B", "horizon/t-1", "origin/main")
    (ws / path).write_text(text)
    git(ws, "add", "-A")
    msg = ["-m", f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"]
    if cause:
        msg += ["-m", f"cause: {cause}\n\n{detail}"]
    git(ws, "commit", *msg)
    git(ws, "push", "-f", "origin", "horizon/t-1")
    git(ws, "checkout", "main")
    return subprocess.run(
        ["git", "--git-dir", str(origin), "rev-parse", "horizon/t-1"], capture_output=True, text=True, check=True
    ).stdout.strip()


def advance_main(tmp_path, origin, path="main_fix.txt", text="fix on main\n"):
    other = tmp_path / f"other-{path.replace('/', '_')}"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(other)], check=True, capture_output=True)
    git(other, "config", "user.email", "other@example.com")
    git(other, "config", "user.name", "Other")
    (other / path).write_text(text)
    git(other, "add", "-A")
    git(other, "commit", "-m", f"main: {path}")
    git(other, "push", "origin", "main")


def head_contains_main(ws):
    return subprocess.run(
        ["git", "-C", str(ws), "merge-base", "--is-ancestor", "origin/main", "HEAD"], capture_output=True
    ).returncode == 0


ITEM = {"id": "T-1", "title": "Test item", "repo": "acme/demo"}


def test_checkpoint_rebases_onto_advanced_main(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    checkpoint = make_checkpoint(ws, origin)
    advance_main(tmp_path, origin)

    prepared = step_agent.prepare_branch(ws, ITEM, rebase_checkpoint=True)

    assert prepared.lease_sha == checkpoint
    assert head_contains_main(ws)
    assert (ws / "main_fix.txt").exists() and (ws / "wip.txt").exists()
    assert step_agent._checkpoint_cause(ws) == ("checks-failed", "not ok 7 - x")
    assert "rebased onto current origin/main" in prepared.note

    # The rebased checkpoint finalizes over the remote one it replaced: the
    # lease names exactly the sha prepare_branch checked out.
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws, "done.txt"))
    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))
    assert result["artifacts"]["branch"] == "horizon/t-1"
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:main_fix.txt"], capture_output=True, text=True, check=True
    ).stdout
    assert shown == "fix on main\n"


def test_conflicting_rebase_aborts_and_resumes_unrebased_with_note(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    checkpoint = make_checkpoint(ws, origin, path="README.md", text="# checkpoint's readme\n")
    advance_main(tmp_path, origin, path="README.md", text="# main's readme\n")

    prepared = step_agent.prepare_branch(ws, ITEM, rebase_checkpoint=True)

    head = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert head == checkpoint == prepared.lease_sha
    assert not head_contains_main(ws)
    assert not (ws / ".git" / "rebase-merge").exists() and not (ws / ".git" / "rebase-apply").exists()
    assert (ws / "README.md").read_text() == "# checkpoint's readme\n"
    assert "could not be rebased" in prepared.note and "unrebased" in prepared.note


def test_checkpoint_whose_parent_is_a_merge_of_main_takes_a_known_path(tmp_path):
    """HZ-188's send-back merges main into the branch, so a checkpoint can sit
    on a merge commit. Rebase linearizes it; either way no work is lost."""
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "checkout", "-B", "horizon/t-1", "origin/main")
    (ws / "feature.txt").write_text("feature\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "T-1: feature")
    git(ws, "push", "-f", "origin", "horizon/t-1")
    advance_main(tmp_path, origin, path="m1.txt")
    git(ws, "fetch", "origin")
    git(ws, "merge", "--no-edit", "origin/main")
    (ws / "wip.txt").write_text("wip\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)", "-m", "cause: exhausted")
    git(ws, "push", "-f", "origin", "horizon/t-1")
    git(ws, "checkout", "main")
    advance_main(tmp_path, origin, path="m2.txt")

    prepared = step_agent.prepare_branch(ws, ITEM, rebase_checkpoint=True)

    assert "rebased onto current origin/main" in prepared.note
    assert head_contains_main(ws)
    for path in ("feature.txt", "wip.txt", "m1.txt", "m2.txt"):
        assert (ws / path).exists(), path


def test_prepare_branch_never_rebases_without_being_asked(tmp_path):
    """The fix-scope path (HZ-182): base_sha..HEAD must stay a valid diff."""
    ws, origin = make_git_workspace(tmp_path)
    checkpoint = make_checkpoint(ws, origin)
    advance_main(tmp_path, origin)

    prepared = step_agent.prepare_branch(ws, ITEM)

    head = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert head == checkpoint and prepared.note == ""


def test_fix_pass_hears_the_last_check_failure_without_a_continue_note(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    checkpoint = make_checkpoint(ws, origin, detail="not ok 9 - the fix broke this")
    advance_main(tmp_path, origin)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    seen = {}

    def _fake(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["head"] = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        (ws / "fix.txt").write_text("fix\n")
        return {"result": '{"summary": "fixed"}'}

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["scope"] = {"mode": "fix", "base_sha": checkpoint, "findings": []}
    execute(task)

    assert seen["head"] == checkpoint  # not rebased
    assert "not ok 9 - the fix broke this" in seen["prompt"]
    assert "Do not discard it or restart" not in seen["prompt"]


def test_resume_note_names_last_failure_and_preserved_work(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    make_checkpoint(ws, origin, detail="not ok 3 - parser\n# fail 1")
    step_agent.prepare_branch(ws, ITEM)

    note = step_agent._checkpoint_resume_note(ws)

    assert "repo's checks failed" in note
    assert "not ok 3 - parser\n# fail 1" in note
    assert "holds the previous attempt's complete work" in note
    assert "wip.txt" in note


def test_a_pre_hz184_checkpoint_with_no_body_keeps_todays_note_and_is_rebased(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    make_checkpoint(ws, origin, cause=None)
    advance_main(tmp_path, origin)

    prepared = step_agent.prepare_branch(ws, ITEM, rebase_checkpoint=True)
    note = step_agent._checkpoint_resume_note(ws)

    assert "rebased onto current origin/main" in prepared.note
    assert "ran out of turns/time" in note
    assert "checks failed" not in note


def test_push_rejected_when_remote_moved_after_prepare(tmp_path):
    """The hub fetch shares refs/remotes/origin/* across every item's
    worktree: another item's fetch moving origin/horizon/t-1 after this
    attempt's prepare_branch must not turn a stale push into a valid lease."""
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "push", "origin", "HEAD:horizon/t-1")
    prepared = step_agent.prepare_branch(ws, ITEM)

    race = tmp_path / "race"
    subprocess.run(["git", "clone", "--quiet", "-b", "horizon/t-1", str(origin), str(race)], check=True, capture_output=True)
    git(race, "config", "user.email", "race@example.com")
    git(race, "config", "user.name", "Racer")
    (race / "race.txt").write_text("someone else's push\n")
    git(race, "add", "-A")
    git(race, "commit", "-m", "concurrent push")
    git(race, "push", "origin", "horizon/t-1")
    git(ws, "fetch", "origin")  # another item's fetch, through the shared refs

    (ws / "mine.txt").write_text("mine\n")
    with pytest.raises(RuntimeError):
        step_agent.finalize_branch(ws, ITEM, prepared.branch, lease_sha=prepared.lease_sha)
    assert "concurrent push" in origin_log(origin)


def test_main_reports_a_failure_at_line_900_end_to_end(tmp_path, monkeypatch):
    """HZ-184 metric 2 across the farm boundary: the error main() posts holds
    the failure printed after 899 passing lines, and the counts."""
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv(
        "FARM_CHECK_CMD",
        "for i in $(seq 1 899); do echo \"ok $i - passing test number $i\"; done; "
        "echo 'not ok 900 - x'; echo '# pass 899'; echo '# fail 1'; exit 1",
    )
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["json"] = json

        class _Resp:
            pass

        return _Resp()

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)

    step_agent.main()

    error = posted["json"]["error"]
    assert posted["json"]["ok"] is False and "artifacts" not in posted["json"]
    assert error.startswith("repo checks failed (sh -c ")
    assert "not ok 900 - x" in error and "# pass 899" in error and "# fail 1" in error
    assert len(error) <= step_agent.ERROR_MAX_CHARS


def test_error_cap_fits_the_servers_fail_route_limit():
    """Over the route's maxLength, Fastify rejects the whole report with a 400
    and the failure is lost to a watchdog timeout."""
    app_js = (Path(__file__).resolve().parents[2] / "server" / "src" / "app.js").read_text()
    route = app_js[app_js.index("'/api/farm/steps/:runId/fail'"):]
    limit = int(re.search(r"error: \{ type: 'string', maxLength: (\d+) \}", route).group(1))
    assert step_agent.ERROR_MAX_CHARS <= limit


def test_salvage_never_fires_for_planner_steps(monkeypatch):
    """No call site for _salvage_checkpoint exists outside the step-11
    branch, but pin that down with a regression test rather than leaving it
    implied by "no call site exists"."""
    spy = []
    monkeypatch.setattr(step_agent, "_salvage_checkpoint", lambda *a, **k: spy.append(1))

    def _fake(prompt, **kwargs):
        raise AgentError("claude timed out after 1140s")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(AgentError):
        execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert spy == []


def test_salvage_swallows_a_lease_conflict_and_the_original_error_still_wins(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    # Establish the branch on origin first so ws's prepare_branch() fetch
    # records a remote-tracking ref for it — the lease race below needs that
    # ref to be stale, not absent.
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")

    race = tmp_path / "race"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(race)], check=True, capture_output=True)
    git(race, "config", "user.email", "race@example.com")
    git(race, "config", "user.name", "Racer")

    def _fake(prompt, **kwargs):
        (ws / "fake_implementation.txt").write_text("partial work\n")
        # A concurrent writer moves origin's branch tip after ws's own
        # prepare_branch() fetch, so ws's remote-tracking ref is stale by the
        # time salvage tries to push — --force-with-lease must reject it.
        git(race, "checkout", "horizon/t-1")
        (race / "race.txt").write_text("someone else's push\n")
        git(race, "add", "-A")
        git(race, "commit", "-m", "concurrent push")
        git(race, "push", "origin", "horizon/t-1")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(AgentError, match="timed out"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    # Salvage's own push lost the lease race and was swallowed — the
    # original AgentError above is what propagated, and origin shows only
    # the concurrent writer's commit, never the checkpoint.
    log_text = origin_log(origin)
    assert step_agent.CHECKPOINT_MARKER not in log_text
    assert "concurrent push" in log_text


def test_checkpoint_resume_note_reaches_the_next_attempts_prompt(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    def _exhausted(prompt, **kwargs):
        (ws / "fake_implementation.txt").write_text("partial work\n")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", _exhausted)
    with pytest.raises(AgentError):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert step_agent.CHECKPOINT_MARKER in captured["prompt"]
    assert "fake_implementation.txt" in captured["prompt"]


def test_two_exhausted_attempts_then_a_successful_run_converges_with_continuation_history(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    def attempt_1(prompt, **kwargs):
        (ws / "part_a.txt").write_text("part a\n")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", attempt_1)
    with pytest.raises(AgentError):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    def attempt_2(prompt, **kwargs):
        assert step_agent.CHECKPOINT_MARKER in prompt  # attempt 2 was told to continue
        (ws / "part_b.txt").write_text("part b\n")
        raise AgentError("claude timed out after 2700s")

    monkeypatch.setattr(step_agent, "run_agent", attempt_2)
    with pytest.raises(AgentError):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    def attempt_3(prompt, **kwargs):
        assert step_agent.CHECKPOINT_MARKER in prompt  # attempt 3 also sees the checkpoint note
        (ws / "part_c.txt").write_text("part c\n")
        return {"result": '{"summary": "finished the item"}'}

    monkeypatch.setattr(step_agent, "run_agent", attempt_3)


# ---- main(): the reason tag that crosses into the Node payload (HZ-76) ----
# The orchestrator only auto-retries a small, explicit set of reasons — this
# is the one Python originates. A Node-side test can fake the string, but
# only this proves the callback payload actually carries it end-to-end from
# a real AgentExhaustedError.


def test_main_tags_a_turn_cap_exhaustion_with_reason_turn_cap(tmp_path, monkeypatch):
    task = {"run_id": 42, "step": {"index": 4, "label": "Plan options & trade-offs (pros / cons)"}, "item": {"id": "T-1"}}
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))

    def _exhausted(t):
        raise AgentExhaustedError("claude reported an error result [error_max_turns]: ran out of turns")

    monkeypatch.setattr(step_agent, "execute", _exhausted)
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["url"], posted["json"] = url, json

        class _Resp:
            pass

        return _Resp()

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)

    step_agent.main()

    assert posted["json"]["ok"] is False
    assert posted["json"]["reason"] == "turn_cap"
    assert not task_file.exists()


def test_main_does_not_tag_a_reason_for_an_ordinary_failure(tmp_path, monkeypatch):
    """A non-turn-cap failure (e.g. a checks-failed RuntimeError) must not
    carry any reason — that is what keeps it un-retryable server-side."""
    task = {"run_id": 43, "step": {"index": 4, "label": "Plan options & trade-offs (pros / cons)"}, "item": {"id": "T-1"}}
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))

    monkeypatch.setattr(step_agent, "execute", lambda t: (_ for _ in ()).throw(RuntimeError("repo checks failed")))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["json"] = json

        class _Resp:
            pass

        return _Resp()

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)

    step_agent.main()

    assert posted["json"]["ok"] is False
    assert "reason" not in posted["json"]


# ---- HZ-156: the shared parser's notes channel, on every path ----
# step_agent has five places a reply is parsed (implement, the code-review and
# QA-review passes, deploy, and the generic planner tail). Surfacing notes on
# only one of them would reintroduce exactly the per-caller drift the shared
# parser exists to remove, so each path gets its own test.


@pytest.fixture
def injected_note(monkeypatch):
    """Injects a parser note through the seam the later repair items report
    through. The note names the parsed summary, so a test covering two passes
    can tell which one produced it."""
    from farm import agent_runner

    def _notes_for(text, parsed):
        label = parsed.get("summary") or parsed.get("verdict") or "?"
        return [f"note<{label}>"]

    monkeypatch.setattr(agent_runner, "_notes_for", _notes_for)
    return _notes_for


def test_a_note_reaches_the_generic_planner_path(injected_note):
    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))
    assert "note<" in result["summary"]
    assert "## Parser notes" in result["artifacts"]["artifact_md"]


def test_a_note_reaches_the_implement_path(tmp_path, monkeypatch, injected_note):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    # The check note is still there — the parser note is appended after it, and
    # finalize_branch's artifacts carry no artifact_md to stamp.
    assert "no repo checks detected" in result["summary"]
    assert "note<" in result["summary"]


def test_a_note_reaches_both_review_passes(tmp_path, monkeypatch, injected_note):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    code_json = {"summary": "code-pass", "verdict": "pass", "findings": [], "artifact_md": "## Code review"}
    qa_json = {
        "summary": "qa-pass",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
        "artifact_md": "## QA review",
    }
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(code_json, qa_json, []))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    # Neither pass is silently dropped: both notes reach both surfaces.
    assert "note<code-pass>" in result["summary"] and "note<qa-pass>" in result["summary"]
    artifact = result["artifacts"]["artifact_md"]
    assert "- note<code-pass>" in artifact and "- note<qa-pass>" in artifact
    assert result["artifacts"]["verdict"]["code_review"]["verdict"] == "pass"


def test_a_note_reaches_the_deploy_path(monkeypatch, injected_note):
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        devops_run_agent(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        ),
    )
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: ("pass", "SMOKE_RESULT=pass"))

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))

    assert "SMOKE_RESULT=pass" in result["summary"]  # the machine verdict still leads
    assert "note<verified the deploy>" in result["summary"]
    assert "- note<verified the deploy>" in result["artifacts"]["artifact_md"]


def test_a_note_survives_a_max_length_summary_and_artifact(monkeypatch, injected_note):
    """Appending a suffix and re-slicing to 600 would drop the note whenever the
    summary is already at its cap — which is the common case, not an edge one."""
    long_reply = json.dumps({"summary": "s" * 900, "artifact_md": "a" * 50})
    monkeypatch.setattr(step_agent, "run_agent", lambda prompt, **kw: {"result": long_reply})

    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert len(result["summary"]) == 600
    assert "note<" in result["summary"]


def test_with_no_notes_the_result_is_byte_identical(monkeypatch):
    """The 'behaviour otherwise unchanged' proof: _notes_for returns [] in this
    item, so the whole result dict is what it was before the channel existed."""
    reply = json.dumps({"summary": "did the step", "artifact_md": "# out"})
    monkeypatch.setattr(step_agent, "run_agent", lambda prompt, **kw: {"result": reply})

    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert result == {"summary": "did the step", "artifacts": {"artifact_md": "# out"}}


# ---- HZ-156: a stray leading object must still take the lossless retry ----
# extract_json()'s attempt 3 lifts the FIRST balanced object out of a reply, so
# `Example: {} \n {...}` — which used to fail both parse attempts and be
# recovered by the retry — now parses, to the stray `{}`. parse_agent_reply()
# spends the retry on exactly that reply anyway, so every path below keeps the
# recovery it had before this item WITHOUT any step-side validator: this module's
# required-field checks all still run after _run_and_parse() returns, where they
# have always run. The pair of tests further down pins the other half — a reply
# that parses whole and is missing a field costs no extra agent run.

STRAY_LEADING_OBJECT = 'Example: {} \n {"summary": "did the step", "artifact_md": "# out"}'


def test_the_stray_leading_object_fixture_really_parses_to_the_stray_object():
    """Anti-vacuity guard for every test below: if extract_json stopped lifting
    the leading object, they would all pass for the wrong reason."""
    from farm.agent_runner import extract_json

    assert extract_json(STRAY_LEADING_OBJECT) == {}


def _replies(*texts, writes_into=None):
    """A run_agent fake returning each text in turn, recording the prompts.

    writes_into is the workspace an implement-step fake must leave a real change
    in — finalize_branch refuses to push an empty diff, so a fake that only
    talks would fail the step before the summary under test is ever read."""
    calls = []

    def _fake(prompt, **kwargs):
        calls.append(prompt)
        if writes_into is not None:
            (writes_into / "note.txt").write_text(f"change {len(calls)}\n")
        return {"result": texts[min(len(calls) - 1, len(texts) - 1)], "session_id": "sess-1"}

    return _fake, calls


def test_a_stray_leading_object_still_takes_the_retry_on_the_generic_path(monkeypatch):
    fake, calls = _replies(STRAY_LEADING_OBJECT, json.dumps({"summary": "recovered", "artifact_md": "# out"}))
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert result["summary"] == "recovered"
    assert len(calls) == 2
    # The retry names the parse failure the reply produced before attempt 3
    # existed — the same prompt this path has always sent.
    assert "Your previous reply was invalid" in calls[1]
    assert "Extra data" in calls[1]  # the widest-span decode error, verbatim


def test_a_stray_leading_object_still_takes_the_retry_on_the_deploy_path(monkeypatch):
    good = json.dumps(
        {
            "summary": "verified the deploy",
            "url": "https://shoreward.ai/horizon/",
            "expected_text": "Horizon",
            "artifact_md": "## Deploy target",
        }
    )
    fake, calls = _replies(f"Example: {{}} \n {good}", good)
    monkeypatch.setattr(step_agent, "run_agent", fake)
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: ("pass", "SMOKE_RESULT=pass"))

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))

    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert len(calls) == 2
    assert "Your previous reply was invalid" in calls[1]


def test_a_stray_leading_object_still_takes_the_retry_on_both_review_passes(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    code_good = json.dumps({"summary": "code review done", "verdict": "pass", "findings": []})
    qa_good = json.dumps(
        {
            "summary": "qa review done",
            "verdict": "pass",
            "regression_tests_run": True,
            "new_code_unit_coverage": True,
            "e2e_test_present": True,
            "findings": [],
        }
    )
    calls = []
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        two_pass_run_agent_with_retries(
            [f"Example: {{}} \n {code_good}", code_good], [f"Example: {{}} \n {qa_good}", qa_good], calls
        ),
    )

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"
    assert len(calls) == 4  # each pass retried exactly once, and recovered


# ---- HZ-156: a reply that parses whole buys no extra agent run ----
# The other half of the boundary. A missing required field is checked after
# _run_and_parse() returns, so a well-formed reply that simply lacks the field
# costs exactly one run, exactly as before this item. Moving those checks inside
# the retry envelope would have spent a second full agent run on each of these —
# and on the review path a retried reply could come back "pass", flipping a gate
# that _code_review_section() deliberately fails closed.


def test_a_review_reply_with_no_verdict_fails_closed_with_no_extra_run(tmp_path, monkeypatch):
    """A verdict-less review reply already has a defined outcome: fail closed,
    never cancel the run, never a second attempt that might come back "pass"."""
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    junk = {"summary": "not the right shape"}
    calls = []
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(junk, junk, calls))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["verdict"] == "fail"
    assert len(calls) == 2  # one run per pass — the fail-closed default is free


def test_a_deploy_reply_with_no_url_cancels_with_no_extra_run(monkeypatch):
    """Valid JSON, no 'url': cancels the run on the first pass, as it always has.
    A second devops run is the most expensive retry in the farm."""
    fake, calls = _replies(json.dumps({"summary": "done"}))
    monkeypatch.setattr(step_agent, "run_agent", fake)

    with pytest.raises(AgentError, match="missing 'url'"):
        execute(make_task(14, "Deploy the changes", repo="acme/demo"))
    assert len(calls) == 1


def test_a_generic_reply_with_no_summary_cancels_with_no_extra_run(monkeypatch):
    fake, calls = _replies(json.dumps({"artifact_md": "# out"}))
    monkeypatch.setattr(step_agent, "run_agent", fake)

    with pytest.raises(AgentError, match="missing 'summary'"):
        execute(make_task(4, "Plan options & trade-offs (pros / cons)"))
    assert len(calls) == 1


# ---- HZ-156: the implement path has no retry, so it reports instead ----


def test_a_reply_with_no_summary_says_so_on_the_implement_path(tmp_path, monkeypatch):
    """The implement step deliberately omits retry= (a second full implement
    run costs far more than a bad summary). So a stray leading object parses to
    `{}` and the default summary would read exactly like a clean run — a note
    is the only thing left to tell the human the reply was junk."""
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, calls = _replies(STRAY_LEADING_OBJECT, writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert len(calls) == 1  # still no retry on this path
    assert "implementation finished" in result["summary"]
    assert "carried no 'summary'" in result["summary"]


def test_an_empty_summary_on_the_implement_path_is_reported_too(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, _calls = _replies(json.dumps({"summary": "   "}), writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "carried no 'summary'" in result["summary"]


def test_an_unparseable_implement_reply_still_reports_the_json_fallback(tmp_path, monkeypatch):
    """The other branch, unchanged: no JSON at all still says so, and does not
    get the note instead."""
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, _calls = _replies("plain prose, no json", writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "was not valid JSON" in result["summary"]
    assert "carried no 'summary'" not in result["summary"]


def test_a_good_implement_summary_carries_no_note(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, _calls = _replies(json.dumps({"summary": "built the thing"}), writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["summary"].startswith("built the thing · ")
    assert "carried no 'summary'" not in result["summary"]


# ---- HZ-156: the summary cap is one constant, not a literal per call site ----


def test_moving_the_summary_cap_moves_both_the_slice_and_the_notes_budget(monkeypatch):
    """Restating the cap as a literal at each shaping site is hidden coupling:
    stamp_notes() reserves room inside exactly the budget the summary was
    already sliced to, so a cap raised in one place and not the other would
    silently truncate the notes back off."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["n"])
    monkeypatch.setattr(step_agent, "SUMMARY_MAX_CHARS", 80)
    fake, _calls = _replies(json.dumps({"summary": "s" * 900}))
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert len(result["summary"]) == 80
    assert result["summary"].endswith(" [n]")


# ---- an exhaustion raised BY the retry keeps its turn_cap tag ----
# AgentExhaustedError subclasses AgentError, so a handler broad enough to catch
# a parse failure around the retry call would swallow it — and the orchestrator
# only auto-retries a run that still carries the tag.


def test_an_exhaustion_inside_the_retry_propagates_out_of_execute(monkeypatch):
    calls = []

    def _fake(prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            return {"result": "plain prose, not json", "session_id": "sess-1"}
        raise AgentExhaustedError("claude reported an error result [error_max_turns]")

    monkeypatch.setattr(step_agent, "run_agent", _fake)

    with pytest.raises(AgentExhaustedError):
        execute(make_task(7, "Architecture review"))
    assert len(calls) == 2  # the retry really was attempted


def test_an_exhaustion_inside_the_retry_is_reported_with_reason_turn_cap(tmp_path, monkeypatch):
    """The same case through main(), which is where the tag actually reaches the
    wire — the mirror of pm_agent's new test."""
    task = make_task(7, "Architecture review")
    task["run_id"] = 99
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))
    calls = []

    def _fake(prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            return {"result": "plain prose, not json", "session_id": "sess-1"}
        raise AgentExhaustedError("ran out of turns")

    monkeypatch.setattr(step_agent, "run_agent", _fake)
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["json"] = json

        class _Resp:
            pass

        return _Resp()

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)

    step_agent.main()

    assert posted["json"]["ok"] is False
    assert posted["json"]["reason"] == "turn_cap"


# ---- HZ-157: a repaired reply's note on both of this caller's surfaces ----
# step_agent is the caller with a real artifact, so both shapes are asserted on
# both surfaces here. The implement path is covered separately: it passes no
# retry, which is what makes its tier rules different.


# `repair_counter` is the suite-wide autouse fixture in farm/tests/conftest.py,
# which repoints the counter into tmp_path. Named in the signatures below so the
# dependency of a count assertion is visible where it is made.


def _mangle(payload: dict, shape: str) -> str:
    """Re-serialize a well-formed reply into one of the two broken shapes, so
    the only difference from a clean reply is the defect under test."""
    good = json.dumps(payload)
    if shape == "trailing_comma":
        return good[:-1] + ",}"
    return good.replace('"', "'")


@pytest.mark.parametrize(
    "shape,note_attr,expected_runs",
    [
        ("trailing_comma", "TRAILING_COMMA_NOTE", 1),
        ("single_quotes", "SINGLE_QUOTE_NOTE", 2),
    ],
)
def test_a_repaired_reply_notes_both_surfaces_on_the_planner_path(
    monkeypatch, repair_counter, shape, note_attr, expected_runs
):
    from farm import agent_runner

    note = getattr(agent_runner, note_attr)
    broken = _mangle({"summary": "planned it", "artifact_md": "# Options"}, shape)
    fake, calls = _replies(broken, broken)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert result["summary"].startswith("planned it")
    assert len(calls) == expected_runs
    assert note in result["summary"], "the repair is missing from the run's output line"
    assert f"- {note}" in result["artifacts"]["artifact_md"], "the artifact has no note"
    assert agent_runner.repair_counts() == {shape: 1}


def test_a_repaired_reply_notes_the_summary_on_the_implement_path(
    tmp_path, monkeypatch, repair_counter
):
    """The implement step passes no retry, so only the unambiguous rung can
    fire here — and finalize_branch returns no artifact_md, which makes the
    summary this path's only note surface."""
    from farm import agent_runner

    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, calls = _replies(_mangle({"summary": "built it"}, "trailing_comma"), writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "built it" in result["summary"]
    assert agent_runner.TRAILING_COMMA_NOTE in result["summary"]
    assert len(calls) == 1
    assert agent_runner.repair_counts() == {"trailing_comma": 1}


def test_a_single_quoted_implement_reply_is_not_repaired(tmp_path, monkeypatch, repair_counter):
    """No retry to spend means the lossless retry can never run, so the
    ambiguous rung must not fire. The step still completes — the code in the
    workspace is the deliverable — and says the reply was not valid JSON."""
    from farm import agent_runner

    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    fake, calls = _replies(_mangle({"summary": "built it"}, "single_quotes"), writes_into=ws)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "not valid JSON" in result["summary"]
    assert "built it" not in result["summary"], "an ambiguous repair fired with no retry spent"
    assert len(calls) == 1
    assert agent_runner.repair_counts() == {}


def test_a_repaired_reply_notes_both_review_passes(tmp_path, monkeypatch, repair_counter):
    """Five places in this module parse a reply; the two review passes are the
    pair that could most easily surface a note from only one of them."""
    from farm import agent_runner

    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    broken = _mangle({"verdict": "pass", "summary": "looks fine", "artifact_md": "# Review"}, "trailing_comma")
    fake, calls = _replies(broken)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    result = execute(make_task(12, step_agent.REVIEW_LABEL, repo="acme/demo"))

    assert agent_runner.TRAILING_COMMA_NOTE in result["summary"]
    # Both passes repaired their own reply, so the counter saw both.
    assert agent_runner.repair_counts() == {"trailing_comma": 2}


def test_an_unrepairable_step_reply_still_cancels_the_run(monkeypatch, repair_counter):
    """No fabricated summary: an unparseable reply that no rung can fix fails
    the step, exactly as it does today."""
    from farm import agent_runner

    bad = '{"summary":"he said "hi" to me"}'
    fake, calls = _replies(bad, bad)
    monkeypatch.setattr(step_agent, "run_agent", fake)

    with pytest.raises((AgentError, json.JSONDecodeError)):
        execute(make_task(4, "Plan options & trade-offs (pros / cons)"))
    assert len(calls) == 2, "the lossless retry is still spent first"
    assert agent_runner.repair_counts() == {}


# ---- step models (HZ-192) ----
# run_agent() resolves every step's model from domain/personas.json's `models`
# block. These run the REAL run_agent() over recording providers (conftest's
# recording_providers) and assert the model each step_agent call site actually
# handed its provider — so a call site passing the wrong agent, step or persona
# fails here even though the AST check in test_model_call_sites.py passes.

STEP_OPUS = "claude-opus-5-5"
PLAN_LABEL = "Plan options & trade-offs (pros / cons)"


def fabricated_models(monkeypatch, **overrides):
    """Points run_agent()'s resolver at a fabricated `models` block: the live
    agent defaults plus the given step/persona overrides."""
    import functools

    from domain.py import personas as domain_personas
    from farm import agent_runner

    models = {
        "agents": dict(domain_personas.MODELS["agents"]),
        "steps": overrides.get("steps", {}),
        "personas": overrides.get("personas", {}),
    }
    monkeypatch.setattr(agent_runner, "resolve_model", functools.partial(domain_personas.resolve_model, models=models))


def test_both_run_and_parse_call_sites_hand_the_step_model_to_claude(recording_providers):
    # An invalid first reply forces the retry call site too.
    recorder = recording_providers("not json", '{"summary": "ok"}')

    execute(make_task(4, PLAN_LABEL))

    assert [c["provider"] for c in recorder.calls] == ["claude", "claude"]
    assert recorder.models()[0] == STEP_OPUS, "step_agent._run_and_parse: first run_agent call"
    assert recorder.models()[1] == STEP_OPUS, "step_agent._run_and_parse: retry_once run_agent call"


def test_the_step_agent_comes_from_the_step_table_not_the_payload(recording_providers, monkeypatch):
    """make_task stamps "Eng" on every step; the plan step is Ensemble's in
    domain/steps.json, and its model agent must say so."""
    fabricated_models(monkeypatch, steps={})
    recorder = recording_providers('{"summary": "ok"}')
    from domain.py import personas as domain_personas
    from farm import agent_runner

    resolved = []
    real_resolve = agent_runner.resolve_model
    monkeypatch.setattr(
        agent_runner, "resolve_model", lambda agent, step, persona: resolved.append((agent, step, persona)) or real_resolve(agent, step, persona)
    )

    execute(make_task(4, PLAN_LABEL))

    assert resolved == [("ensemble", PLAN_LABEL, None)]
    assert recorder.models() == [domain_personas.MODELS["agents"]["ensemble"]]


def test_a_step_override_reaches_only_its_own_step(recording_providers, monkeypatch):
    fabricated_models(monkeypatch, steps={PLAN_LABEL: "claude-test-plan"})
    recorder = recording_providers('{"summary": "ok"}')

    execute(make_task(4, PLAN_LABEL))
    execute(make_task(5, "Draft implementation plan"))

    assert recorder.models() == ["claude-test-plan", STEP_OPUS]


def test_the_implement_call_site_hands_the_resolved_model_to_claude(tmp_path, monkeypatch, recording_providers):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    recorder = recording_providers('{"summary": "did it"}')

    with pytest.raises(RuntimeError, match="no code changes"):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert recorder.models() == [STEP_OPUS], "step_agent._execute: implement run_agent call"


def test_the_implement_call_passes_the_composed_eng_persona(tmp_path, monkeypatch, recording_providers):
    fabricated_models(monkeypatch, personas={"eng.python": "claude-test-python"})
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    recorder = recording_providers('{"summary": "did it"}')
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["personas"] = {"eng": "python"}

    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)

    assert recorder.models() == ["claude-test-python"]


def test_the_review_passes_carry_their_own_personas(tmp_path, monkeypatch, recording_providers):
    """The code pass composes the item's Eng persona, the QA pass its QA
    persona (HZ-125) — and each resolves its model by the persona it composes,
    never as qa.None."""
    fabricated_models(monkeypatch, personas={f"qa.{DEFAULT_PERSONAS['qa']}": "claude-test-qa"})
    ws, _origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    recorder = recording_providers(json.dumps({"summary": "reviewed", "verdict": "pass", "findings": []}))

    execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert recorder.models() == [STEP_OPUS, "claude-test-qa"]


@pytest.mark.parametrize("override", [None, "claude-test-emergency"])
def test_a_muse_routed_persona_step_never_receives_a_claude_model(
    monkeypatch, muse_smoke_test_personas, recording_providers, override
):
    """The item-level provider override (provider_for on an eligible step)."""
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", override)
    recorder = recording_providers("not json", '{"summary": "ok"}')
    task = make_task(4, PLAN_LABEL)
    task["item"]["personas"] = muse_smoke_test_personas

    execute(task)

    assert len(recorder.calls) == 2
    for call in recorder.calls:
        assert call["provider"] == "muse" and call["model"] is None
        assert not [v for v in call.values() if isinstance(v, str) and v.startswith("claude-")]


def test_farm_provider_muse_sends_a_step_no_model(monkeypatch, recording_providers):
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    recorder = recording_providers('{"summary": "ok"}')

    execute(make_task(4, PLAN_LABEL))

    assert [(c["provider"], c["model"]) for c in recorder.calls] == [("muse", None)]


# ---- HZ-188: a conflict send-back starts on a branch with main merged ----
# The server stamps merge_main on an implement task whose PR GitHub reports as
# conflicted. Before the agent runs, prepare_branch's branch must already have
# origin/main merged in, with any conflicted files named in the prompt and
# their markers left on disk for the agent.


def make_diverged_workspace(tmp_path, *, conflict):
    """origin/horizon/t-1 and origin/main both moved on from the seed; with
    conflict=True they changed the same line of shared.txt."""
    ws, origin = make_git_workspace(tmp_path)
    (ws / "shared.txt").write_text("base\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "shared")
    git(ws, "push", "-q", "origin", "HEAD:main")
    git(ws, "checkout", "-q", "-b", "horizon/t-1")
    (ws / "shared.txt").write_text("item side\n" if conflict else "base\n")
    (ws / "item_only.txt").write_text("item\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "item work")
    git(ws, "push", "-q", "origin", "horizon/t-1")
    git(ws, "checkout", "-q", "main")
    git(ws, "reset", "-q", "--hard", "origin/main")
    (ws / "shared.txt").write_text("main side\n" if conflict else "base\n")
    (ws / "main_only.txt").write_text("main\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "main moved on")
    git(ws, "push", "-q", "origin", "main")
    return ws, origin


def rev(cwd, ref):
    return subprocess.run(["git", "-C", str(cwd), "rev-parse", ref], capture_output=True, text=True, check=True).stdout.strip()


def is_ancestor(cwd, ancestor, ref):
    return subprocess.run(["git", "-C", str(cwd), "merge-base", "--is-ancestor", ancestor, ref]).returncode == 0


def test_a_conflict_send_back_merges_main_before_the_agent_and_lists_the_conflicted_files(tmp_path, monkeypatch):
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    main_sha = rev(ws, "origin/main")
    seen = {}

    def _agent(prompt, **kwargs):
        # The state the agent starts in: main merged (in progress, markers on
        # disk), main's own changes present, the item's work still there.
        seen["prompt"] = prompt
        seen["merge_head"] = (ws / ".git" / "MERGE_HEAD").read_text().strip()
        seen["shared"] = (ws / "shared.txt").read_text()
        seen["main_only"] = (ws / "main_only.txt").exists()
        seen["item_only"] = (ws / "item_only.txt").exists()
        (ws / "shared.txt").write_text("item side\nmain side\n")
        return {"result": '{"summary": "resolved the merge"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    execute(task)

    assert seen["merge_head"] == main_sha
    assert "<<<<<<<" in seen["shared"] and "main side" in seen["shared"] and "item side" in seen["shared"]
    assert seen["main_only"] and seen["item_only"]
    assert "- shared.txt" in seen["prompt"]
    assert "conflict markers" in seen["prompt"]
    # The harness committed the merge and pushed it: the PR branch now
    # contains main, so the conflict cannot survive the send-back.
    assert is_ancestor(origin, main_sha, "horizon/t-1")
    pushed = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:shared.txt"], capture_output=True, text=True, check=True
    ).stdout
    assert pushed == "item side\nmain side\n"


def test_a_clean_merge_of_main_is_committed_before_the_agent_starts(tmp_path, monkeypatch):
    ws, origin = make_diverged_workspace(tmp_path, conflict=False)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    main_sha = rev(ws, "origin/main")
    seen = {}

    def _agent(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["main_in_head"] = is_ancestor(ws, main_sha, "HEAD")
        seen["merging"] = (ws / ".git" / "MERGE_HEAD").exists()
        (ws / "agent.txt").write_text("work\n")
        return {"result": '{"summary": "did it"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    execute(task)

    assert seen["main_in_head"] and not seen["merging"]
    assert "merged into it cleanly" in seen["prompt"]
    assert is_ancestor(origin, main_sha, "horizon/t-1")


def test_an_implement_run_without_merge_main_leaves_main_unmerged(tmp_path, monkeypatch):
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    main_sha = rev(ws, "origin/main")
    seen = {}

    def _agent(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["main_in_head"] = is_ancestor(ws, main_sha, "HEAD")
        (ws / "agent.txt").write_text("work\n")
        return {"result": '{"summary": "did it"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)

    execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert not seen["main_in_head"]
    assert "conflicted with main" not in seen["prompt"]


def test_a_conflicted_merge_resolved_to_the_branchs_own_side_is_still_committed(tmp_path, monkeypatch):
    """Keeping the branch's side verbatim stages no diff against HEAD, but the
    merge itself must still be committed or the pushed branch lacks main."""
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    main_sha = rev(ws, "origin/main")

    def _agent(prompt, **kwargs):
        (ws / "shared.txt").write_text("item side\n")
        (ws / "main_only.txt").unlink()
        return {"result": '{"summary": "kept ours"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    execute(task)

    assert is_ancestor(origin, main_sha, "horizon/t-1")


def test_an_exhausted_run_never_checkpoints_a_merge_that_still_has_conflict_markers(tmp_path, monkeypatch):
    """Salvaging a half-resolved merge would push markers to the PR branch and
    make GitHub call it mergeable — the next send-back would then neither
    merge main nor name the files."""
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    before = rev(origin, "horizon/t-1")

    def _agent(prompt, **kwargs):
        (ws / "agent.txt").write_text("partial\n")  # shared.txt still has its markers
        raise AgentExhaustedError("ran out of turns")

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    with pytest.raises(AgentExhaustedError):
        execute(task)

    assert rev(origin, "horizon/t-1") == before


def test_an_exhausted_run_still_checkpoints_a_merge_whose_markers_are_resolved(tmp_path, monkeypatch):
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    main_sha = rev(ws, "origin/main")

    def _agent(prompt, **kwargs):
        (ws / "shared.txt").write_text("item side\nmain side\n")
        raise AgentExhaustedError("ran out of turns")

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    with pytest.raises(AgentExhaustedError):
        execute(task)

    assert is_ancestor(origin, main_sha, "horizon/t-1")


def test_a_finished_run_that_left_conflict_markers_fails_without_committing_or_pushing(tmp_path, monkeypatch):
    """run_checks may not parse the file (.txt, .md), so the markers are
    checked before the commit, not left to the checks."""
    ws, origin = make_diverged_workspace(tmp_path, conflict=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    before_remote = rev(origin, "horizon/t-1")

    def _agent(prompt, **kwargs):
        (ws / "agent.txt").write_text("work\n")  # never touched shared.txt
        return {"result": '{"summary": "done"}'}

    monkeypatch.setattr(step_agent, "run_agent", _agent)
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["merge_main"] = True

    with pytest.raises(RuntimeError, match="conflict markers left unresolved in: shared.txt"):
        execute(task)

    assert rev(origin, "horizon/t-1") == before_remote
    # Not even a local commit: HEAD is still the branch tip, merge uncommitted.
    assert rev(ws, "HEAD") == before_remote
    assert (ws / ".git" / "MERGE_HEAD").exists()


# ---- HZ-257: a green implement run names the exact commit its checks passed on ----


def _origin_sha(origin, ref):
    return subprocess.run(
        ["git", "--git-dir", str(origin), "rev-parse", ref], capture_output=True, text=True, check=True
    ).stdout.strip()


def test_a_green_implement_run_reports_the_pushed_sha_its_checks_passed_on(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["artifacts"]["checks_passed_sha"] == _origin_sha(origin, "horizon/t-1")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", result["artifacts"]["checks_finished_at"])


def test_a_failing_implement_run_reports_no_sha(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))
    reported = []
    monkeypatch.setattr(step_agent.check_record, "report_fields", lambda *a, **k: reported.append(a) or {})

    with pytest.raises(step_agent.CheckFailure):
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert reported == [], "a red run never reaches the report"


def test_a_check_that_leaves_a_file_behind_reports_no_sha(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "echo generated > generated.txt")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["artifacts"]["branch"] == "horizon/t-1"
    assert "checks_passed_sha" not in result["artifacts"]


def test_a_run_with_no_checks_to_run_reports_no_sha(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert "checks_passed_sha" not in result["artifacts"]


def test_a_snapshot_timeout_still_completes_green_with_no_sha(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    monkeypatch.setattr(step_agent, "run_agent", finished_run(ws))

    def hung_git(ws_, *args, timeout=10, **_kwargs):
        raise subprocess.TimeoutExpired(["git", *args], timeout)

    monkeypatch.setattr(step_agent.check_record, "_git", hung_git)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["artifacts"]["branch"] == "horizon/t-1"
    assert "checks_passed_sha" not in result["artifacts"]


# ---- HZ-321: the deploy checkpoint ----
# A self-deploy whose drain ran out of time stops the step: farmd writes
# `<run_id>.stop-reason` ("deploy") and SIGTERMs the agent, which saves its
# whole tree as one WIP commit pushed — never forced — to its own branch.


def _sh(ws, *args):
    return subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, check=True).stdout.strip()


def _origin_rev(origin, ref="horizon/t-1"):
    res = subprocess.run(["git", "--git-dir", str(origin), "rev-parse", "--verify", "-q", ref], capture_output=True, text=True)
    return res.stdout.strip()


def _is_ancestor(repo_args, old, new):
    return subprocess.run(["git", *repo_args, "merge-base", "--is-ancestor", old, new], capture_output=True).returncode == 0


@pytest.fixture
def deploy_stop(tmp_path, monkeypatch, pause_state):
    """The step agent's pause state, stopped for a deploy: the outcome goes
    to tmp_path/1.paused and its sibling stop-reason says "deploy". The
    descendant kill is stubbed — in-process they would be pytest's children."""
    from farm import pause

    pause_state["outcome_path"] = tmp_path / "1.paused"
    (tmp_path / "1.stop-reason").write_text("deploy")
    monkeypatch.setattr(pause, "kill_descendants", lambda sig=None: 0)
    return pause, tmp_path / "1.paused"


def deploy_stopped_run(ws, files):
    from farm import pause

    def _fake(prompt, **kwargs):
        for name, text in files.items():
            (ws / name).parent.mkdir(parents=True, exist_ok=True)
            (ws / name).write_text(text)
        raise pause.PauseRequested()

    return _fake


def run_deploy_stopped(ws, monkeypatch, files, scope=None):
    from farm import pause

    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setattr(step_agent, "run_agent", deploy_stopped_run(ws, files))
    monkeypatch.setattr(step_agent, "finalize_branch", lambda *a, **k: pytest.fail("a deploy checkpoint reached finalize"))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    if scope:
        task["scope"] = scope
    with pytest.raises(pause.PauseRequested):
        execute(task)


def test_deploy_checkpoint_commits_tracked_and_untracked_work_and_pushes_it(tmp_path, monkeypatch, deploy_stop):
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)

    run_deploy_stopped(ws, monkeypatch, {"README.md": "# demo, edited\n", "src/new_module.py": "print('new')\n"})

    assert pause.read_outcome(outcome_path) == {"outcome": "saved", "detail": "pushed a WIP checkpoint to horizon/t-1"}
    assert _sh(ws, "status", "--porcelain") == "", "the worktree is clean after the checkpoint"
    wip = _sh(ws, "rev-parse", "HEAD")
    remote = subprocess.run(["git", "-C", str(ws), "ls-remote", "origin", "refs/heads/horizon/t-1"], capture_output=True, text=True).stdout.split()[0]
    assert remote == wip, "the remote branch head is the WIP commit"
    assert origin_log(origin).splitlines()[0] == f"T-1: {step_agent.CHECKPOINT_MARKER} (Horizon Eng agent)"
    assert origin_body(origin).strip() == "cause: deploy"
    assert _sh(ws, "rev-list", "--parents", "-n", "1", wip).split()[1:] == [_origin_rev(origin, "main")], "one commit on main"
    assert set(_sh(ws, "show", "--name-only", "--format=", wip).split()) == {"README.md", "src/new_module.py"}
    assert _origin_rev(origin, "main") == _sh(ws, "rev-parse", "origin/main"), "main is never pushed to"


def test_deploy_checkpoint_on_a_locally_rebased_branch_fast_forwards_and_the_next_attempt_resumes_it(tmp_path, monkeypatch, deploy_stop):
    """Architecture blocker 1: the resumed checkpoint was rebased onto main
    locally, so origin/horizon/t-1 is not in HEAD. The WIP commit's one parent
    is the remote head, so the push is a plain fast-forward — and the next
    attempt, in a fresh clone with main moved again, holds every file."""
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    old = make_checkpoint(ws, origin, cause="paused", path="wip.txt", text="first half\n")
    advance_main(tmp_path, origin, path="m1.txt")

    run_deploy_stopped(ws, monkeypatch, {"wip.txt": "first half\nsecond half\n", "more.txt": "more\n"})

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    new = _origin_rev(origin)
    assert new != old and _is_ancestor(["--git-dir", str(origin)], old, new), "no force: the old head is kept"
    assert _sh(ws, "rev-list", "--parents", "-n", "1", new).split()[1:] == [old], "a single parent, never a merge"
    assert _sh(ws, "status", "--porcelain") == ""
    advance_main(tmp_path, origin, path="m2.txt")

    fresh = tmp_path / "fresh"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(fresh)], check=True, capture_output=True)
    git(fresh, "config", "user.email", "farm@example.com")
    git(fresh, "config", "user.name", "Horizon Farm")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: fresh)
    pause._state.update(phase="idle", pending=False)
    seen = {}

    def attempt_2(prompt, **kwargs):
        seen.update({p: (fresh / p).read_text() for p in ("wip.txt", "more.txt", "m1.txt", "m2.txt")})
        seen["prompt"] = prompt
        return {"result": '{"summary": "continued"}'}

    monkeypatch.setattr(step_agent, "run_agent", attempt_2)
    monkeypatch.setattr(step_agent, "run_checks", lambda *a, **k: "checks: none")
    monkeypatch.setattr(step_agent, "finalize_branch", lambda *a, **k: {"branch": "horizon/t-1"})
    execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert seen["wip.txt"] == "first half\nsecond half\n" and seen["more.txt"] == "more\n"
    assert seen["m2.txt"] == "fix on main\n", "rebased onto the main that moved since"
    assert "a Horizon deploy stopped the previous attempt mid-run" in seen["prompt"]
    assert "more.txt" in seen["prompt"]


def test_a_merge_of_main_still_in_progress_is_kept_as_a_merge(tmp_path, monkeypatch, deploy_stop):
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "checkout", "-B", "horizon/t-1", "origin/main")
    (ws / "feature.txt").write_text("feature\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "T-1: feature")
    git(ws, "push", "origin", "horizon/t-1")
    advance_main(tmp_path, origin, path="m1.txt")
    git(ws, "fetch", "origin")
    git(ws, "merge", "--no-commit", "--no-ff", "origin/main")
    item = {"id": "T-1", "title": "t", "repo": "acme/demo"}

    outcome, _ = step_agent._deploy_checkpoint(ws, item, "horizon/t-1", [], _origin_rev(origin))

    assert outcome == pause.SAVED
    parents = _sh(ws, "rev-list", "--parents", "-n", "1", "HEAD").split()[1:]
    assert parents == [_sh(ws, "rev-parse", "origin/horizon/t-1"), _sh(ws, "rev-parse", "origin/main")]
    assert _sh(ws, "status", "--porcelain") == "" and _origin_rev(origin) == _sh(ws, "rev-parse", "HEAD")


def test_a_deploy_checkpoint_whose_push_fails_is_kept_and_resumed_by_the_next_attempt(tmp_path, monkeypatch, deploy_stop):
    """Guardrail 2: a failed push is reported, never retried with force, and
    loses nothing — the commit stays in the worktree and the next attempt's
    prepare_branch starts from it instead of scrubbing it."""
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    hook = origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho 'push refused by the test' >&2\nexit 1\n")
    hook.chmod(0o755)

    run_deploy_stopped(ws, monkeypatch, {"unsaved.txt": "do not lose me\n"})

    outcome = pause.read_outcome(outcome_path)
    assert outcome["outcome"] == "failed" and "push" in outcome["detail"]
    assert _origin_rev(origin) == "", "nothing reached the remote"
    wip = _sh(ws, "rev-parse", "HEAD")
    assert (Path(_sh(ws, "rev-parse", "--absolute-git-dir")) / step_agent.UNPUSHED_CHECKPOINT).read_text().split() == ["horizon/t-1", wip]

    hook.unlink()
    prepared = step_agent.prepare_branch(ws, ITEM, rebase_checkpoint=True)
    assert _sh(ws, "rev-parse", "HEAD") == wip
    assert (ws / "unsaved.txt").read_text() == "do not lose me\n"
    assert prepared.lease_sha == "", "later pushes still lease against what origin holds"
    assert not (Path(_sh(ws, "rev-parse", "--absolute-git-dir")) / step_agent.UNPUSHED_CHECKPOINT).exists()
    assert "a Horizon deploy stopped" in step_agent._checkpoint_resume_note(ws)


@pytest.mark.parametrize("branch", ["main", "horizon/t-2"])
def test_a_deploy_checkpoint_pushes_only_to_the_items_own_branch(tmp_path, deploy_stop, branch):
    pause, _ = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "checkout", "-B", branch)
    (ws / "x.txt").write_text("x\n")
    before = _origin_rev(origin, "main")

    outcome, detail = step_agent._deploy_checkpoint(ws, ITEM, branch, [], "")

    assert outcome == pause.SKIPPED and "not this item's own branch" in detail
    assert _origin_rev(origin, "main") == before and _origin_rev(origin, "horizon/t-2") == ""
    assert _sh(ws, "status", "--porcelain") == "?? x.txt", "nothing was committed"


def test_a_deploy_checkpoint_never_commits_or_reports_a_secret(tmp_path, monkeypatch, deploy_stop):
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    files = {
        ".gitignore": "ignored.txt\n",
        "ignored.txt": "local only\n",
        ".env": "API_TOKEN=sekrit-HZ321\n",
        "config/.env": "API_TOKEN=sekrit-HZ321\n",
        "deploy/id_rsa": "-----BEGIN KEY-----\n",
        "src/app.py": "print('work')\n",
    }
    run_deploy_stopped(ws, monkeypatch, files)

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    committed = subprocess.run(["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", "horizon/t-1"], capture_output=True, text=True).stdout.split()
    assert "src/app.py" in committed and ".gitignore" in committed
    for secret in ("ignored.txt", ".env", "config/.env", "deploy/id_rsa"):
        assert secret not in committed
    message = subprocess.run(["git", "--git-dir", str(origin), "log", "-1", "--format=%B", "horizon/t-1"], capture_output=True, text=True).stdout
    assert "sekrit" not in message and "API_TOKEN" not in message

    # A failed push's detail never carries the remote's credentials.
    token = "ghs_" + "a1B2" * 9
    real_git = step_agent.git

    def leaky_push(ws_, *args, **kwargs):
        if args and args[0] == "push":
            raise RuntimeError(f"git push failed: fatal: unable to access 'https://x-access-token:{token}@github.com/acme/demo/'")
        return real_git(ws_, *args, **kwargs)

    monkeypatch.setattr(step_agent, "git", leaky_push)
    (ws / "src/app.py").write_text("print('more work')\n")
    outcome, detail = step_agent._deploy_checkpoint(ws, ITEM, "horizon/t-1", [], _origin_rev(origin))
    assert outcome == pause.FAILED
    assert token not in detail and "x-access-token" not in detail and "[redacted]" in detail


def test_a_deploy_checkpoint_in_fix_mode_still_saves_without_force(tmp_path, monkeypatch, deploy_stop):
    """A pause skips the checkpoint on an open PR; a deploy saves it there
    (the item is at implement, so nothing can merge it) as a fast-forward."""
    pause, outcome_path = deploy_stop
    ws, origin = make_git_workspace(tmp_path)
    git(ws, "push", "origin", "HEAD:horizon/t-1")
    before = _origin_rev(origin)

    run_deploy_stopped(ws, monkeypatch, {"fix.txt": "fixing\n"}, scope={"mode": "fix", "base_sha": before, "findings": []})

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    assert _is_ancestor(["--git-dir", str(origin)], before, _origin_rev(origin))
    assert "fix.txt" in _sh(ws, "show", "--name-only", "--format=", "HEAD").split()


def test_without_a_stop_reason_a_pause_is_unchanged(tmp_path, monkeypatch, deploy_stop):
    """Guardrail 4: no stop-reason file means an operator's pause, as before."""
    pause, outcome_path = deploy_stop
    (tmp_path / "1.stop-reason").unlink()
    ws, origin = make_git_workspace(tmp_path)

    run_deploy_stopped(ws, monkeypatch, {"paused.txt": "x\n"})

    assert pause.read_outcome(outcome_path)["outcome"] == "saved"
    assert origin_body(origin).startswith("cause: paused")
