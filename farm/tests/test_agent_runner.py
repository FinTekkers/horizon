"""agent_runner: subprocess fallback, cost guardrail, JSON lifting.

Deliberately SDK-free: this module must collect and pass even when
claude-agent-sdk is not installed in the venv running the checks (that
exact gap failed the HZ-5 guardrail gate twice). The SDK streaming path
lives in test_agent_runner_sdk.py behind importorskip.

FARM_PROVIDER defaults to "claude" (conftest never sets it), so
assert_provider_auth()/run_agent() below exercise the claude provider,
same as the pre-HZ-83 claude_runner module did.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from farm.agent_runner import (
    AgentError,
    _extract_json_with_notes,
    _record_repair,
    _salvage_truncated_json,
    assert_provider_auth,
    extract_json,
    repair_stats_path,
    run_agent,
)


def test_extract_json_plain():
    assert extract_json('{"summary": "done"}') == {"summary": "done"}


def test_extract_json_fenced():
    assert extract_json('```json\n{"summary": "done"}\n```') == {"summary": "done"}


def test_extract_json_wrapped_in_prose():
    text = 'Here you go:\n{"summary": "done", "n": 2}\nHope that helps!'
    assert extract_json(text) == {"summary": "done", "n": 2}


def test_extract_json_missing_raises():
    with pytest.raises(AgentError):
        extract_json("no json here at all")


# ---- HZ-124: extended repair ladder (success metrics 1-6) ----


def test_extract_json_strips_a_trailing_comma():
    assert extract_json('{"a":1,}') == {"a": 1}


def test_extract_json_converts_single_quotes():
    assert extract_json("{'a':1}") == {"a": 1}


def test_extract_json_returns_the_first_of_two_objects():
    text = '{"s":"first"} prose {"s":"second"}'
    assert extract_json(text) == {"s": "first"}


def test_extract_json_unescaped_inner_quote_raises_on_first_attempt():
    """Metric 5, first half: this shape is genuinely ambiguous (there is no
    deterministic byte-level fix), so extract_json() alone must raise — the
    lossless retry in parse_agent_reply() is the ONLY recovery path, never a
    heuristic guess here."""
    with pytest.raises(AgentError):
        extract_json('{"s":"he said "hi" to me"}')


def test_extract_json_unrepairable_input_raises_without_fabricating_content():
    """Metric 6: truncation mid-literal (not mid-string) is not something
    _salvage_truncated_json or the repair ladder can fix without guessing —
    it must raise, never return plausible-looking but invented content."""
    with pytest.raises(AgentError):
        extract_json('{"ok": tru')


def test_extract_json_produces_no_notes_on_already_valid_input():
    """Negative case for guardrail 2 ('a note only when bytes are altered'):
    clean input must repair-report as silent — an empty notes list — not
    just happen to parse."""
    parsed, notes = _extract_json_with_notes('{"summary": "done"}')
    assert parsed == {"summary": "done"}
    assert notes == []


def test_extract_json_notes_name_the_repair_actually_applied():
    _parsed, comma_notes = _extract_json_with_notes('{"a":1,}')
    assert comma_notes == ["stripped a trailing comma"]

    _parsed, quote_notes = _extract_json_with_notes("{'a':1}")
    assert quote_notes == ["converted single quotes to double quotes"]


def test_extract_json_combines_trailing_comma_and_single_quote_repairs():
    """Neither fix alone parses `{'a':1,}` — trailing-comma-only still has
    single quotes, quote-only still has the trailing comma — only the
    combined `both_fixed` branch in the ladder recovers it."""
    parsed, notes = _extract_json_with_notes("{'a':1,}")
    assert parsed == {"a": 1}
    assert notes == ["stripped a trailing comma", "converted single quotes to double quotes"]


def test_pm_agent_and_step_agent_never_parse_a_reply_without_the_shared_helper():
    """Metric 14: farm/agent_runner.py's parse_agent_reply() must be the ONE
    place a reply is turned into JSON — a caller importing/calling
    extract_json() directly would bypass its retry/repair/salvage/handoff
    machinery silently. Source-text scan, not an import-time check, so it
    also catches a stray `from .agent_runner import extract_json`."""
    repo_root = Path(__file__).resolve().parent.parent.parent
    for relative in ("farm/pm_agent.py", "farm/step_agent.py"):
        source = (repo_root / relative).read_text()
        assert "extract_json(" not in source, f"{relative} must parse replies via parse_agent_reply(), not extract_json()"
        assert "import extract_json" not in source, f"{relative} must not import extract_json at all"
        assert "parse_agent_reply(" in source, f"{relative} must call the shared parse_agent_reply() helper"


def test_requirements_txt_gains_no_third_party_json_repair_dependency():
    """Guardrail 4: no json-repair-style dependency may be added — the
    repair ladder must be implemented in plain Python in agent_runner.py."""
    requirements = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text().lower()
    for banned in ("json-repair", "json_repair", "demjson", "dirtyjson"):
        assert banned not in requirements


# ---- _salvage_truncated_json: the two "never fabricate" give-up branches ----


def test_salvage_truncated_json_gives_up_on_a_mid_literal_cut():
    """`'{"b": tru'` has an open brace (recoverable-looking) but the patched
    text still doesn't parse, because the cut is mid-literal, not mid-string
    or mid-object — salvage must return None here rather than guess a value
    for `b`."""
    assert _salvage_truncated_json('{"b": tru') is None


def test_salvage_truncated_json_gives_up_when_nothing_is_open_at_eof():
    """Braces/strings are already balanced at EOF, so whatever is wrong with
    this text isn't exhaustion truncation — salvage must not touch it."""
    assert _salvage_truncated_json('{"a": 1} trailing garbage after') is None


