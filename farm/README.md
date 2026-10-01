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
| `FARM_SHARED_SECRET` | dev-secret | must match the Node server's value. **farmd only** (HZ-140): `tmux_mgr.py` refuses to forward it into any agent session, and unsets it in the session's own command, so a step/PM/concierge agent can't read it out of its environment |
| `FARM_HOME` | ~/.horizon-farm | queue/state/logs/workspaces |
| `FARM_CLAUDE_BIN` | claude | override with tests/fake_claude in tests |
| `FARM_PM_MODEL` | (CLI default) | model for the PM agent |
| `FARM_STEP_MODEL` | (CLI default) | model for step agents and conflict resolution (Claude provider only) |
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
- Gate approval is also a **native poll** (HZ-142): every gate notification
  carries ✅ Approve / ↩️ Send back, and a tap is resolved by the Node server
  with no model anywhere on the path — the concierge process is not involved
  at all. The numbered-reply flow below is unchanged and still works; whichever
  decides the gate first wins, and the other is refused because the cursor has
  moved. See `infra/host/DEPLOY.md` §2d.
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

**Since HZ-142 the bridge is a FORK.** Gate approval from a WhatsApp poll
needs `POST /api/send-poll` and a vote forwarder, neither of which upstream
has. The patch lives in this repo at `infra/whatsapp-bridge/` — stdlib-only
Go, tested by `npm test`, with the four additions to the fork's `main.go`
written out in its README. Record **two** commits when you re-pin: the
upstream one you forked from, and the fork's own. Upstream pin verified
against: `lharries/whatsapp-mcp@7d6a06d`, `whatsmeow
v0.0.0-20260730092514-662ad1dc6900` (see `infra/whatsapp-bridge/PROBE.md`).

Running the unforked bridge is a supported, degraded state: every poll fails
with a 404 and is retried, every text notification still arrives, and the
free-text approval below still works. Set `WA_POLL_ENABLED=0` on the server
to stop attaching polls entirely.

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
| `WA_APPROVAL_SECRET` | (empty = **approvals refuse**) | HZ-140: the only credential that can approve a gate. Must match the Node server's value. Reaches the `farm-concierge-*` session only — never a step or PM agent |

Gate approval is also gated **server-side** by `WA_APPROVER_JIDS` (set in the
Node server's env, not here): a sender the server doesn't recognise gets a
403 and the gate is untouched, whatever the farm sent. `FARM_WA_ALLOWED_JIDS`
above stays as the farm's own first pass — defence in depth, with the server
list as the authority.

Symptoms when the two are out of step: a sender missing from
`FARM_WA_ALLOWED_JIDS` is dropped **silently** (log line only, no reply); a
sender missing from `WA_APPROVER_JIDS` gets a visible "isn't on Horizon's
approver list" reply.

To check no live agent session is holding a credential it was **not granted**:

```
farm/.venv/bin/python -m farm.tools.check_session_env
```

It prints variable names only, never values, and exits non-zero on a find.
A session started *before* this change keeps the environment it was launched
with, so restart farmd (which tears its sessions down) after upgrading.

Read its output precisely. `LEAK` is a finding and sets the exit status.
`GRANT` is not: the concierge session legitimately holds `WA_APPROVAL_SECRET`,
and the tool prints that on its own line rather than passing over it, so
"clean" is never mistaken for "nothing running here can approve a gate."
Something running here can — that is what the concierge *is*.

**What HZ-140 closes, and what it doesn't.** A step or PM agent no longer
holds any credential that can approve a gate: not in its own environment, not
inherited from the tmux server, and `FARM_SHARED_SECRET` is no longer
accepted by the approval route at all.

The concierge is the one session granted `WA_APPROVAL_SECRET`, and it runs a
model over WhatsApp text a stranger can write, so the model itself is kept
away from the credential on both spawn paths:

- `concierge_agent.main()` calls `credentials.drop_from_process_environ()`
  before any model runs, so the `claude` process it spawns starts from an
  environment that never held the name. This is the leg that matters, because
  the default SDK runner builds its child env as `{**os.environ, **options.env}`
  — `options.env` can override a name but cannot remove one.
- Both providers pass an explicit `env=` (`credentials.without_gate_credentials()`)
  to `subprocess.run`, covering the `FARM_RUNNER=subprocess` rollback lever and
  every step and PM agent as well.

What remains open, stated rather than implied closed: every farm session runs
as the **same OS user**, so an agent with `Bash` can still read
`/proc/<concierge_pid>/environ` or `ps` the concierge's argv, and the
concierge's own model subprocess can read its parent's. Inheritance is closed;
read-out is not. Closing read-out needs a separate uid for farmd + the
concierge, which is host configuration rather than code here, and is
deliberately out of this item's scope. The server-side `WA_APPROVER_JIDS`
check is the part that holds regardless: a forged call still has to come from
an allowlisted number.

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

## Pre-merge check (Accept the code, HZ-183)

A PR green against the main it branched from can still turn main red once it
lands next to another PR. So approving **Accept the code** first runs the same
checks on a test-merge: the server (`server/src/premerge.js`) reads the PR head
and the base branch tip from GitHub, then runs
`python -m farm.premerge <repo> <item> <head-sha> --base <base-sha>`
(`farm/premerge.py`). That makes a scratch worktree off the repo hub at
`~/.horizon-farm/workspaces/<owner>__<repo>__premerge/<item>/` — never
`/opt/horizon` or the running checkout — merges the head into the base there,
runs `run_checks()`, and always reaps the worktree.

- **Green:** the server re-reads the base tip; if it moved, the merge is
  blocked and the human clicks Accept again. Otherwise it merges with the
  tested head as `sha`, so GitHub refuses if the head moved too. The merge is
  a squash, so the tested merge commit itself is never pushed: the head pin
  and the base re-check together are what make the squash the tested tree.
- **Anything else** — a red check, a conflict, a timeout, no checks detected,
  no hub, a crash — leaves the gate open and the PR unmerged, and the item's
  activity names the failing check and the last 40 lines of its output.
- `PREMERGE_CHECK_TIMEOUT_MS` (server env, default 20 minutes) bounds the
  whole run. The server and the farm must share `FARM_HOME` (both default to
  `~/.horizon-farm` for the `ubuntu` user).

Measure it on an idle host with
`HORIZON_PREMERGE_LIVE=1 python3 -m pytest -s farm/tests/test_premerge_live.py`.

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
