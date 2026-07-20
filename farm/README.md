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
- `~/.horizon-farm/` — task queue, PM session/inbox state, logs, workspaces

## Current scope (phases 1–3)

- **PM agent** (long-running, tmux, session-resumed Claude): the three Plan
  steps.
- **Ephemeral agents** (one tmux session per step, max `FARM_MAX_EPHEMERAL`=2
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
`0,1,2`), `FARM_STEP_TIMEOUT_MS` (watchdog, default 20 min).

## Guardrail checks (implement step)

After the Eng agent finishes editing and **before** anything is committed or
pushed, the script runs the target repo's own checks — `FARM_CHECK_CMD` if
set, otherwise auto-detected (`npm test`/`npm run lint` from a root
package.json, pytest from pytest.ini/pyproject/tests). A failing check fails
the run (item pauses with the output tail); agent claims of green tests
don't count.

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
