"""HZ-383: a Task's Assess, Run plan and Impact review steps run on the farm,
read-only, routed by the item's kind and the step's label.

Every agent run is stubbed: run_agent is monkeypatched at step_agent's import
of it, except in the provider-argv case, which stubs one level lower — the
claude CLI's subprocess call — so the real allowlist reaches the argv.
"""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from domain.py import run_plan, steps
from domain.py.personas import model_agent_for_step
from farm import farmd, step_agent
from farm.agent_runner import AgentError
from farm.config import QUEUE_DIR
from farm.providers import claude

REPO_ROOT = Path(__file__).resolve().parents[2]
TASK_LABELS = [step_agent.ASSESS_LABEL, step_agent.RUN_PLAN_LABEL, step_agent.IMPACT_REVIEW_LABEL]
WRITE_TOOLS = ("Edit", "Write", "Bash")
# A literal token shape, built so this file never holds one whole.
FAKE_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"

VALID_PLAN = {
    "cwd": "infra/host",
    "commands": ["./backfill.sh --dry-run", "./backfill.sh"],
    "budget_minutes": 10,
    "env": {"GITHUB_TOKEN": "$GITHUB_TOKEN"},
}


def task_index(label: str) -> int:
    return steps.by_kind_label("task", label)["index"]


def make_task(label: str, *, kind="task", index=None, repo=None, provider_choices=None) -> dict:
    item = {"id": "T-383", "title": "Backfill", "desc": "Run the backfill", "priority": "High", "repo": repo}
    if kind is not None:
        item["kind"] = kind
    if provider_choices:
        item["providerChoices"] = provider_choices
    return {
        "run_id": 383,
        "attempt": 1,
        "item": item,
        "step": {"index": task_index(label) if index is None else index, "label": label},
        "artifacts": [],
        "feedback": [],
    }


def reply_for(label: str, **overrides) -> dict:
    body = {"summary": f"did {label}", "artifact_md": f"## {label}\nbody"}
    if label == step_agent.RUN_PLAN_LABEL:
        body["run_plan"] = dict(VALID_PLAN)
    body.update(overrides)
    return body


