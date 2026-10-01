"""HZ-140: what an agent tmux session is allowed to hold.

The bug this pins: `_farm_env_prefix()` forwarded every FARM_* var into every
session, so a step agent with Bash held FARM_SHARED_SECRET — the only thing
guarding approve-via-whatsapp — and could approve its own gate with one curl.

The server half of the same metric (the endpoint refuses FARM_SHARED_SECRET,
and refuses a sender who isn't on the server's own allowlist) is
server/test/wa-approval-auth.test.mjs. These are Python assertions about a
Python function; that one is a JavaScript assertion about an HTTP route. One
metric, two languages, two tests.
"""

import re
import shlex
from pathlib import Path

import pytest

from farm import tmux_mgr

FARM_DIR = Path(__file__).resolve().parent.parent

# A full, realistic session environment, including both credentials.
FULL_ENV = {
    "FARM_SHARED_SECRET": "super-secret-farm-value",
    "WA_APPROVAL_SECRET": "super-secret-approval-value",
    "FARM_HOME": "/home/farm/.horizon-farm",
    "FARM_PROVIDER": "claude",
    "WA_BRIDGE_URL": "http://localhost:8080",
    "CLAUDE_CODE_OAUTH_TOKEN": "claude-cli-own-auth",
    "HORIZON_URL": "http://localhost:3001",
    "PATH": "/usr/bin",
    "HOME": "/home/farm",
}

STEP_SESSION = "farm-run-hz-140-s11-a1"
PM_SESSION = "farm-pm-horizon"
CONCIERGE_SESSION = "farm-concierge-horizon"


# ---- metric 1: no agent session holds FARM_SHARED_SECRET ----


@pytest.mark.parametrize("session", [STEP_SESSION, PM_SESSION, CONCIERGE_SESSION])
def test_no_agent_session_is_given_the_farm_shared_secret(session):
    assert "FARM_SHARED_SECRET" not in tmux_mgr.agent_env(session, FULL_ENV)


# ---- metric 4: the approval credential reaches only the concierge ----


@pytest.mark.parametrize("session", [STEP_SESSION, PM_SESSION])
def test_step_and_pm_sessions_hold_neither_credential(session):
    env = tmux_mgr.agent_env(session, FULL_ENV)
    assert "FARM_SHARED_SECRET" not in env
    assert "WA_APPROVAL_SECRET" not in env


def test_the_concierge_keeps_the_approval_credential_and_nothing_else():
    env = tmux_mgr.agent_env(CONCIERGE_SESSION, FULL_ENV)
    assert env["WA_APPROVAL_SECRET"] == FULL_ENV["WA_APPROVAL_SECRET"]
    assert "FARM_SHARED_SECRET" not in env


def test_a_grant_is_matched_by_prefix_not_by_substring():
    """"farm-run-farm-concierge-x" must not inherit the concierge's grant by
    merely containing its prefix — the check is startswith, never `in`."""
    env = tmux_mgr.agent_env("farm-run-farm-concierge-x", FULL_ENV)
    assert "WA_APPROVAL_SECRET" not in env
    assert tmux_mgr.granted_names("farm-run-farm-concierge-x") == frozenset()
    assert tmux_mgr.granted_names(CONCIERGE_SESSION) == frozenset({"WA_APPROVAL_SECRET"})


# ---- value-level: a name check alone would miss an aliased var ----


@pytest.mark.parametrize("session", [STEP_SESSION, PM_SESSION])
def test_no_secret_value_appears_anywhere_in_a_step_or_pm_command_prefix(session, monkeypatch):
    monkeypatch.setattr(tmux_mgr.os, "environ", dict(FULL_ENV))
    prefix = tmux_mgr._env_prefix(session)
    assert FULL_ENV["FARM_SHARED_SECRET"] not in prefix
    assert FULL_ENV["WA_APPROVAL_SECRET"] not in prefix


def test_the_concierge_prefix_carries_the_approval_value_but_not_the_farm_one(monkeypatch):
    monkeypatch.setattr(tmux_mgr.os, "environ", dict(FULL_ENV))
    prefix = tmux_mgr._env_prefix(CONCIERGE_SESSION)
    assert FULL_ENV["WA_APPROVAL_SECRET"] in prefix
    assert FULL_ENV["FARM_SHARED_SECRET"] not in prefix


# ---- guardrail 4: everything else still rides along, unchanged ----


def test_ordinary_vars_are_still_forwarded_to_a_step_session():
    env = tmux_mgr.agent_env(STEP_SESSION, FULL_ENV)
    assert env["FARM_HOME"] == "/home/farm/.horizon-farm"
    assert env["FARM_PROVIDER"] == "claude"
    assert env["WA_BRIDGE_URL"] == "http://localhost:8080"
    # The claude CLI's own auth — no farm code reads it, and dropping it would
    # break every agent. This is why NEVER_FORWARD is a denylist.
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "claude-cli-own-auth"
    assert env["HORIZON_URL"] == "http://localhost:3001"
    # Unrelated vars were never forwarded and still aren't.
    assert "PATH" not in env and "HOME" not in env


