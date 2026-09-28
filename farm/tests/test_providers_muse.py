"""The Muse Code provider (HZ-83) — unit tests against a mocked subprocess,
per docs/providers/muse-code.md (the verified interface spec for this
provider). Muse's exhaustion signal is explicitly marked unverified there;
tests that exercise it say so in their docstring rather than presenting it
as confirmed behaviour.
"""

import json
import subprocess
from pathlib import Path

import pytest

from farm.providers import muse
from farm.providers.base import AgentError, AgentExhaustedError

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _completed(stdout: str, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["muse"], returncode=returncode, stdout=stdout, stderr=stderr)


def _terminal_completed_jsonl(text: str, command_id: str = "cmd-1") -> str:
    return json.dumps(
        {
            "payload_type": "run.terminal.completed",
            "payload": {"terminal": "completed", "text": text, "command_id": command_id},
        }
    )


def test_run_returns_result_from_terminal_completed_event(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _completed(_terminal_completed_jsonl("horizon"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    reply = muse.run("reply with exactly the word: horizon", session_id="fixed-session")

    assert reply == {"result": "horizon", "session_id": "fixed-session", "command_id": "cmd-1"}


def test_run_mints_a_session_id_when_caller_supplies_none(monkeypatch):
    def fake_run(cmd, **kwargs):
        return _completed(_terminal_completed_jsonl("ok"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    reply = muse.run("hello")

    assert reply["session_id"]  # caller-supplied ownership model: we mint a UUID
    assert reply["session_id"] != ""


def test_run_passes_headless_safety_flags(monkeypatch):
    """docs/providers/muse-code.md: --approval-mode defaults to on-request
    and blocks forever without --approval-mode never plus
    --user-input-auto-resolve; an untrusted workspace also loses agent
    delegation without --trust-workspace. Missing any of these hangs a real
    farm run, so this asserts the exact argv, not just success."""
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _completed(_terminal_completed_jsonl("ok"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    muse.run("hello", session_id="sess-1", max_turns=12, timeout_s=30)

    cmd = captured["cmd"]
    assert "--approval-mode" in cmd and cmd[cmd.index("--approval-mode") + 1] == "never"
    assert "--user-input-auto-resolve" in cmd
    assert "--trust-workspace" in cmd
    assert "--session-id" in cmd and cmd[cmd.index("--session-id") + 1] == "sess-1"
    assert "--max-model-steps" in cmd and cmd[cmd.index("--max-model-steps") + 1] == "12"
    assert "--json" in cmd


def test_run_writes_the_prompt_to_a_file_not_argv(monkeypatch, tmp_path):
    """--prompt-file avoids ARG_MAX on long prompts (docs/providers/muse-code.md)
    — the prompt text itself must never appear as a raw argv element."""
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        idx = cmd.index("--prompt-file")
        captured["prompt_file_contents"] = open(cmd[idx + 1]).read()
        return _completed(_terminal_completed_jsonl("ok"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    muse.run("a very particular prompt marker XYZZY", append_system="be terse")

    assert "XYZZY" not in captured["cmd"]
    assert "be terse" in captured["prompt_file_contents"]
    assert "XYZZY" in captured["prompt_file_contents"]


def test_run_never_passes_a_metered_credential_flag(monkeypatch):
    """Regression guard for the HZ-5 guarantee on the muse side: there is no
    code path here that ever wires up Muse's metered-credential flags
    (--api-key-stdin), regardless of what's in the environment — metered
    billing is refused by absence, not a comment."""
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _completed(_terminal_completed_jsonl("ok"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "5.00")
    muse.run("hello")

    assert "--api-key-stdin" not in captured["cmd"]
    assert not any("key" in str(part).lower() for part in captured["cmd"])


def test_assert_subscription_auth_does_not_raise():
    """No `muse account status` command exists (unverified per
    docs/providers/muse-code.md — confirmed no `account` subcommand at
    all), so there's nothing for this to check today; it must not block
    ordinary runs."""
    muse.assert_subscription_auth()  # must not raise


def test_run_times_out_raises_agent_exhausted_error(monkeypatch):
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentExhaustedError, match="timed out"):
        muse.run("hang forever", timeout_s=5)


def test_run_no_terminal_event_and_nonzero_exit_raises_agent_error(monkeypatch):
    def fake_run(cmd, **kwargs):
        return _completed(stdout="", returncode=1, stderr="boom")

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="muse exited 1"):
        muse.run("hello")


def test_run_exhaustion_event_raises_agent_exhausted_error(monkeypatch):
    """ASSUMPTION, explicitly: docs/providers/muse-code.md states the real
    exhaustion signal is unverified ("no exhausting run was observed"). This
    exercises this module's best-guess handling — a payload_type naming
    exhaustion — against a fake event, not a confirmed real one. Needs
    reconfirming against an actual exhausting Muse run; see the doc's "still
    unverified" section."""

    def fake_run(cmd, **kwargs):
        line = json.dumps({"payload_type": "run.terminal.exhausted", "payload": {}})
        return _completed(stdout=line, returncode=0)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentExhaustedError, match="exhaust"):
        muse.run("hello")


def test_binary_not_found_raises_agent_error(monkeypatch):
    def fake_run(cmd, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="muse binary not found"):
        muse.run("hello")


def test_run_no_terminal_event_and_zero_exit_raises_agent_error(monkeypatch):
    """The other half of the 'fails loudly, never an empty artifact'
    requirement: a clean exit (0) with no run.terminal.completed event must
    still raise, not silently return an empty result."""

    def fake_run(cmd, **kwargs):
        return _completed(stdout="", returncode=0)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="no terminal.completed event"):
        muse.run("hello")


# ---- provenance: command_id (HZ-102 success metric) ----


def test_run_returns_command_id_from_terminal_completed_event(monkeypatch):
    def fake_run(cmd, **kwargs):
        return _completed(_terminal_completed_jsonl("ok", command_id="a-real-run-id"))

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    reply = muse.run("hello")

    assert reply["command_id"] == "a-real-run-id"


@pytest.mark.parametrize("bad_command_id", [None, "", "   "])
def test_run_raises_when_terminal_completed_is_missing_command_id(monkeypatch, bad_command_id):
    """Provenance is a hard requirement, not best-effort: a terminal event
    without a usable command_id must fail loudly rather than silently
    recording a run nobody can trace back to Muse."""

    def fake_run(cmd, **kwargs):
        line = json.dumps(
            {
                "payload_type": "run.terminal.completed",
                "payload": {"terminal": "completed", "text": "ok", "command_id": bad_command_id},
            }
        )
        return _completed(stdout=line)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="command_id"):
        muse.run("hello")


def test_run_raises_when_terminal_completed_has_no_command_id_field_at_all(monkeypatch):
    def fake_run(cmd, **kwargs):
        line = json.dumps({"payload_type": "run.terminal.completed", "payload": {"text": "ok"}})
        return _completed(stdout=line)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="command_id"):
        muse.run("hello")


# ---- recorded fixtures (QA requirement: a real event stream, not an
# inline-built one, proves the terminal-event parse) ----


def test_parses_a_recorded_terminal_completed_fixture(monkeypatch):
    """docs/providers/muse-code.md's own worked example, captured as a full
    JSONL event stream (farm/tests/fixtures/muse_terminal_completed.jsonl) —
    the observed sequence (runtime.command.accepted -> ... ->
    run.terminal.completed), not just the last line."""
    stdout = (FIXTURES_DIR / "muse_terminal_completed.jsonl").read_text()

    def fake_run(cmd, **kwargs):
        return _completed(stdout=stdout)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    reply = muse.run("Reply with exactly the word: horizon", session_id="fixed-session")

    assert reply == {
        "result": "horizon",
        "session_id": "fixed-session",
        "command_id": "e93cb8d2-f310-48f0-b698-539a49af55d5",
    }


def test_recorded_fixture_missing_terminal_completed_fails_loudly(monkeypatch):
    """A stream cut off before run.terminal.completed (killed run, truncated
    capture) must raise — never produce an empty or partial artifact."""
    stdout = (FIXTURES_DIR / "muse_missing_terminal.jsonl").read_text()

    def fake_run(cmd, **kwargs):
        return _completed(stdout=stdout)

    monkeypatch.setattr(muse.subprocess, "run", fake_run)
    with pytest.raises(AgentError, match="no terminal.completed event"):
        muse.run("hello")
