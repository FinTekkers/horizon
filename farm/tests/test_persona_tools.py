"""HZ-536: the git-only tool allow-list (farm/tools/allowlist.json) a project
persona names tools from — farm/persona_tools.py, its check in
farm/personas.py's loader, and the tool strings a real dispatch hands
run_agent().

Every tool and persona here is fabricated; the allow-list a step reads is a
temp file, and so is the venv root its commands are checked under.
"""

import json
import re
from pathlib import Path

import pytest

from domain.py import providers as domain_providers
from farm import agent_runner, persona_tools, personas, plan_bundle, step_agent, workspaces
from farm.agent_runner import AgentError
from farm.step_agent import DEVOPS_TOOLS, IMPLEMENT_TOOLS, PLANNER_TOOLS, execute
from farm.tests.test_plan_kind import INVENTORY, hubs, inventory_body, plan_task, stub  # noqa: F401 — hubs is a fixture
from farm.tests.test_step_agent import NO_CHECKS, capture_run_agent, git, make_git_workspace, make_task, two_pass_run_agent

REPO_ROOT = Path(__file__).resolve().parents[2]
CLAUDE_MODEL = next(m["id"] for m in domain_providers.PROVIDERS["claude"]["models"] if m["selectable"])
PERSONA = "acme:quant"
ROLE_MD = "# Quant\n\nPrice it before you build it.\n"
ON = {"id": 1, "name": "Acme", "definitionsEnabled": True}
OFF = {"id": 1, "name": "Acme", "definitionsEnabled": False}


def _entry(**overrides):
    entry = {
        "id": "quant",
        "agent": "eng",
        "label": "Quant",
        "initials": "QT",
        "color": "#2E6CB2",
        "model": CLAUDE_MODEL,
        "provider": "claude",
        "file": "quant.md",
        "tools": ["ruff"],
    }
    entry.update(overrides)
    return entry


def tool(tool_id, root, commands=None):
    return {"id": tool_id, "venv": f"{root}/{tool_id}", "commands": commands or [tool_id]}


@pytest.fixture
def venvs(tmp_path, monkeypatch):
    """A temp venv root holding ruff and mypy, and an allow-list naming both."""
    root = tmp_path / "horizon-tools"
    for tool_id in ("ruff", "mypy"):
        (root / tool_id / "bin").mkdir(parents=True)
        (root / tool_id / "bin" / tool_id).write_text("#!/bin/sh\n")
    monkeypatch.setattr(persona_tools, "VENV_ROOT", str(root))
    path = tmp_path / "allowlist.json"
    path.write_text(json.dumps({"version": 1, "tools": [tool("ruff", root), tool("mypy", root)]}))
    monkeypatch.setattr(persona_tools, "ALLOWLIST_PATH", path)
    return root


