"""The Muse Code provider (HZ-83): shells out to `muse exec --json`, parses
the JSONL event stream on stdout, and returns the same {"result",
"session_id"} shape run_agent() promises regardless of provider.

Verified against Muse Code 1.3.0 on this host — see docs/providers/muse-code.md,
the spec every claim below is checked against. Where that doc says a
behaviour is unverified, this module says so too instead of guessing.
"""

import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from ..config import FARM_MUSE_BIN, MAX_TURNS, STEP_TIMEOUT_S
from ..credentials import without_gate_credentials
from .base import AgentError, AgentExhaustedError, AgentUsageLimitedError, decode_partial, reset_from_text
from .muse_stream import LineRenderer

# `muse exec --session-id <UUID>` genuinely carries context across calls
# (verified: two separate processes sharing one id, see the vendor doc) —
# unlike Claude, the id is caller-supplied, not echoed back.
SUPPORTS_RESUME = True
# HZ-158: no (unverified, treated as no) — continuity is verified only between
# completed runs; see AgentExhaustedError's docstring in providers/base.py.
RESUMES_AFTER_EXHAUSTION = False


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
    retry_fresh: bool = True,
) -> dict:
    """Returns {"result": <final text>, "session_id": <id>}.

    retry_fresh is accepted for the same reason and ignored: this provider
    never falls back to a fresh session, so there is nothing to turn off.

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
            # HZ-102 sandbox guardrail, decided deliberately: --disable-sandbox
            # and --sandbox-network are never passed. Muse's sandbox network
            # defaults to proxy-only (docs/providers/muse-code.md), but that
            # only governs network calls made from *inside* Muse's own
            # sandbox; nothing this provider runs needs that. The call to the
            # Horizon server happens outside the sandbox entirely — farm/
            # step_agent.py's own process posts the result via httpx after
            # this subprocess has already exited. So the minimum needed for a
            # headless run to reach the Horizon server is nothing: no
            # sandbox flag is relaxed here.
        ]
        if model:
            cmd += ["--model", model]

        try:
            # HZ-140: same scrub as the claude provider — no model subprocess
            # is ever handed a credential that could approve a gate.
            proc = _stream(cmd, timeout=timeout_s, cwd=cwd, env=without_gate_credentials())
        except subprocess.TimeoutExpired as exc:
            # The captured stdout is the JSONL event stream so far, not prose —
            # carried raw; a salvage of it fails closed.
            raise AgentExhaustedError(
                f"muse timed out after {timeout_s}s", partial_text=decode_partial(exc.output), session_id=sid
            ) from exc
        except FileNotFoundError as exc:
            raise AgentError(f"muse binary not found: {FARM_MUSE_BIN}") from exc
    finally:
        Path(prompt_path).unlink(missing_ok=True)

    return _parse_events(proc, sid)


# How long to wait for the stdout/stderr readers once muse has exited or been
# killed. A grandchild that kept a pipe open must not hang the step.
_READER_GRACE_S = 5


def _stream(cmd: list[str], *, timeout: int, cwd: str | None, env: dict) -> subprocess.CompletedProcess:
    """HZ-489: runs muse as subprocess.run with capture_output and text would,
    and prints each event as a farm log line the moment it arrives (stdout is
    the tmux pane; pipe-pane copies it into the run's log file). Returns the
    whole stdout and stderr, so _parse_events reads the run as before. Once
    its time budget is spent it kills muse and raises
    subprocess.TimeoutExpired with the stdout so far as .output, as
    subprocess.run does.

    Both pipes are read on their own threads: stdout into a queue the loop
    waits on with a deadline, so a silent muse or a half-written line can't
    stall the deadline, and stderr into a buffer, so a full stderr pipe can't
    block muse."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=cwd,
        env=env,
    )
    lines: queue.Queue = queue.Queue()
    stderr: list[str] = []
    readers = [
        threading.Thread(target=_read_lines, args=(proc.stdout, lines), daemon=True),
        threading.Thread(target=lambda: stderr.append(proc.stderr.read()), daemon=True),
    ]
    for reader in readers:
        reader.start()

    renderer = LineRenderer()
    stdout: list[str] = []
    deadline = time.monotonic() + timeout
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise subprocess.TimeoutExpired(cmd, timeout)
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                continue
            if line is None:
                break
            stdout.append(line)
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            _print_lines(renderer.feed(event))
        proc.wait(timeout=max(deadline - time.monotonic(), 0))
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        _print_lines(renderer.flush())
        raise subprocess.TimeoutExpired(cmd, timeout, output="".join(stdout)) from None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for reader in readers:
            reader.join(_READER_GRACE_S)
    _print_lines(renderer.flush())
    return subprocess.CompletedProcess(cmd, proc.returncode, "".join(stdout), "".join(stderr))


