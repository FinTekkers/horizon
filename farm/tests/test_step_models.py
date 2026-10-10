"""HZ-398: the model a step runs on, end to end through the farm — the
owner's stored choice in the task's providerChoices, step_agent's parse, the
real run_agent()/_model_for(), and the real Claude and Muse provider modules
down to the CLI argv they build. Only subprocess.run is faked, and it records
every argv.

Every model id is read from domain/providers.json or domain/personas.json.
"""

import json
import subprocess

import pytest

from domain.py import personas as domain_personas
from domain.py import providers as domain_providers
from domain.py import steps as domain_steps
from farm.providers import claude, muse
from farm.step_agent import execute

PLAN_LABEL = "Plan options & trade-offs (pros / cons)"
CLAUDE_IDS = [m["id"] for m in domain_providers.PROVIDERS["claude"]["models"] if m["selectable"]]
MUSE_IDS = [m["id"] for m in domain_providers.PROVIDERS["muse"]["models"] if m["selectable"]]
SONNET = next(i for i in CLAUDE_IDS if "sonnet" in i)
HAIKU = next(i for i in CLAUDE_IDS if "haiku" in i)
MUSE_DEFAULT = domain_providers.default_model("muse")
MUSE_CHOSEN = next(i for i in MUSE_IDS if i != MUSE_DEFAULT)
# What the step runs on today with no choice: domain/personas.json's models block.
PLAN_DEFAULT = domain_personas.resolve_model(
    domain_personas.model_agent_for_step(domain_steps.by_kind_label("change", PLAN_LABEL)["agent"]), PLAN_LABEL
)
REPLY = json.dumps({"summary": "ok", "artifact_md": "# plan"})


@pytest.fixture
def argv(monkeypatch):
    """Records the argv of every claude/muse CLI call and answers it with a
    valid reply in that CLI's own output format."""
    seen: list[list[str]] = []
    real_run = subprocess.run

    def fake_run(cmd, **kwargs):
        if cmd[0] == claude.CLAUDE_BIN:
            seen.append(cmd)
            out = json.dumps({"result": REPLY, "session_id": "s"})
        elif cmd[0] == muse.FARM_MUSE_BIN:
            seen.append(cmd)
            out = json.dumps(
                {"payload_type": "run.terminal.completed", "payload": {"terminal": "completed", "text": REPLY, "command_id": "c"}}
            )
        else:
            return real_run(cmd, **kwargs)
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=out, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    for name in ("FARM_PROVIDER", "FARM_MODEL_OVERRIDE", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return seen


def run_plan_step(choice=None):
    task = {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "d", "metric": "m", "guardrails": "", "priority": "Medium", "repo": None, "issue": None},
        "step": {"index": 4, "label": PLAN_LABEL, "agent": "PM"},
        "artifacts": [],
        "feedback": [],
    }
    if choice is not None:
        task["item"]["providerChoices"] = {"4": choice}
    return execute(task)


def ran(seen):
    """(binary, --model value) per CLI call."""
    return [(cmd[0], cmd[cmd.index("--model") + 1] if "--model" in cmd else None) for cmd in seen]


def flat(seen):
    return [arg for cmd in seen for arg in cmd]


def test_sanity_the_plan_step_takes_a_choice():
    assert domain_steps.provider_override_eligible(domain_steps.FARM_VIEWS["change"], PLAN_LABEL)


def test_default_runs_todays_provider_and_models_block_model(argv):
    result = run_plan_step()

    assert ran(argv) == [(claude.CLAUDE_BIN, PLAN_DEFAULT)]
    assert result["artifacts"]["provider"] == "claude" and result["artifacts"]["model"] == PLAN_DEFAULT


def test_a_sonnet_choice_runs_sonnet_and_records_it(argv):
    result = run_plan_step(f"claude:{SONNET}")

    assert ran(argv) == [(claude.CLAUDE_BIN, SONNET)]
    assert result["artifacts"]["provider"] == "claude"
    assert result["artifacts"]["model"] == SONNET


def test_a_haiku_choice_reaches_the_argv(argv):
    """What a project-only default looks like here: the server has already
    merged it into providerChoices."""
    run_plan_step(f"claude:{HAIKU}")

    assert ran(argv) == [(claude.CLAUDE_BIN, HAIKU)]


def test_a_chosen_muse_model_is_passed_as_model(argv):
    result = run_plan_step(f"muse:{MUSE_CHOSEN}")

    assert ran(argv) == [(muse.FARM_MUSE_BIN, MUSE_CHOSEN)]
    assert (result["artifacts"]["provider"], result["artifacts"]["model"]) == ("muse", MUSE_CHOSEN)


def test_legacy_bare_values_resolve_as_before(argv):
    """HZ-357's stored "claude" / "muse": the models block, and Muse's pinned
    default (what Muse ran on before HZ-398, now passed explicitly)."""
    run_plan_step("claude")
    run_plan_step("muse")

    assert ran(argv) == [(claude.CLAUDE_BIN, PLAN_DEFAULT), (muse.FARM_MUSE_BIN, MUSE_DEFAULT)]


def test_an_undeclared_stored_model_runs_default_and_never_reaches_the_argv(argv):
    run_plan_step("claude:claude-gone")

    assert ran(argv) == [(claude.CLAUDE_BIN, PLAN_DEFAULT)]
    assert "claude-gone" not in flat(argv)


def test_a_cross_provider_choice_never_reaches_either_argv(argv):
    run_plan_step(f"muse:{SONNET}")
    run_plan_step(f"claude:{MUSE_CHOSEN}")

    assert ran(argv) == [(claude.CLAUDE_BIN, PLAN_DEFAULT), (claude.CLAUDE_BIN, PLAN_DEFAULT)]
    assert SONNET not in flat(argv) and MUSE_CHOSEN not in flat(argv)
