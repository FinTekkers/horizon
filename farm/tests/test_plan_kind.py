"""HZ-446: a Plan's steps on the farm. Its farm-lane steps run read-only
with the planner's read-only tools, workspace or not, so a Plan never edits
code in any repo. Its PM steps run on the PM step kind. "File items" is
Horizon's own server step: it never reaches a farm view.

HZ-447: Inventory and Design read every in-scope repo from a read-only
bundle (farm/plan_bundle.py). Their tests run against local hubs cloned from
bare origins under tmp_path; the other three rows still run the placeholder.

Every agent run is stubbed: run_agent is monkeypatched at step_agent's import.
"""

import json
import os
import subprocess

import pytest

from domain.py import plan_inventory, steps
from farm import agent_runner, plan_bundle, pm_steps, step_agent, workspaces
from farm.agent_runner import AgentError
from farm.providers import claude as claude_provider
from farm.read_only_guard import ReadOnlyViolation, SnapshotFailed

PLAN_FARM_LABELS = [
    "Inventory current state",
    "Design options & recommendation",
    "Draft items",
    "Review drafts: coverage & overlap",
    "Review drafts: metrics & size",
]
PLACEHOLDER_LABELS = PLAN_FARM_LABELS[2:]
INVENTORY, DESIGN = PLAN_FARM_LABELS[:2]
PLAN_PM_LABELS = ["Define the question", "Set guardrails"]
WRITE_TOOLS = ("Edit", "Write", "Bash")


