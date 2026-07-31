# Self-deploy: one-time host setup

After this PR merges, a published GitHub Release on `FinTekkers/horizon` pulls
straight to the shoreward.ai box via a webhook — no more SSHing in to update
it. This is the one-time setup that wires that up. Do it once; every deploy
after that is automatic.

## 1. Install the sudoers rule

`infra/host/deploy.sh` needs to restart `horizon-server` without a password
prompt, and nothing broader:

```
sudo cp infra/host/horizon-deploy.sudoers /etc/sudoers.d/horizon-deploy
sudo visudo -c
```

`visudo -c` must report no syntax errors before continuing.

## 2. Apply the systemd unit change

This PR adds `KillMode=process` to `horizon-server.service` — without it,
`systemctl restart horizon-server` would kill `deploy.sh` itself (it's forked
from the Node process handling the restart request) before it can finish its
health check.

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
2. Confirm `~/.horizon/self-deploy.log` on the box shows a line like:
   ```
   DEPLOY OK tag=refs/tags/<tag> commit=<sha>
   ```
3. **Restart-survival check** — this is the part that can't be verified any
   other way than on the live box: watch that `deploy.sh` actually survives
   the `systemctl restart horizon-server` it triggers partway through its own
   run, rather than being killed along with the process that spawned it.
   `journalctl -u horizon-server -f` in one terminal while a release publishes
   should show the restart happen, and `self-deploy.log` should still get a
   `DEPLOY OK` (or a clearly logged `DEPLOY FAILED: health-check ...`) after
   it — not silence, because the script died mid-run.

If a deploy ever fails its health check, the bad code is already live (the
script does not auto-rollback); redeploy the last good tag by hand:

```
infra/host/deploy.sh "$(cat ~/.horizon/last-good-tag | cut -d: -f1 | sed 's#refs/tags/##')"
```
