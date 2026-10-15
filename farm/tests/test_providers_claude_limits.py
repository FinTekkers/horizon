"""HZ-422: the Claude provider maps its usage-limit and rate-limit refusals to
AgentUsageLimitedError, carrying the reset time when Claude gives one. Any
other failure behaves as it did. The subprocess runner is driven through a
stubbed subprocess.run; the SDK branches share the same _usage_limit()."""

import json
import subprocess

import pytest

from farm.providers import claude
from farm.providers.base import AgentError, AgentUsageLimitedError


def _completed(stdout: str = "", returncode: int = 1, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["claude"], returncode=returncode, stdout=stdout, stderr=stderr)


@pytest.fixture
def subprocess_runner(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    calls = []

    def install(result):
        def fake_run(cmd, **kw):
            calls.append(cmd)
            return result

        monkeypatch.setattr(claude.subprocess, "run", fake_run)
        return calls

    return install


def test_usage_limit_reached_with_an_epoch_gives_that_reset(subprocess_runner):
    stdout = json.dumps({"type": "result", "is_error": True, "result": "Claude AI usage limit reached|1760281200"})
    subprocess_runner(_completed(stdout))

    with pytest.raises(AgentUsageLimitedError) as err:
        claude.run("p")

    assert err.value.reset_at == "2025-10-12T15:00:00Z"


def test_a_rate_limit_error_has_no_reset(subprocess_runner):
    subprocess_runner(_completed(stderr='API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'))

    with pytest.raises(AgentUsageLimitedError) as err:
        claude.run("p")

    assert err.value.reset_at is None


def test_a_usage_limit_on_a_resumed_session_is_never_retried_fresh(subprocess_runner):
    calls = subprocess_runner(_completed(stdout="Claude AI usage limit reached|1760281200"))

    with pytest.raises(AgentUsageLimitedError):
        claude.run("p", session_id="old-session")

    assert len(calls) == 1


def test_a_limit_reached_message_with_an_iso_reset_is_parsed():
    # A time with no offset is taken as UTC (providers/base.py's iso_utc).
    assert claude._usage_limit("You've hit your limit · resets 2026-10-12 14:00 UTC").reset_at == "2026-10-12T14:00:00Z"
    limited = claude._usage_limit("5-hour limit reached ∙ resets at 2026-10-12T14:00:00Z")
    assert limited.reset_at == "2026-10-12T14:00:00Z"
    assert claude._usage_limit("5-hour limit reached ∙ resets 3pm").reset_at is None


def test_any_other_error_is_unchanged(subprocess_runner):
    subprocess_runner(_completed(stderr="model not found"))

    with pytest.raises(AgentError) as err:
        claude.run("p")

    assert not isinstance(err.value, AgentUsageLimitedError)
    assert str(err.value) == "claude exited 1: model not found"
    assert claude._usage_limit("line 429 of app.js failed") is None
    assert claude._usage_limit("") is None