# ---- metric 15 / QA: repair counter must honor a patched STATE_DIR ----


def test_record_repair_writes_to_the_current_state_dir_not_a_frozen_import_time_one(monkeypatch, tmp_path):
    """repair_stats_path() (and therefore _record_repair()) must read
    STATE_DIR at call time — a module-level constant bound at import would
    silently ignore monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    and every repair-triggering test would instead pollute the real,
    process-wide STATE_DIR."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    assert repair_stats_path() == tmp_path / "repair-stats.ndjson"

    _record_repair("stripped a trailing comma")

    stats_file = tmp_path / "repair-stats.ndjson"
    assert stats_file.exists()
    assert json.loads(stats_file.read_text().strip()) == {"path": "stripped a trailing comma"}


# ---- HZ-124 metric 8, subprocess-rollback half: partial_text/session_id on
# the FARM_RUNNER=subprocess timeout path (claude.py's _run_subprocess) ----


def test_subprocess_runner_timeout_carries_partial_text_and_no_session_id(monkeypatch):
    from farm.providers import base, claude

    monkeypatch.setenv("FARM_RUNNER", "subprocess")

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"), output="partial output before kill")

    monkeypatch.setattr(claude.subprocess, "run", fake_run)
    with pytest.raises(base.AgentExhaustedError) as exc_info:
        run_agent("prompt", timeout_s=5)
    assert exc_info.value.partial_text == "partial output before kill"
    assert exc_info.value.session_id is None


# ---- rollback lever: FARM_RUNNER=subprocess keeps the old silent path ----


def test_run_agent_with_fake_binary(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    reply = run_agent('Step to perform now: "Do the thing" (attempt 1)', max_turns=4, timeout_s=30)
    assert reply["session_id"] == "fake-session-001"
    inner = extract_json(reply["result"])
    assert inner["summary"].startswith("[fake-claude] completed")


def test_subprocess_path_never_touches_the_sdk(monkeypatch):
    monkeypatch.setenv("FARM_RUNNER", "subprocess")
    # None in sys.modules makes any `import claude_agent_sdk` raise — so if
    # the subprocess path touched the SDK at all, this test would blow up.
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    reply = run_agent("anything", max_turns=4, timeout_s=30, allowed_tools="Read,Grep")
    assert reply["session_id"] == "fake-session-001"


def test_sdk_path_without_sdk_names_the_rollback_lever(monkeypatch):
    """A venv missing claude-agent-sdk must fail with an actionable AgentError,
    not a bare ImportError mid-step."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    with pytest.raises(AgentError, match="FARM_RUNNER=subprocess"):
        run_agent("prompt", timeout_s=10)


