"""HZ-930: a repo marked for web guidance runs its Eng implement step with the
pinned, host-installed Modern Web Guidance plugin (--plugin-dir). Every other
run — an unmarked repo, any other step — launches exactly as before.

The plugin folder here is a temp stand-in for WEB_GUIDANCE_DIR; `claude` is
farm/tests/fake_claude on the subprocess path.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from domain.py import providers as domain_providers
from farm import agent_runner, config, credentials, step_agent
from farm.agent_runner import AgentError
from farm.providers import claude
from farm.providers.base import AgentModelUnavailableError
from farm.step_agent import IMPLEMENT_LABEL, QA_PLAN_LABEL, REVIEW_LABEL, execute
from farm.tests.test_step_agent import NO_CHECKS, capture_run_agent, make_git_workspace

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_MD = REPO_ROOT / "infra" / "host" / "DEPLOY.md"
FETCHERS = re.compile(r"\b(npx|pnpx|npm)\b|plugin install")


def install_plugin(root: Path) -> Path:
    """A pinned copy shaped like the npm package: manifest, skill and CLI."""
    (root / ".claude-plugin").mkdir(parents=True)
    (root / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "modern-web-guidance", "version": "1.0.1"}))
    skill = root / "skills" / "modern-web-guidance"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: modern-web-guidance\n---\n")
    (skill / "modern-web.mjs").write_text("#!/usr/bin/env node\n")
    return root


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    root = install_plugin(tmp_path / "plugins" / "modern-web-guidance" / "1.0.1")
    current = root.parent / "current"
    current.symlink_to(root.name)
    monkeypatch.setattr(step_agent, "WEB_GUIDANCE_DIR", current)
    return current


def steps_run_body(**extra) -> dict:
    """A task as farmd hands it to step_agent: parsed from the JSON body the
    server sends, with the server's own key (repo-web-guidance.test.mjs)."""
    body = {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "WG-1", "title": "Restyle the form", "desc": "d", "metric": "m", "guardrails": "", "priority": "Medium", "repo": "acme/site", "issue": 7},
        "step": {"index": 11, "label": IMPLEMENT_LABEL, "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
        "checks_waiver": NO_CHECKS,
    }
    body.update(extra)
    return json.loads(json.dumps(body))


class Spawns:
    """Every process started through subprocess.Popen (subprocess.run too),
    passed through to the real one."""

    def __init__(self, monkeypatch):
        self.argvs: list[list[str]] = []
        self.claude: list[tuple[list[str], dict | None]] = []
        real = subprocess.Popen
        spawns = self

        class Recording(real):
            def __init__(self, args, *a, **kw):
                argv = [str(x) for x in (args if isinstance(args, (list, tuple)) else [args])]
                spawns.argvs.append(argv)
                if argv and argv[0] == claude.CLAUDE_BIN:
                    spawns.claude.append((argv, kw.get("env")))
                super().__init__(args, *a, **kw)

        monkeypatch.setattr(subprocess, "Popen", Recording)


