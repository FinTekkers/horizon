## Human feedback addressed in this revision
> Operator correction: the gate-13 accept already works (HZ-231 was accepted by the caretaker 26 s after arrival and merged). This item is only about the two contradictory records (the would-ping eval, and accept outcome failed/not_at_gate despite result merged) and making genuine ping_human decisions always ping. The outcome in the issue has been corrected; keep the metric scoped to that.

## Context (grounded in code)

- **Operator correction addressed.** The gate-13 Accept already works and stays unchanged. This plan fixes only the two contradictory records, plus the rule that every genuine `ping_human` pings.
- **Record 1, "would ping" at gate 13.** `sweepCaretaker` in `server/src/caretaker.js` judges each arrival once. With `pr_mergeable` NULL, `decide()` falls through to `ping_human: no rule matched`. Nothing pings, because `queueHelpPings` in `server/src/caretakerActor.js` only covers gates 5, 10 and 15.
- **Record 2, "failed / not_at_gate".** `performGateApproval` in `server/src/app.js` merges the PR. GitHub's merge webhook then runs `approveGateFromGithub` and moves the cursor first. So `store.approveGate` returns `not_at_gate`. `settle()` in `server/src/caretakerAccept.js` treats any error as `failed`, even though the premerge row says `merged`.
- **Hard constraints found in tests we may not edit:**
  - `caretaker-rules.test.mjs` pins `decide(G13, {review: pass, mergeable: null})` to `ping_human`. So the fix **cannot** change `decide()` or the `caretaker-rules` block in `farm/roles/caretaker.md`.
  - `caretaker-accept.test.mjs` bans `caretakerAccept.js` from importing `github`. Any refresh must be injected.
  - `caretaker-help-ping.test.mjs` requires shadow and off projects to send nothing.

## Options

### A. Fix each record where it is written

- **Outcome:** in `settle()`, read the item's `premerge` `gate_action` state after the Accept call returns. If it is `merged`, write outcome `ok`. Only a non-merged state writes `failed`. Still one update per claim row, so never both values.
- **Bounded refresh:** the gate-13 `wait` branch, for "GitHub has not reported", calls an injected `refreshMergeable`. In production that is `github.refreshPrMergeable`, wired in `caretakerActor.init`.
  - Fixed 4 attempts with backoff, at about 30 s, 1, 2 and 4 min after arrival, driven by the existing 60 s tick.
  - Attempts are tracked in a **new additive table**, keyed UNIQUE on (item, arrival), e.g. `caretaker_mergeable_probe`.
  - A failed GitHub call counts as an attempt.
- **Sweep defers:** at gate 13, with review passed and `pr_mergeable` NULL, `sweepCaretaker` records nothing while the retries are still running. The next sweep picks the item up, the same way gate 15 waits through `releaseSettled`.
  - If GitHub reports clean, the sweep records "would approve" and the Accept path presses Accept.
  - In shadow, no probe runs, so the deferral is capped by time since arrival. After the cap it records as today.
- **Retries exhausted:** the sweep records one `ping_human` eval with reason "GitHub still reports mergeability unknown". It never accepts.
- **Pinging:** add gate 13 to `selectHelpCandidates` in `queueHelpPings`. The ping uses dedupe key `help:<eval_id>`, so one ping per eval and none on re-run. It covers every gate-13 `ping_human`, including a forwarded failing review.
- **Pros:** small diff in 3 files. Keeps the HZ-270 rule that shadow and on record the same thing. Reuses the existing outbox, dedupe and kill switch. No change to `decide()`.
- **Cons:** gate 13 now has two cooperating writers, the sweep and the Accept pass, which share the probe table. The shadow time cap is one more constant.
- **Effort:** about 1.5–2 days, including 5 new test cases in a new file `server/test/caretaker-gate13-records.test.mjs`.

### B. The Accept pass is the only gate-13 writer in 'on' projects

- `sweepCaretaker` skips gate 13 for 'on' items. `actOnAcceptGate` writes the `caretaker_eval` row itself when it acts or stops: `approve`, `resolve_conflicts` or `ping_human`.
- It uses the same bounded refresh and the same `settle()` outcome fix as A.
- **Pros:** one writer, so the records match the action by construction. No deferral logic in the sweep.
- **Cons:** breaks the HZ-270 rule "'on' records exactly what shadow does". Likely conflicts with the unedited `caretaker.test.mjs` and `caretaker-act.test.mjs` cases at gate 13. It also moves eval writing into a module whose header says it is read-only for evals. Higher risk.
- **Effort:** about 3 days, plus test-compatibility risk.

### C. Fix at the shared sources

- `performGateApproval` returns `{ok: true}` when its own merge succeeded and GitHub's webhook has already advanced the cursor. That removes `not_at_gate` for the UI too.
- `pollPrStates` in `server/src/github.js` re-reads NULL `pr_mergeable` for gate-13 items more eagerly. The sweep defers as in A.
- **Pros:** a human clicking Accept also stops seeing a spurious `not_at_gate`.
- **Cons:** changes the merge-critical, human-facing Accept path that the guardrails tell us to reuse unchanged. Tying a GitHub retry to the poll loop is not "a fixed small count" for each item. It still needs A's ping fix.
- **Effort:** about 1.5 days, but with a wider blast radius.

## Recommendation

**Approve Option A.**

- It fixes both records where they are written and leaves the working Accept path untouched.
- It respects every pinned test: `decide()` stays the same, `caretakerAccept.js` gains no `github` import, and shadow stays silent.
- The schema change is one new table, with no rewrite of past `caretaker_accept_action` rows.
- Kill switch and 'off' still stop everything. The probe runs only inside `actOnAcceptGate`, whose candidates require `autopilot = 'on'` and `enabled = 1`.
- **Mapping to the success metric:**
  - 1: stub returns NULL, then clean. The refresh sets 1, then Accept and merge.
  - 2: no eval is recorded while the probe runs, so no "would ping".
  - 3: stub stays unknown. One `ping_human` eval and one `needs_human` ping.
  - 4: the webhook advances the cursor before `approveGate`. The claim reads `ok/merged`.
  - 5: re-sweep and re-tick add no ping.
  - 6: the existing suite runs unedited.
- **Notes for the reviewer:**
  - **Behaviour change:** a forwarded failing review at gate 13 in an 'on' project now sends one owner ping. Metric 5 requires this.
  - "Genuine `ping_human`" means decided in an 'on' project. Shadow evals stay record-only, as `caretaker-help-ping.test.mjs` requires.
  - The `W-null` case in `caretaker-accept.test.mjs` advances 3 min with no refresher injected. With no refresher, the pass must keep its old plain `wait`. Otherwise that test could start seeing a ping.

## Blockers

None.
