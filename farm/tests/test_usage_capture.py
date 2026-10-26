"""HZ-550: every step run reports the model and provider that ran it, and its
token usage and cost as the provider reported them, summed over every agent
call the run made. A run with no agent call reports 0 tokens, labelled
non-agent. Capture never changes how a step runs.

Runs go through step_agent.main() with only the Claude CLI's process stubbed
(claude.subprocess), so the real provider parses the stubbed result, the real
run_agent() meters it and the real result post is captured. The stub's figures
are farm/tests/fixtures/usage_stub.json, which server/test/step-run-usage.test.mjs
stores on step_run.
"""

import json
import math
import subprocess
import sys
import types
from pathlib import Path

import pytest

from domain.py import steps
from farm import agent_runner, step_agent
from farm.providers import base, claude
from farm.tests.test_step_agent import make_git_workspace, make_task

STUB = json.loads((Path(__file__).resolve().parent / "fixtures" / "usage_stub.json").read_text())
FIGURES = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd")
PROVIDER_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
DRAFT_PLAN = "Draft implementation plan"
NON_AGENT = {"agent_run": False, **{key: 0 for key in FIGURES}}


def turn(reply, figures=None, *, cost=None, raw_usage=None, effect=None):
    """One stubbed CLI call: its reply text and the usage it reports —
    (input, output, cache read, cache write) and the cost, or raw_usage as given."""
    usage = raw_usage if raw_usage is not None else dict(zip(PROVIDER_KEYS, figures)) if figures else None
    return {"reply": reply, "usage": usage, "cost": cost, "effect": effect}


STUB_TURN = dict(
    figures=tuple(STUB["provider_usage"][key] for key in PROVIDER_KEYS),
    cost=STUB["total_cost_usd"],
)


@pytest.fixture
def cli(monkeypatch):
    """Stubs the Claude CLI process (only claude.py's subprocess) with a queue
    of turns. Returns the prompts it was given."""
    lane = types.SimpleNamespace(turns=[], prompts=[], argv=[])

    def fake_run(cmd, **kwargs):
        lane.argv.append(cmd)
        lane.prompts.append(cmd[cmd.index("-p") + 1])
        nxt = lane.turns.pop(0)
        if nxt["effect"]:
            nxt["effect"](Path(kwargs.get("cwd") or "."))
        body = {"type": "result", "result": nxt["reply"], "session_id": "sess-550", "num_turns": 3}
        if nxt["usage"] is not None:
            body["usage"] = nxt["usage"]
        if nxt["cost"] is not None:
            body["total_cost_usd"] = nxt["cost"]
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=json.dumps(body), stderr="")

    monkeypatch.setattr(claude, "subprocess", types.SimpleNamespace(run=fake_run, TimeoutExpired=subprocess.TimeoutExpired))
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    monkeypatch.setenv("FARM_PROVIDER", "claude")
    monkeypatch.setenv(agent_runner.MODEL_OVERRIDE_ENV, STUB["model"])
    return lane


def run_main(tmp_path, monkeypatch, task):
    """step_agent.main() on `task`; returns the result it posted."""
    task_file = tmp_path / f"task-{task['run_id']}.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.update(json))
    step_agent.main()
    return posted


def reply(**body):
    return json.dumps({"summary": "did the step", "artifact_md": "## Done\nbody", **body})


def plan_task(run_id=5501):
    task = make_task(steps.by_kind_label("change", DRAFT_PLAN)["index"], DRAFT_PLAN)
    task["run_id"] = run_id
    # The prompt carries every prior artifact; the result must carry none of it.
    task["artifacts"] = [{"label": "Plan options", "content": STUB["prompt_marker"]}]
    return task


