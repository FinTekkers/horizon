# Self-deploy: one-time host setup

After this PR merges, a published GitHub Release on a repo registered in
`infra/host/deploy-targets.json` pulls straight to the host via a webhook —
no more SSHing in to update it. This is the one-time setup that wires that
up. Do it once per target; every deploy after that is automatic.

## 0. The deploy-target registry

`infra/host/deploy-targets.json` is a versioned, git-reviewed file — not a
database row and not editable from the Admin UI — mapping each deployable
repo to the script that deploys it, the systemd service it restarts, and its
own state directory (`~/.horizon/<stateKey>/`). `server/src/deploy.js` looks
up the webhook's `repository.full_name` in this file; a repo absent from it
is rejected and logged, never deployed. Adding a new target means adding an
entry here, a deploy script under `infra/host/`, and a sudoers line (below)
— all three require a reviewed PR, by design.

## 1. Install the sudoers rule

Each target's deploy script needs to restart its own service without a
password prompt, and nothing broader. The template
(`infra/host/horizon-deploy.sudoers`) names every service explicitly — a
target must appear in **both** the registry and this file to be deployable,
so a bad registry entry alone can never restart an arbitrary service. Never
widen this to a wildcard.

```
sudo cp infra/host/horizon-deploy.sudoers /etc/sudoers.d/horizon-deploy
sudo visudo -c
```

`visudo -c` must report no syntax errors before continuing.

## 2. Apply the systemd unit change

