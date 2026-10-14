"""The Claude provider (HZ-5, moved verbatim under the provider seam by HZ-83).

Default path: the Python Agent SDK (`claude-agent-sdk`) drives the local
`claude` binary and yields typed events as the model works — each one is
printed to stdout, which IS the tmux pane (and, via farmd's pipe-pane, the
run's log file that the UI tails). Session continuity still comes from
`resume=<session_id>`; scripts stay in control of the flow.

Rollback lever: FARM_RUNNER=subprocess restores the old silent
`claude -p --output-format json` subprocess path unchanged. This is
independent of FARM_PROVIDER (farm/agent_runner.py) — it only chooses how
*this* provider talks to `claude`, not which provider runs.

Cost guardrail (HZ-5 success metric): refuses to run when ANTHROPIC_API_KEY
is set, unless metered billing is explicitly opted in with an enforced cap
(HZ-83 — see farm/providers/base.py) — every call otherwise rides the
logged-in `claude` subscription, never API billing.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime

from domain.py import reasons

from ..config import CLAUDE_BIN, FARM_RUNNER, MAX_TURNS, STEP_TIMEOUT_S
from ..credentials import without_gate_credentials
from .base import (
    AgentError,
    AgentExhaustedError,
    AgentMessageTooLargeError,
    assert_metered_billing_authorized,
    decode_partial,
    metered_billing_opted_in,
)

SUPPORTS_RESUME = True
# HZ-158: yes — see AgentExhaustedError's docstring in providers/base.py.
RESUMES_AFTER_EXHAUSTION = True
# HZ-447: --disallowedTools / disallowed_tools are passed through on both paths.
ENFORCES_DENY_RULES = True

# HZ-424: the SDK reads each CLI message into a buffer capped at 1 MB by
# default; one Read of a full-page screenshot overflows it and the reader dies.
# 16 MB fits those, and the env override is bounded so a typo can't remove the cap.
SDK_MAX_BUFFER_DEFAULT_BYTES = 16 * 1024 * 1024
SDK_MAX_BUFFER_CEILING_BYTES = 64 * 1024 * 1024
SDK_MAX_BUFFER_ENV = "FARM_SDK_MAX_BUFFER_BYTES"
# The SDK's own wording for the overflow (claude-agent-sdk's subprocess
# transport). The only error that maps to sdk_message_too_large.
_BUFFER_OVERFLOW_PHRASE = "exceeded maximum buffer size"
_BUFFER_SIZE_RE = re.compile(r"Buffer size (\d+) exceeds limit")


def sdk_max_buffer_bytes() -> int:
    """The SDK reader's per-message cap in bytes. Read at call time, like
    _selected_runner(). A value that isn't an integer in 1..64 MB falls back to
    the 16 MB default with one warning on stderr."""
    raw = os.environ.get(SDK_MAX_BUFFER_ENV)
    if raw is None or not raw.strip():
        return SDK_MAX_BUFFER_DEFAULT_BYTES
    try:
        value = int(raw.strip())
    except ValueError:
        value = None
    if value is None or not 0 < value <= SDK_MAX_BUFFER_CEILING_BYTES:
        shown = raw if len(raw) <= 32 else raw[:32] + "…"
        print(
            f"warning: {SDK_MAX_BUFFER_ENV}={shown!r} is not an integer in 1..{SDK_MAX_BUFFER_CEILING_BYTES}; "
            f"using the default {SDK_MAX_BUFFER_DEFAULT_BYTES} bytes",
            file=sys.stderr,
            flush=True,
        )
        return SDK_MAX_BUFFER_DEFAULT_BYTES
    return value


def _is_buffer_overflow(exc: BaseException) -> bool:
    """Whether exc is the SDK reader's buffer overflow. The SDK raises it as
    CLIJSONDecodeError, or as a plain Exception when it flattens the reader's
    error; only the wording tells it apart from a malformed line."""
    return _BUFFER_OVERFLOW_PHRASE in str(exc)


def _too_large(exc: BaseException, limit: int) -> AgentMessageTooLargeError:
    """A one-line error built from scratch: the SDK's text can carry the start
    of the oversized line (image data), so none of it is copied — only the
    sizes, which the SDK reports as numbers."""
    size = None
    original = getattr(exc, "original_error", None)
    match = _BUFFER_SIZE_RE.search(str(original)) if original is not None else None
    if match:
        size = int(match.group(1))
    sized = f" ({size} bytes)" if size is not None else ""
    return AgentMessageTooLargeError(
        f"{reasons.REASON['SDK_MESSAGE_TOO_LARGE']}: an SDK message{sized} exceeded the {limit}-byte reader limit "
        f"({SDK_MAX_BUFFER_ENV})"
    )


def assert_subscription_auth() -> None:
    """Refuse to run with ANTHROPIC_API_KEY present — the farm must use the
    logged-in `claude` subscription, never metered API billing (HZ-5) —
    unless FARM_ALLOW_METERED_BILLING opts in with an enforced spend cap
    (HZ-83)."""
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return
    if not metered_billing_opted_in():
        raise AgentError(
            "ANTHROPIC_API_KEY is set — the farm runs on the logged-in claude "
            "subscription only (HZ-5 cost guardrail). Unset it and restart the farm, or opt "
            "in explicitly with FARM_ALLOW_METERED_BILLING=1 plus an enforced "
            "FARM_METERED_SPEND_CAP_USD (HZ-83)."
        )
    assert_metered_billing_authorized("claude")


def _selected_runner() -> str:
    # Read at call time so a restarted agent (or a test) can flip runners
    # without re-importing config.
    return os.environ.get("FARM_RUNNER", FARM_RUNNER)


def run(
    prompt: str,
    *,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int = MAX_TURNS,
    timeout_s: int = STEP_TIMEOUT_S,
    allowed_tools: str | None = None,
    retry_fresh: bool = True,
    disallowed_tools: str | None = None,
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>}.

    retry_fresh=False (HZ-158) turns off the stale-resume fallback below: a
    failed resume raises AgentError instead of silently starting a second,
    fresh session. The handoff note uses it, since it must be exactly one
    model call on the session that ran out."""
    if _selected_runner() == "subprocess":
        return _run_subprocess(
            prompt,
            session_id=session_id,
            append_system=append_system,
            cwd=cwd,
            model=model,
            max_turns=max_turns,
            timeout_s=timeout_s,
            allowed_tools=allowed_tools,
            retry_fresh=retry_fresh,
            disallowed_tools=disallowed_tools,
        )

    # This runs inside the agent process (tmux pane), whose environment is
    # not farmd's — the guardrail must hold here, not just at daemon boot.
    assert_subscription_auth()
    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError as exc:
        raise AgentError(
            "claude-agent-sdk is not installed in this environment — "
            "run `pip install -r farm/requirements.txt` in the farm venv, "
            "or set FARM_RUNNER=subprocess to fall back to the old runner"
        ) from exc

    # What the stream saw before it stopped — the only record a timeout
    # leaves, since wait_for cancels _stream_query before it can return.
    seen: dict = {"session_id": None, "text": None}
    buffer_limit = sdk_max_buffer_bytes()
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
                    disallowed_tools=disallowed_tools,
                    seen=seen,
                    max_buffer_size=buffer_limit,
                ),
                timeout_s,
            )
        )
    except TimeoutError as exc:
        raise AgentExhaustedError(
            f"claude timed out after {timeout_s}s",
            partial_text=seen["text"],
            session_id=seen["session_id"] or session_id,
        ) from exc
    except ClaudeSDKError as exc:
        # HZ-424: checked before the stale-resume fallback, so an overflow on
        # a resumed session reports its reason instead of re-running fresh.
        # `from None`: the SDK error's text can hold the oversized line.
        if _is_buffer_overflow(exc):
            raise _too_large(exc, buffer_limit) from None
        # A stale `resume` session is the common recoverable failure: retry fresh.
        if session_id and retry_fresh:
            return run(
                prompt,
                session_id=None,
                append_system=append_system,
                cwd=cwd,
                model=model,
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=allowed_tools,
                disallowed_tools=disallowed_tools,
            )
        raise AgentError(f"claude (sdk) failed: {str(exc)[:300]}") from exc
    except Exception as exc:
        # The SDK may flatten the reader's error to a bare Exception; anything
        # but the overflow (our own AgentErrors included) passes through untouched.
        if not isinstance(exc, AgentError) and _is_buffer_overflow(exc):
            raise _too_large(exc, buffer_limit) from None
        raise