@pytest.fixture
def projects(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(personas, "PROJECTS_DIR", root)
    return root


def write_project(root, entries, slug="acme"):
    (root / slug / "personas").mkdir(parents=True)
    (root / slug / "personas.json").write_text(json.dumps({"personas": entries}))
    for entry in entries:
        (root / slug / "personas" / entry["file"]).write_text(ROLE_MD)


def expected(base, root, tool_id="ruff"):
    venv = f"{root}/{tool_id}"
    allowed = f"{base},Bash({venv}/bin/{tool_id}:*),Read(/{venv}/**)"
    return allowed, f"Edit(/{venv}/**),Write(/{venv}/**),NotebookEdit(/{venv}/**)"


def implement(monkeypatch, tmp_path, project, captured):
    tmp_path.mkdir(parents=True, exist_ok=True)
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    task = make_task(11, "Specialist agent implements", repo="acme/demo", checks_waiver=NO_CHECKS)
    task["item"]["personas"] = {"eng": PERSONA}
    if project is not None:
        task["project"] = project
    # The stub edits no files, so the push balks after the call was captured.
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    return captured


# ---- metric 1: an unknown tool id fails the load, naming the id and the persona ----


def test_validate_ids_names_the_unknown_id_and_the_persona():
    with pytest.raises(persona_tools.UnknownToolError) as exc:
        persona_tools.validate_ids(PERSONA, ["ruff", "nope"], {"ruff": {}})
    assert "'nope'" in str(exc.value)
    assert f"'{PERSONA}'" in str(exc.value)


def test_loading_a_persona_naming_an_unknown_tool_fails_before_any_step_runs(projects, venvs, monkeypatch):
    write_project(projects, [_entry(tools=["nope"])])
    with pytest.raises(RuntimeError) as exc:
        personas.load_project_personas("acme")
    assert "'nope'" in str(exc.value)
    assert f"'{PERSONA}'" in str(exc.value)
    assert "farm/projects/acme/personas.json" in str(exc.value)
    # At dispatch the project falls back to the global personas, so the tool
    # is never granted.
    assert personas.project_overlay(ON) is None


# ---- metric 2: exactly the tool's commands, its venv read-only, no new write ----


def test_an_implement_step_gets_the_base_string_plus_exactly_the_tools_commands(projects, venvs, monkeypatch, tmp_path):
    write_project(projects, [_entry()])
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    implement(monkeypatch, tmp_path, ON, captured)

    allowed, denied = expected(IMPLEMENT_TOOLS, venvs)
    assert captured["allowed_tools"] == allowed
    assert captured["disallowed_tools"] == denied
    assert len(captured["disallowed_tools"].split(",")) == 3
    # No write rule is added: the writable set is today's.
    added = captured["allowed_tools"][len(IMPLEMENT_TOOLS) :]
    assert not re.search(r"\b(Edit|Write|NotebookEdit)\(", added)
    assert "mypy" not in captured["allowed_tools"]  # allow-listed, but not named


def test_merge_pins_the_rule_syntax():
    entries = [{"id": "ruff", "venv": "/opt/horizon-tools/ruff", "commands": ["ruff"]}]
    assert persona_tools.merge(IMPLEMENT_TOOLS, entries) == (
        f"{IMPLEMENT_TOOLS},Bash(/opt/horizon-tools/ruff/bin/ruff:*),Read(//opt/horizon-tools/ruff/**)",
        "Edit(//opt/horizon-tools/ruff/**),Write(//opt/horizon-tools/ruff/**),NotebookEdit(//opt/horizon-tools/ruff/**)",
    )


@pytest.mark.parametrize("base", [PLANNER_TOOLS, IMPLEMENT_TOOLS, DEVOPS_TOOLS], ids=["planner", "implement", "devops"])
def test_only_a_step_with_bare_bash_gets_persona_tools(projects, venvs, base):
    write_project(projects, [_entry()])
    overlay = personas.project_overlay(ON)
    got = persona_tools.apply(base, PERSONA, overlay)
    if base == PLANNER_TOOLS:
        # A read-only step has no shell: `ruff --fix` would let it write.
        assert got == (PLANNER_TOOLS, None)
        assert got[0] is PLANNER_TOOLS
    else:
        assert got == expected(base, venvs)


def test_a_persona_with_tools_on_a_provider_without_deny_rules_fails_the_step(projects, venvs, monkeypatch, tmp_path):
    write_project(projects, [_entry()])
    called = []
    monkeypatch.setattr(agent_runner._PROVIDERS["muse"], "run", lambda *a, **k: called.append(1))
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    task = make_task(11, "Specialist agent implements", repo="acme/demo", checks_waiver=NO_CHECKS)
    task["item"]["personas"] = {"eng": PERSONA}
    task["item"]["providerChoices"] = {"11": "muse"}
    task["project"] = ON
    with pytest.raises(AgentError, match="cannot enforce deny rules"):
        execute(task)
    assert called == []


def test_a_missing_venv_command_fails_the_step_naming_the_path(projects, venvs, monkeypatch):
    write_project(projects, [_entry()])
    (venvs / "ruff" / "bin" / "ruff").unlink()
    with pytest.raises(RuntimeError, match=re.escape(f"{venvs}/ruff/bin/ruff is not installed")):
        persona_tools.apply(IMPLEMENT_TOOLS, PERSONA, personas.project_overlay(ON))


# ---- metric 3 / guardrail 4: no persona or switch off is byte-identical ----


@pytest.mark.parametrize("base", [PLANNER_TOOLS, IMPLEMENT_TOOLS, DEVOPS_TOOLS], ids=["planner", "implement", "devops"])
@pytest.mark.parametrize(
    "project", [None, OFF, {"id": 1, "name": "Acme"}, {"id": 1, "name": "Other", "definitionsEnabled": True}], ids=["no-project", "switch-off", "no-flag", "no-file"]
)
def test_no_persona_or_the_switch_off_keeps_each_constant_byte_identical(projects, venvs, base, project):
    write_project(projects, [_entry()])
    allowed, denied = persona_tools.apply(base, PERSONA, personas.project_overlay(project))
    assert allowed is base
    assert denied is None


@pytest.mark.parametrize("project", [None, OFF], ids=["no-project", "switch-off"])
def test_a_dispatch_with_no_project_or_the_switch_off_runs_todays_implement_step(projects, venvs, monkeypatch, tmp_path, project):
    write_project(projects, [_entry()])
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    implement(monkeypatch, tmp_path, project, captured)
    assert captured["allowed_tools"] == IMPLEMENT_TOOLS
    assert captured["disallowed_tools"] is None


def test_the_switch_off_never_reads_a_broken_allowlist(projects, venvs, monkeypatch, tmp_path):
    write_project(projects, [_entry()])
    persona_tools.ALLOWLIST_PATH.write_text("{ not json")
    monkeypatch.setattr(persona_tools, "load_allowlist", lambda *a, **k: pytest.fail("allow-list read with the switch off"))
    captured = {}
    monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
    implement(monkeypatch, tmp_path, OFF, captured)
    assert captured["allowed_tools"] == IMPLEMENT_TOOLS
    assert captured["disallowed_tools"] is None


@pytest.mark.parametrize("project", [None, OFF], ids=["no-project", "switch-off"])
def test_prompt_persona_line_and_step_index_match_a_run_without_persona_tools(projects, venvs, monkeypatch, tmp_path, project):
    write_project(projects, [_entry()])
    runs = []
    for patched in (False, True):
        if patched:
            monkeypatch.setattr(step_agent, "apply_persona_tools", lambda tools, persona, overlay: (tools, None))
        captured = {}
        monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(captured))
        implement(monkeypatch, tmp_path / str(patched), project, captured)
        task = make_task(11, "Specialist agent implements", repo="acme/demo", checks_waiver=NO_CHECKS)
        task["item"]["personas"] = {"eng": PERSONA}
        if project is not None:
            task["project"] = project
        runs.append((captured, step_agent.build_prompt(task), step_agent._persona_line(task), task["step"]["index"]))
    (unpatched, prompt, line, index), (control, prompt2, line2, index2) = runs
    # The worktree path differs per run; everything else is the same bytes.
    unpatched.pop("cwd"), control.pop("cwd")
    assert unpatched == control
    assert (prompt, line, index) == (prompt2, line2, index2)


