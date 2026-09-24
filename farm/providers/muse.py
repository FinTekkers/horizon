"""The Muse Code provider (HZ-83): shells out to `muse exec --json`, parses
the JSONL event stream on stdout, and returns the same {"result",
"session_id"} shape run_agent() promises regardless of provider.

Verified against Muse Code 1.3.0 on this host — see docs/providers/muse-code.md,
the spec every claim below is checked against. Where that doc says a
behaviour is unverified, this module says so too instead of guessing.
"""

import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from ..config import FARM_MUSE_BIN, MAX_TURNS, STEP_TIMEOUT_S
from .base import AgentError, AgentExhaustedError

# `muse exec --session-id <UUID>` genuinely carries context across calls
# (verified: two separate processes sharing one id, see the vendor doc) —
# unlike Claude, the id is caller-supplied, not echoed back.
SUPPORTS_RESUME = True


def assert_subscription_auth() -> None:
    """Muse has no `account status` command (unverified per
    docs/providers/muse-code.md — confirmed there is no `account` subcommand
    at all), so there is nothing to query here. What holds the HZ-5
    guarantee instead: this module never wires up Muse's metered-credential
    flags (`--api-key-stdin` / `auth set --api-key-stdin`) anywhere in run()
    below — there is no code path from a farm-triggered run to metered
    billing on Muse, refused by absence rather than a comment."""


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
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>}.

    allowed_tools is accepted (same public signature as every provider) but
    has no effect: Muse's CLI exposes no tool-restriction flag equivalent to
    Claude's --allowedTools (verified absent from docs/providers/muse-code.md's
    flag table). Callers that need enforced tool restriction must run those
    steps on a provider that supports it.
    """
    sid = session_id or str(uuid.uuid4())
    full_prompt = f"{append_system}\n\n{prompt}" if append_system else prompt

    prompt_fd, prompt_path = tempfile.mkstemp(prefix="horizon-muse-prompt-", suffix=".txt")
    try:
        with os.fdopen(prompt_fd, "w") as f:
            f.write(full_prompt)

        cmd = [
            FARM_MUSE_BIN,
            "exec",
            "--json",
            "--session-id",
            sid,
            "--prompt-file",
            prompt_path,
            "--max-model-steps",
            str(max_turns),
            # Headless-safety (docs/providers/muse-code.md): --approval-mode
            # defaults to on-request and blocks forever waiting on a human
            # that will never answer a farm-launched run; --user-input-auto-
            # resolve auto-cancels anything left over instead of hanging.
            "--approval-mode",
            "never",
            "--user-input-auto-resolve",
            # The farm always runs agents inside its own per-item git
            # worktree; Muse otherwise treats a fresh directory as untrusted
            # and disables agent delegation for it (observed on stderr).
            "--trust-workspace",
        ]
        if model:
            cmd += ["--model", model]

        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, cwd=cwd)
        except subprocess.TimeoutExpired as exc:
            raise AgentExhaustedError(f"muse timed out after {timeout_s}s") from exc
        except FileNotFoundError as exc:
            raise AgentError(f"muse binary not found: {FARM_MUSE_BIN}") from exc
    finally:
        Path(prompt_path).unlink(missing_ok=True)

    return _parse_events(proc, sid)


def _parse_events(proc: subprocess.CompletedProcess, session_id: str) -> dict:
    events = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    terminal = next((e for e in events if e.get("payload_type") == "run.terminal.completed"), None)
    if terminal is not None:
        return {"result": terminal.get("payload", {}).get("text", ""), "session_id": session_id}

    # ASSUMPTION — unverified per docs/providers/muse-code.md ("how
    # exhaustion is reported... unverified... no exhausting run was
    # observed"): treat any terminal payload_type naming exhaustion as the
    # --max-model-steps analogue of Claude's error_max_turns. This needs
    # confirming against a real exhausting Muse run; file a follow-up if it
    # proves wrong.
    exhausted = next((e for e in events if "exhaust" in e.get("payload_type", "")), None)
    if exhausted is not None:
        raise AgentExhaustedError(f"muse reported exhaustion: {exhausted.get('payload_type')}")

    if proc.returncode != 0:
        raise AgentError(f"muse exited {proc.returncode}: {proc.stderr.strip()[:300]}")
    raise AgentError(f"muse produced no terminal.completed event: {proc.stdout[:300]}")
