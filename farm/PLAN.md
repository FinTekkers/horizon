# HZ-3: Replace the mock agents with real ones — Implementation Plan

Tracking issue: FinTekkers/horizon#3

## Principles (from review)

1. **Farm per project.** Switching the active project tears the whole farm down
   and rebuilds it with the new project's context. No context bleed, no idle
   resource burn.
2. **PM agent is long-running**, in a tmux session on the Horizon server (this
   machine for now). It accumulates project context across items.
3. **All other agents are ephemeral** — spawned per step, die after reporting.
4. **Scripts control the flow.** The Node orchestrator remains the *only*
   sequencer: it decides which step runs and when the cursor advances. Agents
   execute exactly one assigned step and report back. Agent output never
   triggers the next step directly.
5. **Separate codebases.** Agent plumbing is Python in `farm/`; the Node code
   in `server/` keeps owning lifecycle state, GitHub mechanics and the UI API.

## Architecture

```
ui/  ── SSE/REST ──  server/ (Node, port 3001)          farm/ (Python, port 4100)
                     │  orchestrator.js = sequencer      │  farmd (FastAPI)
                     │  sqlite = source of truth         │  tmux session manager
                     │                                   │  workspaces (git clones)
                     └── POST /steps/run ───────────────▶│
                     ◀── POST /api/farm/steps/:runId ────┘  (completion callback)
                          {summary, patch, artifacts}
```

### farmd (Python daemon, `farm/`)

FastAPI app on `localhost:4100`, run under tmux itself (`farm-daemon` session).

Endpoints:
- `POST /farm/start {project, repos[]}` — tear down any existing sessions,
  clone/refresh workspaces, start the PM session for the project. Returns when
  the farm is ready (this is the real "restarting… may take minutes" time).
- `POST /farm/stop` — kill all farm tmux sessions.
- `GET  /farm/status` — `{status, project, sessions[], workspaces[]}`.
- `POST /steps/run {run_id, item, step, feedback[], artifacts[]}` — execute one
  step; async; results delivered via callback to the Node server.
- `POST /steps/cancel {run_id}` — kill the ephemeral session for a run.
- ~~`POST /feedback`~~ — **dropped by product decision (2026-07-18)**: farmd
  never injects feedback into a live session. All feedback (gate notes,
  send-back/rework, the Node server's `POST /api/items/:id/feedback`, ingested
  GitHub issue comments) is stored Node-side and rides the re-dispatched
  step's input; a live attempt is superseded (cancelled, session killed) and
  re-run as attempt N+1.

Tmux layout (observable by attaching at any time):
- `farm-daemon` — farmd itself
- `farm-pm-<project>` — the long-running PM agent loop
- `farm-run-<item>-<step>-<attempt>` — one per ephemeral step, auto-removed
  after completion (output piped to `~/.horizon-farm/logs/` first)

### Agent execution

- **PM (long-running):** `farm/pm_agent.py` runs inside its tmux session. It
  is a *script* (control stays with us) that holds a persistent Claude Agent
  SDK session primed with the project context (repo READMEs, open items,
  lifecycle rules). farmd hands it Plan-phase steps over a local queue; it
  answers with structured JSON. Context persists across items; the session
  restarts with the farm.
- **Ephemeral (Architect / Ensemble / Eng / QA / DevOps):** one headless
  Claude Code invocation per step (`claude -p` via the SDK), system prompt
  from `farm/roles/<role>.md`, cwd = the item's repo workspace, JSON output
  contract, hard timeout (default 15 min) and max-turn cap.

Step I/O contract (all agents):
```json
in:  { "item": {id,title,desc,metric,guardrails,repo,issue},
       "step": {label,agent}, "feedback": [...], "artifacts": [...] }
out: { "summary": "...", "patch": {desc?,metric?,guardrails?},
       "artifacts": {plan_md?, branch?, files_changed?} }
```
Invalid JSON → one retry with the parse error; then the run fails.

### Division of labour with the Node server

| Concern | Owner |
|---|---|
| Step sequencing, cursor, gates, pause/reject/rework | Node orchestrator (unchanged) |
| step_run rows, events, SSE | Node (unchanged) |
| Executing a step, tmux, workspaces, Claude sessions | farmd |
| Opening/merging PRs, releases, issue close | Node (unchanged) — but the PR is opened from the **real branch the Eng agent pushed**, replacing the placeholder-file commit |
| Feedback storage/delivery | Node stores; farmd delivers (PM injection or next-step input) |

`orchestrator.js` changes are small: `runMockStep` becomes `dispatchStep` —
POST to farmd, mark the run `active`, and wait for the callback
(`POST /api/farm/steps/:runId/complete|fail`, guarded by a shared secret in
env). Timeout or farm-down → run fails → item pauses with an explanatory
event for human intervention. **`FARM_URL` unset → mocks run exactly as
today** (demo mode and tests keep working).

`switchProject` stops simulating: it calls farm stop/start and reflects
farmd's real status into the existing `farm.status` SSE field. The restart
banner now shows genuine progress.

### Workspaces & code changes

- `~/.horizon-farm/workspaces/<repo>/` — one clone per repo of the active
  project (cloned with the saved PAT at farm start, fetched per step).
- Eng implement step: agent branches `horizon/<item-id>`, makes real changes,
  runs the repo's tests, commits and pushes. Its artifacts name the branch;
  the Node server opens the PR from it. Deterministic guardrail: farmd runs
  the repo's test command itself after the agent finishes — agent claims
  don't count; failing tests fail the run (README's non-negotiable gate).
- Planning-phase artifacts (options A/B/C, impl plan, test plan) are markdown,
  stored with the step_run and posted as **issue comments** so the GitHub
  thread stays the human-readable record (README: "users interact mostly by
  GH comments").

## Phasing (each phase shippable, HZ-3 is the guinea pig)

1. **Plumbing + PM.** farmd skeleton, tmux/session manager, farm lifecycle
   wired to project switch, callback loop into Node. Only the three Plan
   steps run on the real PM agent; everything else stays mocked. Prove it on
   a fresh Horizon item.
2. **Ephemeral planners.** Ensemble options, Eng impl plan, Architect review,
   QA test plan → real agents producing markdown artifacts + issue comments.
3. **Real implementation.** Eng agent writes code in the workspace, pushes
   the branch, farmd verifies tests, Node opens the PR. Placeholder-file
   logic deleted.
4. **Deploy + polish.** DevOps step (release stays Node-side; agent adds
   deploy verification), PM feedback injection, failure-recovery paths,
   docs.

## Stack

Python 3.11+, FastAPI + uvicorn, `claude-agent-sdk`, libtmux, httpx, pytest
(with a fake `claude` binary for tests). Config via env: `FARM_PORT`,
`HORIZON_URL`, `FARM_SHARED_SECRET`, `FARM_WORKSPACES_DIR`, per-role model
overrides.

## Open questions (flagging before build)

1. **Agent permissions.** Ephemeral agents in dedicated workspaces: run with
   an allowlisted permission set (git, test runners) rather than
   skip-permissions? Safer, occasionally gets stuck on prompts. Proposal:
   allowlist for v1, revisit.
2. **Models per role.** Cheap/fast for PM/QA/Architect review, top-tier for
   Eng implement? Proposal: single default + per-role env override.
3. **Concurrency.** Cap simultaneous ephemeral agents (proposal: 2) — items
   already queue naturally at gates.
4. **Cost control.** Max turns per step + daily budget alarm — v1 gets the
   turn cap only.