def stub_agent(monkeypatch, replies):
    """run_agent stub answering with each reply in turn (the last repeats)."""
    calls = []

    def fake(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        body = replies[min(len(calls), len(replies)) - 1]
        return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return calls


# ---- metric 1: routed by kind and label, never by index ----


def test_a_task_step_and_a_change_step_at_the_same_index_each_get_their_own_runner(monkeypatch):
    """The same index, sent once as a Task's Assess and once as a change
    step's Architecture review: each resolves its own role prompt and tools,
    because the kind and the label pick the runner, not the index."""
    shared = task_index(step_agent.ASSESS_LABEL)
    ran = {}
    for kind, label in (("task", step_agent.ASSESS_LABEL), ("change", step_agent.ARCH_REVIEW_LABEL)):
        calls = stub_agent(monkeypatch, [reply_for(label)])
        step_agent.execute(make_task(label, kind=kind, index=shared))
        ran[kind] = calls[0]
    assert ran["task"]["append_system"] == (step_agent.ROLES / "task_assess.md").read_text()
    assert ran["change"]["append_system"] == (step_agent.ROLES / "architect_review.md").read_text()
    assert ran["task"]["append_system"] != ran["change"]["append_system"]


def test_a_shared_label_resolves_to_its_own_kinds_row():
    """Both kinds open with a row of the same label. Each kind sees only its
    own: the change row runs on the PM lane, the Task row has no runner yet,
    so it is not in the Task farm view at all."""
    shared = {row["label"] for row in steps.steps_for("change")} & {row["label"] for row in steps.steps_for("task")}
    assert len(shared) == 1, "the test needs exactly one label both kinds share"
    label = shared.pop()
    assert steps.by_kind_label("change", label)["runsIn"] == "pm"
    with pytest.raises(KeyError):
        steps.by_kind_label("task", label)
    with pytest.raises(KeyError):
        step_agent._step_config("task", label)


@pytest.mark.parametrize("kind,label", [("change", step_agent.ASSESS_LABEL), ("task", step_agent.ARCH_REVIEW_LABEL)])
def test_a_label_sent_under_the_wrong_kind_fails_loudly(monkeypatch, kind, label):
    calls = stub_agent(monkeypatch, [reply_for(label)])
    with pytest.raises(KeyError):
        step_agent.execute(make_task(label, kind=kind, index=0))
    assert calls == []


def test_impact_review_runs_as_its_own_rows_agent(monkeypatch):
    """The Task row says Architect. No change row has this label, so a
    label-only lookup in the change table would raise instead."""
    calls = stub_agent(monkeypatch, [reply_for(step_agent.IMPACT_REVIEW_LABEL)])
    step_agent.execute(make_task(step_agent.IMPACT_REVIEW_LABEL))
    assert steps.by_kind_label("task", step_agent.IMPACT_REVIEW_LABEL)["agent"] == "Architect"
    assert calls[0]["agent"] == model_agent_for_step("Architect")


def test_the_real_tables_change_configs_are_untouched_and_task_labels_map_to_task_roles():
    assert step_agent.STEP_CONFIGS["change"] is step_agent.STEP_CONFIG
    for entry in steps.STEPS:
        assert step_agent._step_config("change", entry["label"]) == step_agent.STEP_CONFIG[entry["label"]]
    expected = {
        step_agent.ASSESS_LABEL: ("task_assess.md", None),
        step_agent.RUN_PLAN_LABEL: ("task_run_plan.md", None),
        step_agent.IMPACT_REVIEW_LABEL: ("task_impact_review.md", None),
        # HZ-378: Verify & report, read-only QA with the item's QA persona.
        step_agent.VERIFY_REPORT_LABEL: ("task_verify.md", "qa"),
    }
    # The agent lanes only: Execute rides the job lane (below), which has no
    # agent runner, so it is in the view but not in the step config.
    assert {entry["label"] for entry in steps.FARM_VIEWS["task"] if entry["runsIn"] in ("farm", "pm")} == set(
        expected
    )
    for label, (role_file, persona) in expected.items():
        assert step_agent._step_config("task", label) == (role_file, True, step_agent.PLANNER_TOOLS, persona)
        assert (step_agent.ROLES / role_file).read_text().strip()
    assert steps.by_kind_label("task", "Execute")["runsIn"] == "job"
    with pytest.raises(KeyError):
        step_agent._step_config("task", "Execute")


# ---- metric 1: farmd refuses a payload whose kind and step disagree ----


@pytest.fixture
def running_farm(monkeypatch):
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: False)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield TestClient(farmd.app)
    finally:
        farmd.state.update(saved)
        for lane in ("pm", "runs"):
            for f in (QUEUE_DIR / lane).glob("3830*.json"):
                f.unlink(missing_ok=True)


def farmd_task(run_id, *, index, label, kind="task"):
    item = {"id": "T-383", "repo": "acme/demo"}
    if kind is not None:
        item["kind"] = kind
    return {"run_id": run_id, "project": {"id": 1, "name": "FinTekkers"}, "item": item, "step": {"index": index, "label": label}}


def test_farmd_queues_a_task_step_on_the_runs_lane(running_farm):
    res = running_farm.post("/steps/run", json=farmd_task(38301, index=task_index("Assess"), label="Assess"))
    assert res.status_code == 200
    assert res.json() == {"ok": True, "queued": "runs"}
    assert json.loads((QUEUE_DIR / "runs" / "38301.json").read_text())["item"]["kind"] == "task"


@pytest.mark.parametrize(
    "case",
    [
        {"index": "Run plan", "label": "Assess", "kind": "task"},
        {"index": "Assess", "label": "Assess", "kind": "change"},
        {"index": "Assess", "label": "Assess", "kind": None},
    ],
    ids=["wrong index", "wrong kind", "a task row sent with no kind"],
)
def test_farmd_refuses_a_step_kind_mismatch(running_farm, case):
    task = farmd_task(38302, index=task_index(case["index"]), label=case["label"], kind=case["kind"])
    res = running_farm.post("/steps/run", json=task)
    assert res.status_code == 400
    assert res.json() == {"error": "step kind mismatch"}
    assert not (QUEUE_DIR / "runs" / "38302.json").exists()


