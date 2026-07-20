"""Runs one Claude Code invocation as a controlled subprocess.

We deliberately drive the CLI (`claude -p --output-format json`) rather than
an interactive session: scripts stay in control of the flow, and session
continuity comes from `--resume <session_id>` — the PM agent persists its
session id per project, giving a "long-running" agent whose every step is
still a bounded, observable subprocess.
"""

import json
import subprocess

from .config import CLAUDE_BIN, MAX_TURNS, STEP_TIMEOUT_S


class ClaudeError(RuntimeError):
    pass


def run_claude(
    prompt: str,
    *,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int = MAX_TURNS,
    timeout_s: int = STEP_TIMEOUT_S,
    allowed_tools: str | None = None,
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>}."""
    # --strict-mcp-config: farm agents must NOT inherit the human's personal
    # MCP servers (WhatsApp etc.) from the global Claude config — least
    # privilege, faster startup, no personal tools in agent context.
    cmd = [CLAUDE_BIN, "-p", prompt, "--output-format", "json", "--max-turns", str(max_turns), "--strict-mcp-config"]
    if session_id:
        cmd += ["--resume", session_id]
    if append_system:
        cmd += ["--append-system-prompt", append_system]
    if model:
        cmd += ["--model", model]
    if allowed_tools:
        cmd += ["--allowedTools", allowed_tools]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, cwd=cwd)
    except subprocess.TimeoutExpired as exc:
        raise ClaudeError(f"claude timed out after {timeout_s}s") from exc
    except FileNotFoundError as exc:
        raise ClaudeError(f"claude binary not found: {CLAUDE_BIN}") from exc

    if proc.returncode != 0:
        # A stale --resume session is the common recoverable failure: retry fresh.
        if session_id:
            return run_claude(
                prompt,
                session_id=None,
                append_system=append_system,
                cwd=cwd,
                model=model,
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=allowed_tools,
            )
        raise ClaudeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:300]}")

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ClaudeError(f"claude produced non-JSON output: {proc.stdout[:200]}") from exc

    return {"result": data.get("result", ""), "session_id": data.get("session_id")}


def extract_json(text: str) -> dict:
    """Lift a JSON object out of a model reply (tolerates fences/prose)."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ClaudeError(f"no JSON object in agent reply: {text[:200]}")
    return json.loads(cleaned[start : end + 1])
