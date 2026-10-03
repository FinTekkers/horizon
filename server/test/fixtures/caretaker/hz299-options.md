## Context from the code

- `g5.approve` in `server/src/caretakerRules.js:63` runs one regex from `farm/roles/caretaker.md:70` over `## Recommendation`.
- That regex misses 'Approve Option A', 'Recommended: A' and 'Option A is recommended'.
- **Latent bug:** today 'do not choose A' **approves** A. The regex finds 'choose A' and ignores the 'do not'.
- `section()` keeps `###` subsections inside `## Recommendation`. So rationale bullets like 'Decisions baked into A' get scanned too.
- `g5.blocker` already treats 'None', 'None.' and an empty section as no blocker. It runs before `g5.approve`. Metrics 4 and 5 need tests only, not code.
- HZ-296 and US-193 artifacts are not in git. They live in the farm store.

## Options

### A — Phrase and negation lists in the role file, plus a one-option check

- Change `g5.approve` in `caretaker.md` from one `pattern` to a `patterns` array. It gets one regex per form: the canonical `Recommended option: X`, `Approve [Option] X`, `Recommended: X`, `Option X is recommended`, and the current choose / recommend(ed) / go with form.
- Add a `negations` array to the same rule, e.g. `not`, `don't`, `do not`, `reject`, `avoid`, `against`.
- The evaluator strips `**`, then splits the section into sentences.
- It **skips** any sentence that contains a negation.
- It collects option letters from phrase matches only. Bare 'Option B' mentions in rationale do not count.
- Exactly one distinct letter → **approve**. Zero or two or more → `null`, so the result falls through to `ping_human`.
- Add one instruction line to `farm/roles/ensemble.md`: end `## Recommendation` with `Recommended option: <letter>`.
- **Pros:** the policy stays in the role file, as HZ-270 designed it. A policy-mutation test can prove that.
- **Pros:** sentence-level negation is simple and covers every guardrail example.
- **Pros:** it also fixes the 'do not choose A' bug.
- **Cons:** sentence-level negation is coarse. 'Choose A, not B' gets skipped and pings the human. That is the safe direction.
- **Cons:** the evaluator grows by about 25 lines.
- **Effort:** S–M. One JSON edit, one evaluator, one role line, about 12 new tests and one fixture.

### B — One wider regex with negative lookbehinds

- Keep the single `pattern` string. Widen it to alternations and add lookbehinds such as `(?<!not\s)` and `(?<!reject\s)`.
- Run it with the `g` flag. Approve only if every match has the same letter.
- **Pros:** smallest diff. The evaluator barely changes.
- **Cons:** lookbehinds only see a fixed width. 'do **not** choose A' and 'would not go with A' need separate entries.
- **Cons:** a long regex inside JSON is hard to review and easy to break.
- **Cons:** the gaps fail open. A missed negation **approves**.
- **Effort:** S.

### C — A structured parser in JS that trusts only the canonical line

- `g5.approve` approves only on an exact `Recommended option: X` line.
- Free-text forms go through a small JS phrase parser with a verb list and a negation window.
- The role file keeps only the section name.
- **Pros:** the most accurate free-text handling.
- **Cons:** it moves policy out of `caretaker.md`. That breaks the HZ-270 rule that editing the role file changes behaviour.
- **Cons:** the 'policy mutation' tests can no longer cover the phrase list.
- **Cons:** most code and the slowest to review.
- **Effort:** M.

## Recommendation

**Approve Option A.**

- It meets every metric and keeps policy in `farm/roles/caretaker.md`.
- It fails safe. Any doubt, negation or second option → `ping_human`. The caretaker never guesses.
- It fixes the existing 'do not choose A' false approve. B leaves similar gaps open.
- C costs more and undoes the role-file-as-policy design.
- Gates 3, 10, 13 and 15 stay untouched. `section()` and `bullets()` are reused unchanged.

### Scope of A

- `farm/roles/caretaker.md`: the `g5.approve` rule gets `patterns` and `negations`. The prose for step 2 gets one line about the canonical form.
- `server/src/caretakerRules.js`: only the `g5.approve` evaluator changes.
- `farm/roles/ensemble.md`: add one line only. Headings and their order stay the same.
- `server/test/caretaker-rules.test.mjs`: new cases only. They are:
  - the role-file line check (metric 1)
  - the phrase table: approve plus the right letter for each row (metric 2)
  - 'All options look viable' → `ping_human` (metric 3)
  - the HZ-296 fixture → approve; US-193 if available (metric 4)
  - a real Blockers bullet with a named option → `send_back` (metric 5)
  - negation rows, a two-option row and an option letter outside `## Recommendation` (guardrails)
  - a policy mutation on `negations`
- `server/test/fixtures/caretaker/hz296-options.md`: the real artifact, copied from the farm store and checked for tokens.

### Notes for the reviewer

- **Interpretation:** 'names two or more options' means two or more *recommended* letters. 'Recommend A over B' **approves** A, because B is not in a recommend phrase. Say so at the gate if you want that to ping instead.
- **Precedence:** the canonical line is not privileged. If it says A and the prose says 'go with B', that is two letters → `ping_human`.
- Option letters must be uppercase. 'go with a phased rollout' cannot match.
- The canonical line in this artifact is below.

Recommended option: A

## Blockers

None.
