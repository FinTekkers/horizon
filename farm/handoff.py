"""Handoff note from a step attempt that ran out of turns (HZ-158).

When a step exhausts its budget, step_agent asks the exhausted session for
one short note for the next attempt, and writes it under STATE_DIR — the only
state that outlives an attempt for a step with no workspace. The next attempt
of the same item and step reads it into its prompt, labelled UNVERIFIED.

The guardrails this module holds:

* exactly one model call, on the exhaustion path only, never retried — a
  HandoffGuard is claimed before the call, and a failed resume never falls
  back to a fresh session (retry_fresh=False);
* read-only tools, so a resumed implement session cannot edit the tree after
  _salvage_checkpoint() committed it;
* never raising into the caller: any failure falls back to a note built from
  the exhausted run's partial text, with no model call;
* never running past the step's own time budget (HandoffContext.deadline) —
  so a timed-out run, which has used all of it, always gets the mechanical
  note.
"""

import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .agent_runner import provider_resumes_after_exhaustion, run_agent
from .config import STATE_DIR
from .providers.base import AgentExhaustedError

HANDOFF_DIR = STATE_DIR / "handoff"
# Smaller than every step's budget (steps.budget_for_label) — a test pins it.
HANDOFF_MAX_TURNS = 3
HANDOFF_TIMEOUT_S = 180
# The handoff must fit inside the step's OWN time budget: the server's
# execution watchdog allows only a little over it (e.g. 1200s against a 1140s
# planning step), and a run it times out loses its turn-cap report. Below this
# much time left there is no model call, only a mechanical note.
HANDOFF_MIN_TIMEOUT_S = 30
HANDOFF_TOOLS = "Read,Glob,Grep"
NOTE_MAX_CHARS = 4000
# How much of the exhausted reply a mechanical note keeps — its tail, where
# the run was when it stopped.
MECHANICAL_TAIL_CHARS = 1500
GIT_TIMEOUT_S = 30

HANDOFF_PROMPT = (
    "You have run out of turns for this step, and this session will end after this reply. "
    "A fresh attempt will redo the step from the start. Write a short handoff note for it, in "
    "plain markdown, not JSON: what you established, what you decided and why, what is left, "
    "and anything you found that would save it time. Do not use any tools and do not try to "
    "finish the step. Keep it under 300 words."
)


@dataclass(frozen=True)
class HandoffContext:
    """Who the exhausted call was, so the handoff resumes it as the same
    agent, persona and role. The provider comes from the exception itself
    (AgentExhaustedError.provider), i.e. whichever one actually ran.

    deadline is a time.monotonic() value: the exhausted call's start plus its
    timeout_s. The handoff call never runs past it."""

    item_id: str
    step: str
    agent: str
    persona: str | None
    append_system: str | None
    cwd: str | None
    deadline: float
    provider_locked: bool = False


class HandoffGuard:
    """One per step run. claim() is True exactly once, and is called BEFORE
    the handoff runs, so not even a crash inside it can let it fire again."""

    def __init__(self) -> None:
        self.fired = False

    def claim(self) -> bool:
        if self.fired:
            return False
        self.fired = True
        return True


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] handoff: {msg}", flush=True)


def mechanical_note(partial_text: str | None, ws: Path | None) -> str:
    """The note built without a model: the tail of the reply in progress, plus
    the workspace's uncommitted changes when there is one."""
    parts = []
    tail = (partial_text or "").strip()[-MECHANICAL_TAIL_CHARS:]
    if tail:
        parts.append(f"The previous attempt's reply in progress ended with:\n\n```\n{tail}\n```")
    else:
        parts.append("The previous attempt ran out of turns before writing any reply text.")
    if ws is not None:
        try:
            stat = subprocess.run(
                ["git", "-C", str(ws), "diff", "--stat", "HEAD"],
                capture_output=True,
                text=True,
                timeout=GIT_TIMEOUT_S,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError) as exc:
            stat = ""
            _log(f"git diff --stat failed ({exc}) — note has no workspace summary")
        if stat:
            parts.append(f"Uncommitted changes it left in the workspace:\n\n```\n{stat}\n```")
    return "\n\n".join(parts)


def request_note(exc: AgentExhaustedError, ctx: HandoffContext, ws: Path | None = None) -> str:
    """The handoff note: ONE resumed call on the exhausted session, or a
    mechanical note when that session cannot be resumed or the call fails.
    Never raises for a model failure, and never retries."""
    if not exc.session_id:
        _log("no session id to resume — writing a mechanical note")
        return mechanical_note(exc.partial_text, ws)
    if not provider_resumes_after_exhaustion(exc.provider):
        _log(f"provider {exc.provider!r} cannot resume an exhausted session — writing a mechanical note")
        return mechanical_note(exc.partial_text, ws)
    timeout_s = min(HANDOFF_TIMEOUT_S, int(ctx.deadline - time.monotonic()))
    if timeout_s < HANDOFF_MIN_TIMEOUT_S:
        _log("the step's time budget is spent — writing a mechanical note")
        return mechanical_note(exc.partial_text, ws)
    try:
        reply = run_agent(
            HANDOFF_PROMPT,
            agent=ctx.agent,
            step=ctx.step,
            persona=ctx.persona,
            session_id=exc.session_id,
            append_system=ctx.append_system,
            cwd=ctx.cwd,
            max_turns=HANDOFF_MAX_TURNS,
            timeout_s=timeout_s,
            allowed_tools=HANDOFF_TOOLS,
            provider=exc.provider,
            provider_locked=ctx.provider_locked,
            retry_fresh=False,
        )
    except Exception as err:  # any failure, including a second exhaustion
        _log(f"the handoff call failed ({type(err).__name__}: {str(err)[:200]}) — writing a mechanical note")
        return mechanical_note(exc.partial_text, ws)
    text = str(reply.get("result") or "").strip()
    if not text:
        _log("the handoff call returned no text — writing a mechanical note")
        return mechanical_note(exc.partial_text, ws)
    return text


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "x"


def note_path(item_id: str, step: str) -> Path:
    return HANDOFF_DIR / f"{_slug(item_id)}--{_slug(step)}.md"


def write_note(item_id: str, step: str, text: str) -> None:
    """Best-effort: a note that cannot be written is logged, never raised —
    the caller's exhaustion is what must propagate."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = f"_Written {stamp}._\n\n{text.strip()[:NOTE_MAX_CHARS]}\n"
    path = note_path(item_id, step)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(body)
        tmp.replace(path)
        _log(f"wrote the note for the next attempt to {path}")
    except OSError as err:
        _log(f"could not write the note to {path} ({err}) — the next attempt starts without one")


def read_note(item_id: str, step: str) -> str | None:
    try:
        text = note_path(item_id, step).read_text().strip()
    except OSError:
        return None
    return text[: NOTE_MAX_CHARS + 100] or None


def clear_note(item_id: str, step: str) -> None:
    try:
        note_path(item_id, step).unlink(missing_ok=True)
    except OSError as err:
        _log(f"could not remove the note ({err})")
