# HZ-144 — farm parallelism and check concurrency: the measurement

Raising `FARM_MAX_EPHEMERAL` from 4 to 6 on a 2-vCPU host is not a config
change, it is a capacity change, so it gets measured rather than asserted.
This file is where the numbers live. It is a point-in-time record, re-run and
re-committed — nothing here is a live metric.

**Status.** The `cap4-nolimit` baseline is **collected and below**, over 147
real farm runs (40 in the like-for-like window) — comfortably past the 20-run
minimum. It did not need to be collected forward in calendar time, because it
was already on disk: see "Where the baseline came from". The two remaining
windows (`cap4-limit2`, `cap6-limit2`) **cannot** be collected before this
merges — they need the code deployed and real traffic through it — so this
branch lands with the "after" half unmeasured. What that means, and what is
being asked of the approver, is in "What lands unmeasured, and the ask" below.
Where a number is not yet measured this file says so rather than estimating.

## Why three windows, not two

| Phase | `FARM_MAX_EPHEMERAL` | `FARM_MAX_CONCURRENT_CHECKS` | What it isolates |
| --- | --- | --- | --- |
| `cap4-nolimit` | 4 | `0` (limiter off) | **today's real behaviour** — the true baseline |
| `cap4-limit2` | 4 | `2` | the limiter's own cost, at unchanged capacity |
| `cap6-limit2` | 6 | `2` | the target |

The middle window is what makes the result attributable. With the limiter
already enabled in the "before" window, a regression in `cap6-limit2` could
not be pinned on the cap rather than on the limiter — and that is precisely
the question this item has to answer.

Each window needs **at least 20 agent check runs** (success metric 4). The
reporter flags a window with fewer and refuses to let three runs read like a
result. At the observed rate of farm traffic that is roughly a few days of
normal work per window; if a window is still short after a week, say so in
this file rather than shipping a thin number.

## Where the baseline came from

The `cap4-nolimit` window did not need collecting forward. The farm has run at
`FARM_MAX_EPHEMERAL=4` with no check limiter for its entire life, and every
one of those runs timestamped its check commands into
`$FARM_HOME/logs/farm-run-*.log`:

```
[17:54:01] checks: running npm install --no-audit --no-fund
[17:54:02] checks: running npm test --silent
[17:55:57] checks: running npm run test:e2e --silent
[17:57:08] checks: running /opt/.../python -m pytest -q
[17:58:13] publish_screenshots: pushed 21 screenshot(s) ...
```

Consecutive `checks: running` lines bound each other and the first line after
the block bounds the last command, so per-command duration, total check
duration and the pass/fail outcome are all recoverable — from real traffic, at
the real cap, with no limiter. That *is* the baseline. Waiting several days to
re-collect prospectively what is already on disk would have been measurement
theatre. `farm/tools/backfill_check_metrics.py` does the extraction and feeds
the **same** reporter the live windows will use, so the two halves of metric 4
are computed by one code path:

```
farm/.venv/bin/python -m farm.tools.backfill_check_metrics --last 40 -o /tmp/base.jsonl
farm/.venv/bin/python -m farm.tools.report_check_metrics --path /tmp/base.jsonl --markdown
```

**What it cannot recover, stated rather than defaulted.** The logs predate the
instrumentation, so `mem_available_low_kb` and load average were never sampled
and are written as `None` — the reporter prints "—" rather than a zero that
would read as a measurement. `slot_wait_s` is `0.0`, which is not an
approximation: no limiter existed, so there was nothing to queue for. Memory
and load for the two live windows come from the real records; metric 6's bound
is on check **duration**, which is recovered exactly.

Timestamps are `HH:MM:SS` with no date, so the date comes from the file mtime
and a block crossing midnight is corrected by a wrap. One-second resolution
means a sub-second command reads as 0s.

## Collecting the two remaining windows

Add to `/etc/horizon/farm.env` (see `infra/host/DEPLOY.md` §2c), then
`sudo systemctl restart horizon-farm`:

