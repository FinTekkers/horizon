# Lifecycle Tracker — Backend Handoff

This documents the data model and integration points in `Lifecycle Tracker.dc.html` so the backend can replace the in-browser mock with real data and actions.

The file is a self-contained Design Component: markup in the `<x-dc>` template, logic in the `class Component extends DCLogic` block, runtime loaded via `support.js` (token-aware bootstrap in `<head>`). All UI state currently lives in `this.state`; swap that for your API.

## Domain model

### Lifecycle definition (static)
- `PHASES = ["Plan", "Technical Plan", "Execute", "Deploy", "Review"]`
- `STEPS` — the fixed 14-step pipeline. Each step:
  ```js
  { phase: <0-4>, kind: "agent" | "gate", agent: "PM"|"QA"|"Architect"|"Eng"|"DevOps"|"Ensemble", gate: "required"|"optional", label: "…" }
  ```
  Gate steps are the human gates; agent steps are agent-owned work. A real backend can keep this fixed or serve it per-item.

### Work item
```js
{
  id: "BF-128",            // display id
  title: "…",
  priority: "Critical" | "High" | "Medium" | "Low",
  desc, metric, guardrails, // the Plan content (outcome / success metric / guardrails)
  cursor: <int>,           // index into STEPS — the current step
  paused: false,           // agents halted on this item
  rejected: false,         // current step sent back for changes
  events: [                // human/agent activity, newest first
    { who, text, color, initials }
  ]
}
```

### Derived state (helpers in the class)
- `isClosed(it)` → `cursor >= STEPS.length` (work complete)
- `curStep(it)` → `STEPS[cursor]`
- `phaseIdx(it)` → current phase (0-4); closed items map to Review
- `awaitingGate(it)` → current step is a gate and not rejected → appears in the **Pending approvals** queue

## Actions to back with endpoints

Each currently mutates `this.state` and appends to the item's `events`. Replace with API calls + optimistic update (or refetch).

| UI action | Method | Effect to implement server-side |
|---|---|---|
| Approve gate | `approve(id)` | Advance `cursor` past the gate; kick off the next agent step(s) |
| Reject (gate or step) | `reject(id, target)` → composer → `submitComposer` | Set `rejected`, record feedback text, halt agents |
| Pause / Resume | `togglePause(id)` | Toggle `paused`; stop/restart agent work |
| Restart phase | `restartPhase(id, phase)` → composer | Reset `cursor` to the phase's first step, clear `rejected`/`paused`, record reason |
| Send feedback | `openComposer("feedback", id, …)` → `submitComposer` | Append feedback to the item; **forward to the owning agent** |

The composer (`buildComposer` + `submitComposer`) is the shared modal for feedback / reject / restart; the captured text is what should be forwarded to the agent or stored as the rejection/restart reason.

### `runAgents(id)` — REMOVE / REPLACE
This is a **front-end simulation only**: after a gate approval it advances through consecutive agent steps on a timer to mimic agents working. Delete it and drive `cursor`/`events` from real agent progress (e.g. websocket/poll). The UI re-renders from `state.items`, so pushing real items in is all that's needed.

## Other integration points
- **GitHub issues:** the `ISSUE` map + `REPO` constant build the per-item issue links (board card + tracker header). Replace placeholder numbers with real issue IDs, or add an `issue` field per item and read it.
- **Agents:** `AGENTS` maps agent keys → label/initials/color. Extend as needed.
- **Identity:** human actions are logged as `who: "You"`; wire to the real user.

## Suggested API shape
- `GET /items` → `[item]` (above shape)
- `POST /items/:id/gates/:stepIndex/approve`
- `POST /items/:id/reject` `{ stepIndex, feedback }`
- `POST /items/:id/pause` `{ paused }`
- `POST /items/:id/phases/:phase/restart` `{ reason }`
- ~~`POST /items/:id/feedback`~~ — **dropped by product decision (2026-07-18)**:
  standalone feedback had no delivery moment; feedback reaches agents only via
  gate approve-with-comments or send-back/rework, which re-runs the step.
- Stream/poll item updates so `runAgents` can be dropped.