def implement(monkeypatch, tmp_path, task) -> Spawns:
    """Runs a real implement step to the fake claude and on to the push to a
    local origin. The launch is what's under test, so the outcome isn't."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    spawns = Spawns(monkeypatch)
    execute(task)
    return spawns


def plugin_args(argv: list[str]) -> list[str]:
    return [argv[i + 1] for i, arg in enumerate(argv) if arg == "--plugin-dir"]


# ---- metric 1: a marked implement run loads the pinned plugin ----


def test_a_marked_steps_run_body_reaches_claude_with_exactly_one_plugin_dir(plugin, monkeypatch, tmp_path):
    spawns = implement(monkeypatch, tmp_path, steps_run_body(web_guidance=True))
    assert len(spawns.claude) == 1
    argv, _env = spawns.claude[0]
    assert plugin_args(argv) == [str(plugin)]
    assert argv.count("--plugin-dir") == 1
    # The skill's npx route is denied, and the role points at the pinned CLI.
    denied = argv[argv.index("--disallowedTools") + 1]
    for rule in ("Bash(npx modern-web-guidance:*)", "Bash(npx -y modern-web-guidance@latest:*)", "Bash(pnpx modern-web-guidance:*)"):
        assert rule in denied.split(",")
    role = argv[argv.index("--append-system-prompt") + 1]
    assert f"node {plugin}/skills/modern-web-guidance/modern-web.mjs search" in role


def test_a_marked_run_starts_no_npx_npm_or_plugin_install(plugin, monkeypatch, tmp_path):
    spawns = implement(monkeypatch, tmp_path, steps_run_body(web_guidance=True))
    assert [argv for argv in spawns.argvs if argv[0] == claude.CLAUDE_BIN] == [spawns.claude[0][0]]
    fetches = [argv for argv in spawns.argvs if FETCHERS.search(" ".join(argv[:4]))]
    assert fetches == []
    # Nothing but the agent and git ran.
    assert {Path(argv[0]).name for argv in spawns.argvs} <= {"git", Path(claude.CLAUDE_BIN).name}


def test_the_sdk_options_carry_plugins_only_when_plugin_dirs_are_set(monkeypatch):
    import claude_agent_sdk as sdk

    monkeypatch.setenv("FARM_RUNNER", "sdk")
    seen = []
    real_options = sdk.ClaudeAgentOptions

    def recording_options(**kwargs):
        seen.append(kwargs)
        return real_options(**kwargs)

    def fake_query(*, prompt, options=None, **kwargs):
        async def gen():
            yield sdk.ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="s", result="{}"
            )

        return gen()

    monkeypatch.setattr(sdk, "ClaudeAgentOptions", recording_options)
    monkeypatch.setattr(sdk, "query", fake_query)
    claude.run("p", plugin_dirs=["/opt/mwg/current"])
    claude.run("p")
    claude.run("p", plugin_dirs=None)
    claude.run("p", plugin_dirs=[])
    assert seen[0]["plugins"] == [{"type": "local", "path": "/opt/mwg/current"}]
    for kwargs in seen[1:]:
        assert "plugins" not in kwargs
    assert seen[1] == seen[2] == seen[3]


# ---- metric 1: never dropped silently on another provider ----


def test_run_agent_forwards_plugin_dirs_and_refuses_a_provider_that_cannot_load_them(monkeypatch):
    calls = []
    monkeypatch.setattr(claude, "assert_subscription_auth", lambda: None)
    monkeypatch.setattr(claude, "run", lambda prompt, **kw: calls.append(kw) or {"result": "{}", "session_id": "s"})
    agent_runner.run_agent("p", agent="eng", step=IMPLEMENT_LABEL, provider="claude", plugin_dirs=["/opt/mwg/current"])
    agent_runner.run_agent("p", agent="eng", step=IMPLEMENT_LABEL, provider="claude")
    assert calls[0]["plugin_dirs"] == ["/opt/mwg/current"]
    assert "plugin_dirs" not in calls[1]

    muse_calls = []
    monkeypatch.setattr(agent_runner.muse, "run", lambda prompt, **kw: muse_calls.append(kw))
    with pytest.raises(AgentError, match=r"cannot load plugins \(web guidance\)"):
        agent_runner.run_agent("p", agent="eng", step=IMPLEMENT_LABEL, provider="muse", plugin_dirs=["/opt/mwg/current"])
    assert muse_calls == []


def test_the_unavailable_model_fallback_skips_providers_that_cannot_load_plugins():
    claude_models = [m["id"] for m in domain_providers.PROVIDERS["claude"]["models"] if m["selectable"]]
    tried = frozenset(("claude", m) for m in claude_models)
    # Without plugins, another provider is next; with them, nothing is.
    assert agent_runner._next_unavailable_candidate("claude", claude_models[0], False, tried) is not None
    assert agent_runner._next_unavailable_candidate("claude", claude_models[0], False, tried, plugin_dirs=["/x"]) is None
    nxt = agent_runner._next_unavailable_candidate("claude", claude_models[0], False, frozenset({("claude", claude_models[0])}), plugin_dirs=["/x"])
    assert nxt is None or nxt[0] == "claude"


def test_a_marked_call_whose_every_claude_model_is_unavailable_fails_rather_than_dropping_the_skills(monkeypatch):
    calls = []

    def unavailable(prompt, **kwargs):
        calls.append(("claude", kwargs.get("plugin_dirs")))
        raise AgentModelUnavailableError("model not found")

    monkeypatch.setattr(claude, "assert_subscription_auth", lambda: None)
    monkeypatch.setattr(claude, "run", unavailable)
    monkeypatch.setattr(agent_runner.muse, "run", lambda prompt, **kw: pytest.fail("fell back to a provider without plugins"))
    with pytest.raises(AgentError):
        agent_runner.run_agent("p", agent="eng", step=IMPLEMENT_LABEL, provider="claude", plugin_dirs=["/opt/mwg/current"])
    assert calls and all(dirs == ["/opt/mwg/current"] for _, dirs in calls)


# ---- guardrail 1: unmarked runs launch exactly as today ----


def test_key_absent_and_false_launch_identically_with_no_plugin_dir(plugin, monkeypatch, tmp_path):
    runs = []
    for i, extra in enumerate([{}, {"web_guidance": False}]):
        spawns = implement(monkeypatch, tmp_path / str(i), steps_run_body(**extra))
        assert len(spawns.claude) == 1
        runs.append(spawns.claude[0])
    (argv_a, env_a), (argv_b, env_b) = runs
    assert "--plugin-dir" not in argv_a
    assert "--disallowedTools" not in argv_a
    assert argv_a == argv_b
    assert env_a == env_b
    # Today's launch: the plugin's presence on the host alone changes nothing.
    monkeypatch.setattr(step_agent, "web_guidance_plugin_dirs", lambda task, label: None)
    control = implement(monkeypatch, tmp_path / "control", steps_run_body(web_guidance=True)).claude[0]
    assert control == (argv_a, env_a)


@pytest.mark.parametrize("label", [QA_PLAN_LABEL, REVIEW_LABEL, "Architecture review", "Draft implementation plan", "Deploy the changes"])
def test_only_the_implement_label_resolves_a_plugin(plugin, label):
    assert step_agent.web_guidance_plugin_dirs({"web_guidance": True}, label) is None
    assert step_agent.web_guidance_plugin_dirs({"web_guidance": True}, IMPLEMENT_LABEL) == [str(plugin)]


@pytest.mark.parametrize("label,index", [(QA_PLAN_LABEL, 8), ("Architecture review", 7)])
def test_a_marked_task_on_another_agent_step_calls_run_agent_unchanged(plugin, monkeypatch, label, index):
    captured = []
    for extra in ({}, {"web_guidance": True}):
        seen = {}
        monkeypatch.setattr(step_agent, "run_agent", capture_run_agent(seen))
        task = steps_run_body(step={"index": index, "label": label, "agent": "QA"}, **extra)
        task["item"]["repo"] = None
        try:
            execute(task)
        except Exception:
            pass
        captured.append(seen)
    assert captured[0], f"{label} never reached run_agent"
    assert "plugin_dirs" not in captured[1]
    assert captured[0] == captured[1]


# ---- guardrail 3: only the pinned copy, and a missing one fails early ----


def test_a_missing_plugin_folder_fails_before_prepare_branch_and_before_claude(tmp_path, monkeypatch):
    missing = tmp_path / "nowhere" / "current"
    monkeypatch.setattr(step_agent, "WEB_GUIDANCE_DIR", missing)
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    touched = []
    monkeypatch.setattr(step_agent, "prepare_branch", lambda *a, **k: touched.append("prepare_branch"))
    monkeypatch.setattr(step_agent, "run_agent", lambda *a, **k: touched.append("run_agent"))
    with pytest.raises(AgentError) as exc:
        execute(steps_run_body(web_guidance=True))
    assert str(missing) in str(exc.value)
    assert "infra/host/DEPLOY.md" in str(exc.value)
    assert touched == []


@pytest.mark.parametrize("extra", ["hooks", ".mcp.json", "manifest-hooks"])
def test_a_plugin_carrying_more_than_skills_is_refused(tmp_path, monkeypatch, extra):
    root = install_plugin(tmp_path / "p")
    if extra == "hooks":
        (root / "hooks").mkdir()
    elif extra == ".mcp.json":
        (root / ".mcp.json").write_text("{}")
    else:
        (root / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "x", "hooks": "./h.json"}))
    monkeypatch.setattr(step_agent, "WEB_GUIDANCE_DIR", root)
    with pytest.raises(AgentError, match="not skills only"):
        step_agent.web_guidance_plugin_dirs({"web_guidance": True}, IMPLEMENT_LABEL)


# ---- metric 3 precondition: a tenant run user resolves the same path ----


def test_a_tenant_run_user_resolves_the_same_plugin_path_farmd_does(tmp_path):
    def resolved(env):
        out = subprocess.run(
            [sys.executable, "-c", "from farm.config import WEB_GUIDANCE_DIR; print(WEB_GUIDANCE_DIR)"],
            cwd=REPO_ROOT,
            env={**env, "PATH": os.environ.get("PATH", "")},
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()

    farmd_env = {"HOME": str(tmp_path / "farm"), "FARM_HOME": str(tmp_path / "farm" / ".horizon-farm")}
    tenant_env = credentials.tenant_session_env(
        {"id": 3, "githubTokenRef": "$TENANT_TOKEN"}, home=str(tmp_path / "tenant"), environ={"TENANT_TOKEN": "t"}
    )
    assert tenant_env["FARM_HOME"] != farmd_env["FARM_HOME"]
    assert resolved(farmd_env) == resolved(tenant_env) == str(config.WEB_GUIDANCE_DIR)
    assert not str(config.WEB_GUIDANCE_DIR).startswith(str(tmp_path))


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads a mode-000 file")
def test_an_unreadable_plugin_folder_gives_the_named_error(tmp_path, monkeypatch):
    root = install_plugin(tmp_path / "p")
    manifest = root / ".claude-plugin" / "plugin.json"
    manifest.chmod(0)
    monkeypatch.setattr(step_agent, "WEB_GUIDANCE_DIR", root)
    try:
        with pytest.raises(AgentError) as exc:
            step_agent.web_guidance_plugin_dirs({"web_guidance": True}, IMPLEMENT_LABEL)
    finally:
        manifest.chmod(0o644)
    assert str(root) in str(exc.value)
    assert "Permission denied" in str(exc.value)


# ---- guardrail 2: the host install never enables the skills globally ----


def test_the_deploy_runbook_never_installs_the_plugin_at_user_scope():
    text = DEPLOY_MD.read_text()
    match = re.search(r"^## Modern Web Guidance skills\b[^\n]*\n(.*?)(?=^## )", text, re.S | re.M)
    assert match, "DEPLOY.md has a 'Modern Web Guidance skills' section"
    section = match.group(1)
    assert str(config.WEB_GUIDANCE_DIR.parent) in section
    # Each paragraph or bullet that names a user-scope install only forbids it.
    for block in re.split(r"\n\s*\n|\n(?=- )", section):
        if any(banned in block for banned in ("/plugin install", "claude plugin install", "/plugin marketplace add")):
            assert "```" not in block, block
            assert re.search(r"\b(never|don't|do not)\b", block, re.I), block
