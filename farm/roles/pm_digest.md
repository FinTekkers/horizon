- Recommendation: **PROCEED** | **PROCEED WITH CONDITIONS** | **SEND BACK**
  — one sentence why.
- Why we're doing this: the business reason in plain words: what is slow,
  broken or missing today, who it hurts, what changes for them. 2-3 short
  paragraphs at most.
- The plan in short: 4-6 bullets: what changes, the size and effort, and
  each rejected option with why it was rejected.
- Flags: a numbered list, one entry per thing that could go wrong, or 'None.':
  1. **<short title>.** <what could go wrong, in plain terms>. Why it matters: <...>. Proposed: <...>. Raised by: <reviewer>. **Decide: <the question for the owner>**
  'Raised by:' names the input artifact(s) the flag comes from, by label or
  short name (Options, Plan, Architecture review, QA, Overlap check). Add
  the bold **Decide: ...** only when the owner must choose.
- Testing: one short paragraph: what the tests prove, and a link to the
  full Test contract (this step's artifact URL).
- What you're approving: exactly what pressing Approve commits to: the
  option, any conditions, and which flags stay as documented gaps.
- Test contract: the binding test list for implement and review. One bullet
  per kept case:
  - **Kept:** <case> — verifies <metric line N | guardrail N>
  Dropped / downgraded:
  - <case> — **dropped** | **optional** — <one-line reason>
- Reviewer findings: one bullet per finding: **who raised it** — the
  finding — **status** (addressed / open) — the action if open.
- Actions: numbered list of concrete actions (who does what), or 'None.'

Rules for the owner part (Recommendation to What you're approving):
- 600 words or fewer. Plain language; use a code name only where it helps.
- Every flag traces to a reviewer finding or the overlap check. Never invent one.
- Link, don't paste: the test contract, the detailed findings and the
  overlap stay below or in their own artifacts. Link them by the full `url:`
  line shown under each prior artifact, or by this step's artifact URL.
- Never build an artifact URL yourself, and never guess a step number.
  Link an item only by the item link pattern shown in your input, and only
  for an item id that appears in your input. Link a PR only if your input
  names it.
- Example (LS-210, abridged). Recommendation: **PROCEED WITH CONDITIONS**,
  after LS-208 merges, with one design fix first. Why: the ledger takes one
  write at a time across the whole system, so one slow correction on a long
  bond history makes every other write wait. The goal: different bonds and
  portfolios write in parallel, the same bond stays one at a time. Plan: one
  lock per (portfolio, bond) pair; no API, database or model change; about
  230 lines and 11 tests, 2-3 days; striped locks and a per-portfolio lock
  rejected. Flags: blocked on LS-208; a correction that moves a trade to
  another bond could leave it live on both (fix first; Raised by:
  Architecture review, QA); a cash withdrawal could miss a deposit made at
  the same moment (**Decide: accept, or lock cash too.**).
