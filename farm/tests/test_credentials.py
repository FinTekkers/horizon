"""HZ-140: the model subprocess never inherits a gate-approving credential.

test_tmux_env.py covers the tmux boundary — which credentials reach an agent
*session*. This file covers the boundary one level in: the concierge session is
deliberately granted WA_APPROVAL_SECRET, and the thing it spawns inside that
session is a model reading WhatsApp text a stranger wrote. That model must not
get the credential, on either runner.

Two mechanisms, because one is not enough:

  providers pass env=   covers FARM_RUNNER=subprocess, and every step/PM agent
  main() drops the name covers the default SDK runner, whose transport builds
                        the child env as {**os.environ, **options.env} — it can
                        override a name there but never remove one

Values are asserted absent, not printed.
"""

import inspect
import os
import subprocess
from pathlib import Path

import pytest

from farm import credentials, tmux_mgr
from farm.providers import claude as claude_provider
from farm.providers import muse as muse_provider

FARM_VALUE = "super-secret-farm-value"
APPROVAL_VALUE = "super-secret-approval-value"


# ---- the name list is shared, not copied ----


def test_the_tmux_boundary_and_the_process_boundary_use_the_same_list():
    """Three consumers, one frozenset. A second copy would drift the day
    someone adds a credential to only one of them."""
    assert tmux_mgr.NEVER_FORWARD is credentials.GATE_APPROVING
    assert credentials.GATE_APPROVING == {"FARM_SHARED_SECRET", "WA_APPROVAL_SECRET"}


# ---- without_gate_credentials ----


def test_without_gate_credentials_drops_both_and_keeps_everything_else():
    env = {
        "FARM_SHARED_SECRET": FARM_VALUE,
        "WA_APPROVAL_SECRET": APPROVAL_VALUE,
        "FARM_HOME": "/home/farm/.horizon-farm",
        "CLAUDE_CODE_OAUTH_TOKEN": "claude-cli-own-auth",
        "PATH": "/usr/bin",
    }
    scrubbed = credentials.without_gate_credentials(env)
    assert "FARM_SHARED_SECRET" not in scrubbed
    assert "WA_APPROVAL_SECRET" not in scrubbed
    # Unlike the tmux prefix, this is a whole process environment: PATH and the
    # claude CLI's own auth must survive or the child cannot run at all.
    assert scrubbed["PATH"] == "/usr/bin"
    assert scrubbed["CLAUDE_CODE_OAUTH_TOKEN"] == "claude-cli-own-auth"
    assert scrubbed["FARM_HOME"] == "/home/farm/.horizon-farm"
    assert FARM_VALUE not in scrubbed.values()
    assert APPROVAL_VALUE not in scrubbed.values()


def test_without_gate_credentials_never_mutates_the_source():
    source = {"FARM_SHARED_SECRET": FARM_VALUE, "FARM_HOME": "/tmp"}
    credentials.without_gate_credentials(source)
    assert source == {"FARM_SHARED_SECRET": FARM_VALUE, "FARM_HOME": "/tmp"}


def test_without_gate_credentials_defaults_to_this_process(monkeypatch):
    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.setenv("FARM_SHARED_SECRET", FARM_VALUE)
    scrubbed = credentials.without_gate_credentials()
    assert "WA_APPROVAL_SECRET" not in scrubbed and "FARM_SHARED_SECRET" not in scrubbed
    assert scrubbed.get("FARM_HOME")  # conftest sets it — proves we read the real env


# ---- drop_from_process_environ ----


def test_drop_from_process_environ_removes_the_names_and_reports_them(monkeypatch):
    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.setenv("FARM_SHARED_SECRET", FARM_VALUE)
    dropped = credentials.drop_from_process_environ()
    assert dropped == ["FARM_SHARED_SECRET", "WA_APPROVAL_SECRET"]
    assert os.environ.get("WA_APPROVAL_SECRET") is None
    assert os.environ.get("FARM_SHARED_SECRET") is None
    # A report of what was given up must name it, never quote it.
    assert APPROVAL_VALUE not in dropped and FARM_VALUE not in dropped


def test_drop_from_process_environ_is_idempotent_and_reports_only_what_was_there(monkeypatch):
    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.delenv("FARM_SHARED_SECRET", raising=False)
    assert credentials.drop_from_process_environ() == ["WA_APPROVAL_SECRET"]
    assert credentials.drop_from_process_environ() == []


def test_drop_from_process_environ_leaves_unrelated_vars_alone(monkeypatch):
    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.setenv("WA_BRIDGE_URL", "http://localhost:8080")
    credentials.drop_from_process_environ()
    assert os.environ["WA_BRIDGE_URL"] == "http://localhost:8080"


# ---- the provider seam: what the model subprocess is actually launched with ----


class _FakeCompleted:
    returncode = 0
    stdout = '{"result": "ok", "session_id": "s1"}'
    stderr = ""


