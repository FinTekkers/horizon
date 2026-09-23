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