```
FARM_CHECK_METRICS_PHASE=cap4-limit2
FARM_MAX_CONCURRENT_CHECKS=2
```

Leave it until the reporter shows ≥20 agent runs for that phase, then move to
`cap6-limit2` (`FARM_MAX_EPHEMERAL=6`). Read it back with:

```
farm/.venv/bin/python -m farm.tools.report_check_metrics --markdown
```

Remove `FARM_CHECK_METRICS_PHASE` when the last window is done; records then
land under `unlabelled`, which is honest rather than mixed into a window.

## Host baseline — 2026-09-30

Measured, not assumed:

| Fact | Value | How |
| --- | --- | --- |
| CPUs | 2 | `nproc` |
| Total RAM | 7,991,300 kB (≈7.6 GiB) | `/proc/meminfo` `MemTotal` |
| `MemAvailable` at rest | 5,546,880 kB (≈5.3 GiB) | `/proc/meminfo` |
| Load average | 0.62 / 1.82 / 2.42 | `/proc/loadavg` |
| Live `farm-run-*` sessions | 4 | `tmux list-sessions` |
| `FARM_MAX_EPHEMERAL` in `farm.env` | **unset** (code default 4) | the 30 Sept trial of `6` was reverted |
| `never_picked_up` step runs, last 7 days | **23** | `SELECT COUNT(*) FROM step_run WHERE output LIKE '%never_picked_up%' AND started_at >= datetime('now','-7 days')` |

The 23 matches the figure in the item's outcome, so metric 7's "below the
current 23" is measured against a confirmed number, not a quoted one.

### One real check-gate run through the new code path — 2026-09-30

This repo's own gate (`npm test` → the `server`/`ui` suites, the deploy shell
harness, the production-base UI build; `npm run test:e2e`; `pytest -q`) run
once via `run_checks()` on this host, with the limiter enabled and one free
slot. It is a **single run**, so it is a sanity check on
the instrumentation and a rough scale for one uncontended suite — not a
baseline, and explicitly not one of the 20.

Recorded at load 3.70 (1-min, at the start of the run), one free check slot,
`FARM_MAX_CONCURRENT_CHECKS=2`, throwaway `FARM_HOME` so the record did not
dilute the live file:

| Command | Duration | Result |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | 0.5s | 0 |
| `npm test --silent` | 113.6s | 0 |
| `npm run test:e2e --silent` | **82.2s** | 0 |
| `python3 -m pytest -q` | 83.6s | 0 |
| **Total check duration** | **280.0s** | `outcome: pass` |

| Record field | Value |
| --- | --- |
| `slot_mode` / `slot_index` | `held` / 0 |
| `slot_wait_s` | 0.0 (no contention — nothing else was checking) |
| `load_start` / `load_end` | 3.70 / 3.37 |
| `mem_available_low_kb` | 5,739,332 kB (≈5.5 GiB still free) |

(The 280.0s here is one run through the *new* code path and is what it says on
the tin — an instrumentation check. The number the rest of this document
reasons from is the 40-run baseline above: median 248.0s, p95 302.0s. This
single run sits between the two, which is the only agreement worth claiming
from a sample of one.)

This confirms the instrumentation end to end: the slot was taken, the record
was written with one line, the classifier reported `pass`, and the nested
`run_checks()` calls inside the inner `pytest` were no-ops rather than a
deadlock — that inner suite is the 603-test run, and it completed inside the
outer gate without ever waiting for a second slot.

**Reading the e2e number correctly.** The 82.2s above is the whole
`npm run test:e2e` command — the Vite build, the `webServer` boot and
Playwright's own startup, then the suite. `globalTimeout: 85_000` does **not**
cover that window; it bounds the test run, which reported **30 passed
(50.9s)** on a standalone re-run of the same gate at comparable load. So the
margin against the 85s ceiling is roughly **50.9s of 85s — about 40% headroom**,
not the 2.8s a naive comparison of 82.2s to 85s would suggest. The two
durations answer different questions and should not be compared: use the
command duration for capacity (what a check slot occupies) and the suite
duration for the contention ceiling.

