<!--
HZ-801 fixture: the LS-210 owner digest, rebuilt in the owner-first shape from
LS-210's stored artifacts, read 2026-11-06:
  4 Plan options & trade-offs (pros / cons)  https://shoreward.ai/horizon/api/items/LS-210/artifacts/4
  6 Draft implementation plan                https://shoreward.ai/horizon/api/items/LS-210/artifacts/6
  7 Architecture review                      https://shoreward.ai/horizon/api/items/LS-210/artifacts/7
  8 QA reviews the test plan                 https://shoreward.ai/horizon/api/items/LS-210/artifacts/8
The owner part follows the owner's approved LS-210 draft. The Test contract,
Reviewer findings, Actions and the server's Overlap are the stored step-9 text.
Tests strip this comment before use: a model reply never carries it.
-->
## Recommendation
**PROCEED WITH CONDITIONS** — start after LS-208 merges, with one design fix made first.

## Why we're doing this
The ledger accepts one write at a time across the whole system. One slow correction on a long bond history makes every other write wait: other portfolios, trades entered on the website, and the weekly SOMA load.

The goal is to let writes on different bonds and portfolios run in parallel. Writes on the same bond in the same portfolio still run one at a time, so the safety checks LS-208 adds keep holding.

## The plan in short
- One lock per (portfolio, bond) pair, created only while in use and taken in a fixed order, so two writes can never deadlock.
- No API, database or data-model change. Only how many writes run at once changes, not what is stored.
- About 230 lines in 5 files, plus 11 tests. Effort: 2-3 days.
- Rejected: striped locks (option B). Unrelated bonds can share a stripe and wait for each other, which makes the tests brittle.
- Rejected: one lock per portfolio (option C). SOMA's 433 bonds sit in one portfolio, so they would still queue one by one.
- Detail: [options](https://shoreward.ai/horizon/api/items/LS-210/artifacts/4) and [plan](https://shoreward.ai/horizon/api/items/LS-210/artifacts/6).

## Flags
1. **Blocked on LS-208.** This work builds on checks that exist only on the LS-208 branch ([LS-208](https://shoreward.ai/horizon/ls-208), [PR #209](https://github.com/FinTekkers/ledger-service/pull/209)). Why it matters: starting now means copying or stacking on unmerged code. Proposed: hold LS-210 until LS-208 merges, then branch from main. Raised by: Options, Plan, Architecture review, QA.
2. **A moved trade could end up live on two bonds.** A correction that moves a trade to another bond, while the old bond is mid-replay, can miss the old copy. Why it matters: positions would be wrong, silently. Proposed: keep a trade-to-pair map and fix the design before coding, with a test for this exact case. Raised by: Architecture review, QA. See the [architecture review](https://shoreward.ai/horizon/api/items/LS-210/artifacts/7).
3. **A cash withdrawal could miss a deposit made at the same moment by another bond.** Why it matters: a withdrawal check may see slightly stale cash. This is how it works today and does not affect SOMA. Proposed: record it in a code comment and leave cash unlocked. Raised by: Architecture review. **Decide: accept this, or lock cash too.**
4. **Delete stays unlocked.** Why it matters: a delete can still race a write on the same pair. Proposed: out of scope here; recorded in a code comment. Raised by: Architecture review.
5. **LS-211 shares the test script.** Why it matters: both items edit `scripts/checks/test.sh`. Proposed: whichever merges second rebases and keeps the other's tests passing ([LS-211](https://shoreward.ai/horizon/ls-211)). Raised by: Overlap check.

## Testing
11 tests compare parallel runs against the same writes run one at a time, including through the real gRPC API and the moved-trade case from Flag 2. The full list is the Test contract below, at [this artifact](https://shoreward.ai/horizon/api/items/LS-210/artifacts/9); QA's detailed cases are in [the QA review](https://shoreward.ai/horizon/api/items/LS-210/artifacts/8).

## What you're approving
Option A, built after LS-208 merges, with Flag 2's design fix made before any code. Flags 3 and 4 stay as documented gaps. Reviewer findings and the overlap decisions are listed below.

## Test contract
- **Kept:** `TransactionConcurrencyWireJourneyTest`. A latch holds a **backdated** insert on pair A, on a chain of 50+ transactions. `CreateOrUpdate` on pair B returns OK within 5 s and B is then readable. There are two variants: same portfolio with a different security, and a different portfolio. Verifies **metric line 1**.
- **Kept:** connector-level hold on A. When B's write returns, A's second write has made 0 `getTransactions(filter)` calls and 0 `check()` entries. A background `ValidateCreateOrUpdate` on A has not returned. After release, both finish within 5 s and A's lots equal a serial run. No fixed sleeps. Verifies **metric line 1** and **guardrail 2**.
- **Kept:** two threads write one pair, 20 rounds, including a backdated SELL. Lots and positions equal a serial run. The rejected SELL stores nothing. Verifies **metric line 2**.
- **Kept:** first versions of one transaction ID sent at once on two pairs, 50 rounds. Exactly one live version, equal to a serial run. Verifies **metric line 2**.
- **Kept:** two bonds write at once, with `WITHDRAWAL`/`DEPOSIT`/`MATURATION` children on `(P, USD)`. The USD lots and position equal a serial run. Verifies **metric line 3**.
- **Kept:** `scripts/checks/test.sh` stays green, including LS-208's `TransactionSellPreCheckTest`, `TaxLotCalculatorCheckTest` and `TransactionConnectorMergeTest`. Verifies **metric line 4**.
- **Kept:** opposite-order corrections start on a `CyclicBarrier`, 50 rounds. All finish within 10 s. Verifies **metric line 5**.
- **Kept:** moved-ID case. Pair X is latched mid-replay with T cancelled. A correction moves T to Y. T ends live on Y only, X and Y equal a serial run, and a stale resend of T is rejected. Verifies **guardrail 1**.
- **Kept:** `KeyedLocksTest` checks that keys are taken in sorted order whatever order they are passed in. Verifies **guardrail 3**.
- **Kept:** lock maps drain. `size()` is 0 after a throwing body in `KeyedLocksTest`. `idLocks` and `pairLocks` are empty after the connector tests, a `TransactionErrorNoLotsToReduce` rejection and a processor that throws. Verifies **guardrail 4** (bounded map).
- **Kept:** after N parallel writes across 8 pairs, `processedCount == N` and the invalidation counters equal a serial run. Verifies **guardrail 4** (thread-safe shared state).

That is 11 cases, under the soft cap of 14. Guardrail 4 gets 2 cases because it makes two separate claims.

Dropped / downgraded:
- Reload parity through `Service.loadAndReplay` — **optional** — no metric line covers reload. Writes to the DB are unchanged.
- Startup replay alongside an API write — **optional** — the wire journey already proves pair B is not blocked.
- Concurrent `delete` on a pair being written — **dropped** — `delete` stays unlocked and is out of scope.
- Cash `SELL` racing a bond's cash child — **optional** — today's behaviour is unchanged. A code comment records it.
- Stress loop over 200 random pairs — **dropped** — metrics 2 and 3 already compare against serial runs. It risks a slow, flaky test.
- Plan's separate `KeyedLocksTest` drain case — **merged** into the lock-map drain case above.

## Reviewer findings
- **Architect** — The key-set lookup uses `getTransactions(id)`, which skips cancelled rows. A correction during pair X's replay can leave T live on two pairs. — **open** — Action 1.
- **Architect** — Cash children only add lots, pair windows skip children, and the lock order is deadlock-free. — **addressed**.
- **Architect** — A cash `SELL` may not see a cash child lot added at the same moment. This is how it works today. — **open** — Action 5.
- **Architect** — The `addTransaction` Javadoc at `TransactionConnector.java:467` still says `synchronized`. — **open** — Action 5.
- **Architect** — `AbstractTransactionConnector.delete` stays unlocked. — **open** — Action 5.
- **QA** — The moved-ID case has no test. — **open** — Action 1.
- **QA** — Metric 1 is only tested inside the service, never through gRPC. — **open** — Action 2.
- **QA** — The metric 1 test needs a backdated insert, a blocked `ValidateCreateOrUpdate`, no fixed sleeps, and must show A's second write finishes. — **open** — Action 3.
- **QA** — No test for first writes of one ID on two pairs. — **open** — Action 4.
- **QA** — Lock-map drain is not checked after errors. Counters are not checked. — **open** — Action 4.
- **Options, Plan, Architect, QA** — LS-208 is not on `main`. — **open** — Action 6.

## Actions
1. **Eng:** Before coding, change `withWriteLocks` to use a connector-owned `ConcurrentHashMap<UUID, PairKey>`. Update it only while holding that pair's lock. Read it before locking, check it again after locking, and retry if it changed. Add the moved-ID test.
2. **Eng:** Add `TransactionConcurrencyWireJourneyTest` with both pair-B variants.
3. **Eng:** Extend the connector-level metric 1 test as set out in the Test contract.
4. **Eng:** Add the same-ID test, the lock-map drain checks and the counter checks.
5. **Eng:** In the cross-pair comment, record the cash `SELL` race and the unlocked `delete`. Fix the Javadoc at `TransactionConnector.java:467`.
6. **Horizon:** Hold LS-210 until LS-208 (PR #209) merges, as the **depends-on** decision says. Eng then branches `horizon/ls-210` from `main`.
7. **Eng:** Run `scripts/checks/test.sh` green. Do not edit it. LS-211 shares it under **shared-contract**.

## Overlap
Checked against 2 other in-flight item(s) in `FinTekkers/ledger-service` (steps 6–14). The server computed these decisions; the digest cannot change them.
- **LS-208** — decision: **depends-on**
  - Shared files: none
  - Shared functions/endpoints: `getTaxLotQuantity()`, `processTransaction()`
  - Contract: LS-208 and LS-210 both change `getTaxLotQuantity()`, `processTransaction()`. Whichever merges second rebases onto the other first and keeps the other item's tests for that code passing.
  - Effect: dependency LS-210 → LS-208 already present; implement waits until LS-208 merges (shown on the card); contract queued as feedback on LS-208 and LS-210
- **LS-211** — decision: **shared-contract**
  - Shared files: `scripts/checks/test.sh`
  - Shared functions/endpoints: `getParentTransaction()`
  - Contract: LS-210 and LS-211 both change `scripts/checks/test.sh`. Whichever merges second rebases onto the other first and keeps the other item's tests in those files passing.
  - Why: LS-211 is waiting at the Review before execution gate; links go only to items implementing, in review or merged but not deployed
  - Effect: contract already queued on LS-210 and LS-211
