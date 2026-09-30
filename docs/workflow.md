# Workflow — how a task moves from definition to done

Every unit of work in Horizon is a **work item** (usually backed by a GitHub
issue). Every work item follows the exact same fixed sequence of steps —
there is no per-item customization today. That sequence is defined once, in
code, at `domain/steps.json`, as five **phases** containing sixteen
**steps**. Every consumer — server, UI, farm and the e2e suite — reads a
generated binding of that one file; see [`domain/README.md`](../domain/README.md). This doc explains that sequence for a reader who has never seen
the codebase.

## The two kinds of step

- 🤖 **Agent step** — the server hands the step to an AI agent (via the farm,
  see [`docs/architecture.md`](architecture.md)) and waits for it to report
  back. No human action is required to *start* it.
- 🚦 **Gate step** — work stops here until a human clicks Approve (or
  Reject) in the UI. Every gate in the current lifecycle is `required`.

## The full sequence

```mermaid
flowchart TD
    subgraph P0["Phase 1 — Plan"]
        S0["🤖 PM: Define the outcome"]
        S1["🤖 PM: Define how we measure success"]
        S2["🤖 Architect: Set guardrails"]
        S3["🚦 GATE: Approve & prioritize this work"]
        S0 --> S1 --> S2 --> S3
    end

    subgraph P1["Phase 2 — Technical Plan"]
        S4["🤖 PM+QA+Architect: Plan options & trade-offs"]
        S5["🚦 GATE: Approve the high-level design"]
        S6["🤖 Eng: Draft implementation plan"]
        S7["🤖 Architect: Architecture review"]
        S8["🤖 QA: QA reviews the test plan"]
        S9["🤖 PM: Summarize reviews & recommend"]
        S10["🚦 GATE: Review before execution"]
        S4 --> S5 --> S6 --> S7 --> S8 --> S9 --> S10
    end

    subgraph P2["Phase 3 — Execute"]
        S11["🤖 Eng: Specialist agent implements"]
        S12["🤖 Review: Automated review (code + QA)"]
        S13["🚦 GATE: Accept the code"]
        S11 --> S12 --> S13
    end

    subgraph P3["Phase 4 — Deploy"]
        S14["🤖 DevOps: Deploy the changes"]
    end

    subgraph P4["Phase 5 — Review"]
        S15["🚦 GATE: Review the work & close"]
    end

    S3 --> S4
    S10 --> S11
    S13 --> S14
    S14 --> S15

    style S3 fill:#DFA200,color:#000
    style S5 fill:#DFA200,color:#000
    style S10 fill:#DFA200,color:#000
    style S13 fill:#DFA200,color:#000
    style S15 fill:#DFA200,color:#000
```

Yellow boxes are gates (human required); the rest run automatically once
their turn comes up. This mirrors `phases` and `steps` in
`domain/steps.json` exactly — that file is the source of truth, and this
diagram will drift if it changes without this doc being updated.

## Which agent does what

Every agent step names an agent by its `agent` field in `domain/steps.json`.
The role's presentation (label, initials, colour) is a separate, hand-owned
concern: `server/src/agentTokens.js` server-side, `ui/src/domain/agentTokens.js`
in the UI.

| Agent | Role |
| --- | --- |
| **PM** | Defines outcome/success criteria, synthesizes review summaries |
| **Architect** | Sets guardrails, reviews architecture of a plan |
| **Ensemble** | PM + QA + Architect together, for the options/trade-offs step |
| **Eng** | Drafts the implementation plan, then implements the code |
| **QA** | Reviews whether the test plan is sufficient |
| **Review** | Automated code + QA review after implementation |
| **DevOps** | Deploys the change |

The table above names the *label* a step shows in the UI; it does not say
which *process* actually executes it. Two steps that look like separate
agent roles (0/1/9 as PM, 2 as Architect) share one long-lived PM process,
while every other agent step gets a fresh, short-lived process per run:

| Step index | Label | Executes as |
| --- | --- | --- |
| 0 | Define the outcome | PM session |
| 1 | Define how we measure success | PM session |
| 2 | Set guardrails | PM session |
| 4 | Plan options & trade-offs (pros / cons) | fresh agent |
| 6 | Draft implementation plan | fresh agent |
| 7 | Architecture review | fresh agent |
| 8 | QA reviews the test plan | fresh agent |
| 9 | Summarize reviews & recommend | PM session |
| 11 | Specialist agent implements | fresh agent |
| 12 | Automated review (code + QA) | fresh agent |
| 14 | Deploy the changes | fresh agent |

(Gates — 3, 5, 10, 13, 15 — are covered above; they get no agent at all.)
Sourced from `domain/steps.json`, `farm/farmd.py`'s lane routing and
`farm/step_agent.py`'s `STEP_CONFIG`. See
[`docs/agent-architecture.md`](agent-architecture.md) for why that PM/fresh
split exists, why the PM's long-lived session makes steps 0/1/2/9
non-reproducible, and how a step's AI provider is actually chosen.

## What "current step" and "done" mean

Each work item stores a single number, `cursor` — its index into the 16-step
`STEPS` array. `curStep(item)` (`domain/js/lifecycle.js`) looks up
`STEPS[item.cursor]` to find what's next; an item is closed
(`isClosed`, same file) once `cursor >= STEPS.length`, i.e. it has
passed the final "Review the work & close" gate. There is no other "done"
state — paused and blocked (below) are both independent of, and do not
change, the cursor.

## A concrete walk-through

1. A human (or a synced GitHub issue) creates a work item. Its `cursor`
   starts at `0` — step 1, "Define the outcome," a PM agent step.
2. The orchestrator (`server/src/orchestrator.js`) sees the item is
   `runnable()` and dispatches step 0 to the farm. The PM agent runs, writes
   its output back via `POST /api/farm/steps/:runId/complete`, and the
   orchestrator advances `cursor` to `1`.
3. Steps 1 and 2 repeat the same agent-dispatch pattern.
4. `cursor` reaches step 3, a gate. The orchestrator stops — no agent is
   dispatched. The item sits here until a human opens the UI and approves.
5. On approval, `cursor` advances to `4` and Phase 2 begins the same way:
   agent steps run automatically, gate steps wait for a human.
6. This repeats through Phase 3 (Execute — the actual code gets written and
   reviewed), Phase 4 (Deploy — a real GitHub Release gets published and the
   host redeploys, see [`docs/architecture.md`](architecture.md)), and
   Phase 5 (a final human review and close).
7. Once `cursor` passes index 15 (the last step), `isClosed(item)` is `true`
   and the item is done.

## Two things that can interrupt "ever-forward"

- **Paused.** A human can pause an item at any point (a UI action, tracked
  separately from `cursor`). A paused item's steps simply don't get
  dispatched until resumed.
- **Blocked (dependencies, see `README.md`'s Dependencies section).** A work
  item can declare it depends on another. `isBlocked`
  (`domain/js/lifecycle.js`)
  checks whether *any* declared blocker has not yet closed; if so, the
  orchestrator's `runnable()` refuses to dispatch this item's steps at all,
  regardless of `cursor`. A blocker that is abandoned (soft-deleted, not
  closed) still blocks — `isBlockedByAbandoned` flags this case distinctly
  so it doesn't silently look like ordinary in-progress work.

Both are independent of the phase/step sequence itself — they gate *whether*
the next step runs, not *which* step is next.

See [`docs/architecture.md`](architecture.md) for how each step's agent
dispatch physically works (server → farm → tmux → agent → server).