# ---- metric 4: the lint ----


def test_the_committed_allowlist_passes_the_lint():
    doc = json.loads((REPO_ROOT / "farm" / "tools" / "allowlist.json").read_text())
    assert persona_tools.lint(doc) == []
    assert persona_tools.ALLOWLIST_PATH == REPO_ROOT / "farm" / "tools" / "allowlist.json"


def _doc(**entry_overrides):
    entry = {"id": "ruff", "venv": "/opt/horizon-tools/ruff", "commands": ["ruff"]}
    entry.update(entry_overrides)
    return {"version": 1, "tools": [entry]}


def test_the_lint_fails_an_entry_carrying_env():
    errors = persona_tools.lint(_doc(env={"PATH": "/usr/bin"}))
    assert any("env field" in e for e in errors)


def test_the_lint_fails_a_github_token_value():
    errors = persona_tools.lint(_doc(commands=["ghp_xxx"]))
    assert any("secret-like" in e and "GitHub token" in e for e in errors)


# Built by concatenation so this file carries no literal credential.
SECRETS = [
    "ghp" + "_abc123",
    "github" + "_pat_abc",
    "AKIA" + "ABCDEFGH",
    "sk" + "-abc123",
    "-----BEGIN" + " RSA PRIVATE KEY-----",
    "token" + "=abc",
]


