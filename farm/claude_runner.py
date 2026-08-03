"""Runs one Claude Code invocation and streams its activity to stdout.

Default path (HZ-5): the Python Agent SDK (`claude-agent-sdk`) drives the
local `claude` binary and yields typed events as the model works — each one
is printed to stdout, which IS the tmux pane (and, via farmd's pipe-pane,
the run's log file that the UI tails). Session continuity still comes from
`resume=<session_id>`; scripts stay in control of the flow.

Rollback lever: FARM_RUNNER=subprocess restores the old silent
`claude -p --output-format json` subprocess path unchanged.

Cost guardrail (HZ-5 success metric): the SDK path refuses to run when
ANTHROPIC_API_KEY is set, so every call rides the logged-in `claude`
subscription — never API billing.
"""

import asyncio
import json
import os
import subprocess
from datetime import datetime

from .config import CLAUDE_BIN, FARM_RUNNER, MAX_TURNS, STEP_TIMEOUT_S


class ClaudeError(RuntimeError):
    pass


def assert_subscription_auth() -> None:
    """Refuse to run with ANTHROPIC_API_KEY present — the farm must use the
    logged-in `claude` subscription, never metered API billing (HZ-5)."""
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        raise ClaudeError(
            "ANTHROPIC_API_KEY is set — the farm runs on the logged-in claude "
            "subscription only (HZ-5 cost guardrail). Unset it and restart the farm."
        )


def _selected_runner() -> str:
    # Read at call time so a restarted agent (or a test) can flip runners
    # without re-importing config.
    return os.environ.get("FARM_RUNNER", FARM_RUNNER)


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
    if _selected_runner() == "subprocess":
        return _run_claude_subprocess(
            prompt,
            session_id=session_id,
            append_system=append_system,
            cwd=cwd,
            model=model,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
        )

    # This runs inside the agent process (tmux pane), whose environment is
    # not farmd's — the guardrail must hold here, not just at daemon boot.
    assert_subscription_auth()
    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError as exc:
        raise ClaudeError(
            "claude-agent-sdk is not installed in this environment — "
            "run `pip install -r farm/requirements.txt` in the farm venv, "
            "or set FARM_RUNNER=subprocess to fall back to the old runner"
        ) from exc

    try:
        return asyncio.run(
            asyncio.wait_for(
                _stream_query(
                    prompt,
                    session_id=session_id,
                    append_system=append_system,
                    cwd=cwd,
                    model=model,
                    max_turns=max_turns,
                    allowed_tools=allowed_tools,
                ),
                timeout_s,
            )
        )
    except TimeoutError as exc:
        raise ClaudeError(f"claude timed out after {timeout_s}s") from exc
    except ClaudeSDKError as exc:
        # A stale `resume` session is the common recoverable failure: retry fresh.
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
        raise ClaudeError(f"claude (sdk) failed: {str(exc)[:300]}") from exc


async def _stream_query(
    prompt: str,
    *,
    session_id: str | None,
    append_system: str | None,
    cwd: str | None,
    model: str | None,
    max_turns: int,
    allowed_tools: str | None,
) -> dict:
    import claude_agent_sdk as sdk

    options = sdk.ClaudeAgentOptions(
        # The preset+append form mirrors the CLI's --append-system-prompt.
        system_prompt=(
            {"type": "preset", "preset": "claude_code", "append": append_system} if append_system else None
        ),
        cwd=cwd,
        model=model,
        max_turns=max_turns,
        # Public signature keeps the CLI's comma-joined string; the SDK wants a list.
        allowed_tools=[t.strip() for t in allowed_tools.split(",") if t.strip()] if allowed_tools else [],
        resume=session_id,
        # Same isolation as the subprocess path's --strict-mcp-config: farm
        # agents must NOT inherit the human's personal MCP servers (WhatsApp
        # etc.) from the global Claude config.
        strict_mcp_config=True,
        cli_path=CLAUDE_BIN if CLAUDE_BIN != "claude" else None,
    )

    result_text, new_session_id = "", None
    stream = sdk.query(prompt=prompt, options=options)
    try:
        async for message in stream:
            _print_event(message)
            if isinstance(message, sdk.ResultMessage):
                result_text = message.result or ""
                new_session_id = message.session_id
                if message.is_error:
                    # subtype names the cause (e.g. error_max_turns) — the
                    # result text is often empty on these, so without it the
                    # failure reads as a mystery in the UI.
                    subtype = getattr(message, "subtype", None) or "unknown"
                    detail = result_text[:300] or f"no result text (subtype: {subtype}, {message.num_turns} turns)"
                    raise ClaudeError(f"claude reported an error result [{subtype}]: {detail}")
    finally:
        # Cancellation (asyncio.wait_for timeout) lands here too: closing the
        # generator tears down the SDK's transport, killing the spawned
        # `claude` process rather than orphaning it in the tmux session.
        await stream.aclose()
    return {"result": result_text, "session_id": new_session_id}


def _print_event(message) -> None:
    """One flushed stdout line per visible event — stdout is the tmux pane,
    and pipe-pane mirrors it into the run's log file for the UI tail."""
    import claude_agent_sdk as sdk

    stamp = datetime.now().strftime("%H:%M:%S")
    if isinstance(message, sdk.AssistantMessage):
        for block in message.content:
            if isinstance(block, sdk.TextBlock) and block.text.strip():
                print(f"[{stamp}] {block.text.strip()}", flush=True)
            elif isinstance(block, sdk.ToolUseBlock):
                print(f"[{stamp}] ⏺ {block.name}({_brief(block.input)})", flush=True)
    elif isinstance(message, sdk.ResultMessage):
        print(
            f"[{stamp}] ── result: {message.num_turns} turn(s) in {message.duration_ms / 1000:.0f}s ──",
            flush=True,
        )


def _brief(tool_input) -> str:
    try:
        text = json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(tool_input)
    return text if len(text) <= 160 else text[:157] + "…"


def _run_claude_subprocess(
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
    """The pre-HZ-5 path: silent `claude -p --output-format json` subprocess."""
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
            return _run_claude_subprocess(
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
        # strict=False: models occasionally emit raw control characters
        # (literal newlines/tabs) inside JSON strings — meaningful content
        # that the strict parser rejects, failing an otherwise-good step.
        return json.loads(cleaned, strict=False)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ClaudeError(f"no JSON object in agent reply: {text[:200]}")
    return json.loads(cleaned[start : end + 1], strict=False)