def _read_lines(pipe, lines: queue.Queue) -> None:
    """Every line of `pipe` onto `lines`, then None at end of file."""
    try:
        for line in pipe:
            lines.put(line)
    finally:
        lines.put(None)


def _print_lines(lines: list[str]) -> None:
    for line in lines:
        print(line, flush=True)


# HZ-422: Muse's usage-limit refusal, e.g. "429 Subscription quota exhausted.
# Your usage window resets at <time>" (SH-3, 12 Oct; its time was cut off).
_LIMIT_STATUS_RE = re.compile(r"\b429\b")
_LIMIT_WORDS_RE = re.compile(r"quota|rate[ _-]?limit", re.IGNORECASE)


def _usage_limit(text: str) -> AgentUsageLimitedError | None:
    """The usage-limit error `text` reports, or None. Called on the whole
    stderr and stdout, before anything is cut to 300 chars, so the reset time
    survives. A reset time that is missing or unparseable is None."""
    if not text or not _LIMIT_STATUS_RE.search(text) or not _LIMIT_WORDS_RE.search(text):
        return None
    line = next((ln.strip() for ln in text.splitlines() if _LIMIT_STATUS_RE.search(ln)), text.strip())
    return AgentUsageLimitedError(f"muse usage limit: {line[:300]}", reset_at=reset_from_text(text))


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
        payload = terminal.get("payload", {})
        command_id = payload.get("command_id")
        # HZ-102 success metric: provenance requires a non-empty command_id
        # from this exact event. Do not use it as a session handle (that's
        # --session-id) — this only identifies the one run, which is exactly
        # what provenance needs. A terminal event without one means the
        # event shape docs/providers/muse-code.md verified no longer holds —
        # fail loudly rather than silently recording provenance-less output.
        if not isinstance(command_id, str) or not command_id.strip():
            raise AgentError(
                "muse run.terminal.completed event is missing command_id — cannot record "
                "provenance for this run"
            )
        return {"result": payload.get("text", ""), "session_id": session_id, "command_id": command_id}

    limited = _usage_limit(proc.stderr)
    if limited is not None:
        raise limited

    # ASSUMPTION — unverified per docs/providers/muse-code.md ("how
    # exhaustion is reported... unverified... no exhausting run was
    # observed"): treat any terminal payload_type naming exhaustion as the
    # --max-model-steps analogue of Claude's error_max_turns. This needs
    # confirming against a real exhausting Muse run; file a follow-up if it
    # proves wrong.
    exhausted = next((e for e in events if "exhaust" in e.get("payload_type", "")), None)
    if exhausted is not None:
        payload = exhausted.get("payload")
        text = payload.get("text") if isinstance(payload, dict) else None
        raise AgentExhaustedError(
            f"muse reported exhaustion: {exhausted.get('payload_type')}",
            partial_text=text if isinstance(text, str) and text else None,
            session_id=session_id,
        )

    # The event stream is read only once no exhaustion explains the stop: an
    # agent's own text may mention a 429.
    limited = _usage_limit(proc.stdout)
    if limited is not None:
        raise limited
    if proc.returncode != 0:
        raise AgentError(f"muse exited {proc.returncode}: {proc.stderr.strip()[:300]}")
    raise AgentError(f"muse produced no terminal.completed event: {proc.stdout[:300]}")