40% headroom is the useful framing for this item: it means the suite tolerates
roughly a 1.65x slowdown before `globalTimeout` fires, and on 30 Sept at load
~8 it did fire — so the slowdown under six unthrottled agents exceeded that.
That is consistent with the limiter being a precondition for the cap raise
rather than an accompaniment to it, and it is the quantity `cap6-limit2` has to
confirm. Memory is not the binding constraint at this concurrency (≈5.5 GiB
free at the trough); CPU is.

## Results

### `cap4-nolimit` (baseline) — collected

Reconstructed from the farm's own session logs on 2026-09-30, spanning
2026-07-30 to 2026-09-30.

| Window | Agent runs | Median check | p95 check | Timeouts | OOM | Unthrottled |
| --- | --- | --- | --- | --- | --- | --- |
| all history | 147 | 186.0s | 284.0s | 1 | 0 | 0 |
| **last 40 (the comparison window)** | **40** | **248.0s** | **302.0s** | **0** | **0** | **0** |
| last 20 | 20 | 266.0s | 302.0s | 0 | 0 | 0 |

Queue wait is 0.0s throughout by definition — there was no limiter to queue
for. Memory and load are "—": never sampled at the time.

**Use the 40-run window, not all 147.** The check gate itself has grown over
the farm's life (more suites, more e2e specs), so the all-history median of
186s is the median of a *smaller gate*. Comparing a future `cap6-limit2`
window against it would read the gate's own growth as a contention regression,
which is the opposite of what metric 6 asks. The like-for-like figure is
**median 248.0s**; metric 6's 50% bound is therefore **372.0s**.

#### The finding that was not expected

| Outcome | all 147 | last 40 |
| --- | --- | --- |
| `pass` | 130 | 37 |
| `contention` | **7** | **2** |
| `leakage` | 1 | 1 |
| `timeout` | 1 | 0 |
| `other` (real test failures) | 8 | 0 |

**Contention already fails checks at cap 4, today, without the limiter.** Five
of those seven predate the 30 Sept trial entirely and are all the same shape —
a Playwright `webServer` port collision between concurrent runs:

```
Error: http://localhost:3057 is already used, make sure that nothing is
running on the port/url or set reuseExistingServer:true in config
```

All five on port 3057. `PORT_OFFSET` in `e2e/playwright.config.js` is a hash of
the worktree path modulo 1000, so two concurrent runs whose worktrees collide
kill each other's dev server (`fuser -k`). The other two are the 30 Sept trial
(the Playwright `globalTimeout` firing at load ~8), and the single `leakage` is
the documented `assert 6 == 4`.

Checks run before commit/push, so each of those seven discarded a whole
attempt's work. That is a **4.8% attempt-loss rate from contention at the
current cap of 4** — this item's premise is not merely that contention *would*
appear at 6, but that it is already happening at 4. It also means the limiter
is not purely a cost: capping concurrent check suites at 2 halves the number of
e2e suites that can collide, so `cap4-limit2` is expected to *reduce* this
class, and the contention tally is the number to watch for it.

This is also a live check on the classifier: it recognised failure shapes from
the real history that it was not written against, rather than filing them under
`other`.

### `cap4-limit2`

Not yet collected — needs this branch deployed. See the ask below.

### `cap6-limit2`

Not yet collected — needs this branch deployed and the host cap raised. See
the ask below.

## What lands unmeasured, and the ask

Stated plainly rather than implied, because guardrail 6 says not to ship
without the before/after measurements.

**What is measured:** the entire "before" half — metric 4's baseline, over 147
real runs (40 like-for-like), plus a classified outcome tally that already
shows contention failing checks at the current cap.

**What is not, and cannot be, before merge:** both "after" windows. They
require this code running on the host and ≥20 real runs through it, which is
days of calendar time. No arrangement of this branch can produce them first.

