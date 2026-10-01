# Text-cap firing rates — a point-in-time measurement

Generated 2026-09-29 against a live `horizon.db`, for HZ-114's success metric: "Measured over current real items, we can state how often each remaining cap actually fires. A cap that never fires is recorded as such rather than assumed."

**This is a snapshot, not an ongoing metric.** It reflects the rows in the database at generation time; re-run `python -m farm.tools.measure_text_caps` and recommit this file for a fresh answer. No telemetry runs continuously for any of these caps except `orchestrator.js`'s existing `logArtifactBudgetUsage()` line (HZ-104), which is unrelated to the caps below.

> **Stale as of 2026-09-30 — HZ-134 raised two of these caps, and this file was not regenerated.**
>
> The `work_item.metric` and `work_item.guardrails` rows below describe a 400-char PM-revision cap that no longer exists. HZ-134 declared each work-item field's limit once, in `domain/fields.json`, and raised the PM caps to the API's own numbers: `desc` 500 → 4,000, `metric` 400 → 2,000, `guardrails` 400 → 2,000. The tool itself reads the live numbers from that declaration now, so **re-running it produces correct rows**; this committed output is simply older than the change.
>
> It was deliberately not regenerated: that needs the live `horizon.db` on the production host, which CI does not have, and inventing numbers would be worse than a dated caveat. The two verdicts below ("fires, 37/65" and "fires, 44/65") remain true statements about the 400-char cap that was in force when they were measured.
>
> One consequence worth stating: a value sitting exactly at the cap no longer implies a PM revision hit it, because the ingest limit and the PM limit are now the same number — a human could have typed exactly that much. A PM revision that ran over is still identifiable by the `chars omitted` marker HZ-114 appends.

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

## MAX_PROMPT_RULES_CHARS: a cap that cannot fire given today's sibling caps

`render_rules_section()`/`renderRulesSection()`'s whole-part-drop branch (this item's fix) is unit-tested directly against hand-built oversized parts, but tracing the only real caller — `resolve_rules()`/`resolveRules()` — shows it can never actually receive input large enough to trigger that branch:

- `resolve_rules()` produces at most two parts (project rules, repo rules).
- Each part already passed through `_read_capped()`/`readCapped()`, which drops (returns `''` for) any file over `MAX_RULES_BYTES`/`MAX_DEFINITION_BYTES` = 8,192 bytes — the UI's save endpoint enforces the same 8,192-byte ceiling on write, so a file can't even get onto disk larger than that through the product's own write path either.
- Two parts × 8,192 bytes = 16,384 chars maximum, strictly less than `MAX_PROMPT_RULES_CHARS` = 24,000.

So today, the drop-whole-part branch is reachable only by a caller that hands `render_rules_section()`/`renderRulesSection()` a list built some other way than `resolve_rules()`/`resolveRules()` — which is exactly what its unit tests do, and exactly why an end-to-end test through the live `/api/definitions/effective` endpoint (`e2e/tests/14-definitions-preview.spec.js`, added by this item) can only exercise the *non-drop* composition path with real files, never the drop-with-note path. This isn't a gap in test coverage; it's what "measured over current real items" means applied statically instead of historically — the cap is real defense-in-depth (documented in `rules.py` as guarding against "runaway input, not rules") for a future third rules layer or a raised per-file limit, not something reachable today. If `MAX_RULES_BYTES`/`MAX_DEFINITION_BYTES` is ever raised, or a third rules layer is added, this arithmetic should be rechecked.

## E2E coverage added by this item, and what's still Python-only

`e2e/tests/14-definitions-preview.spec.js` drives the real `/definitions` UI page and the real `GET /api/definitions/effective` route against a real file in this repo (`farm/rules/projects/fintekkers.md`) — proving the `resolveRules`/`renderRulesSection` refactor composes correctly through the live production path, not just in unit tests. It deliberately never exercises Save (`writeDefinition`), which commits to git and pushes to `origin` — doing that from a test run would create real commits against this checkout.

`server/test/webhook-issue-ingest.test.mjs` drives the real `/api/webhooks/github` route (HMAC-verified, real `upsertFromGithub` → `parseIssueBody` → DB write/read) to prove the HZ-113 fix survives a real webhook ingest end to end, not just a direct call to `parseIssueBody()`. It's a Node integration test against the real Fastify app (`buildApp().inject()`), not a Playwright spec — Playwright's e2e suite runs the server in demo mode with `GITHUB_WEBHOOK_SECRET`/`GITHUB_TOKEN`/`HORIZON_REPO` all unset (see `e2e/playwright.config.js`'s `webServer.env`) specifically so it never talks to real GitHub, so this path is structurally unreachable from Playwright.

The PM-guardrails marked-fallback fix (`farm/pm_agent.py`'s `_mark_truncated`) has no live-server or e2e path at all to exercise it from: `farm/pm_agent.py` is a separate long-running process driven by a real Claude Code session outside this repo's test infrastructure, and the e2e/demo server's `server/src/orchestrator.js` `MOCK_STEP_BEHAVIOR` fakes every agent step's output in-process — it never calls into any Python farm code. This is the same "mock-path" boundary this item's guardrails explicitly say not to touch. Coverage for this fix is pytest-only (`farm/tests/test_pm_agent.py`), matching how every other `farm/pm_agent.py` behavior in this codebase is tested.
