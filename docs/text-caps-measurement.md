# Text-cap firing rates — a point-in-time measurement

Generated 2026-09-29 against a live `horizon.db`, for HZ-114's success metric: "Measured over current real items, we can state how often each remaining cap actually fires. A cap that never fires is recorded as such rather than assumed."

**This is a snapshot, not an ongoing metric.** It reflects the rows in the database at generation time; re-run `python -m farm.tools.measure_text_caps` and recommit this file for a fresh answer. No telemetry runs continuously for any of these caps except `orchestrator.js`'s existing `logArtifactBudgetUsage()` line (HZ-104), which is unrelated to the caps below.

| Cap | Site | Verdict |
| --- | --- | --- |
| work_item.desc (pre-HZ-114 ingest cap, now removed) (cap 500) | server/src/store.js parseIssueBody (removed by this item) | fires (51/65 rows at-or-over 500 chars) |
| work_item.metric (PM patch-revision budget) (cap 400) | farm/pm_agent.py PATCH_FIELDS['metric'] | fires (37/65 rows at-or-over 400 chars) |
| work_item.guardrails (PM patch-revision budget) (cap 400) | farm/pm_agent.py PATCH_FIELDS['guardrails'] | fires (44/65 rows at-or-over 400 chars) |
| step_run.output (agent summary) (cap 600) | farm/step_agent.py / farm/pm_agent.py summary[:600] / summary[:300] | fires (7/811 rows at-or-over 600 chars) |
| step_run.output (PM agent summary variant) (cap 300) | farm/pm_agent.py summary[:300] | fires (136/811 rows at-or-over 300 chars) |
| feedback.message (human/UI feedback ingest cap) (cap 2,000) | server/src/store.js addFeedback (line ~650) | fires (18/118 rows at-or-over 2,000 chars) |
| feedback.message (automated review feedback cap) (cap 2,000) | server/src/orchestrator.js formatReviewFeedback (line ~903) | fires (18/118 rows at-or-over 2,000 chars) |
| event.text (activity feed line) (cap 300) | server/src/orchestrator.js addEvent(...text.slice(0,300)...) | fires (140/1776 rows at-or-over 300 chars) |

## Notes

- **work_item.desc (pre-HZ-114 ingest cap, now removed):** This item deleted this cap — it never defended a real boundary. Counted here to show how often the deleted cap would have fired.
- **work_item.metric (PM patch-revision budget):** Enforced only when a PM-agent revision patches this field, not at original ingest — a current value at the cap suggests a PM revision hit the marked-fallback path in farm/pm_agent.py validate().
- **work_item.guardrails (PM patch-revision budget):** Same mechanism as metric above — this is the exact field HZ-114's outcome names for the PM-revision bug.
- **step_run.output (agent summary):** Two different summary caps exist across the codebase (600 in step_agent.py, 300 in pm_agent.py) — measured at the looser of the two so a pm_agent.py-authored row isn't miscounted as never hitting its own, tighter cap. See the 400-cap variant below for that.
- **feedback.message (automated review feedback cap):** Same column, same cap value as the row above, different write path (review-cycle failures insert straight into `feedback`, bypassing addFeedback's own slice) — kept as a separate row because architecture review flagged this exact site as the class of bug HZ-79 hit: a raw, unmarked slice feeding the next prompt's 'Human feedback to address' section. Not fixed by this item's scope (only the three outcome-named sites were); measured so a future decision about it has real data, not a guess.
- **event.text (activity feed line):** event.text wraps the sliced fragment in a longer templated sentence, so a row's *total* length can exceed 300 even though the embedded fragment was capped — this measures the whole stored string, which is a conservative (over-count-safe) proxy.

## A comment that drifted (architecture review, HZ-114)

`farm/pm_agent.py`'s `MAX_PROMPT_ARTIFACT_CHARS` comment used to say it "mirrors farm/rules.py's MAX_PROMPT_RULES_CHARS backstop." That's no longer true: `rules.py` now drops whole rules blocks with a note instead of slicing, and `MAX_PROMPT_ARTIFACT_CHARS` still does a flat `[:N]` slice on prior-artifact content in both `pm_agent.py` and `step_agent.py`. Neither is one of the three sites this item's outcome named for a fix, so both are left as-is — flagged here (and in the code comment) rather than fixed blind, per this item's own guardrail against rewriting caps the outcome didn't name.
