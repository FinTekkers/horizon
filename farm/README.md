# farm/ — the Horizon agent farm

Python plumbing that runs the real agents. See `PLAN.md` for the full design;
the short version: the Node server (`server/`) stays the only sequencer, and
farmd executes exactly one step when asked.

## Running (local dev)

```
./farm/run.sh            # creates farm/.venv (python3.13) on first run,
                         # starts farmd in tmux session `farm-daemon` on :4100
FARM_URL=http://localhost:4100 npm run dev   # in server/ — enables real agents
```

With `FARM_URL` unset the server uses the built-in mock agents (demo mode).

## What runs where

- `farm-daemon` tmux session — farmd (FastAPI, port 4100)
- `farm-pm-<project>` tmux session — the long-running PM agent
  (`tmux attach -t farm-pm-<project>` to watch it work)
- `farm-concierge-<project>` tmux session — the WhatsApp concierge
  (only with `FARM_WA_ENABLED=1`; see below)
- `~/.horizon-farm/` — task queue, PM session/inbox state, logs, workspaces

## Current scope (phases 1–3)

- **PM agent** (long-running, tmux, session-resumed Claude): the three Plan
  steps.
- **Ephemeral agents** (one tmux session per step, max `FARM_MAX_EPHEMERAL`=4
  concurrent): Ensemble options (4), impl plan (6), architecture review (7),
  QA test plan (8) — planners read the repo workspace and produce markdown
  artifacts (stored on the step_run, posted to the issue) — and the
  **implement step (10)**: the Eng agent edits real code in the workspace on
  branch `horizon/<item-id>`; the *script* commits and pushes, the Node
  server opens the PR. Tool access is allowlisted per role (planners
  read-only; implement gets edit+bash inside the workspace).
- **Deploy (12)** deliberately stays script-driven on the Node side
  (release → workflow), no model in the loop.

Farm start/stop is wired to project switching; a watchdog revives dead agent
sessions; queued work survives on disk.

## Config (env)

| Var | Default | |
|---|---|---|
| `FARM_PORT` | 4100 | farmd port |
| `HORIZON_URL` | http://localhost:3001 | Node server for result callbacks |
| `FARM_SHARED_SECRET` | dev-secret | must match the Node server's value |
| `FARM_HOME` | ~/.horizon-farm | queue/state/logs/workspaces |
| `FARM_CLAUDE_BIN` | claude | override with tests/fake_claude in tests |
| `FARM_PM_MODEL` | (CLI default) | model for the PM agent |
| `FARM_STEP_TIMEOUT_S` | 900 | per-claude-invocation timeout |
| `FARM_CHECK_CMD` | (auto-detect) | guardrail check command run before push (via `sh -c`) |
| `FARM_CHECK_TIMEOUT_S` | 600 | guardrail check timeout |

Node side: `FARM_URL`, `FARM_SHARED_SECRET`, `FARM_STEP_INDEXES` (default
`0,1,2`). Two independent watchdogs (HZ-57): `FARM_QUEUE_TIMEOUT_MS` (default
10 min) bounds how long a step may sit queued before the farm claims it;
`FARM_STEP_TIMEOUT_MS` (default 20 min, floored at 50 min for the implement
step) only starts once farmd confirms a launch via `POST
.../steps/:runId/started`.

## WhatsApp concierge (HZ-7, item creation & gate approval in HZ-15)

Chat with the farm from WhatsApp: create work items, reprioritize them,
leave feedback (also mirrored as a GitHub issue comment), approve gates, and
ask questions about items and their plan/review artifacts.

- `[New Item] <title>` starts a short wizard (outcome, success metric,
  guardrails, priority, then create/edit/cancel) that ends with a link to
  the item in the web UI and, once GitHub is connected, its issue link.
- Gate approval is WhatsApp's numbered-reply proxy for a radio button: when
  the concierge lists items AWAITING HUMAN APPROVAL it also offers a
  numbered choice, and a bare `1`-`9` reply approves that gate — resolved
  deterministically by the script, never by the model. Rejecting, merging,
  and deploying directly still require the human gate key in the UI.
- Both flows are deterministic state machines (`farm/wizard.py`), not model
  turns — a message is claimed (persisted) before its item is created or its
  gate approved, the same at-most-once discipline as the plain
  feedback/priority actions below, and state is keyed per `(chat, sender)`
  pair so two people in one group chat can never read or advance each
  other's wizard or approval choice.
- Everything else the model can do is capped by a two-entry action
  whitelist (`set_priority`, `feedback`) the concierge script enforces
  before anything touches the farm.