def test_farmd_still_accepts_a_change_step_with_no_kind(running_farm):
    """A server that predates item kinds sends no item.kind: still a change step."""
    index = steps.by_label(step_agent.ENG_PLAN_LABEL)["index"]
    res = running_farm.post("/steps/run", json=farmd_task(38303, index=index, label=step_agent.ENG_PLAN_LABEL, kind=None))
    assert res.status_code == 200
    assert res.json()["queued"] == "runs"


# ---- metric 2: read-only tools, guardrail 1: nothing can run a command ----


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    for args in (("init", "-b", "main"), ("config", "user.email", "t@example.com"), ("config", "user.name", "T")):
        subprocess.run(["git", "-C", str(ws), *args], check=True, capture_output=True)
    (ws / "README.md").write_text("# demo\n")
    subprocess.run(["git", "-C", str(ws), "add", "-A"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(ws), "commit", "-m", "init"], check=True, capture_output=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo_full, item_id: ws)
    return ws


@pytest.mark.parametrize("with_workspace", [False, True], ids=["no workspace", "workspace"])
@pytest.mark.parametrize("label", TASK_LABELS)
def test_each_task_step_gets_only_the_read_only_tools(monkeypatch, request, label, with_workspace):
    repo = None
    if with_workspace:
        request.getfixturevalue("workspace")
        repo = "acme/demo"
    calls = stub_agent(monkeypatch, [reply_for(label)])
    # A project default of Muse for this step: Task steps are provider-locked.
    task = make_task(label, repo=repo, provider_choices={str(task_index(label)): "muse"})
    step_agent.execute(task)
    assert len(calls) == 1
    tools = calls[0]["allowed_tools"]
    assert tools == "Read,Glob,Grep"
    assert not any(tool in tools.split(",") for tool in WRITE_TOOLS)
    assert calls[0]["provider_locked"] is True
    assert calls[0]["provider"] is None
    if with_workspace:
        assert calls[0]["cwd"]


@pytest.mark.parametrize("label", TASK_LABELS)
def test_the_claude_argv_carries_the_read_only_allowlist(monkeypatch, label):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    monkeypatch.delenv("FARM_PROVIDER", raising=False)
    argvs = []

    def fake_run(cmd, **kwargs):
        argvs.append(cmd)
        out = json.dumps({"result": json.dumps(reply_for(label)), "session_id": "s"})
        return SimpleNamespace(returncode=0, stdout=out, stderr="")

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    step_agent.execute(make_task(label, provider_choices={str(task_index(label)): "muse"}))
    assert len(argvs) == 1
    argv = argvs[0]
    assert argv[argv.index("--allowedTools") + 1] == "Read,Glob,Grep"
    assert not any(tool in argv[argv.index("--allowedTools") + 1].split(",") for tool in WRITE_TOOLS)


# ---- metric 3: each step stores an artifact and a one-line summary ----


@pytest.mark.parametrize("label", TASK_LABELS)
def test_each_task_step_posts_its_summary_and_artifact(monkeypatch, tmp_path, label):
    stub_agent(monkeypatch, [reply_for(label)])
    posted = []
    monkeypatch.setattr(step_agent, "post_result", posted.append)
    monkeypatch.setattr(step_agent.handoff, "clear_note", lambda *a: None)
    task = make_task(label)
    path = tmp_path / "383.json"
    path.write_text(json.dumps(task))
    monkeypatch.setattr("sys.argv", ["step_agent", "--task", str(path)])
    assert step_agent.main() == 0
    assert posted[0]["ok"] is True
    assert posted[0]["summary"] == f"did {label}"
    assert posted[0]["artifacts"]["artifact_md"].startswith(f"## {label}\nbody")


