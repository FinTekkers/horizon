# ADR 0001: Asks — follow-up and prerequisite work that agents raise

- **Status:** Accepted
- **Deciders:** the owner
- **Plan:** see the Plan item that links this ADR

## Context

Agents often find work that belongs in another item: a fix another item must land first, a follow-up
that is out of scope, or a decision only the owner can make. Today they write it as prose in a step's
artifact ("**Human:** file a follow-up item…", "Do not approve until X merges", "Consider a follow-up
item"). Nothing in Horizon reads that prose.

The one structured exception is the PM's `split` (`farm/roles/pm.md`, `server/src/split.js`): when the
summary narrows the metric, Horizon files the deferred lines as a follow-up item when "Review before
execution" is approved, and Caretaker refuses a deferred line with no filed follow-up.

Between 3 Oct and 3 Nov 2026, across 4,069 finished steps:

| Kind of ask | Items | Nothing followed | On Autopilot | Caretaker approved a gate after | Merged anyway |
|---|---|---|---|---|---|
| Explicit filing ask ("Human: file…") | 196 | 84 | 77 | 67 | 49 |
| Hard prerequisite ("must merge first", "do not start until") | 112 | 21 | 17 | 13 | 15 |
| Soft suggestion ("consider a follow-up item") | 381 | 185 | 170 | 145 | 111 |

The cost shows up late. HZ-699 reached "Approve the run" before its impact review found that the
publish script would commit under the owner's GitHub identity; the needed fix had no item, so nothing
would ever land it.

## Decision

1. **Agents raise asks as data, fully drafted.** Any review, summary, Assess or Run plan step may return
   an `asks` list next to its artifact. Each ask has:
   - `kind`: `blocking` (this item cannot finish correctly without it) or `soft` (worth doing, not needed here);
   - a complete draft item: `title`, `repo`, `outcome`, a lean 3–5 line `metric`, `guardrails`;
   - `why`: one line, with the step and artifact line that prompted it.
   Prose like "Human: file…" is replaced by an ask. The PM's `split` stays as it is, and is shown as an
   ask of kind `split` so every follow-up appears in one place.
2. **Every ask is reviewed by an independent AI.** Before acceptance, a reviewer running on a different
   provider from the ask's author (Muse by default) checks fit with the repo's architecture, QA and
   project rules; overlap with open items (an open Plan covering the area means "amend that Plan", not a
   new item); and shape (lean metric, guardrails, size). Its verdict is `accept`, `amend` (with the edit)
   or `escalate`.
3. **Asks are put up for acceptance.**
   - Blocking asks show prominently on the item page and in the Approvals drawer.
   - Soft asks show quietly, as "Suggested follow-ups" on the item and in a project-wide list.
   - **File it** files the draft as an item. For a blocking ask it also links the new item as a
     dependency of the asking item.
   - **Dismiss** needs a reason, which is fed back to the asking agent.
4. **Autopilot treats asks like gates.** With Autopilot on, Caretaker files asks the reviewer accepted
   and escalates the rest. With Autopilot off, the owner decides, with the reviewer's verdict shown.
5. **No silent approvals.** Caretaker never approves a gate while the item has an open blocking ask.
6. **A start check.** Before Implement or Execute, every blocking ask must be filed and its item merged
   (or closed), or the item waits with that reason (a hold, see HZ-713).

## Consequences

- Follow-up work is never lost in prose; every ask is filed, dismissed with a reason, or still visible.
- Autopilot can no longer approve past an unresolved prerequisite.
- One more review per ask costs some tokens; asks are rarer than steps, and the reviewer's job is small.
- Role prompts change: agents must return asks rather than prose instructions to the owner.
- The split mechanism keeps working unchanged; unifying it fully with asks is left for later.

## Alternatives considered

- **Parse the prose.** Fragile and silent when it misses; rejected.
- **Let the authoring agent file items directly.** No independent check on overlap or architecture,
  and Autopilot would multiply unreviewed items; rejected.
- **Only block on hard prerequisites, drop soft suggestions.** Loses useful follow-ups; soft asks are
  kept but shown quietly.

## Documentation changes

| File | Change |
|---|---|
| `docs/adr/README.md` (new) | The ADR convention: numbering, statuses, template, index |
| `docs/adr/0001-agent-asks.md` (new) | This ADR |
| `docs/README.md` | Index lines for `adr/` and ADR 0001 |
| `docs/workflow.md` | New section "Asks"; "Two things that can interrupt ever-forward" becomes three (open blocking asks); "Which agent does what" gains the ask reviewer |
| `README.md` (Dependencies) | Dependencies created by accepted blocking asks; the start check |
| `docs/agent-architecture.md` | The ask review step and its provider rule (a different provider from the author) |
| `docs/architecture.md` | Where asks live: table, routes, UI components |
| `docs/project-onboarding.md` §8 | What Autopilot does with asks; triaging Suggested follow-ups |
| `farm/README.md` | The `asks` field in a step reply, and ask review dispatch |
| `farm/roles/pm.md`, `qa_review.md`, `code_review.md`, `architect_review.md`, `task_assess.md`, `task_impact_review.md` | Return asks instead of "Human: file…" or "Consider a follow-up item" prose |
| `farm/roles/caretaker.md` | New rule: an open blocking ask means never approve; file reviewer-accepted asks |
| `farm/roles/ask_review.md` (new) | The independent reviewer's role |
| `infra/host/DEPLOY.md` | None expected (no new settings) |