def _spawn_env(monkeypatch, run_it) -> dict:
    """Run a provider with subprocess.run stubbed; return the env= it passed."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["env"] = kwargs.get("env")
        return _FakeCompleted()

    monkeypatch.setenv("FARM_SHARED_SECRET", FARM_VALUE)
    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    run_it(fake_run)
    env = captured["env"]
    assert env is not None, "the provider inherited the parent environment instead of passing env="
    return env


def test_the_claude_subprocess_runner_scrubs_both_credentials(monkeypatch):
    monkeypatch.setattr(claude_provider, "_selected_runner", lambda: "subprocess")
    monkeypatch.setattr(claude_provider, "assert_subscription_auth", lambda: None)

    def run_it(fake_run):
        monkeypatch.setattr(claude_provider.subprocess, "run", fake_run)
        claude_provider.run("hello")

    env = _spawn_env(monkeypatch, run_it)
    assert "FARM_SHARED_SECRET" not in env
    assert "WA_APPROVAL_SECRET" not in env
    assert FARM_VALUE not in env.values() and APPROVAL_VALUE not in env.values()
    # Positive control: a wholesale env= replacement that dropped PATH would
    # break every agent, and would make the assertions above pass vacuously.
    assert env.get("PATH")


def test_the_muse_subprocess_runner_scrubs_both_credentials(monkeypatch):
    monkeypatch.setattr(muse_provider, "assert_subscription_auth", lambda: None)
    monkeypatch.setattr(muse_provider, "_parse_events", lambda proc, sid: {"result": "ok", "session_id": sid})

    def run_it(fake_run):
        monkeypatch.setattr(muse_provider.subprocess, "run", fake_run)
        muse_provider.run("hello")

    env = _spawn_env(monkeypatch, run_it)
    assert "FARM_SHARED_SECRET" not in env
    assert "WA_APPROVAL_SECRET" not in env
    assert env.get("PATH")


def test_no_provider_spawns_a_model_without_an_explicit_env(monkeypatch):
    """The seam has two call sites today. A third added without env= would
    silently reopen the inheritance path, so it fails here instead."""
    providers_dir = Path(muse_provider.__file__).parent
    for path in sorted(providers_dir.glob("*.py")):
        source = path.read_text()
        for call in ("subprocess.run(", "subprocess.Popen("):
            start = 0
            while (idx := source.find(call, start)) != -1:
                start = idx + len(call)
                # Argument list of this one call, up to its closing paren.
                depth, end = 1, start
                while depth and end < len(source):
                    depth += (source[end] == "(") - (source[end] == ")")
                    end += 1
                assert "env=" in source[start:end], f"{path.name}: a {call.rstrip('(')} call passes no env="


# ---- the SDK runner: only the process-level drop can cover it ----


def test_the_concierge_drops_the_credential_before_it_runs_any_model(monkeypatch):
    """concierge_agent.main() must scrub its own environment before the first
    model call. Asserted by stopping main() at the very next thing it does (the
    empty-allowlist refusal) and checking the name is already gone."""
    from farm import concierge_agent

    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.setattr(concierge_agent.config, "FARM_WA_ALLOWED_JIDS", [])
    monkeypatch.setattr("sys.argv", ["concierge_agent", "--project", "horizon"])

    with pytest.raises(SystemExit):
        concierge_agent.main()

    assert "WA_APPROVAL_SECRET" not in os.environ


def test_the_value_survives_in_config_so_the_approval_still_works(monkeypatch):
    """Dropping the name must not disarm the concierge: config.py captured the
    value at import, and wizard._approve_gate reads it from there."""
    from farm import config, wizard

    monkeypatch.setenv("WA_APPROVAL_SECRET", APPROVAL_VALUE)
    monkeypatch.setattr(config, "WA_APPROVAL_SECRET", APPROVAL_VALUE)
    credentials.drop_from_process_environ()

    sent: dict = {}

    def fake_post(url, **kwargs):
        sent.update(kwargs)

        class R:
            status_code = 200

        return R()

    monkeypatch.setattr(wizard.httpx, "post", fake_post)
    ok, err = wizard._approve_gate(
        "http://server", {"item_id": "hz-1", "step_index": 3}, "David", "15551112222@s.whatsapp.net"
    )
    assert ok and err == ""
    assert sent["headers"]["x-wa-approval-secret"] == APPROVAL_VALUE


# ---- the SDK's own semantics, pinned ----


def test_the_sdk_transport_cannot_remove_a_name_via_options_env():
    """Why the process-level drop exists at all. If a future SDK gains the
    ability to *remove* a name, this fails and the comment in
    farm/credentials.py should be revisited — not silently left stale."""
    sdk_transport = pytest.importorskip("claude_agent_sdk._internal.transport.subprocess_cli")
    source = inspect.getsource(sdk_transport)
    # The child env is a merge over os.environ; nothing subtracts from it.
    assert "**self._options.env" in source


# ---- guardrail 4: farmd's own calls are untouched ----


def test_farmd_keeps_the_shared_secret_it_needs(monkeypatch):
    """The scrub is at the model-spawn seam, not at import. farmd never runs a
    model, so its FARM_SHARED_SECRET — and every /api/farm/* call — is unaffected."""
    monkeypatch.setenv("FARM_SHARED_SECRET", FARM_VALUE)
    assert os.environ["FARM_SHARED_SECRET"] == FARM_VALUE
    # Nothing in the provider seam touches the parent's own environment.
    before = dict(os.environ)
    credentials.without_gate_credentials()
    assert dict(os.environ) == before


def test_subprocess_module_is_still_the_one_being_patched():
    """Guards the two provider tests above from passing vacuously if a provider
    switched to another spawn API."""
    assert claude_provider.subprocess is subprocess
    assert muse_provider.subprocess is subprocess
