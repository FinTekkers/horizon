"""HZ-383: a Task's Assess, Run plan and Impact review steps run on the farm,
read-only, routed by the item's kind and the step's label.

Every agent run is stubbed: run_agent is monkeypatched at step_agent's import
of it, except in the provider-argv case, which stubs one level lower — the
claude CLI's subprocess call — so the real allowlist reaches the argv.
"""

import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from domain.py import run_plan, steps
from domain.py.personas import model_agent_for_step
from farm import farmd, pm_steps, step_agent
from farm.agent_runner import AgentError
from farm.config import QUEUE_DIR
from farm.providers import claude

REPO_ROOT = Path(__file__).resolve().parents[2]
TASK_LABELS = [step_agent.ASSESS_LABEL, step_agent.RUN_PLAN_LABEL, step_agent.IMPACT_REVIEW_LABEL]
# HZ-413: a Task's steps 0-2, the PM kind like the change ones.
TASK_PM_LABELS = [row["label"] for row in steps.steps_for("task")[:3]]
CHANGE_PM_LABELS = [row["label"] for row in steps.steps_for("change")[:3]]
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
    own: both run on the PM lane (HZ-413), each at its own index."""
    shared = {row["label"] for row in steps.steps_for("change")} & {row["label"] for row in steps.steps_for("task")}
    assert len(shared) == 1, "the test needs exactly one label both kinds share"
    label = shared.pop()
    change, task = steps.by_kind_label("change", label), steps.by_kind_label("task", label)
    assert change["runsIn"] == task["runsIn"] == "pm"
    assert change["index"] == 0
    assert task["index"] == steps.first_step_index("task")
    assert step_agent._step_config("task", label) == step_agent._step_config("change", label)


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
    # agent runner, so it is in the view but not in the step config. HZ-413:
    # steps 0-2 are the PM kind, checked apart, as they get no tools here.
    assert {entry["label"] for entry in steps.FARM_VIEWS["task"] if entry["runsIn"] in ("farm", "pm")} == set(
        expected
    ) | set(TASK_PM_LABELS)
    for label, (role_file, persona) in expected.items():
        assert step_agent._step_config("task", label) == (role_file, True, step_agent.PLANNER_TOOLS, persona)
        assert (step_agent.ROLES / role_file).read_text().strip()
    for label in TASK_PM_LABELS:
        assert step_agent._step_config("task", label) == ("pm.md", True, None, None)
        assert step_agent._is_pm_step(label, "task")
        assert not step_agent._is_read_only("task", label)
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


# ---- HZ-429: Verify & report's verdict reaches the server ----


def test_verify_and_report_passes_its_verdict_through_and_run_plan_does_not(monkeypatch):
    verdict = {"verdict": "fail", "summary": "Command 1 crashed on import.\nNone of the 5 metric lines hold."}
    stub_agent(monkeypatch, [reply_for(step_agent.VERIFY_REPORT_LABEL, verdict=verdict)])
    result = step_agent.execute(make_task(step_agent.VERIFY_REPORT_LABEL))
    assert result["artifacts"]["verdict"] == verdict
    assert result["artifacts"]["artifact_md"].startswith(f"## {step_agent.VERIFY_REPORT_LABEL}\nbody")

    stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, verdict=verdict)])
    result = step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert "verdict" not in result["artifacts"]


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
        {**VALID_PLAN, "cwd": "/opt/x"},
        {**VALID_PLAN, "cwd": "a/../b"},
    ],
    ids=["missing cwd", "empty commands", "missing budget_minutes", "zero budget_minutes", "absolute cwd", "cwd with .."],
)
def test_a_bad_run_plan_fails_the_step_after_one_retry(monkeypatch, plan):
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, run_plan=plan)])
    with pytest.raises(AgentError, match="invalid run plan") as raised:
        step_agent.execute(make_task(step_agent.RUN_PLAN_LABEL))
    assert len(calls) == 2
    if plan.get("cwd") in ("/opt/x", "a/../b"):
        assert "'cwd'" in str(raised.value)


# ---- HZ-415 metric 3: cwd is relative to the repo root ----


@pytest.mark.parametrize(
    "cwd,reason",
    [
        ("/abs", "must be relative to the repo root, not an absolute path"),
        ("/opt/fintekkers/market-data-inputs", "must be relative to the repo root, not an absolute path"),
        ("a/../b", "must not contain '..'"),
        ("..", "must not contain '..'"),
    ],
)
def test_validate_rejects_an_absolute_cwd_or_one_with_dotdot(cwd, reason):
    with pytest.raises(ValueError, match=re.escape(reason)):
        run_plan.validate({**VALID_PLAN, "cwd": cwd})


@pytest.mark.parametrize("cwd", [".", "sub", "./sub", "sub/dir/", "a..b"])
def test_validate_accepts_a_relative_cwd(cwd):
    assert run_plan.validate({**VALID_PLAN, "cwd": cwd})["cwd"] == cwd


def test_the_run_plan_prompt_says_cwd_is_relative_to_the_repo_root():
    prompt = (REPO_ROOT / "farm" / "roles" / "task_run_plan.md").read_text()
    assert "`cwd` is relative to the repo root" in prompt
    assert "An absolute path or a `..` in `cwd` fails the step." in prompt


def test_the_run_plan_prompt_asks_for_every_tool_and_file_and_no_gh_blocker_check():
    """HZ-502 metric 4: the role fills in `requires`, and never checks a
    blocker with `gh` — Horizon dependencies already did."""
    prompt = (REPO_ROOT / "farm" / "roles" / "task_run_plan.md").read_text()
    assert '"requires": [{"tool": ' in prompt
    assert "`requires` lists every tool and file the commands need." in prompt
    assert "Horizon dependencies already guarantee a blocker has merged or closed" in prompt
    assert "Do not add a `gh` command, or a `gh` tool, to check" in prompt


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


# ---- HZ-503: the plan names the proof for every metric line ----

PROOF_METRIC = "1. rows written match the count\n2. no row failed\n3. the report lists every batch"


def proof_task() -> dict:
    task = make_task(step_agent.RUN_PLAN_LABEL)
    task["item"]["metric"] = PROOF_METRIC
    return task


def proof_plan(*lines) -> dict:
    return {**VALID_PLAN, "proof": [{"line": n, "command": 1} for n in lines]}


@pytest.mark.parametrize(
    "lines,named",
    [((1, 2), "metric line 3"), ((1, 2, 2, 3), "metric line 2 more than once"), ((1, 2, 3, 6), "metric line 6")],
    ids=["a line with no proof", "a line named twice", "a line the metric does not have"],
)
def test_a_plan_with_a_proof_gap_is_sent_back_naming_the_line(monkeypatch, lines, named):
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, run_plan=proof_plan(*lines))])
    with pytest.raises(AgentError, match="invalid run plan") as raised:
        step_agent.execute(proof_task())
    assert len(calls) == 2
    assert named in str(raised.value)
    # The retry sends the plan back to Run plan with the line named.
    assert calls[1]["step"] == step_agent.RUN_PLAN_LABEL
    assert named in calls[1]["prompt"]


def test_a_plan_proving_every_line_once_finishes_with_its_proof(monkeypatch):
    plan = proof_plan(1, 2, 3)
    calls = stub_agent(monkeypatch, [reply_for(step_agent.RUN_PLAN_LABEL, run_plan=plan)])
    result = step_agent.execute(proof_task())
    assert len(calls) == 1
    assert result["summary"] == f"did {step_agent.RUN_PLAN_LABEL}"
    assert run_plan.extract(result["artifacts"]["artifact_md"])["proof"] == plan["proof"]


def test_impact_review_follows_run_plan_for_a_task():
    labels = [row["label"] for row in steps.FARM_VIEWS["task"]]
    assert labels[labels.index(step_agent.RUN_PLAN_LABEL) + 1] == step_agent.IMPACT_REVIEW_LABEL


def test_a_change_step_labelled_run_plan_gets_no_task_check():
    assert step_agent._reply_validator("change", step_agent.RUN_PLAN_LABEL, proof_task()) is None


def test_the_task_roles_name_the_proof_map_and_the_single_run_rule():
    roles = REPO_ROOT / "farm" / "roles"
    run_plan_prompt = (roles / "task_run_plan.md").read_text()
    assert '"proof": [{"line": 1, "command": 2}' in run_plan_prompt
    assert "Give one entry per metric" in run_plan_prompt
    impact = (roles / "task_impact_review.md").read_text()
    assert "'## Proof'" in impact
    assert "the plan's `proof` map" in impact
    verify = (roles / "task_verify.md").read_text()
    assert "Judge each metric line against its named proof." in verify
    assert "The plan's `proof` map" in verify
    pm = (roles / "pm_task.md").read_text()
    assert "Each line must be provable from a single run's output." in pm


def test_verify_still_judges_a_plan_approved_before_the_proof_map():
    verify = (REPO_ROOT / "farm" / "roles" / "task_verify.md").read_text()
    assert "A plan with no\n`proof` map was approved before it existed" in verify
    assert "judge each line on the job's\nevidence as a whole." in verify


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


# ---- HZ-413: a Task's steps 0-2 run on the shared PM step code ----


def _metric_lines(count: int) -> str:
    return "\n".join(f"{n}. rows written {n}" for n in range(1, count + 1))


def test_a_task_how_we_verify_over_its_line_budget_takes_the_retry_then_patches_metric(monkeypatch):
    """Metric 1, farm half: the same line budget and retry as the change PM
    steps. The first reply is over budget, so the step asks once more."""
    limit = pm_steps.LINE_LIMITS["metric"]
    calls = stub_agent(
        monkeypatch,
        [
            {"summary": "too long", "patch": {"metric": _metric_lines(limit + 1)}},
            {"summary": "wrote the run checks", "patch": {"metric": _metric_lines(limit)}},
        ],
    )
    result = step_agent.execute(make_task("How we'll verify"))
    assert len(calls) == 2
    assert f"metric has {limit + 1} lines" in calls[1]["prompt"]
    assert result["patch"] == {"metric": _metric_lines(limit)}


def test_a_task_how_we_verify_rejected_twice_fails_with_no_patch(monkeypatch):
    over = {"summary": "too long", "patch": {"metric": _metric_lines(pm_steps.LINE_LIMITS["metric"] + 1)}}
    calls = stub_agent(monkeypatch, [over])
    with pytest.raises(pm_steps.FieldOverBudgetError):
        step_agent.execute(make_task("How we'll verify"))
    assert len(calls) == 2


@pytest.mark.parametrize(
    "label,field,value",
    [
        (TASK_PM_LABELS[0], "desc", "The ledger is backfilled for 2025."),
        ("How we'll verify", "metric", "1. 12,000 rows written\n2. A 20-row spot check matches the source"),
        ("Guardrails", "guardrails", "- Writes only the 2025 ledger rows\n- At most 5 requests a second"),
    ],
)
def test_each_task_pm_step_writes_its_field(monkeypatch, label, field, value):
    calls = stub_agent(monkeypatch, [{"summary": f"did {label}", "patch": {field: value}}])
    result = step_agent.execute(make_task(label))
    assert len(calls) == 1
    assert calls[0]["step"] == label
    assert calls[0]["agent"] == model_agent_for_step(steps.by_kind_label("task", label)["agent"])
    assert result["patch"] == {field: value}
    assert result["summary"] == f"did {label}"


def test_the_composed_role_frames_a_task_and_leaves_the_change_role_byte_identical(monkeypatch):
    """Metric 2: the role each of the six PM steps 0-2 is given."""
    roles = {}
    for kind, labels in (("task", TASK_PM_LABELS), ("change", CHANGE_PM_LABELS)):
        for label in labels:
            calls = stub_agent(monkeypatch, [{"summary": "ok"}])
            task = make_task(label, kind=kind, index=steps.by_kind_label(kind, label)["index"])
            step_agent.execute(task)
            roles[(kind, label)] = calls[0]["append_system"]

    task_phrases = [
        # A Task: an operational run of existing tooling, with no code change.
        "A Task is an operational run of existing tooling",
        "It makes no code change.",
        # The metric: checks on the run's result.
        "write the metric as checks on the run's result",
        "Use counts",
        "spot checks",
        "failures reported",
        # The guardrails: run safety.
        "write guardrails as run safety",
        "what the run may write",
        "rate limits",
        "safe to re-run",
        # The override of pm.md's three change-only rules, and no personas.
        "For a Task, these rules replace three rules above: a metric line needs no automated test, "
        "guardrails are not rules for implementing, and you propose no eng persona.",
        'Leave "personas" out of your patch on every Task step.',
    ]
    for label in TASK_PM_LABELS:
        role = roles[("task", label)]
        assert role.startswith(pm_steps.ROLE_PROMPT)
        assert pm_steps.TASK_ROLE_ADDENDUM in role
        flat = " ".join(role.split())  # the role file wraps its lines
        for phrase in task_phrases:
            assert phrase in flat, f"{label}: missing {phrase!r}"
    addendum_lines = [line for line in pm_steps.TASK_ROLE_ADDENDUM.splitlines() if line.strip()]
    for label in CHANGE_PM_LABELS:
        role = roles[("change", label)]
        assert role == pm_steps.ROLE_PROMPT
        assert not any(line in role for line in addendum_lines), label
        assert "Task" not in role.replace("Test contract", "")


@pytest.mark.parametrize("label", TASK_PM_LABELS)
def test_a_task_pm_step_runs_on_the_dispatched_provider_choice(monkeypatch, label):
    """Metric 3, farm half: the server sends the item choice, else the project
    default, under the step's index; with no key it is today's routing."""
    index = task_index(label)
    calls = stub_agent(monkeypatch, [{"summary": "ok"}])
    step_agent.execute(make_task(label, provider_choices={str(index): "muse:muse-spark-1.3"}))
    assert (calls[0]["provider"], calls[0]["model_choice"]) == ("muse", "muse-spark-1.3")

    calls = stub_agent(monkeypatch, [{"summary": "ok"}])
    # A choice for change step 0 must not reach the Task's step at its own index.
    step_agent.execute(make_task(label, provider_choices={"0": "muse"}))
    assert (calls[0]["provider"], calls[0]["model_choice"]) == (None, None)


def test_farmd_queues_a_tasks_first_step_on_the_pm_lane(running_farm):
    index = task_index(TASK_PM_LABELS[0])
    res = running_farm.post("/steps/run", json=farmd_task(38304, index=index, label=TASK_PM_LABELS[0]))
    assert res.status_code == 200
    assert res.json() == {"ok": True, "queued": "pm"}
    assert json.loads((QUEUE_DIR / "pm" / "38304.json").read_text())["step"]["index"] == index


def test_lane_accounting_counts_each_task_row_in_its_own_lane():
    """Architect concern 2: farmd counts live sessions per lane by step index
    alone. Every Task row lands in the lane its own row names, so a Task's PM
    step holds the PM lane, not a runs slot."""
    task_rows = steps.FARM_VIEWS["task"]
    assert {row["label"] for row in task_rows if row["runsIn"] == "pm"} == set(TASK_PM_LABELS)
    for row in task_rows:
        assert farmd.lane_for_index(farmd.LANE_ROWS, row["index"]) == farmd.lane_for_index(task_rows, row["index"])
    for row in steps.STEPS:
        assert farmd.lane_for_index(farmd.LANE_ROWS, row["index"]) == farmd.lane_for_index(steps.STEPS, row["index"])
    sessions = [f"farm-run-t-413-s{task_index(label)}-a1" for label in TASK_PM_LABELS]
    assert farmd._lane_busy(sessions) == {"pm": 3, "runs": 0}


def test_line_budgets_refuse_a_label_two_kinds_share():
    table = {
        "change": [{"label": "Shared", "runsIn": "pm"}],
        "task": [{"label": "Shared", "runsIn": "pm"}],
    }
    with pytest.raises(RuntimeError, match="more than one kind: \\['Shared'\\]"):
        pm_steps._assert_line_budgets_are_kind_safe({"Shared": "metric"}, table)
    with pytest.raises(RuntimeError, match="not a PM step in any kind: \\['Gone'\\]"):
        pm_steps._assert_line_budgets_are_kind_safe({"Gone": "metric"}, table)
    pm_steps._assert_line_budgets_are_kind_safe({"Shared": "metric"}, {"change": table["change"]})