def kind_task(kind, label, run_id):
    return {
        "run_id": run_id,
        "attempt": 1,
        "item": {"id": f"{kind[0].upper()}-550", "title": "Usage", "priority": "High", "repo": None, "kind": kind},
        "step": {"index": steps.by_kind_label(kind, label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


def deploy_task(run_id, deploy_wait):
    task = make_task(steps.by_kind_label("change", step_agent.DEPLOY_LABEL)["index"], step_agent.DEPLOY_LABEL, repo="acme/demo")
    task["run_id"] = run_id
    task["item"]["release_tag"] = None  # nothing to wait for
    task["deploy_wait"] = deploy_wait
    return task


# ---- metric 1: the stub's model, provider and every figure ----


def test_a_completed_agent_step_posts_the_stubbed_model_provider_tokens_and_cost(tmp_path, monkeypatch, cli, capsys):
    cli.turns = [turn(reply(), **STUB_TURN)]
    posted = run_main(tmp_path, monkeypatch, plan_task())

    assert posted["ok"] is True
    artifacts = posted["artifacts"]
    assert artifacts["usage"] == STUB["usage"]
    assert (artifacts["provider"], artifacts["model"]) == (STUB["provider"], STUB["model"])
    # Guardrail 1: the prompt went to the CLI and nowhere else.
    assert STUB["prompt_marker"] in cli.prompts[0]
    assert STUB["prompt_marker"] not in json.dumps(posted)
    # Guardrail 1: no log line carries a figure.
    out = capsys.readouterr()
    for value in STUB["usage"].values():
        if not isinstance(value, bool):
            assert str(value) not in out.out + out.err


@pytest.mark.parametrize(
    "task,body",
    [
        (lambda: kind_task("task", step_agent.ASSESS_LABEL, 5502), {}),
        (
            lambda: kind_task("plan", "Review drafts: metrics & size", 5503),
            {"plan_review": {"coverage": [], "overlaps": []}},
        ),
    ],
    ids=["task-step", "plan-step"],
)
def test_task_and_plan_steps_record_the_model_that_ran(tmp_path, monkeypatch, cli, task, body):
    """Neither is providerOverrideEligible, so before HZ-550 neither sent one."""
    built = task()
    assert not steps.provider_override_eligible(steps.FARM_VIEWS[built["item"]["kind"]], built["step"]["label"])
    cli.turns = [turn(reply(**body), **STUB_TURN)]
    posted = run_main(tmp_path, monkeypatch, built)

    assert posted["ok"] is True, posted
    assert posted["artifacts"]["model"] == STUB["model"]
    assert posted["artifacts"]["provider"] == STUB["provider"]
    assert posted["artifacts"]["usage"] == STUB["usage"]


def test_an_agent_deploy_records_the_model_that_ran(tmp_path, monkeypatch, cli):
    monkeypatch.setattr(step_agent, "run_grpc_health_check", lambda url: ("pass", "SMOKE_RESULT=pass: gRPC health SERVING"))
    cli.turns = [turn(json.dumps({"summary": "deployed", "artifact_md": "## Deploy\nok"}), **STUB_TURN)]
    wait = {"state_dir": str(tmp_path), "timeout_s": 60, "health_check_type": "grpc-health", "health_url": "http://127.0.0.1:8090/"}
    posted = run_main(tmp_path, monkeypatch, deploy_task(5504, wait))

    assert posted["ok"] is True, posted
    assert posted["artifacts"]["verdict"] == {"verdict": "pass"}
    assert (posted["artifacts"]["provider"], posted["artifacts"]["model"]) == (STUB["provider"], STUB["model"])
    assert posted["artifacts"]["usage"] == STUB["usage"]


# ---- metric 5: every turn summed; a run with no agent is 0, non-agent ----


def _sum(*turns):
    return {
        "agent_run": True,
        **{key: sum(t[i] for t in turns) for i, key in enumerate(FIGURES[:4])},
        "cost_usd": sum(t[4] for t in turns),
    }


def assert_usage(actual, expected):
    assert {k: v for k, v in actual.items() if k != "cost_usd"} == {k: v for k, v in expected.items() if k != "cost_usd"}
    assert math.isclose(actual["cost_usd"], expected["cost_usd"], abs_tol=1e-9)


def test_a_parse_retry_is_summed_with_the_first_try(tmp_path, monkeypatch, cli):
    first, retry = (1201, 311, 40213, 2207, 0.081337), (1733, 402, 41019, 2911, 0.097121)
    cli.turns = [turn("no json here", first[:4], cost=first[4]), turn(reply(), retry[:4], cost=retry[4])]
    posted = run_main(tmp_path, monkeypatch, plan_task(5505))

    assert posted["ok"] is True and len(cli.prompts) == 2
    assert_usage(posted["artifacts"]["usage"], _sum(first, retry))


def test_a_fix_loop_turn_is_summed_with_the_first_try(tmp_path, monkeypatch, cli, checks_notify):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.delenv("FARM_FIX_LOOP_CAP", raising=False)
    monkeypatch.setenv(
        "FARM_CHECK_CMD",
        "if [ -f seeded_bug.txt ]; then echo 'not ok 1 - seeded bug'; echo '# fail 1'; exit 1; fi; echo 'ok 1 - fine'",
    )
    first, fix = (5309, 1187, 91203, 6113, 0.412977), (2141, 653, 99871, 1009, 0.153309)
    cli.turns = [
        turn('{"summary": "built it"}', first[:4], cost=first[4], effect=lambda cwd: (cwd / "seeded_bug.txt").write_text("bug\n")),
        turn('{"summary": "fixed it"}', fix[:4], cost=fix[4], effect=lambda cwd: (cwd / "seeded_bug.txt").unlink()),
    ]
    task = make_task(steps.by_kind_label("change", step_agent.IMPLEMENT_LABEL)["index"], step_agent.IMPLEMENT_LABEL, repo="acme/demo")
    task["run_id"] = 5506
    posted = run_main(tmp_path, monkeypatch, task)

    assert posted["ok"] is True, posted
    assert "fix loops: 1" in posted["summary"]
    assert "--resume" in cli.argv[1]  # the fix turn ran in the same session
    assert_usage(posted["artifacts"]["usage"], _sum(first, fix))


def test_three_metered_calls_sum_exactly():
    """The meter on its own: a first try, a retry and a fix turn, each distinct."""
    turns = [(11, 7, 101, 13, 0.25), (23, 5, 307, 17, 0.125), (41, 3, 503, 19, 0.0625)]
    with agent_runner.usage_meter() as meter:
        for t in turns:
            agent_runner._meter_call("claude", STUB["model"], dict(zip(FIGURES, t)))
    assert meter.report() == _sum(*turns)


def test_a_deploy_log_deploy_runs_no_agent_and_reports_zero_non_agent(tmp_path, monkeypatch, cli):
    cli.turns = []  # any CLI call would pop an empty queue
    wait = {"state_dir": str(tmp_path), "timeout_s": 60, "health_check_type": "deploy-log"}
    posted = run_main(tmp_path, monkeypatch, deploy_task(5507, wait))

    assert posted["ok"] is True, posted
    assert posted["artifacts"]["usage"] == NON_AGENT
    # No agent ran, so there is no model to name.
    assert "provider" not in posted["artifacts"] and "model" not in posted["artifacts"]
    assert cli.prompts == []


def test_one_call_with_unknown_usage_nulls_the_run_rather_than_under_counting():
    with agent_runner.usage_meter() as meter:
        agent_runner._meter_call("claude", STUB["model"], dict(STUB["usage"]))
        agent_runner._meter_call("muse", "muse-spark-1.3", None)
    assert meter.report() == {"agent_run": True, **{key: None for key in FIGURES}}
    assert meter.last_ran() == ("muse", "muse-spark-1.3")


# ---- guardrail 2: capture never changes how a step runs ----


@pytest.mark.parametrize(
    "raw,cost",
    [
        (None, 1.0),
        ("lots", 1.0),
        ({**STUB["provider_usage"], "input_tokens": "48213"}, 1.0),
        ({**STUB["provider_usage"], "output_tokens": -1}, 1.0),
        ({**STUB["provider_usage"], "cache_read_input_tokens": float("nan")}, 1.0),
        ({**STUB["provider_usage"], "cache_creation_input_tokens": 1.5}, 1.0),
        ({k: v for k, v in STUB["provider_usage"].items() if k != "input_tokens"}, 1.0),
        (STUB["provider_usage"], None),
        (STUB["provider_usage"], "1.73"),
        (STUB["provider_usage"], -0.01),
        (STUB["provider_usage"], True),
    ],
)
def test_normalize_usage_returns_none_for_anything_malformed(raw, cost):
    assert base.normalize_usage(raw, cost) is None


def test_normalize_usage_never_raises():
    class Exploding(dict):
        def get(self, *args):
            raise RuntimeError("boom")

    assert base.normalize_usage(Exploding(), 1.0) is None
    assert base.normalize_usage(STUB["provider_usage"], STUB["total_cost_usd"]) == {
        k: v for k, v in STUB["usage"].items() if k != "agent_run"
    }


def test_malformed_usage_leaves_the_figures_null_and_the_result_otherwise_unchanged(tmp_path, monkeypatch, cli):
    cli.turns = [turn(reply(), **STUB_TURN)]
    good = run_main(tmp_path, monkeypatch, plan_task(5508))
    cli.turns = [turn(reply(), raw_usage={"input_tokens": "lots"}, cost=STUB["total_cost_usd"])]
    bad = run_main(tmp_path, monkeypatch, plan_task(5508))

    assert bad["ok"] is True
    assert bad["artifacts"]["usage"] == {"agent_run": True, **{key: None for key in FIGURES}}
    strip = lambda posted: {**posted, "artifacts": {k: v for k, v in posted["artifacts"].items() if k != "usage"}}
    assert strip(bad) == strip(good)


def test_a_meter_that_fails_to_report_leaves_the_result_alone(monkeypatch):
    class Broken:
        def report(self):
            raise RuntimeError("meter broke")

    result = {"run_id": 1, "ok": True, "summary": "s", "artifacts": {"artifact_md": "a"}}
    step_agent._attach_usage(result, Broken())
    assert result == {"run_id": 1, "ok": True, "summary": "s", "artifacts": {"artifact_md": "a"}}


def _stub_provider(monkeypatch, run):
    monkeypatch.setitem(
        agent_runner._PROVIDERS,
        "claude",
        types.SimpleNamespace(SUPPORTS_RESUME=True, RESUMES_AFTER_EXHAUSTION=True, assert_subscription_auth=lambda: None, run=run),
    )
    monkeypatch.setenv("FARM_PROVIDER", "claude")


def test_run_agent_with_no_meter_returns_and_raises_as_before(monkeypatch):
    """The concierge, the conflict resolver and the caretaker call run_agent()
    outside step_agent.main(): nothing is recorded and nothing changes."""
    outcomes = [{"result": "ok", "session_id": "s", "usage": dict(STUB["usage"])}, agent_runner.AgentError("provider broke")]

    def run(prompt, **kwargs):
        nxt = outcomes.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return dict(nxt)

    _stub_provider(monkeypatch, run)
    assert agent_runner._METER.get() is None
    reply_ = agent_runner.run_agent("p", agent="eng")
    assert reply_["result"] == "ok" and reply_["provider"] == "claude"
    with pytest.raises(agent_runner.AgentError, match="provider broke"):
        agent_runner.run_agent("p", agent="eng")
    assert agent_runner._METER.get() is None


def test_a_metered_call_raises_exactly_as_an_unmetered_one(monkeypatch):
    def run(prompt, **kwargs):
        raise agent_runner.AgentUsageLimitedError("limit", reset_at="2026-10-24T18:00:00Z")

    _stub_provider(monkeypatch, run)
    with agent_runner.usage_meter() as meter:
        with pytest.raises(agent_runner.AgentUsageLimitedError) as err:
            agent_runner.run_agent("p", agent="eng")
    assert (err.value.provider, err.value.reset_at) == ("claude", "2026-10-24T18:00:00Z")
    assert meter.report()["cost_usd"] is None  # the limited call's usage is unknown


def test_metered_billing_charges_the_same_estimate_with_or_without_a_meter(monkeypatch):
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "100")
    tracker = base._SpendTracker()
    monkeypatch.setattr(base, "_METERED_SPEND_TRACKER", tracker)
    monkeypatch.setitem(
        agent_runner._PROVIDERS,
        "claude",
        types.SimpleNamespace(
            SUPPORTS_RESUME=True,
            RESUMES_AFTER_EXHAUSTION=True,
            assert_subscription_auth=lambda: base.assert_metered_billing_authorized("claude"),
            run=lambda prompt, **kwargs: {"result": "ok", "session_id": "s", "usage": None},
        ),
    )
    monkeypatch.setenv("FARM_PROVIDER", "claude")

    agent_runner.run_agent("p", agent="eng")
    unmetered = tracker.spent_usd
    with agent_runner.usage_meter():
        agent_runner.run_agent("p", agent="eng")
    assert unmetered == base._METERED_CALL_ESTIMATE_USD
    assert tracker.spent_usd == 2 * unmetered


# ---- the SDK path reads the same figures off its ResultMessage ----


def test_the_sdk_result_message_usage_and_cost_reach_the_reply(monkeypatch):
    sdk = pytest.importorskip("claude_agent_sdk")
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setenv("FARM_PROVIDER", "claude")

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield sdk.ResultMessage(
                subtype="success",
                duration_ms=1500,
                duration_api_ms=1200,
                is_error=False,
                num_turns=2,
                session_id="sdk-550",
                result='{"summary": "done"}',
                total_cost_usd=STUB["total_cost_usd"],
                usage=dict(STUB["provider_usage"]),
            )

        return gen()

    monkeypatch.setattr(sdk, "query", fake_query)
    with agent_runner.usage_meter() as meter:
        reply_ = agent_runner.run_agent("p", agent="eng")
    assert reply_["usage"] == {k: v for k, v in STUB["usage"].items() if k != "agent_run"}
    assert meter.report() == STUB["usage"]
