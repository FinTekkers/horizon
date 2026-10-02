## Context from the code

- Gates are step indexes `3, 5, 10, 13, 15` in `domain/steps.json`. Index `3` is "Approve & prioritize".
- `server/src/gateNotifier.js` already detects gate arrivals as **derived state**. It does not hook into cursor writes. It reconciles the persisted `work_item.notified_step` against `cursor` from `store.onChange`.
  - That design already handles restarts and send-back re-arrivals.
- The PIN-protected per-project flag pattern exists: `POST /api/projects/:id/enabled` (HZ-207/208).
- **Blocking schema finding:** `event.item_id` is `NOT NULL`. The success metric asks for a project-level Autopilot change event, and nothing can hold one today. Every option below adds a small `project_event` table for this.
- Facts the caretaker needs are already persisted:
  - step artifacts in `step_run`
  - `work_item.pr_mergeable`
  - running `premerge`/`resolve` runs (`store.js:146`)
  - the deploy step's smoke result

## Options

### A. Deterministic server sweep with the rules in the role file

- New `server/src/caretaker.js`, modelled on `gateNotifier.js`. `server.js` `init()` is its only caller.
- New table `caretaker_eval(item_id, gate_index, arrival_seq, …)` with `UNIQUE(item_id, gate_index, arrival_seq)`.
- **Pros:**
  - Zero GitHub calls by construction.
  - Fixture tests are deterministic and fast.
- **Cons:**
  - Spotting "blocker open" and "operator must decide" means matching markers in artifact text, which can be brittle.
- **Effort:** **M**. About 3–4 days, mostly tests.

### B. Farm-side model agent

- The server sweep only enqueues a `caretaker_eval` outbox row.
- **Pros:**
  - Handles nuanced prose in architect and PM artifacts.
- **Cons:**
  - Output is not deterministic, so fixture tests need a stubbed provider.
- **Effort:** **L**. About 6–8 days.

### C. Hybrid: deterministic facts with a model only for prose

- Uses A's sweep, dedup, Admin setting and fact gathering.
- **Effort:** **L−**. About 5–6 days.

## Recommendation

**Choose A.**

- It meets guardrail 3 (zero GitHub or PR calls) by structure: the module never imports those clients. A recording stub of `github.js` then proves it.
- Restart-safe dedup comes free from the `notified_step` pattern plus a `UNIQUE` key.
- Every metric-5 rule gets a deterministic fixture test against the role file.

### Decisions baked into A (open to change at the gate)

- **Error or timeout:** catch it and log it. Record one `caretaker would wait` event with a sanitized error reason.

### Risks

- **Marker brittleness for gate 5 blockers and "operator must decide".**
  - Mitigation: the role file defines the exact markers.
- **Blocking finding:** the project-level `project_event` table is new schema, not a reuse of `event`. The reviewer should confirm that is acceptable.

### Out of scope, per guardrails

- WhatsApp, digest, kill-switch, rulings and amendments (HZ-271–HZ-274).