async def _stream_query(
    prompt: str,
    *,
    session_id: str | None,
    append_system: str | None,
    cwd: str | None,
    model: str | None,
    max_turns: int,
    allowed_tools: str | None,
    disallowed_tools: str | None = None,
    seen: dict | None = None,
    max_buffer_size: int | None = None,
) -> dict:
    import claude_agent_sdk as sdk

    seen = seen if seen is not None else {}

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
        # HZ-447: deny rules win over allow rules; no bypass permission mode is set.
        disallowed_tools=[t.strip() for t in disallowed_tools.split(",") if t.strip()] if disallowed_tools else [],
        resume=session_id,
        # Same isolation as the subprocess path's --strict-mcp-config: farm
        # agents must NOT inherit the human's personal MCP servers (WhatsApp
        # etc.) from the global Claude config.
        strict_mcp_config=True,
        cli_path=CLAUDE_BIN if CLAUDE_BIN != "claude" else None,
        max_buffer_size=max_buffer_size if max_buffer_size is not None else sdk_max_buffer_bytes(),
    )

    result_text, new_session_id = "", None
    stream = sdk.query(prompt=prompt, options=options)
    try:
        async for message in stream:
            _print_event(message)
            if isinstance(message, sdk.SystemMessage) and message.subtype == "init":
                # The session id arrives here first; a timeout before the
                # ResultMessage has no other source for it.
                data = message.data if isinstance(message.data, dict) else {}
                seen["session_id"] = data.get("session_id") or seen.get("session_id")
            elif isinstance(message, sdk.AssistantMessage):
                text = "".join(b.text for b in message.content if isinstance(b, sdk.TextBlock))
                if text.strip():
                    seen["text"] = text
            if isinstance(message, sdk.ResultMessage):
                result_text = message.result or ""
                new_session_id = message.session_id
                if message.is_error:
                    # subtype names the cause (e.g. error_max_turns) — the
                    # result text is often empty on these, so without it the
                    # failure reads as a mystery in the UI.
                    subtype = getattr(message, "subtype", None) or "unknown"
                    detail = result_text[:300] or f"no result text (subtype: {subtype}, {message.num_turns} turns)"
                    if subtype == "error_max_turns":
                        raise AgentExhaustedError(
                            f"claude reported an error result [{subtype}]: {detail}",
                            # The result text is usually empty here; the last
                            # assistant text is then the reply in progress.
                            partial_text=result_text or seen.get("text"),
                            session_id=new_session_id or seen.get("session_id"),
                        )
                    raise AgentError(f"claude reported an error result [{subtype}]: {detail}")
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


