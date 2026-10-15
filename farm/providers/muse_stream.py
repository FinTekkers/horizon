"""HZ-489: Muse's `exec --json` event stream as farm log lines.

A Claude step prints one flushed line per visible event (providers/claude.py's
_print_event); tmux pipe-pane copies them into farm-run-<item>-s<n>-a<n>.log
and the item page's agent output view shows that file as it is. This turns
Muse's JSONL events into the same lines, so a Muse step reads the same:

    [12:01:02] <agent text>
    [12:01:02] ⏺ Read({"file_path": "README.md"})
    [12:01:02] ── result: 4 turn(s) in 19s ──

What Muse 1.4.9's stream carries (recorded in
farm/tests/fixtures/muse_stream_recorded.jsonl, see docs/providers/muse-code.md):
agent text arrives as run.output.delta fragments, split anywhere, so text is
buffered until a newline, a tool line or the end of the run. A tool's input is
not sent before it runs; tool.result names the tool and carries the text the
input is read back from, so a tool line prints when the tool finishes.
"""

import json
import re
import time
from datetime import datetime

from .base import brief

# tool.result's correlation_facts.tool_name -> the name the log shows. Bash,
# Read, Write and Edit are Claude's names too. Muse has one search tool, shown
# as Search, where a Claude step logs Grep or Glob.
TOOL_NAMES = {
    "bash": "Bash",
    "read_file": "Read",
    "search": "Search",
    "write_file": "Write",
    "edit_file": "Edit",
    "apply_patch": "Edit",
    "web_fetch": "WebFetch",
    "web_search": "WebSearch",
}

_READ_RE = re.compile(r"^Read text file `([^`]+)`")


def _stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class LineRenderer:
    """Feed it each event in order; it returns the finished lines to print.
    Keeps the partial agent text between events."""

    def __init__(self, *, stamp=_stamp, monotonic=time.monotonic):
        self._stamp = stamp
        self._monotonic = monotonic
        self._started = monotonic()
        self._text = ""
        self._turns = 0

    def feed(self, event) -> list[str]:
        if not isinstance(event, dict) or not isinstance(event.get("payload_type"), str):
            return []
        payload_type = event["payload_type"]
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if payload_type == "run.output.delta":
            text = payload.get("text")
            if not isinstance(text, str):
                return []
            *done, self._text = (self._text + text).split("\n")
            return [self._line(t) for t in done if t.strip()]
        if payload_type == "task.lifecycle.proposed":
            task = payload.get("event") if isinstance(payload.get("event"), dict) else {}
            # One model call is one turn: what --max-model-steps counts.
            if str(task.get("task_kind", "")).startswith("model."):
                self._turns += 1
            return []
        if payload_type == "tool.result":
            return self.flush() + [self._tool_line(payload)]
        if payload_type.startswith("run.terminal."):
            elapsed = self._monotonic() - self._started
            return self.flush() + [self._line(f"── result: {self._turns} turn(s) in {elapsed:.0f}s ──")]
        return []

    def flush(self) -> list[str]:
        """The agent text still waiting for its newline. Called at a tool line,
        at the end of the run, and when the run is killed or fails."""
        text, self._text = self._text, ""
        return [self._line(text)] if text.strip() else []

    def _line(self, text: str) -> str:
        return f"[{self._stamp()}] {text.strip()}"

    def _tool_line(self, payload: dict) -> str:
        facts = payload.get("correlation_facts") if isinstance(payload.get("correlation_facts"), dict) else {}
        tool = facts.get("tool_name") if isinstance(facts.get("tool_name"), str) else "tool"
        text = payload.get("text") if isinstance(payload.get("text"), str) else ""
        return self._line(f"⏺ {TOOL_NAMES.get(tool, tool)}({brief(_tool_input(tool, text))})")


def _tool_input(tool: str, text: str) -> dict:
    """The tool's input, read back from its result text. Muse's search result
    holds only the hits, not the query, so Search shows the first hit."""
    if tool == "bash":
        try:
            shell = json.loads(text)
        except json.JSONDecodeError:
            shell = None
        if isinstance(shell, dict) and isinstance(shell.get("command"), str):
            return {k: shell[k] for k in ("command", "description") if isinstance(shell.get(k), str)}
    if tool == "read_file" and (m := _READ_RE.match(text)):
        return {"file_path": m.group(1)}
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return {"result": first}