**The behaviour this branch changes on deploy, with no "after" number yet:**
`FARM_MAX_CONCURRENT_CHECKS` defaults to `2`, so deploying the code alone
throttles checks even though the cap stays at 4. The bound on that is
arithmetic, not a guess: at cap 4 with limit 2 at most two runs ever queue, one
wave deep, so the worst added wait is one p95 suite — **≈302s**, against a
1200s fail-open ceiling and a 3000s implement-step watchdog. It is also
strictly more conservative than today's behaviour (at most 2 concurrent check
suites where today there can be 4).

**The ask at the human gate:** accept that this merges with the "after" half
outstanding, on these conditions —

1. `cap4-limit2` is collected first, at the unchanged cap of 4. If its median
   check duration is outside 372.0s, or any run shows as `Unthrottled`, the cap
   does **not** move to 6.
2. `FARM_MAX_EPHEMERAL=6` is a separate host edit made only after (1) passes,
   and `cap6-limit2` is collected and recorded here before the item closes.
3. Rollback is one env var and a restart, in either direction, with no code
   revert — see "If the measurement says no".

If that is not acceptable, the alternative is to merge with
`FARM_MAX_CONCURRENT_CHECKS=0` set in `/etc/horizon/farm.env`, which makes the
deploy behaviour-identical to today and defers the limiter to the same host
edit that collects `cap4-limit2`. That is a one-line change to `farm.env`, not
to this branch.

### Against the success metric

| # | Metric | Status |
| --- | --- | --- |
| 1 | 6 concurrent agent steps observed | **pending** — dispatcher logic covered by `test_the_dispatcher_launches_up_to_the_configured_cap_and_no_further`; the `tmux list-sessions` capture goes below once the host cap is raised |
| 2 | No more than the configured check suites at once | **pass** — `test_only_the_configured_number_of_slots_are_held_at_once` starts three runs against two slots and asserts the third waits |
| 3 | Queue wait does not count toward `FARM_CHECK_TIMEOUT_S` | **pass** — `test_queue_wait_does_not_eat_the_check_timeout` |
| 4 | Before/after numbers over ≥20 runs | **before: pass** — 147 real runs (40 like-for-like), above. **After: pending** — both windows need the code deployed |
| 5 | Zero OOM kills, zero contention timeouts | **pending** — `oom`/`contention` classes and a host-wide `MemAvailable` low-water mark are recorded per run. The baseline shows 0 OOM and 7 contention failures **at cap 4 today**, which is the number the after-windows have to beat |
| 6 | Median check duration ≤50% above baseline | **baseline recorded: 248.0s, so the bound is 372.0s.** Verdict pending `cap6-limit2`; the reporter computes the ratio rather than leaving it to be eyeballed |
| 7 | `never_picked_up` over 7 days below 23 | **pending** — baseline 23 confirmed; see the follow-up below |
| 8 | Both limits env-configurable and documented | **pass** — `FARM_MAX_EPHEMERAL`, `FARM_MAX_CONCURRENT_CHECKS` (plus `FARM_CHECK_SLOT_WAIT_MAX_S`) in `farm/README.md` and `infra/host/DEPLOY.md` §2c |
| — | Zero failures from configuration leakage or contention (human feedback) | **pending** for the window; the `leakage` class exists and both scrub seams have tripwire tests |

### Metric 7's closure step

`never_picked_up` is a 7-day window, so it cannot close inside a 20-run
measurement. **On or after 7 days from the date `FARM_MAX_EPHEMERAL=6` is
applied**, re-run the query in the table above and add a dated line to this
section. No number here until then.

| Date | `never_picked_up` (prior 7 days) | Cap in force |
| --- | --- | --- |
| 2026-09-30 | 23 | 4 |

## The 30 Sept 2026 trial, and what it changed

`FARM_MAX_EPHEMERAL=6` was tried by hand and reverted after ~30 minutes. Two
distinct failures, both designed out rather than worked around:

