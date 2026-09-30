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
out not to work, that call fails (or exhausts again), is never retried
(guardrail: no retry of the handoff itself), and the run still fails as
`turn_cap`-retryable, exactly as if no handoff had been attempted at all. So
the mechanical fallback (the file) is not conditional on this doc's answer —
it is the only mechanism, with the optimistic resume as a best-effort bonus on
top of it.

The handoff call's turn budget is **strictly below** the exhausted step's own
(`min(3, max_turns - 1)`), with no floor clamping it back up: a step running on
a 1-turn budget leaves no room underneath it, so the handoff is **skipped**
rather than made as expensive as the step it reports on. That skip is counted
(`handoff_skipped_no_budget`) for the same reason every other giving-up path
is.

## The same invariant, on the salvage path

`reason="turn_cap"` is only ever set from an `AgentExhaustedError` — so
**anything** that replaces that exception with a different one silently
converts an auto-retried run into one that pauses for a human. The handoff call
(below) is one way to lose it; an over-eager *salvage* is the other, and it is
less obvious because the salvage looks like a success:

- A partial reply of `{` closes to `{}`, which parses. Accepting it means
  `pm_agent.validate()` / `step_agent.execute()` raise their own plain
  `AgentError("agent reply missing 'summary'")` a moment later — no
  `turn_cap`, no auto-retry. `{` is the *likeliest* capture when a budget runs
  out mid-JSON, so this is the common case, not the corner case.
- `{"summary": "` closes to `{"summary": ""}`: the key is present, the value
  is useless, same outcome.

So every caller names the fields its own validation refuses to do without
(`salvage_required_keys`), a salvage missing or blanking one of them is refused
outright, and a memberless object is refused regardless of what any caller
asked for. Refusing leaves the original `AgentExhaustedError` in place, which
is strictly better than both alternatives.

A gate-bearing caller (review, deploy) names its fields in the stricter
`salvage_intact_keys` instead. Those must additionally be *untouched by the
truncation*: salvage reports which field the cut landed in, because a value the
closing patch terminated still parses while not being what the model meant to
write. An `expected_text` cut from `Horizon board — 12 items` down to `Horizon`
is present, non-blank, and would make `run_smoke_check` pass on a prefix of the
assertion the DevOps agent intended; a `findings` array cut mid-write closes to
whichever findings happened to fit. Both are the deploy/review gate getting
quietly weaker, which no salvage is allowed to do. A truncated **summary**, by
contrast, is salvaged — it gates nothing, saving it is the whole point of the
item, and the note says it is a fragment.

Each refusal is counted (`salvage_refused_incomplete`,
`salvage_refused_truncated_value`, `salvage_refused_memberless`) alongside the
firings, so `python -m farm.scripts.repair_stats` shows how often the ladder
declines to help as well as how often it does.

## Containment on the handoff call

Because this call is the least-verified thing in the exhaustion path, its
failure is contained rather than typed: `_fire_handoff()` catches
`Exception`, not just `AgentError`. If a resume-after-exhaustion turns out to
fail in some shape nobody predicted — a `TypeError` from an SDK signature
change, an `httpx`/`OSError` from the transport — that exception must not
escape and replace the original `AgentExhaustedError`, because losing the
exception loses the `reason="turn_cap"` tagging in `pm_agent.process()` /
`step_agent.main()` and the item pauses for a human instead of auto-retrying.
Contained is not silent: the giving-up reason prints to the run log and a
`handoff_failed` line is appended to the repair counter, so
`python -m farm.scripts.repair_stats` shows failures next to firings — which
is also how this doc's "provisionally yes" gets confirmed or refuted from real
runs.
