"""HZ-535: project personas on the farm side — farm/personas.py's loader and
overlay, and a real dispatch that composes one.

Every project persona id here is fabricated; model ids are read from
domain/providers.json and global persona ids from domain/personas.json.
"""

import json
import subprocess

import pytest

from domain.py import personas as domain_personas
from domain.py import providers as domain_providers
from farm import personas
from farm.providers import claude
from farm.step_agent import QA_PLAN_LABEL, execute

CLAUDE_IDS = [m["id"] for m in domain_providers.PROVIDERS["claude"]["models"] if m["selectable"]]
QA_DEFAULT_MODEL = domain_personas.MODELS["agents"]["qa"]
# A model the QA agent would not run on by default, so the dispatch test can
# only pass if the project file's model reached the CLI.
FILE_MODEL = next(i for i in CLAUDE_IDS if i != QA_DEFAULT_MODEL)
MUSE_MODEL = domain_providers.default_model("muse")
ROLE_MD = "# Ledger checks\n\nReconcile every position before you sign off.\n"


def _entry(**overrides):
    entry = {
        "id": "ledger_checks",
        "agent": "qa",
        "label": "Ledger checks",
        "initials": "LC",
        "color": "#2E6CB2",
        "model": FILE_MODEL,
        "provider": "claude",
        "file": "ledger_checks.md",
    }
    entry.update(overrides)
    return entry


def write_project(root, slug, entries, role_files=None):
    (root / slug / "personas").mkdir(parents=True)
    (root / slug / "personas.json").write_text(json.dumps({"personas": entries}))
    for name, text in (role_files or {"ledger_checks.md": ROLE_MD}).items():
        (root / slug / "personas" / name).write_text(text)


