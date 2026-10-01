<!-- Generated 2026-10-01 on the farm host by: python -m farm.tools.pm_run_timings --spawn-bench 20 (raw output, unedited). HZ-212 metric 6: this is SPAWN overhead — a cold CPython importing farm.pm_agent plus a tmux new/has/kill round trip — not claim-to-start; the farmd-side claim overhead is timed in-suite by farm/tests/test_pm_per_task.py. -->

## Measured per-step cost

Source: `/home/ubuntu/.horizon-farm/logs/pm-horizon.log` — **401 PM runs** across 96 work items.

**Corpus coverage: 398/401 runs carry a timing line (3 unmeasured).** Only `farm/providers/claude.py` prints it; `farm/providers/muse.py` does not, so a Muse-routed run is counted as unmeasured rather than dropped. Times are whole seconds (`:.0f`): ±10% on a 5s step.

| Step label | n | min | median | p90 | max | unmeasured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Define how we measure success | 91 | 1s | 6s | 20s | 50s | 1 |
| Define the outcome | 114 | 2s | 8s | 22s | 44s | 1 |
| Set guardrails | 92 | 2s | 8s | 22s | 51s | 1 |
| Summarize reviews & recommend | 101 | 12s | 24s | 41s | 227s | 0 |

**All PM steps pooled:** median 12s, p90 28s, max 227s (n=398).

### Queue-claim latency the PM lane already pays

- **Poll latency (≤5s): n=214, median 2s, p90 2s, max 4s** — `pm_agent.main()`'s `time.sleep(2)`.
- Idle waits (>5s): n=185, median 547s — not per-step cost, listed so the split is auditable.

The ephemeral dispatcher polls on `time.sleep(3)` (`farm/farmd.py`): 0-3s, mean 1.5s.

### Spawn overhead — the cost ephemeral adds

Measured over 20 samples.

| Component | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| Cold CPython + `import farm.pm_agent` | 0.262s | 0.275s | 0.295s | 0.315s |
| tmux new/has/kill round trip | 0.016s | 0.02s | 0.025s | 0.029s |
| **Total added per step** | 0.282s | 0.294s | 0.324s | 0.341s |

Raw per-sample totals (seconds):

```
0.324
0.302
0.283
0.288
0.282
0.290
0.313
0.289
0.283
0.294
0.305
0.294
0.341
0.298
0.284
0.288
0.310
0.299
0.294
0.336
```
