"""claude_runner against the fake binary: envelope parsing and JSON lifting."""

import pytest

from farm.claude_runner import ClaudeError, extract_json, run_claude


def test_extract_json_plain():
    assert extract_json('{"summary": "done"}') == {"summary": "done"}


def test_extract_json_fenced():
    assert extract_json('```json\n{"summary": "done"}\n```') == {"summary": "done"}


def test_extract_json_wrapped_in_prose():
    text = 'Here you go:\n{"summary": "done", "n": 2}\nHope that helps!'
    assert extract_json(text) == {"summary": "done", "n": 2}


def test_extract_json_missing_raises():
    with pytest.raises(ClaudeError):
        extract_json("no json here at all")


def test_run_claude_with_fake_binary():
    reply = run_claude('Step to perform now: "Do the thing" (attempt 1)', max_turns=4, timeout_s=30)
    assert reply["session_id"] == "fake-session-001"
    inner = extract_json(reply["result"])
    assert inner["summary"].startswith("[fake-claude] completed")