@pytest.fixture
def projects(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(personas, "PROJECTS_DIR", root)
    return root


# ---- metric 3: a colliding id fails, naming the id ----


def test_a_project_id_equal_to_a_global_persona_id_fails_and_names_it(projects):
    global_id = domain_personas.PERSONA_IDS["eng"][1]
    write_project(projects, "acme", [_entry(id=global_id, file="ledger_checks.md")])
    with pytest.raises(RuntimeError) as exc:
        personas.load_project_personas("acme")
    assert f'"{global_id}"' in str(exc.value)
    assert f"eng.{global_id}" in str(exc.value)
    # At dispatch the same file never kills a run: the project goes global.
    assert personas.project_overlay({"name": "Acme", "definitionsEnabled": True}) is None


# ---- guardrail 3: the credential lint runs on every project persona file ----


def test_the_credential_lint_refuses_a_credential_in_personas_json(projects):
    key = "AKIA" + "ABCDEFGHIJKLMNOP"
    write_project(projects, "in-json", [_entry(label=f"Ledger {key}")])
    with pytest.raises(RuntimeError, match=r"farm/projects/in-json/personas\.json: credential lint refused it \(AWS access key id\)"):
        personas.load_project_personas("in-json")


def test_the_credential_lint_refuses_a_dirty_second_role_file(projects):
    key = "AKIA" + "ABCDEFGHIJKLMNOP"
    write_project(
        projects,
        "second-md",
        [_entry(), _entry(id="risk", label="Risk", file="risk.md")],
        {"ledger_checks.md": "clean\n", "risk.md": f"aws key {key}\n"},
    )
    with pytest.raises(RuntimeError, match=r"farm/projects/second-md/personas/risk\.md: credential lint refused it"):
        personas.load_project_personas("second-md")


# ---- guardrail 4: switch off or no file keeps everything byte-identical ----


@pytest.mark.parametrize(
    "project",
    [
        {"name": "Acme", "definitionsEnabled": False},
        {"name": "Acme"},  # a server from before HZ-535 sends no flag
        {"name": "Acme", "definitionsEnabled": 1},  # only a real true turns it on
        None,
    ],
)
def test_the_switch_off_or_missing_gives_no_overlay_even_with_a_real_file(projects, project):
    write_project(projects, "acme", [_entry()])
    assert personas.project_overlay(project) is None


def test_switch_off_composes_byte_identical_to_no_project_file(projects):
    write_project(projects, "acme", [_entry()])
    role = "ROLE TEXT\n"
    off = personas.compose_role(role, "qa", "acme:ledger_checks", personas.project_overlay({"name": "Acme", "definitionsEnabled": False}))
    no_file = personas.compose_role(role, "qa", "acme:ledger_checks", personas.project_overlay({"name": "No File", "definitionsEnabled": True}))
    assert off == no_file == personas.compose_role(role, "qa", "acme:ledger_checks")
    assert ROLE_MD not in off


# ---- metric 4: the file's model and provider ----


def test_the_overlay_carries_the_files_model_badge_and_provider(projects):
    write_project(projects, "acme", [_entry(provider="muse", model=MUSE_MODEL)])
    overlay = personas.project_overlay({"name": "Acme", "definitionsEnabled": True})
    assert overlay["models"] == {"qa.acme:ledger_checks": MUSE_MODEL}
    assert overlay["display"]["acme:ledger_checks"] == {"label": "Ledger checks", "initials": "LC", "color": "#2E6CB2"}
    assert personas.provider_for({"qa": "acme:ledger_checks"}, overlay) == "muse"
    # Another project's id, or no overlay, forces nothing.
    assert personas.provider_for({"qa": "other:ledger_checks"}, overlay) is None
    assert personas.provider_for({"qa": "acme:ledger_checks"}) is None


@pytest.fixture
def argv(monkeypatch):
    """Records the argv of every claude CLI call and answers with a valid reply."""
    seen: list[list[str]] = []
    real_run = subprocess.run
    reply = json.dumps({"summary": "ok", "artifact_md": "# test plan"})

    def fake_run(cmd, **kwargs):
        if cmd[0] != claude.CLAUDE_BIN:
            return real_run(cmd, **kwargs)
        seen.append(cmd)
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=json.dumps({"result": reply, "session_id": "s"}), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    for name in ("FARM_PROVIDER", "FARM_MODEL_OVERRIDE", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return seen


def qa_plan_task(project, qa_persona):
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "AC-1",
            "title": "t",
            "desc": "d",
            "metric": "m",
            "guardrails": "",
            "priority": "Medium",
            "repo": None,
            "issue": None,
            "personas": {"qa": qa_persona},
        },
        "step": {"index": 8, "label": QA_PLAN_LABEL, "agent": "QA"},
        "project": project,
        "artifacts": [],
        "feedback": [],
    }


def test_a_dispatched_step_runs_on_the_project_files_model_and_role(projects, argv):
    """The real path a persona takes: step_agent._execute composes the
    project role, and run_agent()/_model_for() hand the file's model to the
    Claude CLI. (Change step 1, "Define how we measure success", is a PM step:
    _execute_pm, which composes no persona at all, global or project.)"""
    write_project(projects, "acme", [_entry()])
    result = execute(qa_plan_task({"id": 1, "name": "Acme", "definitionsEnabled": True}, "acme:ledger_checks"))

    assert len(argv) == 1
    cmd = argv[0]
    assert cmd[cmd.index("--model") + 1] == FILE_MODEL
    assert result["artifacts"]["model"] == FILE_MODEL
    assert ROLE_MD in cmd[cmd.index("--append-system-prompt") + 1]


def test_the_same_dispatch_with_the_switch_off_runs_on_the_global_defaults(projects, argv):
    write_project(projects, "acme", [_entry()])
    execute(qa_plan_task({"id": 1, "name": "Acme", "definitionsEnabled": False}, "acme:ledger_checks"))

    cmd = argv[0]
    assert cmd[cmd.index("--model") + 1] == QA_DEFAULT_MODEL
    assert ROLE_MD not in cmd[cmd.index("--append-system-prompt") + 1]
