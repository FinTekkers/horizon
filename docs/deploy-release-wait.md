# The Deploy step waits for its own release (HZ-275)

Publishing the release only starts the deploy. The deploy itself takes
minutes, because of an `npm ci` and a build. On 2026-10-02, US-191's smoke
check passed against the **old** fintekkers.org while ui-service was still
building. So the Deploy step (step 14) now waits before it verifies anything.

## How the wait works

- The server publishes the release. It then hands the step to the farm with
  a `deploy_wait` field: `{ state_dir, timeout_s }`. The field comes from
  `server/src/deployWait.js` and appears only when the repo has a deploy
  target.
- Before the DevOps agent or `e2e/smoke/check.mjs` runs, `farm/step_agent.py`
  (`wait_until_release_live`) polls every 5 s. It stops when
  `<state_dir>/last-good-tag` names this item's release tag.
- The step reads only `last-good-tag` and `self-deploy.log`. It never runs a
  deploy script, never writes the state dir, and never rolls back.
- The wait runs in the farm, not the server, so it survives the
  `horizon-server` restart caused by a Horizon self-deploy. That deploy also
  restarts farmd, so posting the step's result retries for up to 2 min while
  farmd comes back.

## Bounds and failures

- **Bound:** 20 min by default. To change it, set `HORIZON_DEPLOY_WAIT_MS` in
  `server.env`. The farm caps it at 2 h. The step's server watchdog is
  `FARM_STEP_TIMEOUT_MS` plus this wait.
- **When the step fails:**
  - The log records `DEPLOY FAILED` for this tag.
  - The wait runs out while `last-good-tag` still names another version.
- **What a failure shows:** the reason, then the last 20 lines of
  `self-deploy.log`. The tail is at most 1500 chars, with secrets redacted.
- **After a failure:** the item pauses. Nothing retries on its own.
- **Missing or unreadable `last-good-tag`:** counts as "not live yet".
- **Release published for a repo with no deploy target:** the step fails
  closed. Nothing would deploy, so a smoke check would test the previous
  version.
- **Known risk:** a `horizon` deploy can sit queued behind another one, then
  spend up to 25 min in its drain. Together these can outlast the 20-min
  wait. The step then fails safe. If that happens often, raise
  `HORIZON_DEPLOY_WAIT_MS`.

## Queued deploys wait for the lock

A deploy the server starts now waits up to 30 min for another deploy holding
the lock. Before, it waited 5 min and then gave up. So two releases
published close together both deploy, in order.

- **Where it's set:** `server/src/config.js` sets
  `HORIZON_DEPLOY_LOCK_TIMEOUT_S=1800` in the server's env. `spawnEnv` passes
  that env to the deploy scripts, which already read the variable.
- **Override:** an explicit value in `server.env` still wins. Set `300` to
  restore the old bound.
- **Manual runs:** running a script by hand still uses the script's own
  5-min default.

## No more workflow push

Publishing a release no longer commits anything to the product repo, so the
legacy dummy `.github/workflows/horizon-deploy.yml` is no longer pushed.
Copies already in product repos, such as `FinTekkers/ui-service`, stay where
they are. Removing them is a separate, human-approved cleanup.
