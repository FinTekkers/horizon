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

## 2c. Gate-arrival notification env (HZ-141)

Turns on the server-side notifier that messages the approver when an item
lands on a gate. **Off by default** — it messages a real human, so it is
never on by accident, and configuring HZ-140's approval path above does not
enable it.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `WA_NOTIFY_ENABLED` | `1` turns it on. Anything else ⇒ the sweep never runs |
| `/etc/horizon/server.env` | `WA_BRIDGE_URL` | whatsapp-mcp bridge base URL. Unset ⇒ `http://localhost:8080`. Same var `farm.env` already sets |

**Who gets notified is `WA_APPROVER_JIDS` from 2b — there is no separate
recipient setting.** Whoever can approve a gate is exactly who is told one is
waiting. `WA_NOTIFY_ENABLED=1` with an empty `WA_APPROVER_JIDS` logs a warning
at boot and delivers nothing.

No credential is on this path. `POST /api/send` takes no auth and is
localhost-only, so neither `FARM_SHARED_SECRET` nor `WA_APPROVAL_SECRET` is
read by the notifier.

### Verifying it, without reading code

Restarting and waiting for a text is not a check — it has no observable if
nothing arrives. The outbox records every attempt, so read it back instead.
After `systemctl restart horizon-server`, drive one item to a gate (or wait
for one), then:

```
# HORIZON_DB is unset on this host, so the server uses its default path,
# relative to horizon-server.service's WorkingDirectory=/opt/horizon/server.
sqlite3 -header -column /opt/horizon/server/data/horizon.db \
  "SELECT item_id, step_index, status, attempts, last_error, sent_at
     FROM gate_notice ORDER BY id DESC LIMIT 5;"
```

Expected on success: one row per approver for that arrival, `status = sent`,
`attempts = 0`, `last_error` empty, `sent_at` set.

- **No rows at all** — `WA_NOTIFY_ENABLED` is not `1`, or
  `WA_APPROVER_JIDS` is empty. Check the boot log for the notifier's own
  warning.
- **`status = pending`, `attempts ≥ 1`** — the bridge rejected or was
  unreachable; `last_error` says which. It retries with 60s doubling backoff
  and nothing about the item is affected.
- **`status = failed`, `last_error` set** — gave up after
  `WA_NOTIFY_MAX_ATTEMPTS` (default 8, ≈2h). Fix the bridge; this arrival is
  not resent.
- **`status = failed`, `last_error = interrupted…`** — the process exited
  mid-send. Deliberately not resent: one logged miss beats two pings about the
  same arrival.

To turn it off with no deploy: set `WA_NOTIFY_ENABLED=0` and restart
`horizon-server`. Nothing else changes.

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
