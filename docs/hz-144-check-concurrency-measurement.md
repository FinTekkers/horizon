# HZ-144 — farm parallelism and check concurrency: the measurement

Raising `FARM_MAX_EPHEMERAL` from 4 to 6 on a 2-vCPU host is not a config
change, it is a capacity change, so it gets measured rather than asserted.
This file is where the numbers live. It is a point-in-time record, re-run and
re-committed — nothing here is a live metric.

**Status: the mechanism has shipped; the three measurement windows have
not been collected.** What is recorded below is the host baseline, the
protocol, and a single-run timing of this repo's own check gate through the
new code path. The 20-run windows are an operational step (they need real
farm traffic over real calendar time), and the numbers get filled in here by
re-running the reporter. Where a number is not yet measured this file says so
rather than estimating.

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

## Collecting a window

Add to `/etc/horizon/farm.env` (see `infra/host/DEPLOY.md` §2c), then
`sudo systemctl restart horizon-farm`:

```
FARM_CHECK_METRICS_PHASE=cap4-nolimit
FARM_MAX_CONCURRENT_CHECKS=0
```

Leave it until the reporter shows ≥20 agent runs for that phase, then move to
the next window. Read it back with:

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

### `cap4-nolimit` (baseline)

Not yet collected.

### `cap4-limit2`

Not yet collected.

### `cap6-limit2`

Not yet collected.

### Against the success metric

| # | Metric | Status |
| --- | --- | --- |
| 1 | 6 concurrent agent steps observed | **pending** — dispatcher logic covered by `test_the_dispatcher_launches_up_to_the_configured_cap_and_no_further`; the `tmux list-sessions` capture goes below once the host cap is raised |
| 2 | No more than the configured check suites at once | **pass** — `test_only_the_configured_number_of_slots_are_held_at_once` starts three runs against two slots and asserts the third waits |
| 3 | Queue wait does not count toward `FARM_CHECK_TIMEOUT_S` | **pass** — `test_queue_wait_does_not_eat_the_check_timeout` |
| 4 | Before/after numbers over ≥20 runs | **pending** — instrumentation and reporter shipped; windows not collected |
| 5 | Zero OOM kills, zero contention timeouts | **pending** — `oom`/`contention` classes and a host-wide `MemAvailable` low-water mark are recorded per run |
| 6 | Median check duration ≤50% above baseline | **pending** — needs `cap4-nolimit` and `cap6-limit2` |
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

Counts on this branch, 2026-09-30:

| Gate | Result |
| --- | --- |
| `npm test` | **50 pass, 0 fail** (plus the production-base UI build check) |
| `npm run test:e2e` | **30 passed** (suite 50.9s; 82.2s for the whole command) |
| `python -m pytest -q` | **603 passed, 4 skipped** |
| Python linter | none configured in this repo — no coverage claimed |

Guardrail 7 ("every test passing before passes after") checked by running the
suite at this branch's parent (`161d267`) as well:

| Commit | pytest |
| --- | --- |
| `161d267` (before) | 519 passed, 4 skipped |
| this branch (after) | **603 passed, 4 skipped** |

84 tests added, none removed, none newly skipped. The parent run also showed 2
failures in `test_step_agent.py`'s smoke-check cases, which are an artifact of
measuring in a bare `git worktree` with no `node_modules`
(`ERR_MODULE_NOT_FOUND: Cannot find package '@playwright/test'`) — both pass
in a provisioned workspace, on this branch and on the parent, so they are not
a pre-existing failure this branch inherited or masked.
