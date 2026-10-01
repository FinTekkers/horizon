# PM cross-item context reliance — a point-in-time analysis

Generated 2026-10-01 against `/home/ubuntu/.horizon-farm/logs/pm-horizon.log` for HZ-115's evidence gate (362 PM runs, 90 distinct work items). A snapshot: re-run `python -m farm.tools.analyze_pm_context_reliance` for a fresher answer.

**Corpus coverage: 169/362 runs yielded a parseable `patch` field (193 contributed nothing).** A run contributes nothing when it proposed no patch, failed, or its reply never reached the log — only `farm/providers/claude.py` echoes reply text, so **this is the Claude-routed corpus**.

## Verbatim phrase reuse across different items' patch fields

`build_prompt()` never renders one item's fields into another item's prompt, so a phrase of 8 consecutive words shared by two items' `patch` output, surviving every exclusion below, reached the later item through the resumed session.

**50 shared-phrase occurrence(s) survive every exclusion:**

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
| HZ-128 (run 889, `guardrails`) | HZ-130 (run 895, `guardrails`) | "no test regressions every test passing before this" |
| HZ-128 (run 889, `guardrails`) | HZ-130 (run 895, `guardrails`) | "test regressions every test passing before this change" |
| HZ-128 (run 889, `guardrails`) | HZ-130 (run 895, `guardrails`) | "regressions every test passing before this change passes" |
| HZ-128 (run 889, `guardrails`) | HZ-130 (run 895, `guardrails`) | "every test passing before this change passes after" |
| HZ-126 (run 873, `guardrails`) | HZ-130 (run 895, `guardrails`) | "11 defaults apply tests linters and e2e must" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "every test passing before passes after 8 defaults" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "test passing before passes after 8 defaults apply" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "passing before passes after 8 defaults apply tests" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "before passes after 8 defaults apply tests linters" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "passes after 8 defaults apply tests linters and" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "after 8 defaults apply tests linters and e2e" |
| HZ-139 (run 927, `guardrails`) | HZ-140 (run 940, `guardrails`) | "8 defaults apply tests linters and e2e must" |
| HZ-139 (run 927, `guardrails`) | HZ-144 (run 973, `guardrails`) | "each line is a prohibition 1 do not" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "8 no test regressions every test passing before" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "regressions every test passing before passes after 9" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "every test passing before passes after 9 defaults" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "test passing before passes after 9 defaults apply" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "passing before passes after 9 defaults apply tests" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "before passes after 9 defaults apply tests linters" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "passes after 9 defaults apply tests linters and" |
| HZ-141 (run 942, `guardrails`) | HZ-144 (run 973, `guardrails`) | "after 9 defaults apply tests linters and e2e" |
| HZ-130 (run 895, `guardrails`) | HZ-142 (run 1095, `guardrails`) | "9 no test regressions every test passing before" |
| HZ-124 (run 846, `desc`) | HZ-157 (run 1153, `guardrails`) | "a note in both the run output and" |
| HZ-124 (run 846, `desc`) | HZ-157 (run 1153, `guardrails`) | "note in both the run output and the" |
| HZ-124 (run 846, `desc`) | HZ-157 (run 1153, `guardrails`) | "in both the run output and the artifact" |
| HZ-156 (run 1067, `guardrails`) | HZ-157 (run 1153, `guardrails`) | "any step's output the step sequence or any" |
| HZ-156 (run 1067, `guardrails`) | HZ-157 (run 1153, `guardrails`) | "step's output the step sequence or any gate" |
| HZ-191 (run 1270, `guardrails`) | HZ-192 (run 1287, `guardrails`) | "stop and report it as a blocking finding" |

### Exclusions, each with its reason

- **role_prompt: 0 occurrence(s), 0 distinct phrase(s)** — the phrase is in `farm/roles/pm.md` or the rules under `farm/rules/`, which every prompt carries (`render_rules_section()`) — explained by the prompt.
- **own_prior: 0 occurrence(s), 0 distinct phrase(s)** — the later item's own earlier patch already wrote it, so its pre-run fields — rendered into its own prompt — carried the phrase (replayed from the log in time order, not read from the current row).
- **path_like: 5 occurrence(s), 5 distinct phrase(s)** — file-path-shaped text — two items listing the same repo files converge on it via the directory layout.
  - "farm personas py server src personas js ui"
  - "personas py server src personas js ui src"
  - "py server src personas js ui src domain"
  - "server src personas js ui src domain personas"
  - "src personas js ui src domain personas js"
- **boilerplate: 29 occurrence(s), 6 distinct phrase(s)** — written by 3+ distinct items — a stock phrase, not recall of one earlier item.
  - "7 no test regressions every test passing before"
  - "9 defaults apply tests linters and e2e must"
  - "defaults apply tests linters and e2e must pass"
  - "no test regressions every test passing before passes"
  - "regressions every test passing before passes after 8"
  - "test regressions every test passing before passes after"

**Not excludable from the log:** an item's *human-written* fields before its first PM run are not logged. A phrase a human copied into item B's issue from item A would survive every exclusion above.

## Verdict

**Load-bearing: yes, evidenced** — in one direction. The resumed session carries specific wording from one item into another. This proves the channel is live; it does not measure how much output degrades without it. Which option carries the context forward is decided in `docs/pm-step-ephemeral-recommendation.md`.