def test_agent_env_never_mutates_the_environment_it_reads():
    source = dict(FULL_ENV)
    tmux_mgr.agent_env(STEP_SESSION, source)
    assert source == FULL_ENV


def test_an_empty_environment_still_unsets_the_credentials(monkeypatch):
    """Even with nothing to forward, the prefix must still clear what the tmux
    server's own global environment might be carrying.

    HZ-144 added FARM_MAX_EPHEMERAL to the same `env -u` list for a
    non-credential reason (the tmux server is usually started by farmd, the
    one process that holds it), so the exact list grew — the property under
    test is unchanged. The two sets stay separate; see
    farm/tests/test_check_env_scrub.py.
    """
    monkeypatch.setattr(tmux_mgr.os, "environ", {})
    assert shlex.split(tmux_mgr._env_prefix(STEP_SESSION)) == [
        "env",
        "-u",
        "FARM_MAX_EPHEMERAL",
        "-u",
        "FARM_SHARED_SECRET",
        "-u",
        "WA_APPROVAL_SECRET",
    ]


def test_the_prefix_unsets_what_it_refuses_to_forward(monkeypatch):
    """Omitting a name is not enough: a pane inherits the tmux server's global
    environment, which in production was seeded from farmd's."""
    monkeypatch.setattr(tmux_mgr.os, "environ", dict(FULL_ENV))
    words = shlex.split(tmux_mgr._env_prefix(STEP_SESSION))
    assert "-u FARM_SHARED_SECRET" in " ".join(words)
    assert "-u WA_APPROVAL_SECRET" in " ".join(words)
    # The concierge unsets only the one it isn't granted.
    concierge = " ".join(shlex.split(tmux_mgr._env_prefix(CONCIERGE_SESSION)))
    assert "-u FARM_SHARED_SECRET" in concierge
    assert "-u WA_APPROVAL_SECRET" not in concierge


def test_a_value_with_spaces_or_quotes_is_still_shell_quoted(monkeypatch):
    value = "/tmp/a dir'with quote"
    monkeypatch.setattr(tmux_mgr.os, "environ", {"FARM_HOME": value})
    # Round-trips through the shell as exactly two words — the space can never
    # split the value into another argument, and the quote can't escape it.
    assert shlex.split(tmux_mgr._env_prefix(STEP_SESSION))[-1] == f"FARM_HOME={value}"


# ---- the tripwire: a future secret must not leak by omission ----

SECRETISH = re.compile(r"SECRET|TOKEN|PASSWORD|API_KEY")
ENV_READ = re.compile(r"""os\.environ\.(?:get|pop)\(\s*["']([A-Z0-9_]+)["']""")

# Names that look secret-shaped but are deliberately NOT in NEVER_FORWARD.
# Empty today. Adding one here is a decision someone has to write down.
KNOWN_FORWARDABLE: frozenset[str] = frozenset()


def secretish_names(source: str) -> set[str]:
    return {name for name in ENV_READ.findall(source) if SECRETISH.search(name)}


def test_every_secret_shaped_var_in_config_is_listed_in_never_forward():
    """If someone adds a new FARM_*_TOKEN to config.py, this fails until they
    decide whether an agent session may hold it. A denylist only stays safe
    with something like this watching it."""
    found = secretish_names((FARM_DIR / "config.py").read_text())
    assert found, "the scan found nothing — it is pointed at the wrong file or the regex broke"
    unlisted = found - set(tmux_mgr.NEVER_FORWARD) - KNOWN_FORWARDABLE
    assert not unlisted, (
        f"{sorted(unlisted)} read from the environment in farm/config.py but listed neither in "
        "tmux_mgr.NEVER_FORWARD nor in this test's KNOWN_FORWARDABLE"
    )


def test_the_tripwire_itself_can_fail():
    """A tripwire only ever seen passing proves nothing."""
    fixture = 'FOO = os.environ.get("FOO_TOKEN", "")\nBAR = os.environ.get("BAR_HOME", "")\n'
    found = secretish_names(fixture)
    assert found == {"FOO_TOKEN"}
    assert found - set(tmux_mgr.NEVER_FORWARD) - KNOWN_FORWARDABLE == {"FOO_TOKEN"}


def test_farm_step_model_is_forwarded_to_a_step_session():
    """HZ-187: STEP_MODEL is read inside the agent process, so the operator's
    FARM_STEP_MODEL must reach the pane — and it is no secret."""
    assert "FARM_STEP_MODEL" not in tmux_mgr.NEVER_FORWARD
    assert tmux_mgr.agent_env(STEP_SESSION, {"FARM_STEP_MODEL": "claude-x"})["FARM_STEP_MODEL"] == "claude-x"