1. **Configuration leaked into the tests.** `farm/tmux_mgr.py` forwarded every
   `FARM_*` variable into agent sessions, and `farm/checks.py` ran the checked
   repo's tests with no `env=` at all. The checked repo is Horizon, whose own
   suite asserts `farmd.MAX_EPHEMERAL == 4` — so every implement run's pytest
   failed, and since checks run before commit/push, each failure discarded a
   whole attempt's work. Now scrubbed at both seams
   (`farm/config.py`'s `AGENT_NEVER_NEEDS` and `CHECK_SUBPROCESS_SCRUB`), with
   `farm/tests/test_check_env_scrub.py` as the tripwire and a `leakage`
   outcome class so a recurrence is visible in the tally rather than inferred.
2. **Contention failed the e2e suite.** At load ~8 the Playwright suite hit its
   own `globalTimeout: 85_000` — "Timed out waiting 85s for the test suite to
   run". That ceiling **stays where it is** and is treated as the contention
   detector: raising it would hide exactly what this measurement is for, which
   guardrail 3 forbids for `FARM_CHECK_TIMEOUT_S` for the same reason. A
   runner enforces both values
   (`test_the_e2e_contention_ceiling_is_not_raised_either`,
   `test_the_check_timeout_default_is_not_raised_to_hide_contention`).

## If the measurement says no

If `cap6-limit2` shows check timeouts, OOM kills, or a median check duration
more than 50% above `cap4-nolimit`, the answer is to **stop at the highest cap
that stays inside those bounds and record the numbers here** — including the
recommendation for a larger instance, with the measured evidence behind it.
The host is not to be resized as part of this item. Reducing
`FARM_MAX_CONCURRENT_CHECKS` to 1 before giving up on cap 6 is worth one
window of its own: it trades check throughput for headroom, which is the
cheaper lever.

## Gates

No Python linter is configured anywhere in this repo (`farm/README.md` records
this), so the "linters must pass" guardrail is vacuous for the new Python
files — stated plainly rather than implied covered. The gates that do run are
`npm test`, `npm run test:e2e` and `python -m pytest -q`.

Counts on this branch, re-run 2026-10-01 (all three green, each run to
completion rather than sampled):

| Gate | Result |
| --- | --- |
| `npm test` | **exit 0** — the server/UI suites, plus **50 pass, 0 fail** in the deploy shell harness and the production-base UI build check |
| `npm run test:e2e` | **30 passed** (suite 55.4s) |
| `python -m pytest -q` | **633 passed, 4 skipped** (637 collected) |
| Python linter | none configured in this repo — no coverage claimed |

The e2e suite's 55.4s against `globalTimeout: 85_000` is **~35% headroom** on a
host that was not idle (load 2.0, four live `farm-run-*` sessions). That is the
contention detector reading green at the current cap, and it is the same
quantity `cap6-limit2` has to re-confirm after the cap moves.

Guardrail 7 ("every test passing before passes after") checked by running the
suite at this branch's parent (`161d267`) as well:

| Commit | pytest |
| --- | --- |
| `161d267` (before) | 519 passed, 4 skipped |
| this branch (after) | **633 passed, 4 skipped** |

114 tests added, none removed, none newly skipped. "None removed" is checked
mechanically, not by eye: the only `-def test_` line in the whole branch diff
is `test_max_ephemeral_default_is_four` gaining a `monkeypatch` parameter.

The parent run also showed 2 failures in `test_step_agent.py`'s smoke-check
cases. Those are an artifact of measuring in a bare `git worktree` with no
`e2e/node_modules` (`ERR_MODULE_NOT_FOUND: Cannot find package
'@playwright/test'`), not something this branch inherited or masked —
confirmed directly on 2026-10-01 rather than assumed: both fail before
`npm --prefix e2e install` and both pass after it, with no code change in
between. They are also untouched by this branch, which edits neither
`run_smoke_check` nor `e2e/smoke/`.
