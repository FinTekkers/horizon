# PM cross-item context reliance — a point-in-time analysis

Generated 2026-09-30 against `/home/ubuntu/.horizon-farm/logs/pm-horizon.log`, for HZ-115's evidence gate: "Is the accumulated cross-item context actually load-bearing?" (247 PM runs, 61 distinct work items in this log.)

**This is a snapshot, not an ongoing metric.** It reflects one production `pm-<slug>.log` file at generation time; re-run `python -m farm.tools.analyze_pm_context_reliance` and recommit this file against a fresher log for an updated answer.

## Signal 1 — verbatim phrase reuse across different items' patch fields

`farm/pm_agent.py`'s `build_prompt()` never renders one item's `desc`/`metric`/`guardrails` into another item's prompt — each item's prompt carries only its own fields. So a word-for-word phrase shared between two different items' `patch` output can only have reached the second item's reply through the resumed session's own memory of writing the first, not through anything explicitly given to the model this call.

**22 shared-phrase occurrence(s) found, on wording specific enough it is not plausibly independent convergence — cross-item memory reuse is present in this log:**

| Earlier item (run) | Later item (run) | Shared phrase |
| --- | --- | --- |
| HZ-33 (run 211, `metric`) | HZ-76 (run 536, `desc`) | "retry visible in the activity feed a checks" |
| HZ-33 (run 211, `metric`) | HZ-76 (run 536, `desc`) | "visible in the activity feed a checks failed" |
| HZ-33 (run 211, `metric`) | HZ-76 (run 536, `desc`) | "in the activity feed a checks failed failure" |
| HZ-77 (run 538, `desc`) | HZ-94 (run 641, `desc`) | "category cause attempts used and next action instead" |
| HZ-77 (run 538, `desc`) | HZ-94 (run 641, `desc`) | "cause attempts used and next action instead of" |
| HZ-77 (run 538, `desc`) | HZ-94 (run 641, `desc`) | "attempts used and next action instead of just" |
| HZ-77 (run 538, `desc`) | HZ-94 (run 641, `desc`) | "used and next action instead of just 'paused" |
| HZ-77 (run 538, `desc`) | HZ-94 (run 641, `desc`) | "and next action instead of just 'paused '" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "an item blocked by another shows what blocks" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "item blocked by another shows what blocks it" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "blocked by another shows what blocks it and" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "by another shows what blocks it and what" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "another shows what blocks it and what would" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "shows what blocks it and what would unblock" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "what blocks it and what would unblock it" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "an item with dependents shows what's waiting behind" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "item with dependents shows what's waiting behind it" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "on the board blocked is visually distinct from" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "the board blocked is visually distinct from idle" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "board blocked is visually distinct from idle paused" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "blocked is visually distinct from idle paused and" |
| HZ-79 (run 546, `desc`) | HZ-95 (run 642, `desc`) | "is visually distinct from idle paused and queued" |

**5 additional occurrence(s) excluded as file-path-shaped text** — the shared shingle was built from a token that sat directly against a `/` or `.` in the source text (e.g. a list of source file paths). Two items independently listing the same repo files produce this identical word sequence with zero cross-item recall involved — it is determined by the directory layout, not by anything carried from a resumed session:

- "farm personas py server src personas js ui"
- "personas py server src personas js ui src"
- "py server src personas js ui src domain"
- "server src personas js ui src domain personas"
- "src personas js ui src domain personas js"

**2 additional occurrence(s) excluded as likely convergent boilerplate** — the shared shingle recurs across 3+ distinct items independently, more consistent with a stock phrase the model drafts the same way regardless of memory than with recall of one specific earlier item:

- "defaults apply tests linters and e2e must pass"

## Signal 2 — cross-item ID mentions (weaker signal, reported for context)

A run's reply mentioning a *different* item's ID. This does **not** distinguish cross-item memory from a legitimate reference already present in the current item's own `desc`/`guardrails` text (which the current item's own prompt does carry) — reported as raw counts for a human to read the excerpts and judge, not as a standalone verdict.

**87 mention(s) found:**

