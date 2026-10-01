<!-- Generated 2026-10-01 by: python -m farm.tools.pm_run_timings --log ~/.horizon-farm/logs/pm-horizon.log --spawn-bench 5 (raw output, unedited) -->

## Measured per-step cost

Source: `/home/ubuntu/.horizon-farm/logs/pm-horizon.log` — **362 PM runs** across 90 work items.

**Corpus coverage: 359/362 runs carry a timing line (3 unmeasured).** Only `farm/providers/claude.py` prints it; `farm/providers/muse.py` does not, so a Muse-routed run is counted as unmeasured rather than dropped. Times are whole seconds (`:.0f`): ±10% on a 5s step.

| Step label | n | min | median | p90 | max | unmeasured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Define how we measure success | 83 | 1s | 6s | 20s | 50s | 1 |
| Define the outcome | 100 | 2s | 9s | 22s | 44s | 1 |
| Set guardrails | 84 | 2s | 9s | 23s | 51s | 1 |
| Summarize reviews & recommend | 92 | 12s | 24s | 38s | 227s | 0 |

**All PM steps pooled:** median 12s, p90 28s, max 227s (n=359).

### Queue-claim latency the PM lane already pays

- **Poll latency (≤5s): n=193, median 2s, p90 2s, max 4s** — `pm_agent.main()`'s `time.sleep(2)`.
- Idle waits (>5s): n=168, median 498s — not per-step cost, listed so the split is auditable.

The ephemeral dispatcher polls on `time.sleep(3)` (`farm/farmd.py`): 0-3s, mean 1.5s.

### Spawn overhead — the cost ephemeral adds

Measured over 5 samples.

| Component | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| Cold CPython + `import farm.pm_agent` | 0.288s | 0.306s | 0.344s | 0.344s |
| tmux new/has/kill round trip | 0.028s | 0.029s | 0.031s | 0.031s |
| **Total added per step** | 0.317s | 0.337s | 0.373s | 0.373s |