def make_task(label: str) -> dict:
    return {
        "run_id": 446,
        "attempt": 1,
        "item": {"id": "P-446", "title": "Retire the FIX gateway", "priority": "High", "repo": None, "kind": "plan"},
        "step": {"index": steps.by_kind_label("plan", label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


def test_the_plan_farm_view_holds_its_agent_steps_and_never_file_items():
    view = steps.FARM_VIEWS["plan"]
    assert [entry["label"] for entry in view] == PLAN_PM_LABELS + PLAN_FARM_LABELS
    assert "File items" not in {entry["label"] for entry in view}
    assert all(entry["runsIn"] in ("pm", "farm") for entry in view)
    with pytest.raises(KeyError):
        steps.by_kind_label("plan", "File items")


def test_each_plan_farm_step_runs_the_read_only_placeholder_with_the_planner_tools():
    for label in PLACEHOLDER_LABELS:
        role, wants_artifact, tools, persona = step_agent._step_config("plan", label)
        assert (role, wants_artifact, tools, persona) == ("plan_placeholder.md", True, "Read,Glob,Grep", None)
        assert not any(tool in tools.split(",") for tool in WRITE_TOOLS)
        assert step_agent._is_read_only("plan", label)
        assert steps.by_kind_label("plan", label)["workspaceMutating"] is False
    assert (step_agent.ROLES / "plan_placeholder.md").read_text().strip()


def test_each_plan_pm_step_runs_on_the_pm_step_kind():
    for label in PLAN_PM_LABELS:
        assert step_agent._step_config("plan", label) == ("pm.md", True, None, None)
        assert step_agent._is_pm_step(label, "plan")
        assert not step_agent._is_read_only("plan", label)


def test_inventory_and_design_run_their_own_roles_and_read_the_bundle():
    assert step_agent._step_config("plan", INVENTORY) == ("plan_inventory.md", True, "Read,Glob,Grep", None)
    assert step_agent._step_config("plan", DESIGN) == ("plan_design.md", True, "Read,Glob,Grep", None)
    for label in (INVENTORY, DESIGN):
        assert step_agent._reads_bundle("plan", label) and step_agent._is_read_only("plan", label)
    assert not any(step_agent._reads_bundle("plan", label) for label in PLACEHOLDER_LABELS)


@pytest.mark.parametrize("label", PLACEHOLDER_LABELS)
def test_a_plan_step_with_no_workspace_is_still_held_to_the_read_only_tools(monkeypatch, label):
    calls = []

    def fake(prompt, **kwargs):
        calls.append(kwargs)
        body = {"summary": "placeholder", "artifact_md": "## Not built yet"}
        return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    step_agent.execute(make_task(label))
    assert len(calls) == 1
    assert calls[0]["allowed_tools"] == "Read,Glob,Grep"
    assert calls[0]["provider_locked"] is True


def test_change_and_task_read_only_sets_are_unchanged():
    assert step_agent.READ_ONLY_LABELS_BY_KIND["change"] is step_agent.READ_ONLY_LABELS
    assert step_agent.READ_ONLY_LABELS_BY_KIND["task"] is step_agent.TASK_READ_ONLY_LABELS
    assert not step_agent._is_read_only("change", step_agent.IMPLEMENT_LABEL)


def test_set_guardrails_may_be_shared_by_change_and_plan_only():
    table = {
        "change": [{"label": "Set guardrails", "runsIn": "pm"}],
        "task": [{"label": "Set guardrails", "runsIn": "pm"}],
        "plan": [{"label": "Set guardrails", "runsIn": "pm"}],
    }
    shared = pm_steps.SHARED_LINE_BUDGETS
    pm_steps._assert_line_budgets_are_kind_safe(
        {"Set guardrails": "guardrails"}, {"change": table["change"], "plan": table["plan"]}, shared
    )
    with pytest.raises(RuntimeError, match="more than one kind"):
        pm_steps._assert_line_budgets_are_kind_safe({"Set guardrails": "guardrails"}, table, shared)
    with pytest.raises(RuntimeError, match="more than one kind"):
        pm_steps._assert_line_budgets_are_kind_safe(
            {"Set guardrails": "guardrails"}, {"change": table["change"], "plan": table["plan"]}
        )


# ---- HZ-447: Inventory and Design over a read-only bundle ----

IN_SCOPE = ["acme/api", "acme/web", "acme/data"]
OUTSIDE = "acme/secret"
CHECK_SHA = "0123456789abcdef0123456789abcdef01234567"


def _git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def hubs(tmp_path, monkeypatch):
    """A hub per repo, each cloned from a bare origin holding one commit with
    `src/<name>.py` and an `e2e-baseline` branch."""
    for key, value in (("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")):
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(plan_bundle, "BUNDLE_ROOT", tmp_path / "bundles")
    for repo in [*IN_SCOPE, OUTSIDE]:
        name = repo.split("/")[1]
        origin, seed = tmp_path / "origins" / f"{name}.git", tmp_path / "seed" / name
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(seed)], check=True)
        (seed / "src").mkdir()
        (seed / "src" / f"{name}.py").write_text(f"# {name} service\nSTORE = '{name}.db'\n")
        _git(seed, "add", "-A")
        _git(seed, "commit", "-qm", "seed")
        _git(seed, "push", "-q", str(origin), "main", "main:e2e-baseline")
        subprocess.run(["git", "clone", "-q", str(origin), str(workspaces.hub_path(repo))], check=True)
    return tmp_path


def hub_fingerprint(repo):
    hub = workspaces.hub_path(repo)
    return (
        _git(hub, "rev-parse", "HEAD"),
        _git(hub, "for-each-ref", "refs/heads", "refs/tags"),
        _git(hub, "status", "--porcelain"),
        _git(hub, "ls-remote", "origin"),
    )


def plan_task(label, *, artifacts=(), scope=IN_SCOPE, repo="acme/api", last_checks=None):
    last_checks = last_checks or {}
    return {
        "run_id": 447,
        "attempt": 1,
        "item": {"id": "P-447", "title": "Retire the FIX gateway", "priority": "High", "repo": repo, "kind": "plan"},
        "step": {"index": steps.by_kind_label("plan", label)["index"], "label": label},
        "artifacts": list(artifacts),
        "feedback": [],
        "plan_scope": {
            "repos": [
                {"repo": r, "default_branch": "main", "last_check": last_checks.get(r, {"status": "none"})} for r in scope
            ],
            "out_of_scope": [OUTSIDE],
        },
    }


def inventory_from(cwd, repos=IN_SCOPE):
    """What an Inventory agent would cite: a line it read from each repo's
    folder in the bundle, so the reply proves every repo was readable."""
    rows = []
    for repo in repos:
        folder, name = repo.replace("/", "__"), repo.split("/")[1]
        line = (cwd / folder / "src" / f"{name}.py").read_text().splitlines()[1]
        rows.append({"repo": repo, "has": [line], "gaps": [], "evidence": [{"kind": "file", "ref": f"src/{name}.py:2", "note": line}]})
    return {"repos": rows, "key_facts": [{"topic": "storage", "fact": "Baselines live on e2e-baseline", "evidence": [{"kind": "branch", "ref": "origin/e2e-baseline", "note": "in _refs"}]}]}


def reply(body):
    return {"result": json.dumps(body), "session_id": "s", "provider": "claude", "command_id": None}


def stub(monkeypatch, *bodies, action=None):
    """run_agent replaced: each call runs `action(kwargs)` (if any), then
    answers with the next body — a callable gets the bundle path."""
    calls = []

    def fake(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        if action:
            action(kwargs)
        body = bodies[min(len(calls), len(bodies)) - 1]
        return reply(body(plan_bundle.Path(kwargs["cwd"])) if callable(body) else body)

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return calls


def inventory_body(cwd):
    return {"summary": "took stock of 3 repos", "artifact_md": "## Current state\nAll three.", "inventory": inventory_from(cwd)}


def run_inventory(monkeypatch, **task_kwargs):
    stub(monkeypatch, inventory_body)
    return step_agent.execute(plan_task(INVENTORY, **task_kwargs))


def test_inventory_three_repos_read_only(hubs, monkeypatch):
    before = {repo: hub_fingerprint(repo) for repo in IN_SCOPE}
    calls = stub(monkeypatch, inventory_body)
    result = step_agent.execute(plan_task(INVENTORY))
    block = plan_inventory.extract(result["artifacts"]["artifact_md"], IN_SCOPE)
    assert [row["repo"] for row in block["repos"]] == IN_SCOPE
    assert [row["has"] for row in block["repos"]] == [["STORE = 'api.db'"], ["STORE = 'web.db'"], ["STORE = 'data.db'"]]
    assert {repo: hub_fingerprint(repo) for repo in IN_SCOPE} == before
    assert len(calls) == 1 and not plan_bundle.Path(calls[0]["cwd"]).exists(), "the bundle is removed afterwards"


@pytest.mark.parametrize("mutation", ["write", "commit", "push"])
def test_seeded_mutation_fails_step(hubs, monkeypatch, mutation):
    def act(kwargs):
        if mutation == "write":
            folder = plan_bundle.Path(kwargs["cwd"]) / "acme__api"
            os.chmod(folder, 0o755)
            (folder / "notes.txt").write_text("written by the agent")
        elif mutation == "commit":
            _git(workspaces.hub_path("acme/web"), "commit", "-q", "--allow-empty", "-m", "sneaky")
        else:
            _git(workspaces.hub_path("acme/data"), "push", "-q", "origin", "HEAD:refs/heads/sneaky")

    stub(monkeypatch, inventory_body, action=act)
    with pytest.raises(ReadOnlyViolation) as raised:
        step_agent.execute(plan_task(INVENTORY))
    expected = {"write": "bundle: acme__api", "commit": "acme/web: HEAD moved", "push": "acme/data: origin refs/heads/sneaky"}
    assert expected[mutation] in str(raised.value)


def test_a_reply_with_rows_for_two_of_three_repos_fails_after_one_retry(hubs, monkeypatch):
    def two_rows(cwd):
        return {"summary": "s", "artifact_md": "a", "inventory": inventory_from(cwd, IN_SCOPE[:2])}

    calls = stub(monkeypatch, two_rows)
    with pytest.raises(AgentError, match=r"no row for \['acme/data'\]"):
        step_agent.execute(plan_task(INVENTORY))
    assert len(calls) == 2


def test_refs_carry_last_check(hubs, monkeypatch):
    seen = {}

    def read_refs(kwargs):
        refs = plan_bundle.Path(kwargs["cwd"]) / "_refs"
        seen.update({name: (refs / name).read_text() for name in ("acme__api", "acme__web")})

    stub(monkeypatch, inventory_body, action=read_refs)
    check = {"status": "pass", "sha": CHECK_SHA, "finished_at": "2026-10-13T18:02:11Z", "source": "implement"}
    step_agent.execute(plan_task(INVENTORY, last_checks={"acme/api": check}))
    assert f"last_check: pass {CHECK_SHA} finished 2026-10-13T18:02:11Z (source: implement)" in seen["acme__api"]
    assert "last_check: none" in seen["acme__web"] and "pruned" in seen["acme__web"]
    assert "origin/e2e-baseline" in seen["acme__api"]
    block = {
        "repos": [{"repo": "acme/api", "has": [], "gaps": [], "evidence": [{"kind": "check", "ref": f"last_check: pass {CHECK_SHA}", "note": "_refs"}]}],
        "key_facts": [],
    }
    assert plan_inventory.validate(block, ["acme/api"]) is block


def design_body(changes):
    return {"summary": "two options; B recommended", "artifact_md": "## Options\nA, B", "design": {"recommendation": "B", "changes": changes}}


def test_design_citations(hubs, monkeypatch):
    inventory = run_inventory(monkeypatch)
    prior = [{"label": INVENTORY, "content": inventory["artifacts"]["artifact_md"]}]
    cited = design_body([{"repo": "acme/api", "summary": "drop it", "cites": ["src/api.py:2"]}])
    stub(monkeypatch, cited)
    assert step_agent.execute(plan_task(DESIGN, artifacts=prior))["summary"].startswith("two options")

    uncited = design_body([{"repo": "acme/api", "cites": ["src/api.py:2"]}, {"repo": "acme/web", "cites": ["nowhere.py:1"]}])
    calls = stub(monkeypatch, uncited)
    with pytest.raises(AgentError, match=r"changes \['acme/web'\] but cites no Inventory evidence"):
        step_agent.execute(plan_task(DESIGN, artifacts=prior))
    assert len(calls) == 2


def test_out_of_scope_repo_never_bundled_or_logged(hubs, monkeypatch, capsys):
    hub = workspaces.hub_path(OUTSIDE)

    def act(kwargs):
        assert not (plan_bundle.Path(kwargs["cwd"]) / "acme__secret").exists()
        assert sorted(p.name for p in plan_bundle.Path(kwargs["cwd"]).iterdir()) == ["_refs", "acme__api", "acme__data", "acme__web"]
        # What the agent's streamed events would print to the run log.
        print(f"⏺ Read({hub}/src/secret.py) for {OUTSIDE}", flush=True)

    def naming(cwd):
        body = inventory_body(cwd)
        body["artifact_md"] += f"\nAlso see {OUTSIDE}."
        return body

    stub(monkeypatch, naming, action=act)
    with pytest.raises(ReadOnlyViolation, match="a repo outside the Plan's scope") as raised:
        step_agent.execute(plan_task(INVENTORY))
    log = capsys.readouterr().out
    for text in (log, str(raised.value)):
        assert OUTSIDE not in text and "acme__secret" not in text
    assert plan_bundle.OUT_OF_SCOPE_MASK in log


def test_no_workspace_no_run_setup(hubs, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("no worktree, checkout or venv is set up for a bundle step")

    for name in ("ensure_item_worktree", "checkout_detached"):
        monkeypatch.setattr(step_agent, name, refuse)
    monkeypatch.setattr(step_agent.run_plan, "resolve_venv", refuse)
    monkeypatch.setattr(step_agent.run_plan, "resolve_cwd", refuse)
    stub(monkeypatch, inventory_body)
    inventory = step_agent.execute(plan_task(INVENTORY, repo=None))
    prior = [{"label": INVENTORY, "content": inventory["artifacts"]["artifact_md"]}]
    stub(monkeypatch, design_body([{"repo": "acme/data", "cites": ["src/data.py:2"]}]))
    design = step_agent.execute(plan_task(DESIGN, artifacts=prior, repo=None))
    assert design["artifacts"]["artifact_md"].startswith("## Options")


def test_bundle_steps_get_the_bundle_tool_rules_not_the_planner_tools(hubs, monkeypatch):
    calls = stub(monkeypatch, inventory_body)
    step_agent.execute(plan_task(INVENTORY))
    root = plan_bundle.BUNDLE_ROOT / "p-447"
    assert calls[0]["cwd"] == str(root)
    assert calls[0]["allowed_tools"] == f"Read(/{root}/**)" != step_agent.PLANNER_TOOLS
    assert calls[0]["disallowed_tools"] == f"Read(/{workspaces.WORKSPACES_DIR}/**),{plan_bundle.DENIED_TOOLS}"
    for tool in ("Edit", "Write", "Bash", "Read(~/**)"):
        assert tool in calls[0]["disallowed_tools"].split(",")


def test_a_provider_that_cannot_enforce_deny_rules_is_refused(monkeypatch):
    called = []
    monkeypatch.setattr(agent_runner._PROVIDERS["muse"], "run", lambda *a, **k: called.append(1))
    with pytest.raises(AgentError, match="cannot enforce deny rules"):
        agent_runner.run_agent("p", agent="architect", provider="muse", disallowed_tools="Bash")
    assert called == []


def test_claude_passes_the_deny_rules_and_sets_no_bypass_mode(monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"result": "{}", "session_id": "s"}), "")

    monkeypatch.setattr(claude_provider.subprocess, "run", fake_run)
    claude_provider._run_subprocess("p", allowed_tools="Read(//b/**)", disallowed_tools="Bash,Edit")
    cmd = seen["cmd"]
    assert cmd[cmd.index("--disallowedTools") + 1] == "Bash,Edit"
    assert not any("permission-mode" in arg or "skip-permissions" in arg for arg in cmd)


def test_claude_sdk_path_passes_the_deny_rules(monkeypatch):
    sdk = pytest.importorskip("claude_agent_sdk")
    seen = {}

    def fake_query(*, prompt, options=None, **kwargs):
        seen["options"] = options

        async def gen():
            yield sdk.ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="s", result="{}")

        return gen()

    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setattr(sdk, "query", fake_query)
    claude_provider.run("p", allowed_tools="Read(//b/**)", disallowed_tools="Bash,Edit")
    assert seen["options"].disallowed_tools == ["Bash", "Edit"]
    assert seen["options"].permission_mode is None


