"""HZ-158: salvage a turn-capped reply, hand off to the next attempt, and fail
closed everywhere else.

Every review rejection of HZ-124 from attempt 3 on was a way salvage failed
open — a gate step salvaged, an empty object accepted, an exhaustion turned
into a plain AgentError that paused for a human. Each of those is a test here,
driven through the real call sites (execute()/main()) rather than the helper
alone, and each rejection asserts the ORIGINAL exception object came back out.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from domain.py import reasons, steps
from farm import agent_runner, handoff, step_agent
from farm.agent_runner import AgentError, AgentExhaustedError, salvage_truncated_reply
from farm.providers import base, claude
from farm.step_agent import (
    DEPLOY_LABEL,
    IMPLEMENT_LABEL,
    REVIEW_LABEL,
    SALVAGE_STEPS,
    execute,
)

PLAN = "Draft implementation plan"
OPTIONS = "Plan options & trade-offs (pros / cons)"
ARCH = "Architecture review"
QA_PLAN = "QA reviews the test plan"
REPO_ROOT = Path(__file__).resolve().parents[2]
TURN_CAP = reasons.REASON["TURN_CAP"]

# A plan reply cut off mid-way through artifact_md, every required key present.
CUT_PLAN = '{"summary": "drafted the plan", "artifact_md": "## Changes\\n- add the salvage path\\n- and the hand'


def make_task(label, repo=None, run_id=1):
    return {
        "run_id": run_id,
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
        "step": {"index": 0, "label": label, "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
    }


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


def make_git_workspace(tmp_path):
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
    return ws


def exhausted(partial_text=None, session_id=None, provider="claude"):
    """An AgentExhaustedError as run_agent() lets it out: the provider set it
    with partial_text/session_id, the dispatcher tagged the provider."""
    exc = AgentExhaustedError(
        "claude reported an error result [error_max_turns]: no result text",
        partial_text=partial_text,
        session_id=session_id,
    )
    exc.provider = provider
    return exc


def raising(exc, calls=None):
    def _fake(prompt, **kwargs):
        if calls is not None:
            calls.append(kwargs)
        raise exc

    return _fake


@pytest.fixture
def handoff_calls(monkeypatch):
    """Records every handoff model call; returns a note."""
    calls = []

    def _fake(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        return {"result": "NOTE: the plan's Changes section was done; Testing was left.", "session_id": "s1"}

    monkeypatch.setattr(handoff, "run_agent", _fake)
    return calls


def run_main(monkeypatch, tmp_path, task):
    task_file = tmp_path / f"task-{task['run_id']}.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["json"] = json

    monkeypatch.setattr(step_agent.httpx, "post", fake_post)
    step_agent.main()
    return posted["json"]


def assert_fails_closed(monkeypatch, tmp_path, task, exc):
    """The original exception object, exactly AgentExhaustedError, comes out
    of execute(); main() posts exactly the turn-cap failure payload."""
    with pytest.raises(AgentExhaustedError) as exc_info:
        execute(task)
    assert exc_info.value is exc
    assert type(exc_info.value) is AgentExhaustedError
    posted = run_main(monkeypatch, tmp_path, task)
    assert posted == {"run_id": task["run_id"], "ok": False, "error": str(exc), "reason": TURN_CAP}


# ---- the docs answer and the fields ----


def test_the_docstring_answers_yes_for_claude_and_no_for_muse():
    doc = base.AgentExhaustedError.__doc__
    assert "Claude: yes" in doc
    assert "Muse: no" in doc
    assert claude.RESUMES_AFTER_EXHAUSTION is True
    from farm.providers import muse

    assert muse.RESUMES_AFTER_EXHAUSTION is False


def test_a_positional_exhaustion_still_works_with_both_fields_none():
    exc = AgentExhaustedError("ran out")
    assert (str(exc), exc.partial_text, exc.session_id, exc.provider) == ("ran out", None, None, None)


def test_claude_cli_timeout_carries_partial_text_and_session_id(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=5, output=b'{"partial')

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    with pytest.raises(AgentExhaustedError, match="timed out") as exc_info:
        claude.run("p", session_id="resumed-1", timeout_s=5)
    assert exc_info.value.partial_text == '{"partial'
    assert exc_info.value.session_id == "resumed-1"


def test_claude_cli_retry_fresh_false_never_starts_a_fresh_session(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 1, "", "No conversation found")

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="exited 1"):
        claude.run("p", session_id="stale-1", retry_fresh=False)
    assert len(calls) == 1 and "--resume" in calls[0]


def test_run_agent_tags_the_exhaustion_with_the_provider_that_ran(monkeypatch):
    from farm.providers import muse

    def fake_run(cmd, **kwargs):
        line = json.dumps({"payload_type": "run.terminal.exhausted", "payload": {}})
        return subprocess.CompletedProcess(cmd, 0, line + "\n", "")

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentExhaustedError) as exc_info:
        agent_runner.run_agent("p", agent="eng", provider="muse")
    assert exc_info.value.provider == "muse"
    assert exc_info.value.session_id  # muse mints the id the run used


# ---- salvage succeeds ----


def test_a_plan_reply_cut_mid_string_with_every_key_is_salvaged_with_a_note(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted(CUT_PLAN, "s1")))

    result = execute(make_task(PLAN))

    assert result["summary"].startswith("drafted the plan")
    assert agent_runner.SALVAGE_NOTE in result["summary"]
    assert "and the hand" in result["artifacts"]["artifact_md"]
    assert agent_runner.SALVAGE_NOTE in result["artifacts"]["artifact_md"]
    assert handoff_calls == []  # a salvaged run is a success: no handoff


def test_a_salvaged_result_keeps_the_ok_key_set_and_records_the_provider_that_ran(
    monkeypatch, muse_smoke_test_persona, handoff_calls
):
    """R2: providerOverrideEligible steps post artifacts.provider, which the
    server persists on step_run — a salvage must name the provider that ran."""
    def ok(prompt, **kwargs):
        return {"result": '{"summary": "s", "artifact_md": "a"}', "provider": kwargs["provider"], "command_id": "c"}

    def cut(prompt, **kwargs):
        raise exhausted(CUT_PLAN, "s1", provider=kwargs["provider"])

    def task():
        t = make_task(OPTIONS)
        t["item"]["personas"] = {"eng": muse_smoke_test_persona}  # conftest's MUSE_SMOKE_TEST_PERSONA_AGENT
        return t

    monkeypatch.setattr(step_agent, "run_agent", ok)
    normal = execute(task())
    monkeypatch.setattr(step_agent, "run_agent", cut)
    salvaged = execute(task())

    assert set(salvaged) == set(normal) == {"summary", "artifacts"}
    assert set(salvaged["artifacts"]) == set(normal["artifacts"]) == {"artifact_md", "provider", "command_id"}
    assert salvaged["artifacts"]["provider"] == "muse"
    assert salvaged["artifacts"]["command_id"] is None


def test_main_posts_a_salvaged_run_as_ok(monkeypatch, tmp_path, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted(CUT_PLAN, "s1")))
    posted = run_main(monkeypatch, tmp_path, make_task(PLAN))
    assert posted["ok"] is True and "reason" not in posted


# ---- the four metric rejections, plus R3's degenerate inputs ----


def test_partial_text_of_a_bare_brace_is_not_salvaged(monkeypatch, tmp_path, handoff_calls):
    exc = exhausted("{")
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(PLAN), exc)


def test_a_salvage_missing_summary_is_not_salvaged(monkeypatch, tmp_path, handoff_calls):
    exc = exhausted('{"artifact_md": "## Changes\\n- half a pl')
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(PLAN), exc)


def test_unparseable_partial_text_is_not_salvaged(monkeypatch, tmp_path, handoff_calls):
    exc = exhausted("I was about to write the plan when I ran out of t")
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(PLAN), exc)


@pytest.mark.parametrize("partial", [None, ""])
def test_no_partial_text_fails_closed(monkeypatch, tmp_path, handoff_calls, partial):
    exc = exhausted(partial)
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(PLAN), exc)


def test_a_salvage_check_that_raises_still_lets_the_original_exhaustion_out(monkeypatch, tmp_path, handoff_calls):
    exc = exhausted(CUT_PLAN)

    def boom(text, keys):
        raise ValueError("salvage bug")

    monkeypatch.setattr(step_agent, "salvage_truncated_reply", boom)
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(PLAN), exc)


# ---- gate steps never salvage, at every real call site (R4) ----


@pytest.fixture
def salvage_spy(monkeypatch):
    """A salvage that would accept anything — so only the step allowlist
    stands between a gate step and a salvaged verdict."""
    calls = []

    def _accept(text, keys):
        calls.append(text)
        return {"summary": "s", "artifact_md": "a", "verdict": "pass", "url": "u", "expected_text": "e"}, "note"

    monkeypatch.setattr(step_agent, "salvage_truncated_reply", _accept)
    return calls


def review_ws(tmp_path, monkeypatch):
    ws = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    return ws


@pytest.mark.parametrize("partial", ['{"verdict": "pass"', '{"verdict": "pass", "summary": "ok', '{"verdict": "pass'])
def test_the_review_code_pass_cut_after_a_pass_verdict_is_not_salvaged(
    monkeypatch, tmp_path, salvage_spy, handoff_calls, partial
):
    review_ws(tmp_path, monkeypatch)
    exc = exhausted(partial)
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(REVIEW_LABEL, repo="acme/demo"), exc)
    assert salvage_spy == []


def test_the_review_qa_pass_cut_after_a_pass_verdict_is_not_salvaged(monkeypatch, tmp_path, salvage_spy, handoff_calls):
    review_ws(tmp_path, monkeypatch)
    exc = exhausted('{"verdict": "pass", "regression_tests_run": true, "summary": "ok')
    calls = []

    def code_ok_then_qa_cut(prompt, **kwargs):
        calls.append(kwargs)
        if len(calls) % 2 == 1:
            return {"result": '{"verdict": "pass", "findings": [], "summary": "fine"}'}
        raise exc

    monkeypatch.setattr(step_agent, "run_agent", code_ok_then_qa_cut)
    assert_fails_closed(monkeypatch, tmp_path, make_task(REVIEW_LABEL, repo="acme/demo"), exc)
    assert len(calls) == 4  # code + QA pass, once for execute() and once for main()
    assert salvage_spy == []


@pytest.mark.parametrize("label", [ARCH, QA_PLAN])
def test_a_planning_review_step_is_not_salvaged(monkeypatch, tmp_path, salvage_spy, handoff_calls, label):
    # Salvageable on its face — every key, cut mid-string, no verdict key —
    # so only SALVAGE_STEPS refuses it.
    exc = exhausted('{"summary": "reviewed", "artifact_md": "## Verdict\\n**pass** — fine so f')
    assert salvage_truncated_reply(exc.partial_text, ("summary", "artifact_md")) is not None
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(label), exc)
    assert salvage_spy == []


def test_the_deploy_step_is_not_salvaged(monkeypatch, tmp_path, salvage_spy, handoff_calls):
    def no_ws(repo, item_id):
        raise RuntimeError("no hub")

    monkeypatch.setattr(step_agent, "ensure_item_worktree", no_ws)
    exc = exhausted('{"summary": "deployed", "url": "https://x", "expected_text": "Horiz')
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    assert_fails_closed(monkeypatch, tmp_path, make_task(DEPLOY_LABEL, repo="acme/demo"), exc)
    assert salvage_spy == []


def test_the_salvage_allowlist_is_exactly_the_two_non_gate_planning_steps():
    """R8: an explicit denylist, not a role-file grep (two allowlisted role
    files mention "verdict" in their writing rules)."""
    assert SALVAGE_STEPS == frozenset({OPTIONS, PLAN})
    authored = {s["label"]: s for s in json.loads((REPO_ROOT / "domain" / "steps.json").read_text())["steps"]}
    for label in SALVAGE_STEPS:
        assert label in authored
        assert authored[label]["kind"] == "agent"
        assert authored[label]["workspaceMutating"] is False
    assert not SALVAGE_STEPS & {IMPLEMENT_LABEL, REVIEW_LABEL, DEPLOY_LABEL, ARCH, QA_PLAN}


# ---- the handoff: once, only on exhaustion, read-only, smaller budget ----


def test_two_consecutive_exhaustions_in_one_run_make_one_handoff_call(monkeypatch, handoff_calls):
    """The first reply is junk, the lossless retry exhausts, and the handoff
    call itself exhausts too — still exactly one handoff call."""
    first = exhausted(None, "s1")
    replies = iter([{"result": "not json", "session_id": "s1"}])

    def fake(prompt, **kwargs):
        reply = next(replies, None)
        if reply is None:
            raise first
        return reply

    def handoff_exhausts(prompt, **kwargs):
        handoff_calls.append(kwargs)
        raise exhausted(None, "s1")

    monkeypatch.setattr(step_agent, "run_agent", fake)
    monkeypatch.setattr(handoff, "run_agent", handoff_exhausts)
    with pytest.raises(AgentExhaustedError) as exc_info:
        execute(make_task(PLAN))
    assert exc_info.value is first
    assert len(handoff_calls) == 1


def test_one_guard_never_hands_off_twice_across_two_exhaustions(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted(None, "s1")))
    guard = step_agent.HandoffGuard()
    kwargs = dict(
        agent="eng", step=PLAN, persona=None, append_system=None, cwd=None, max_turns=40, timeout_s=600,
        allowed_tools=None, required_keys=("summary", "artifact_md"), item_id="T-1", guard=guard,
    )
    for _ in range(2):
        with pytest.raises(AgentExhaustedError):
            step_agent._run_and_parse("p", **kwargs)
    assert len(handoff_calls) == 1


def test_the_handoff_resumes_the_session_read_only_on_a_smaller_budget(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted(None, "sess-9")))
    with pytest.raises(AgentExhaustedError):
        execute(make_task(PLAN))

    (call,) = handoff_calls
    assert call["session_id"] == "sess-9"
    assert call["retry_fresh"] is False
    assert call["max_turns"] == handoff.HANDOFF_MAX_TURNS
    assert call["timeout_s"] == handoff.HANDOFF_TIMEOUT_S
    assert handoff.HANDOFF_MAX_TURNS < min(s["maxTurns"] for s in steps.STEPS if s["runsIn"] == "farm")
    tools = {t.strip() for t in call["allowed_tools"].split(",")}
    assert not tools & {"Write", "Edit", "Bash", "NotebookEdit"}


def test_a_successful_run_makes_no_handoff_call(monkeypatch, handoff_calls):
    monkeypatch.setattr(
        step_agent, "run_agent", lambda p, **k: {"result": '{"summary": "s", "artifact_md": "a"}'}
    )
    execute(make_task(PLAN))
    assert handoff_calls == []


def test_a_plain_agent_error_makes_no_handoff_and_leaves_no_note(monkeypatch, handoff_calls, handoff_dir):
    monkeypatch.setattr(step_agent, "run_agent", raising(AgentError("claude exited 1: boom")))
    with pytest.raises(AgentError):
        execute(make_task(PLAN))
    assert handoff_calls == []
    assert not handoff_dir.exists() or not any(handoff_dir.iterdir())


def test_a_parsed_reply_missing_summary_makes_no_handoff(monkeypatch, handoff_calls, handoff_dir):
    monkeypatch.setattr(step_agent, "run_agent", lambda p, **k: {"result": '{"artifact_md": "a"}'})
    with pytest.raises(AgentError, match="missing 'summary'"):
        execute(make_task(PLAN))
    assert handoff_calls == []
    assert not handoff_dir.exists() or not any(handoff_dir.iterdir())


# ---- the note reaches the next attempt (R6) ----


def test_the_note_round_trips_to_the_next_attempts_prompt_and_clears_on_ok(
    monkeypatch, tmp_path, handoff_calls, handoff_dir
):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted("{", "s1")))
    first = run_main(monkeypatch, tmp_path, make_task(PLAN, run_id=1))
    assert first["reason"] == TURN_CAP
    assert len(list(handoff_dir.iterdir())) == 1

    captured = {}

    def ok(prompt, **kwargs):
        captured["prompt"] = prompt
        return {"result": '{"summary": "s", "artifact_md": "a"}'}

    monkeypatch.setattr(step_agent, "run_agent", ok)
    second = run_main(monkeypatch, tmp_path, make_task(PLAN, run_id=2))

    assert second["ok"] is True
    heading = "## Handoff note from a previous attempt — UNVERIFIED"
    assert heading in captured["prompt"]
    after = captured["prompt"].split(heading, 1)[1]
    assert "Check every claim against the code" in after
    assert "NOTE: the plan's Changes section was done" in after
    assert not any(handoff_dir.iterdir())  # cleared on ok


def test_a_note_for_one_step_never_reaches_another_steps_prompt(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted("{", "s1")))
    with pytest.raises(AgentExhaustedError):
        execute(make_task(PLAN))
    assert "UNVERIFIED" in step_agent.build_prompt(make_task(PLAN))
    assert "UNVERIFIED" not in step_agent.build_prompt(make_task(OPTIONS))


# ---- the mechanical fallback ----


def test_no_session_id_means_a_mechanical_note_and_no_model_call(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted('{"summary": "half', None)))
    with pytest.raises(AgentExhaustedError):
        execute(make_task(PLAN))
    assert handoff_calls == []
    note = handoff.read_note("T-1", PLAN)
    assert '{"summary": "half' in note


def test_a_provider_that_cannot_resume_gets_a_mechanical_note(monkeypatch, handoff_calls):
    monkeypatch.setattr(step_agent, "run_agent", raising(exhausted("partial words", "sid", provider="muse")))
    with pytest.raises(AgentExhaustedError):
        execute(make_task(PLAN))
    assert handoff_calls == []
    assert "partial words" in handoff.read_note("T-1", PLAN)


def handoff_ctx(deadline):
    return handoff.HandoffContext(
        item_id="T-1", step=PLAN, agent="eng", persona=None, append_system=None, cwd=None, deadline=deadline
    )


def test_a_spent_time_budget_means_a_mechanical_note_and_no_model_call(handoff_calls):
    """The server's watchdog allows only a little over the step's own budget;
    a handoff past it would lose the turn-cap report to a server timeout."""
    import time

    note = handoff.request_note(exhausted("tail text", "s1"), handoff_ctx(time.monotonic() + 5))
    assert handoff_calls == []
    assert "tail text" in note


def test_the_handoff_timeout_is_clamped_to_the_time_left(handoff_calls):
    import time

    handoff.request_note(exhausted("tail text", "s1"), handoff_ctx(time.monotonic() + 100))
    (call,) = handoff_calls
    assert handoff.HANDOFF_MIN_TIMEOUT_S <= call["timeout_s"] <= 100


def test_a_handoff_call_that_raises_falls_back_to_a_mechanical_note(monkeypatch):
    calls = []

    def boom(prompt, **kwargs):
        calls.append(1)
        raise AgentError("claude exited 1: stale session")

    monkeypatch.setattr(handoff, "run_agent", boom)
    exc = exhausted("the tail of the reply", "s1")
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    with pytest.raises(AgentExhaustedError) as exc_info:
        execute(make_task(PLAN))
    assert exc_info.value is exc
    assert calls == [1]
    assert "the tail of the reply" in handoff.read_note("T-1", PLAN)


# ---- implement: the checkpoint is untouched, the handoff can't break it (R7b) ----


def test_an_implement_handoff_that_raises_still_reports_exhaustion_after_one_checkpoint(monkeypatch, tmp_path):
    ws = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    checkpoints = []
    monkeypatch.setattr(step_agent, "_salvage_checkpoint", lambda *a, **k: checkpoints.append(1))

    def broken(exc, ctx, ws=None):
        raise RuntimeError("handoff crashed")

    monkeypatch.setattr(handoff, "request_note", broken)
    exc = exhausted('{"summary": "implemented half', "s1")
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))

    posted = run_main(monkeypatch, tmp_path, make_task(IMPLEMENT_LABEL, repo="acme/demo"))

    assert posted == {"run_id": 1, "ok": False, "error": str(exc), "reason": TURN_CAP}
    assert checkpoints == [1]


def test_implement_is_never_salvaged_but_does_hand_off(monkeypatch, tmp_path, salvage_spy, handoff_calls):
    ws = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setattr(step_agent, "_salvage_checkpoint", lambda *a, **k: None)
    exc = exhausted('{"summary": "implemented half', "s1")
    monkeypatch.setattr(step_agent, "run_agent", raising(exc))
    with pytest.raises(AgentExhaustedError) as exc_info:
        execute(make_task(IMPLEMENT_LABEL, repo="acme/demo"))
    assert exc_info.value is exc
    assert salvage_spy == []
    (call,) = handoff_calls
    assert call["cwd"] == str(ws)
    assert not {t.strip() for t in call["allowed_tools"].split(",")} & {"Write", "Edit", "Bash", "NotebookEdit"}


# ---- salvage_truncated_reply on its own (optional robustness cases) ----


@pytest.mark.parametrize(
    "text",
    [
        '{"summ',  # cut inside a key
        '{"summary": "ok", "artifact_md": "a\\',  # cut inside an escape
        '{"summary": "ok", "artifact_md": "a"}',  # not cut off at all
        '{"summary": "ok", "artifact_md": "a"} trailing',  # closed, then prose
        '{"summary": "ok", "artifact_md": "a", ',  # cut between tokens
        '{"summary": "", "artifact_md": "a',  # required key empty
        '{"summary": null, "artifact_md": "a',  # required key null
        'prose {"summary": "ok", "artifact_md": "a',  # not a bare object
        '{"summary": "ok", "verdict": "pass", "artifact_md": "a',  # verdict backstop
    ],
)
def test_salvage_refuses(text):
    assert salvage_truncated_reply(text, ("summary", "artifact_md")) is None


def test_salvage_refuses_when_no_required_keys_are_named():
    assert salvage_truncated_reply('{"summary": "o', ()) is None


def test_salvage_closes_a_nested_array_in_stack_order():
    parsed, note = salvage_truncated_reply('{"summary": "s", "artifact_md": "a", "items": ["x", "y', ("summary",))
    assert parsed == {"summary": "s", "artifact_md": "a", "items": ["x", "y"]}
    assert note == agent_runner.SALVAGE_NOTE


def test_salvage_reads_through_a_code_fence():
    parsed, _ = salvage_truncated_reply('```json\n{"summary": "s", "artifact_md": "half', ("summary", "artifact_md"))
    assert parsed == {"summary": "s", "artifact_md": "half"}


def test_the_handoff_note_is_capped_and_timestamped(handoff_dir):
    handoff.write_note("T-1", PLAN, "x" * (handoff.NOTE_MAX_CHARS * 2))
    text = handoff.read_note("T-1", PLAN)
    assert text.startswith("_Written ")
    assert text.count("x") == handoff.NOTE_MAX_CHARS