# ---- cost guardrail (HZ-5 success metric: no API billing) ----


def test_assert_provider_auth_raises_with_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        assert_provider_auth()


def test_assert_provider_auth_passes_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert_provider_auth()  # must not raise


def test_sdk_path_refuses_to_run_with_api_key(monkeypatch):
    """The check must hold in the agent process itself, not just in farmd —
    and it fires before the SDK import, so it needs no SDK installed."""
    monkeypatch.setenv("FARM_RUNNER", "sdk")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        run_agent("prompt")


def test_assert_provider_auth_allows_metered_billing_when_explicitly_capped(monkeypatch):
    """HZ-5 guarantee, extended by HZ-83: metered billing is refused unless
    explicitly opted in with an enforced cap — this is the "unless" branch,
    proven against the real claude provider stack (agent_runner ->
    providers.claude -> providers.base's spend gate), not just the gate in
    isolation."""
    from farm.providers import base

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("FARM_ALLOW_METERED_BILLING", "1")
    monkeypatch.setenv("FARM_METERED_SPEND_CAP_USD", "5.00")
    monkeypatch.setattr(base, "_METERED_SPEND_TRACKER", base._SpendTracker())

    assert_provider_auth()  # must not raise


# ---- config-driven provider selection, end to end (HZ-83 success metric) ----


def test_run_agent_selects_muse_provider_via_config_end_to_end(monkeypatch):
    """The success metric's central claim — 'a step runs on Muse Code
    selected by configuration' — needs a test that actually crosses the
    seam. Sets FARM_PROVIDER=muse and drives a real call through
    agent_runner.run_agent() into the real farm.providers.muse module, down
    to muse.subprocess.run — the same boundary test_providers_muse.py mocks
    in isolation — rather than a fake in-process provider standing in for
    it (as test_agent_runner_dispatch.py does for the dispatcher contract)."""
    from farm.providers import muse

    captured = {}

    def fake_subprocess_run(cmd, **kwargs):
        captured["cmd"] = cmd
        payload = json.dumps(
            {
                "payload_type": "run.terminal.completed",
                "payload": {"terminal": "completed", "text": "muse says hi", "command_id": "cmd-1"},
            }
        )
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=payload, stderr="")

    monkeypatch.setattr(muse.subprocess, "run", fake_subprocess_run)
    monkeypatch.setenv("FARM_PROVIDER", "muse")

    reply = run_agent("say hi", session_id="fixed-session", max_turns=5, timeout_s=30)

    assert reply == {
        "result": "muse says hi",
        "session_id": "fixed-session",
        "provider": "muse",
        "command_id": "cmd-1",
    }
    # Proves the real muse.run() actually built the command (headless-safety
    # flags and all) rather than the dispatcher short-circuiting somewhere.
    assert captured["cmd"][0] == muse.FARM_MUSE_BIN
    assert "--approval-mode" in captured["cmd"]
    assert "--session-id" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--session-id") + 1] == "fixed-session"


def test_extract_json_tolerates_raw_control_characters_in_strings():
    # Real failure (HZ-21, 2026-07-31): an agent reply carried a literal
    # newline inside a JSON string; strict parsing failed the whole step.
    reply = '{"summary": "line one\nline two\ttabbed", "artifact_md": "# Plan\nbody"}'
    parsed = extract_json(reply)
    assert parsed["summary"] == "line one\nline two\ttabbed"