# ---- metric 5: the Run plan block ----


def test_a_valid_run_plan_is_appended_to_the_artifact(monkeypatch):
    stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL)])
    result = step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert run_plan.extract(result["artifacts"]["artifact_md"]) == VALID_PLAN


@pytest.mark.parametrize(
    "plan",
    [
        {k: v for k, v in VALID_PLAN.items() if k != "cwd"},
        {**VALID_PLAN, "commands": []},
        {k: v for k, v in VALID_PLAN.items() if k != "budget_minutes"},
        {**VALID_PLAN, "budget_minutes": 0},
    ],
    ids=["missing cwd", "empty commands", "missing budget_minutes", "zero budget_minutes"],
)
def test_a_bad_run_plan_fails_the_step_after_one_retry(monkeypatch, plan):
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, run_plan=plan)])
    with pytest.raises(AgentError, match="invalid run plan"):
        step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert len(calls) == 2


def test_a_bad_run_plan_fixed_on_the_retry_passes(monkeypatch):
    bad = reply_for(step_agent.RUN_PLAN_LABEL, run_plan={**VALID_PLAN, "commands": []})
    calls = stub_agent(monkeypatch, [bad, reply_for(step_agent.RUN_PLAN_LABEL)])
    result = step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert len(calls) == 2
    assert run_plan.extract(result["artifacts"]["artifact_md"]) == VALID_PLAN


def test_the_run_plan_binding_takes_its_required_fields_from_the_schema():
    schema = json.loads((REPO_ROOT / "domain" / "runPlan.schema.json").read_text())
    assert run_plan.REQUIRED == tuple(schema["required"]) == ("cwd", "commands", "budget_minutes")
    assert run_plan.validate(dict(VALID_PLAN)) == VALID_PLAN


# ---- guardrail 4: secrets are references only ----


def test_the_schema_alone_accepts_a_literal_env_value_and_the_binding_rejects_it():
    """domain/validate.mjs has no `pattern` keyword, so the reference rule
    lives in the binding. Proven here against the real JS validator."""
    plan = {**VALID_PLAN, "env": {"GITHUB_TOKEN": "literal-value-123"}}
    script = (
        "import { validate } from './domain/validate.mjs';"
        "import { readFileSync } from 'node:fs';"
        "const schema = JSON.parse(readFileSync('domain/runPlan.schema.json', 'utf8'));"
        f"console.log(JSON.stringify(validate(schema, {json.dumps(plan)})));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    assert json.loads(out.stdout) == []
    with pytest.raises(ValueError, match="env"):
        run_plan.validate(plan)


@pytest.mark.parametrize(
    "overrides",
    [
        {"run_plan": {**VALID_PLAN, "commands": [f'curl -H "Authorization: token {FAKE_TOKEN}" https://api.github.com']}},
        {"summary": f"used {FAKE_TOKEN}"},
        {"artifact_md": f"## Environment\nexport GITHUB_TOKEN={FAKE_TOKEN}"},
    ],
    ids=["in commands", "in the summary", "in the artifact"],
)
def test_a_literal_token_fails_the_step_and_is_never_logged(monkeypatch, capsys, overrides):
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, **overrides)])
    with pytest.raises(AgentError) as exc:
        step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert len(calls) == 2
    assert "github-token" in str(exc.value)
    assert FAKE_TOKEN not in str(exc.value)
    captured = capsys.readouterr()
    assert "github-token" in captured.out
    assert FAKE_TOKEN not in captured.out + captured.err
    # The retry prompt names the shape too, never the token.
    assert FAKE_TOKEN not in calls[1]["prompt"]


def test_a_secret_reference_is_not_a_literal():
    assert run_plan.literal_secrets("export GITHUB_TOKEN=$GITHUB_TOKEN; uses sk-learn") == []
    assert run_plan.literal_secrets(f"GITHUB_TOKEN={FAKE_TOKEN}") == ["github-token", "secret-assignment"]
