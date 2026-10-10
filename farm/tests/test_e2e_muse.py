"""Real-CLI end-to-end check for HZ-102 — the ticket's own success metric,
run against the actual Muse Code binary rather than a mocked subprocess.

CI runs the mocked-subprocess suite instead (test_providers_muse.py,
test_step_agent.py, test_personas.py, test_agent_runner_dispatch.py) —
this file needs a real, `muse login`-authenticated CLI on PATH and is
skipped unless explicitly requested, same split as test_e2e_whatsapp.py's
FARM_WA_E2E convention.

Run it like this (from the repo root, with `muse` installed and logged in —
see docs/providers/muse-code.md):

    FARM_MUSE_E2E=1 farm/.venv/bin/python -m pytest farm/tests/test_e2e_muse.py -s

Every test here is read-only / side-effect-free: a planning step (no repo
attached), a planning step in a throwaway temp git repo, and two bare `muse
exec` prompts. Nothing here ever exercises implement, ship, or deploy.
"""

import os
import shutil
import subprocess
import time
import uuid

import pytest

from domain.py import steps
from farm import step_agent
from farm.config import FARM_MUSE_BIN
from farm.providers import muse

pytestmark = pytest.mark.skipif(
    os.environ.get("FARM_MUSE_E2E") != "1",
    reason="real Muse CLI e2e — set FARM_MUSE_E2E=1 with an authenticated `muse` on PATH (see module docstring)",
)


def setup_module():
    if not shutil.which(FARM_MUSE_BIN):
        pytest.skip(f"FARM_MUSE_E2E=1 but no '{FARM_MUSE_BIN}' binary on PATH")


def test_session_continuity_across_two_separate_muse_invocations():
    """docs/providers/muse-code.md's verified claim, re-checked live: a
    nonce sent under --session-id in one `muse exec` process is recalled by
    a second, wholly separate process sharing the same id."""
    session_id = str(uuid.uuid4())
    nonce = str(uuid.uuid4().int)[:6]

    first = muse.run(f"Remember this number: {nonce}. Reply with just OK.", session_id=session_id)
    assert first["command_id"]

    second = muse.run("What number did I ask you to remember? Reply with just the number.", session_id=session_id)
    assert nonce in second["result"]
    assert second["command_id"]
    # Two distinct runs on the shared session, not a cached/duplicate reply.
    assert second["command_id"] != first["command_id"]


def test_terminal_completed_parse_holds_against_a_real_run():
    """The parser's contract (test_providers_muse.py's mocked/fixture
    coverage) actually holds against the CLI version installed here — a
    real command_id and the exact reply text, not an empty artifact."""
    reply = muse.run("Reply with exactly the word: horizon")
    assert reply["result"].strip() == "horizon"
    assert reply["command_id"]


def test_one_real_planning_step_completes_with_muse_and_records_provenance(muse_smoke_test_personas):
    """The HZ-102 success metric itself: one real lifecycle step, dispatched
    through the farm's normal path (step_agent.execute() -> run_agent() ->
    the muse provider — never a direct call into farm.providers.muse),
    completes with Muse as the executing provider and its artifact records
    provider provenance including a non-empty command_id. No repo is
    attached, so this is guaranteed side-effect-free — no branch, no PR, no
    release.

    HZ-121: the persona is a test-registered fixture
    (conftest.py's muse_smoke_test_persona), not a shipped one — the
    PERSONA_PROVIDERS mapping it needs no longer ships in farm/personas.py."""
    task = {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "HZ-102-SMOKE",
            "title": "HZ-102 Muse smoke test (throwaway — not a real deliverable)",
            "desc": "Prove the Muse provider is wired in.",
            "metric": "Muse runs this step and provenance is recorded.",
            "guardrails": "Planning step only; never implement/ship/deploy.",
            "priority": "Low",
            "repo": None,
            "issue": None,
            "personas": muse_smoke_test_personas,
        },
        "step": {"index": 4, "label": "Plan options & trade-offs (pros / cons)", "agent": "Ensemble"},
        "artifacts": [],
        "feedback": [],
    }
    step_timeout_s = steps.budget_for_label(steps.STEPS, task["step"]["label"])[1]

    started = time.monotonic()
    result = step_agent.execute(task)
    elapsed_s = time.monotonic() - started

    assert result["artifacts"]["provider"] == "muse"
    assert result["artifacts"]["command_id"]
    assert "provider=muse" in result["summary"]
    # QA send-back on cycle 1: prove the run finished comfortably inside its
    # normal budget, not just that it returned at all. subprocess.run's own
    # timeout=timeout_s (farm/providers/muse.py) would turn a real hang into
    # an AgentExhaustedError and fail this test with an exception — but a run
    # that limps in at, say, 95% of budget is still a hang in every practical
    # sense for a "cheap, side-effect-free planning step" and that case
    # raises nothing. Half the configured budget is a generous ceiling for a
    # one-line smoke prompt; this is verification, not a perf benchmark.
    assert elapsed_s < step_timeout_s * 0.5, (
        f"planning step took {elapsed_s:.1f}s against a {step_timeout_s}s budget for step "
        f"{task['step']['index']} — too close to the timeout to call this a healthy run"
    )


def test_a_real_muse_planning_step_in_a_git_worktree_leaves_it_unchanged(tmp_path, monkeypatch, muse_smoke_test_personas):
    """HZ-387 metric 4 on the real provider: a read-only step run by Muse in
    a real git repo passes the farm's read-only check — Muse writes no state
    file of its own into the cwd that would fail every Muse planning run."""
    ws = tmp_path / "ws"
    ws.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(ws), *args], check=True, capture_output=True, text=True).stdout

    git("init", "-b", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    (ws / "README.md").write_text("# demo\n\nA tiny repo for a read-only planning smoke test.\n")
    git("add", "-A")
    git("commit", "-m", "initial")
    head, status = git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=all")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    task = {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "HZ-387-SMOKE",
            "title": "HZ-387 Muse read-only smoke test (throwaway — not a real deliverable)",
            "desc": "Read README.md and list two options for improving it. Do not edit any file.",
            "metric": "The worktree is unchanged.",
            "guardrails": "Planning step only; never edit, commit or create a file.",
            "priority": "Low",
            "repo": "acme/demo",
            "issue": 1,
            "personas": muse_smoke_test_personas,
        },
        "step": {"index": 4, "label": "Plan options & trade-offs (pros / cons)", "agent": "Ensemble"},
        "artifacts": [],
        "feedback": [],
    }

    result = step_agent.execute(task)  # a read-only violation raises here

    assert result["artifacts"]["provider"] == "muse"
    assert git("rev-parse", "HEAD") == head
    assert git("status", "--porcelain", "--untracked-files=all") == status