| Run | Item | Step | Mentions | Excerpt |
| --- | --- | --- | --- | --- |
| 129 | HZ-18 | Define how we measure success | HZ-13 | ...h({"command": "printf '%s' \"Every core HZ-13 journey (at least 8) has a named screen... |
| 129 | HZ-18 | Define how we measure success | HZ-13 | ...   "patch": {     "metric": "Every core HZ-13 journey (at least 8) has a named screen... |
| 131 | HZ-18 | Set guardrails | HZ-13 | ...wright browsers are missing. Depends on HZ-13 landing first. Push screenshots before ... |
| 141 | HZ-18 | Summarize reviews & recommend | HZ-13 | ... Each of the 9 core browser tests (from HZ-13) takes one screenshot of the screen it ... |
| 151 | HZ-18 | Summarize reviews & recommend | HZ-13 | ... Each of the 9 core browser tests (from HZ-13) takes one screenshot of the screen it ... |
| 161 | HZ-25 | Define how we measure success | HZ-13 | ...'%s' \"An automated e2e test (extending HZ-13's suite) toggles dark mode from the top... |
| 161 | HZ-25 | Define how we measure success | HZ-13 | ...ric": "An automated e2e test (extending HZ-13's suite) toggles dark mode from the top... |
| 188 | HZ-21 | Summarize reviews & recommend | HZ-18 | ...n be tested automatically, the same way HZ-18's tests fake out other external pieces.... |
| 192 | HZ-29 | Define the outcome | HZ-4 | ... silently cut off mid-document like the HZ-4 incident. Both the dispatch side (orche... |
| 197 | HZ-30 | Set guardrails | HZ-4 | ...ight items, per the quiesce lesson from HZ-4's double-shift incid…) [14:01:11] 378 c... |
| 197 | HZ-30 | Set guardrails | HZ-4 | ...ight items, per the quiesce lesson from HZ-4's double-shift incident. Hard cap: 3 re... |
| 204 | HZ-31 | Define the outcome | HZ-21 | ...r than one budget (as happened twice on HZ-21). The next attempt's prompt names the c... |
| 207 | HZ-32 | Define the outcome | HZ-21 | ...closes the gap where paused items (like HZ-21, unnoticed for 3 days) go undetected un... |
| 210 | HZ-33 | Define the outcome | HZ-31 | ... session) and turn/time exhaustion (via HZ-31's checkpoint salvage) retry automatical... |
| 212 | HZ-33 | Set guardrails | HZ-31 | ...odel decides retry behavior. Depends on HZ-31 — sequence after it. No pipeline-struct... |
| 222 | HZ-37 | Define the outcome | HZ-36 | ...js` bug fix (Node backend, same file as HZ-36/HZ-21) — no UI or Python component. Cla... |
| 222 | HZ-37 | Define the outcome | HZ-21 | ...g fix (Node backend, same file as HZ-36/HZ-21) — no UI or Python component. Classifyi... |
| 222 | HZ-37 | Define the outcome | HZ-36 | ...t and classified as fullstack — same as HZ-36, pure Node backend work in server/src/a... |
| 224 | HZ-37 | Set guardrails | HZ-36 | ...ema as defense in depth. Runs AFTER the HZ-36 allowlist check — non-allowlisted email... |
| 255 | HZ-43 | Define the outcome | HZ-21 | ...updated — instead of every deploy since HZ-21 being wrongly marked FAILED. The stale ... |
| 316 | HZ-51 | Set guardrails | HZ-46 | ...ctness check, explicit UI scope (citing HZ-46's gap as a cautionary precedent), and a... |
| 332 | HZ-53 | Set guardrails | HZ-50 | ...rialization (with its rationale tied to HZ-50), no cap increase in this item, session... |
| 369 | HZ-59 | Set guardrails | HZ-53 | ...on, distinct-state modeling (citing the HZ-53 workaround as a cautionary precedent), ... |
| 388 | HZ-62 | Set guardrails | HZ-30 | ...tion with a named regression precedent (HZ-30), an explicit anti-pattern to avoid (th... |
| 410 | HZ-63 | Define the outcome | HZ-18 | ...ly on merge, offline support, preserved HZ-18 guarantee) and classified as fullstack/... |
| 410 | HZ-63 | Define the outcome | HZ-18 | ...ork with no baseline available, and the HZ-18 silent-failure regression still fails l... |
| 412 | HZ-63 | Define how we measure success | HZ-18 | ...ehaviors, and preservation of the named HZ-18 regression check. No changes needed. [1... |
| 413 | HZ-63 | Set guardrails | HZ-18 | ...omprehensive and specific: preserve the HZ-18 loud-failure guarantee, missing-baselin... |
| 413 | HZ-63 | Set guardrails | HZ-18 | ...rdrails; already comprehensive — covers HZ-18 preservation, missing-baseline handling... |
| 429 | HZ-66 | Define the outcome | HZ-21 | ... model error, and every other caller of HZ-21-gated routes has been audited.","person... |
| 472 | HZ-33 | Summarize reviews & recommend | HZ-31 | ...rse than the one this ticket fixes; the HZ-31 sequencing decision was also never conf... |
| 472 | HZ-33 | Summarize reviews & recommend | HZ-31 | ...tion) — never just \"Paused.\"\n- Since HZ-31 (checkpoint salvage) doesn't exist yet,... |
| 472 | HZ-33 | Summarize reviews & recommend | HZ-31 | ...note (carried from the options doc)** — HZ-31, which this ticket's own guardrails say... |
| 472 | HZ-33 | Summarize reviews & recommend | HZ-31 | ...n\n## Actions\n1. PM/human: confirm the HZ-31 sequencing decision — ship the descope-... |
| 472 | HZ-33 | Summarize reviews & recommend | HZ-31 | ...rt approach, or block this ticket until HZ-31 lands.\n2. Plan author: fix the retry-b... |
| 502 | HZ-63 | Summarize reviews & recommend | HZ-18 | ...ural (only `mergePr` can write it), the HZ-18 guarantee is genuinely untouched — **ad... |
| 537 | HZ-76 | Define how we measure success | HZ-33 | ...ement behavior (the exact failure class HZ-33's review caught). No changes needed. [1... |
| 539 | HZ-76 | Set guardrails | HZ-33 | ... the exact unbounded-retry bug found in HZ-33's review.","patch":{"guardrails":"Auto-... |
| 539 | HZ-76 | Set guardrails | HZ-33 | ..., it has drifted and should be stopped. HZ-33 failed precisely because both halves we... |
| 539 | HZ-76 | Set guardrails | HZ-31 | ...halves were one step.\n\nSequence after HZ-31 (checkpoint salvage), which is already ... |
| 541 | HZ-77 | Set guardrails | HZ-33 | ... `ui/src`-only scope discipline (citing HZ-33's failure mode), graceful degradation f... |
| 544 | HZ-78 | Define how we measure success | HZ-77 | ...e: a concrete end-to-end demonstration (HZ-77/HZ-76), specific API-payload behavior, ... |
| 544 | HZ-78 | Define how we measure success | HZ-76 | ...oncrete end-to-end demonstration (HZ-77/HZ-76), specific API-payload behavior, explic... |
| 545 | HZ-78 | Set guardrails | HZ-33 | ...ry between blocked and paused (with the HZ-33 incident as rationale), fail-closed cyc... |
| 556 | HZ-81 | Define the outcome | HZ-5 | ...er than silently producing nothing. The HZ-5 cost guardrail is deliberately replaced... |
| 558 | HZ-81 | Set guardrails | HZ-5 | ...nsive and specific: preservation of the HZ-5 cost guardrail with a deliberate replac... |
| 560 | HZ-76 | Summarize reviews & recommend | HZ-59 | ... retry `kick()`, mirroring the existing HZ-59 precedent — **open** — add it.\n- **QA*... |
| 561 | HZ-81 | Set guardrails | HZ-5 | ...:{"guardrails":"Do NOT quietly drop the HZ-5 cost guardrail — but do not treat it as... |
| 561 | HZ-81 | Set guardrails | HZ-76 | ...he orchestrator's retry classification (HZ-76) depends on distinguishing exhaustion f... |
| 571 | HZ-78 | Summarize reviews & recommend | HZ-33 | ...ill silently won't dispatch — the exact HZ-33 failure mode the guardrail names — **op... |

...and 37 more occurrence(s), truncated for table length — full count above.

## Verdict

**Load-bearing: yes, evidenced.** Signal 1 shows the model carrying specific, exact wording from one item's `patch` output into a different item's reply — this could only happen via the resumed session's memory, since `build_prompt()` never sends that wording for any item but its own. Per HZ-115's guardrails, this means migrating to ephemeral execution should not delete this context outright — it should be replaced with an explicit, reproducible digest injected into the prompt (Option D's premise, folded into Option A's migration), not silently dropped.