This PR adds `KillMode=process` to `horizon-server.service` — without it,
`systemctl restart horizon-server` would kill `deploy-horizon.sh` itself
(it's forked from the Node process handling the restart request) before it
can finish its health check.

```
sudo cp infra/host/horizon-server.service /etc/systemd/system/horizon-server.service
sudo systemctl daemon-reload
sudo systemctl restart horizon-server
```

## 2b. WhatsApp gate-approval env (HZ-140)

Set these **before** the release ships, or every WhatsApp approval fails
closed. Names only below — values live on the host, never in this repo.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `WA_APPROVAL_SECRET` | the only credential that can approve a gate. Unset ⇒ the route answers **503** |
| `/etc/horizon/server.env` | `WA_APPROVER_JIDS` | comma-separated approver numbers. Unset/empty ⇒ **deny all**, every sender gets **403** |
| `/etc/horizon/farm.env` | `WA_APPROVAL_SECRET` | same value as the server's |

`FARM_SHARED_SECRET` stays where it is, in both files. It no longer opens the
approval route — it is farmd's credential for `/api/farm/*` and nothing else.

Diagnosing a failed approval without reading code:

- **503, "aren't configured on the Horizon server"** — `WA_APPROVAL_SECRET`
  missing from `server.env`.
- **401** — the two `WA_APPROVAL_SECRET` values disagree between
  `server.env` and `farm.env`.
- **403, "isn't on Horizon's approver list"** — the sender's number is
  missing from `WA_APPROVER_JIDS` on the server.
- **Silence, no reply at all** — the sender is missing from the farm's own
  `FARM_WA_ALLOWED_JIDS`, which drops the message before it is ever read.

After deploying, restart `horizon-server`, then restart farmd. Existing tmux
sessions keep the environment they were launched with, so a pre-upgrade
session still holds the old credential until farmd's teardown kills it.
Confirm with `python -m farm.tools.check_session_env` (names only, exits
non-zero on a find).

## 2c. Farm capacity env (HZ-144)

The farm's two concurrency limits live in `/etc/horizon/farm.env`, loaded by
`infra/host/horizon-farm.service`. **That file is not in git**, so "set
explicitly in the deployed farm config" is a host edit, not a reviewable
diff — this section is the reviewable record of it.

It is a **prescription, not a log**: the values below are what this host is to
run, applied by whoever deploys the change. Nothing in the repo can assert
they were applied, so confirm them with the commands at the end of this
section rather than trusting this table. As of the HZ-144 PR the mechanism is
in the code and the host edit has **not** been made — `FARM_MAX_EPHEMERAL` is
unset on this host, so the code default of 4 is in force.

| File | Var | Value to set | Notes |
|---|---|---|---|
| `/etc/horizon/farm.env` | `FARM_MAX_EPHEMERAL` | `6` | how many agent steps run at once. The code default in `farm/farmd.py` stays **4** on purpose: raising the default would silently re-raise the cap on every other host |
| `/etc/horizon/farm.env` | `FARM_MAX_CONCURRENT_CHECKS` | `2` | how many check suites run at once. **Set this before raising the line above** |
| `/etc/horizon/farm.env` | `FARM_CHECK_SLOT_WAIT_MAX_S` | (unset ⇒ 600) | how long a run waits for a check slot before proceeding without one |
| `/etc/horizon/farm.env` | `FARM_CHECK_METRICS_PHASE` | measurement only | tags records during a measurement window; remove it afterwards |

The exact lines:

```
FARM_MAX_CONCURRENT_CHECKS=2
FARM_MAX_EPHEMERAL=6
```

Then `sudo systemctl restart horizon-farm`. Existing tmux sessions keep the
environment they were launched with, so the restart's teardown is what
applies the new values.

**Order matters.** Six agents all reaching their checks at once on 2 vCPUs is
the failure this pairing exists to prevent — it was observed live on 30 Sept
2026 (load ~8, the Playwright suite failing its own 85s budget). Add
`FARM_MAX_CONCURRENT_CHECKS` first, restart, confirm, then raise
`FARM_MAX_EPHEMERAL`.

Confirm afterwards:

```
curl -s localhost:4100/farm/status | python3 -m json.tool   # agents.limit, checks.limit
tmux list-sessions | grep -c farm-run-                      # never exceeds agents.limit
farm/.venv/bin/python -m farm.tools.check_session_env       # no INFO line about FARM_MAX_EPHEMERAL
```

The last one matters: farmd holds `FARM_MAX_EPHEMERAL` and must not pass it
into an agent session. The checked repo is Horizon, whose own suite asserts
the default, so a leak there fails every implement run's pytest rather than
showing up as a warning. It prints an `INFO` line (not a `LEAK`, and not a
non-zero exit — that status is reserved for credentials).

### Rolling back

All three levers are config; no code revert is needed.

- Too much contention: `FARM_MAX_EPHEMERAL=4`, restart.
- The limiter itself is suspect: `FARM_MAX_CONCURRENT_CHECKS=0`, restart —
  `check_slot()` becomes a no-op and pre-HZ-144 behaviour is restored.
- Do **not** raise `FARM_CHECK_TIMEOUT_S` or the e2e `globalTimeout` to
  absorb slow checks. Both are the contention detectors; report the numbers
  from `python -m farm.tools.report_check_metrics` instead.

Stale slot files under `$FARM_HOME/locks/checks/` need no cleanup — `flock`
state is held by the kernel, not by the files' contents.

## 3. Confirm the repo is pull-only

`/opt/horizon` must be able to `git fetch`/`checkout` from `origin`, but must
**not** hold any push credential (no GitHub-held SSH key, no token with
`contents:write` in its remote URL) — deploys are pull-only by design.

```
cd /opt/horizon && git remote -v
```

If `origin` is an `https://github.com/...` URL with no embedded token, or an
SSH remote using a read-only deploy key, you're good.

## 4. Add the Releases event to the webhook

In the `FinTekkers/horizon` repo settings → Webhooks, edit the webhook already
pointed at `https://shoreward.ai/horizon/api/webhooks/github` (it already
verifies `issues`/`issue_comment`/`pull_request` events with
`GITHUB_WEBHOOK_SECRET`) and add the **Releases** event. No new secret needed.

## 5. Verify end to end

1. Publish a test release (or just wait for the next work item's Deploy
   step — it publishes one automatically).
2. Confirm `~/.horizon/horizon/self-deploy.log` on the box shows a line like:
   ```
   DEPLOY OK tag=refs/tags/<tag> commit=<sha>
   ```
   (each target logs to its own `~/.horizon/<stateKey>/self-deploy.log`, per
   `infra/host/deploy-targets.json`.)
3. **Restart-survival check** — this is the part that can't be verified any
   other way than on the live box: watch that `deploy-horizon.sh` actually
   survives the `systemctl restart horizon-server` it triggers partway
   through its own run, rather than being killed along with the process that
   spawned it. `journalctl -u horizon-server -f` in one terminal while a
   release publishes should show the restart happen, and `self-deploy.log`
   should still get a `DEPLOY OK` (or a clearly logged `DEPLOY FAILED:
   health-check ...`) after it — not silence, because the script died
   mid-run.

If a deploy ever fails its health check, the bad code is already live (the
script does not auto-rollback); redeploy the last good tag by hand, using
the target's own script and state directory:

```
infra/host/deploy-horizon.sh "$(cat ~/.horizon/horizon/last-good-tag | cut -d: -f1 | sed 's#refs/tags/##')"
```

## Deep verification beyond the health check (HZ-22)

Each deploy script's health check proves the process restarted and answered
— it does not always prove the page a user loads actually renders (see
`deploy-horizon.sh`'s health check, which only confirms the API is up, vs.
`deploy-ui-service.sh`'s, which also confirms the SSR shell and its client
bundle really serve). `e2e/smoke/check.mjs` closes that gap for any target:
it loads a URL in a real headless browser and confirms expected content is
actually visible, not just that a response arrived.

```
node e2e/smoke/check.mjs https://shoreward.ai/horizon/ "Horizon" [screenshot.png]
```

Exits `0` with `SMOKE_RESULT=pass` only if the text renders; `1` with
`SMOKE_RESULT=fail: <reason>` otherwise.

This is now a real pipeline gate, not just a manual tool. The Deploy step
(`STEPS[14]` in `lifecycle.js`) is farm-dispatched by default: the JS
orchestrator still owns publishing the GitHub release itself (it holds the
GitHub token the farm doesn't), and only hands the step to the farm's
DevOps agent (`farm/roles/devops.md`) afterwards, for verification. The
agent picks the `url`/`expected_text` to check from the project rules, but
`farm/step_agent.py` — not the agent's own self-reported verdict — is what
actually runs `check.mjs` and reads its real exit code; that's the value
this script sends back as the deploy verdict. A failing verdict pauses the
item for a human rather than silently advancing (`server/src/orchestrator.js`
`finalizeDeployStep`), the same way a failing review verdict does.

## Adding a new target

1. Add a deploy script under `infra/host/` (copy the closest existing one —
   `deploy-horizon.sh` for a Node/systemd service, `deploy-ui-service.sh` for
   an SSR frontend — and adjust its build/health-check stages).
2. Add an entry to `infra/host/deploy-targets.json`: `key`, `repo`, `script`,
   `service`, `repoDir`, `stateKey`, `healthUrl`, `healthCheckType`.
3. Add an explicit sudoers line for the new service to
   `infra/host/horizon-deploy.sudoers` and re-apply it on the host (step 1
   above) — a registry entry with no matching sudoers line fails closed at
   the `restart` stage (`DEPLOY FAILED: restart`), it does not deploy with
   elevated privilege.
4. Add the **Releases** webhook event on the new repo (step 4 above).

All three of steps 1-3 land in the same reviewed PR; nothing about a deploy
target is editable outside of git.