@pytest.mark.parametrize("secret", SECRETS)
@pytest.mark.parametrize("where", ["key", "value"])
def test_the_lint_fails_every_secret_pattern_as_a_key_and_as_a_value(secret, where):
    doc = _doc(**{secret: "x"}) if where == "key" else _doc(venv=secret)
    errors = persona_tools.lint(doc)
    assert any("secret-like" in e for e in errors), errors


def test_load_allowlist_raises_naming_every_lint_error(tmp_path):
    path = tmp_path / "allowlist.json"
    path.write_text(json.dumps(_doc(env={}, commands=["*"])))
    with pytest.raises(persona_tools.AllowlistError, match=r"allowlist\.json failed the allow-list lint: .*env field.*'\*'"):
        persona_tools.load_allowlist(path)


# ---- guardrail 2: a tool cannot widen the sandbox ----


@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"commands": ["*"]}, "command '*'"),
        ({"commands": ["bin/ruff"]}, "command 'bin/ruff'"),
        ({"commands": ["ruff --fix"]}, "command 'ruff --fix'"),
        ({"venv": "/opt/horizon-tools/other"}, "must be exactly /opt/horizon-tools/ruff"),
        ({"venv": "/home/ubuntu"}, "must be exactly /opt/horizon-tools/ruff"),
    ],
)
def test_the_lint_refuses_a_wildcard_a_path_and_a_foreign_venv(overrides, fragment):
    errors = persona_tools.lint(_doc(**overrides))
    assert any(fragment in e for e in errors), errors


def test_review_passes_get_no_persona_tools(projects, venvs, monkeypatch, tmp_path):
    write_project(projects, [_entry()])
    ws, _origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []
    verdict = {"summary": "ok", "verdict": "pass", "findings": [], "artifact_md": "ok"}
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(verdict, verdict, calls))
    task = make_task(12, "Automated review (code + QA)", repo="acme/demo")
    task["item"]["personas"] = {"eng": PERSONA, "qa": PERSONA}
    task["project"] = ON
    execute(task)
    assert len(calls) == 2
    for call in calls:
        assert call["allowed_tools"] == PLANNER_TOOLS
        assert call["disallowed_tools"] is None


def test_a_bundle_step_keeps_exactly_the_bundle_tool_rules(hubs, projects, venvs, monkeypatch):  # noqa: F811
    write_project(projects, [_entry()])
    calls = stub(monkeypatch, inventory_body)
    task = plan_task(INVENTORY)
    task["item"]["personas"] = {"eng": PERSONA}
    task["project"] = ON
    step_agent.execute(task)
    root = plan_bundle.BUNDLE_ROOT / "p-447"
    assert calls[0]["allowed_tools"] == f"Read(/{root}/**)"
    assert calls[0]["disallowed_tools"] == f"Read(/{workspaces.WORKSPACES_DIR}/**),{plan_bundle.DENIED_TOOLS}"
    assert "horizon-tools" not in calls[0]["allowed_tools"] + calls[0]["disallowed_tools"]


# ---- guardrail 1: nothing but persona_tools.py reads the allow-list ----


def test_only_persona_tools_references_the_allowlist_and_only_reads_it():
    hits = []
    for top in ("server/src", "ui/src", "farm"):
        for path in (REPO_ROOT / top).rglob("*"):
            rel = path.relative_to(REPO_ROOT).as_posix()
            if not path.is_file() or rel.startswith(("farm/tests/", "docs/")) or "node_modules" in rel:
                continue
            if path.suffix not in (".py", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".json", ".sh"):
                continue
            text = path.read_text(errors="replace")
            if "allowlist.json" in text:
                hits.append(rel)
    assert hits == ["farm/persona_tools.py"]
    source = (REPO_ROOT / "farm" / "persona_tools.py").read_text()
    assert not re.search(r"write_text|write_bytes|open\(", source)
