# Can a session that ended `error_max_turns` be resumed? (HZ-124 metric 12)

**Provisionally yes — but unverified against a real exhausting run, so a
mechanical fallback ships regardless of the answer.**

## The reasoning

`max_turns`/`--max-turns` (farm/providers/claude.py) is documented and
observed to be a **per-call** budget, not a session-lifetime counter — every
call to `claude_agent_sdk.query()` / `claude -p` takes its own `max_turns`,
and `resume=<session_id>` only restores conversation history, nothing about
turns already spent. `claude.py`'s existing stale-session retry
(`ClaudeSDKError` / non-zero exit with `session_id` set -> retry fresh) already
depends on `resume=` working in the ordinary case, and there is no code in
the SDK or CLI that flags a session as permanently unresumable once one call
against it ends in `error_max_turns`.

## Why "provisionally," not "confirmed"

Nothing in this repository has driven a real exhausting Claude run through a
second, resumed call — every `error_max_turns` test in
`farm/tests/test_agent_runner_sdk.py` mocks `claude_agent_sdk.query` and only
proves this module's own message-shape handling, not the real SDK/CLI's
behaviour on an actual resume-after-exhaustion. Confirming this needs a real
`claude` binary run past its turn cap and then resumed — not done here.

## What ships regardless

Because the answer is unverified, HZ-124's cross-attempt handoff (metric 11)
is **always a plain-text file** under `STATE_DIR`
(`farm/agent_runner.py`'s `_write_handoff_note()` /
`read_and_clear_handoff_note()`), never a resumed session standing in for
persistence. `agent_runner._fire_handoff()` does optimistically pass
`session_id=exc.session_id` to its one summarization call — if resume turns
out not to work, that call fails (or exhausts again) like any other
`AgentError`, is never retried (guardrail: no retry of the handoff itself),
and the run still fails as `turn_cap`-retryable, exactly as if no handoff had
been attempted at all. So the mechanical fallback (the file) is not
conditional on this doc's answer — it is the only mechanism, with the
optimistic resume as a best-effort bonus on top of it.