Setup (Option A — the local [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp)
bridge; **pin the bridge commit you paired with** — its SQLite schema is
unversioned, and `BridgeTransport` fails loudly with `SchemaMismatch` if it
drifts):

1. Run the bridge's `whatsapp-bridge` Go process and pair via QR.
2. Set the env (all read by farmd/the concierge at launch):

| Var | Default | |
|---|---|---|
| `FARM_WA_ENABLED` | 0 | master switch; concierge launches only when `1` |
| `FARM_WA_ALLOWED_JIDS` | (empty = **deny all**) | comma-separated allowed sender numbers, e.g. `15550001111` |
| `FARM_WA_GROUP_JIDS` | (empty = no groups) | comma-separated group jids (`...@g.us`) the concierge serves; group messages need the group listed here AND an allowlisted sender |
| `WA_DB_PATH` | (required) | the bridge's `store/messages.db` |
| `WA_BRIDGE_URL` | http://localhost:8080 | the bridge's REST endpoint |
| `FARM_WA_POLL_S` | 5 | poll interval |
| `FARM_WA_TRANSPORT` | mcp_bridge | `cloud_api` arrives with the Option B cutover |
| `FARM_CONCIERGE_MODEL` | (CLI default) | model for the concierge agent |
| `FARM_UI_URL` | http://localhost:5173 | web UI base, for deep links texted back on item creation |
| `FARM_WA_SENDER_NAMES` | `{}` | JSON jid->name map, e.g. `{"15551112222":"David"}` — every wizard/approval reply names whose turn it is |
| `FARM_WA_WIZARD_TTL_S` | 1800 | item-wizard conversation expiry (seconds) |
| `FARM_WA_CHOICE_TTL_S` | 600 | offered gate-approval choice expiry (seconds) |

3. Restart farmd (`./farm/run.sh`); the concierge appears as
   `farm-concierge-<project>` and its log lands in `~/.horizon-farm/logs/`.

Messages from senders not on the allowlist are consumed silently (no reply
that would confirm the bot exists). Side effects are at-most-once: each
message id is claimed (persisted) before its actions execute, so crashes or
failed sends never duplicate a GitHub comment. Note that feedback on an item
whose step is running supersedes and re-runs that step — the concierge warns
you in its reply when that happens.

End-to-end check against the real bridge (CI runs the FakeTransport round
trip instead; this one needs your phone):

```
FARM_WA_E2E=1 FARM_WA_ALLOWED_JIDS=<your number> \
WA_DB_PATH=~/Dev/whatsapp-mcp/whatsapp-bridge/store/messages.db \
FARM_CLAUDE_BIN=$(which claude) \
farm/.venv/bin/python -m pytest farm/tests/test_e2e_whatsapp.py -s
```

**Cutover to the official Cloud API (Option B):** implement
`farm/whatsapp/cloud_api.py` against the `Transport` protocol, make it pass
the contract suite in `tests/test_whatsapp_transport.py`, and set
`FARM_WA_TRANSPORT=cloud_api`. The concierge loop, role prompt, action
executor and every test above the transport carry over unchanged.

## Guardrail checks (implement step)

After the Eng agent finishes editing and **before** anything is committed or
pushed, the script runs the target repo's own checks — `FARM_CHECK_CMD` if
set, otherwise auto-detected (`npm test`/`npm run lint` from a root
package.json, pytest from pytest.ini/pyproject/tests). A failing check fails
the run (item pauses with the output tail); agent claims of green tests
don't count.

Detection is root-level only, so this repo carries a root `pytest.ini`
(→ `farm/tests`) and a root `package.json` whose `test` script fans out to
the `server` and `ui` suites — that wiring is what makes the guardrail gate
actually run all three. No linters are configured anywhere in the repo yet,
so the "linters must pass" guardrail is currently vacuous.

## Tests

```
pip install -r farm/requirements-dev.txt
python -m pytest farm/tests        # from the repo root
```

The suite drives the real step-agent code against `tests/fake_claude` (an
instant, deterministic stand-in for the CLI) — including a full implement-step
run that pushes a branch to a local bare "origin". Server-side tests:
`npm test` in `server/`.

## Failure semantics

Agent/step failure → step_run closed (`FAILED: …` in output), item paused
with an explanatory event; resume the item to retry. Farm unreachable at
dispatch → same. Farm down at boot → farm status `error` in the UI snapshot;
agents don't run until it's back (`./farm/run.sh` again).