def _run_subprocess(
    prompt: str,
    *,
    session_id: str | None = None,
    append_system: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int = MAX_TURNS,
    timeout_s: int = STEP_TIMEOUT_S,
    allowed_tools: str | None = None,
    retry_fresh: bool = True,
    disallowed_tools: str | None = None,
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
    if disallowed_tools:
        cmd += ["--disallowedTools", disallowed_tools]

    try:
        # HZ-140: the model never gets a gate-approving credential, whichever
        # process is running it. env= replaces the child's environment outright,
        # so this holds even in the concierge, the one session granted one.
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=cwd,
            env=without_gate_credentials(),
        )
    except subprocess.TimeoutExpired as exc:
        # --output-format json writes nothing until the run ends, so stdout is
        # usually empty here, and the new session id is unknown — the resumed
        # one, if any, is the best there is.
        raise AgentExhaustedError(
            f"claude timed out after {timeout_s}s",
            partial_text=decode_partial(exc.stdout),
            session_id=session_id,
        ) from exc
    except FileNotFoundError as exc:
        raise AgentError(f"claude binary not found: {CLAUDE_BIN}") from exc

    if proc.returncode != 0:
        # A stale --resume session is the common recoverable failure: retry fresh.
        if session_id and retry_fresh:
            return _run_subprocess(
                prompt,
                session_id=None,
                append_system=append_system,
                cwd=cwd,
                model=model,
                max_turns=max_turns,
                timeout_s=timeout_s,
                allowed_tools=allowed_tools,
                disallowed_tools=disallowed_tools,
            )
        raise AgentError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:300]}")

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AgentError(f"claude produced non-JSON output: {proc.stdout[:200]}") from exc

    return {"result": data.get("result", ""), "session_id": data.get("session_id")}