def test_a_plan_task_with_no_scope_fails_before_any_call(hubs, monkeypatch):
    calls = stub(monkeypatch, inventory_body)
    task = plan_task(INVENTORY)
    del task["plan_scope"]
    with pytest.raises(AgentError, match="plan_scope"):
        step_agent.execute(task)
    assert calls == []


def test_a_snapshot_failure_fails_the_step_before_any_call(hubs, monkeypatch):
    _git(workspaces.hub_path("acme/web"), "remote", "set-url", "origin", str(hubs / "no-such-origin.git"))
    calls = stub(monkeypatch, inventory_body)
    with pytest.raises(SnapshotFailed):
        step_agent.execute(plan_task(INVENTORY))
    assert calls == []
    assert not any((hubs / "bundles").iterdir()), "the bundle is removed when the step never runs"


def test_quoted_secret_scrubbed(hubs, monkeypatch, capsys):
    token = "ghp_" + "a" * 36
    monkeypatch.setenv("ACME_DB_PASSWORD", "hunter2-correct-horse")

    def quoting(cwd):
        body = inventory_body(cwd)
        body["artifact_md"] += "\nThe DSN quotes hunter2-correct-horse."
        return body

    stub(monkeypatch, quoting, action=lambda kwargs: print(f"read .env: GITHUB_TOKEN={token}", flush=True))
    result = step_agent.execute(plan_task(INVENTORY))
    assert "hunter2-correct-horse" not in result["artifacts"]["artifact_md"]
    assert "The DSN quotes [redacted]." in result["artifacts"]["artifact_md"]
    log = capsys.readouterr().out
    assert token not in log and "GITHUB_TOKEN=[redacted]" in log

    # A reply quoting the token itself is never stored: it is rejected.
    def leaking(cwd):
        return {**inventory_body(cwd), "artifact_md": f"GITHUB_TOKEN={token}"}

    stub(monkeypatch, leaking)
    with pytest.raises(AgentError, match="literal secret") as raised:
        step_agent.execute(plan_task(INVENTORY))
    assert token not in str(raised.value)

    def fail(kwargs):
        raise AgentError(f"claude exited 1: GITHUB_TOKEN={token}")

    stub(monkeypatch, inventory_body, action=fail)
    with pytest.raises(AgentError) as raised:
        step_agent.execute(plan_task(INVENTORY))
    assert token not in str(raised.value) and "GITHUB_TOKEN=[redacted]" in str(raised.value)
