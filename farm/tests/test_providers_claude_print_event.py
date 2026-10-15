"""HZ-489 guardrail: a Claude step's farm log lines stay byte-for-byte what
they were. Muse now shares the tool-input brief with Claude (it moved to
providers/base.py), so this pins Claude's _print_event output exactly."""

import claude_agent_sdk as sdk

from farm.providers import claude


class _FixedClock:
    @staticmethod
    def now():
        from datetime import datetime

        return datetime(2026, 10, 15, 12, 1, 2)


def test_claude_log_lines_are_unchanged(monkeypatch, capsys):
    monkeypatch.setattr(claude, "datetime", _FixedClock)
    long_command = "echo " + "x" * 200

    claude._print_event(
        sdk.AssistantMessage(
            content=[
                sdk.TextBlock(text="  Reading the runner first.\n"),
                sdk.ToolUseBlock(id="t1", name="Read", input={"file_path": "farm/farmd.py"}),
                sdk.ToolUseBlock(id="t2", name="Bash", input={"command": long_command}),
                sdk.ToolUseBlock(id="t3", name="Grep", input={"pattern": "def run", "path": "farm"}),
                sdk.TextBlock(text="   "),
            ],
            model="m",
        )
    )
    claude._print_event(
        sdk.ResultMessage(
            subtype="success", duration_ms=41_600, duration_api_ms=1, is_error=False, num_turns=7, session_id="s", result="{}"
        )
    )

    bash_brief = ('{"command": "' + long_command)[:157] + "…"
    assert capsys.readouterr().out.splitlines() == [
        "[12:01:02] Reading the runner first.",
        '[12:01:02] ⏺ Read({"file_path": "farm/farmd.py"})',
        f"[12:01:02] ⏺ Bash({bash_brief})",
        '[12:01:02] ⏺ Grep({"pattern": "def run", "path": "farm"})',
        "[12:01:02] ── result: 7 turn(s) in 42s ──",
    ]
