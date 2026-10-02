// HZ-250: drain running gate actions before a self-deploy restarts the server.
//
// horizon-server runs with KillMode=process, and the pre-merge checker is
// spawned detached, so a restart used to leave a checker running with nobody
// to read its result, and its gate_action row `running` until the lease ran
// out. deploy-horizon.sh now calls the loopback-only /api/farm/deploy-drain
// routes (app.js) through infra/host/deploy-drain.mjs, inside its flock and
// just before `restart`:
//
//   1. beginDrain()        — block new premerge/resolve runs, list running ones
//   2. drainStatus()       — polled until nothing runs or the wait ends
//   3. interruptForDeploy() — only if runs are left: mark them `interrupted`
//                             and stop their premerge checker process trees
//   4. endDrain()          — the script's ERR trap, when the deploy fails
//
// The block lives in this process's memory on purpose: a restart (the normal
// end of a deploy) clears it by construction, the TTL clears it if the
// script dies, and nothing ever needs a DB edit.
//
// A `resolve` row is marked interrupted but its resolver is not stopped here
// (HZ-256): it runs inside farmd, which deploy-horizon.sh restarts right
// after this server. farmd's /conflicts/resolve leaves no task file, so its
// _adopt_existing() has nothing to re-launch it from.

import * as store from './store.js'
import * as premerge from './premerge.js'
import { DEPLOY_BLOCK_MAX_TTL_S } from './config.js'

export const DEPLOY_BLOCK_MESSAGE = 'deploy in progress, try again in a few minutes'

let blockedUntil = 0

export function isDeployBlocked(now = Date.now()) {
  return now < blockedUntil
}

// A second call while blocked extends the block, never shortens it.
export function beginDrain({ ttlS }, now = Date.now()) {
  blockedUntil = Math.max(blockedUntil, now + Math.min(ttlS, DEPLOY_BLOCK_MAX_TTL_S) * 1000)
  return {
    blocked: isDeployBlocked(now),
    blockedUntil: new Date(blockedUntil).toISOString(),
    running: store.listRunningGateActions(),
  }
}

export function drainStatus() {
  return { blocked: isDeployBlocked(), running: store.listRunningGateActions() }
}

// Marks the listed runs that are still running `interrupted` first — so no
// owner write can land after — then stops the premerge checkers of exactly
// those rows. `killed` is false when no tracked checker was found (a resolve
// run, or a premerge run already past its checks and in its merge call).
export async function interruptForDeploy(runs, { graceMs } = {}) {
  const moved = store.interruptGateActionsForDeploy(runs)
  const interrupted = await Promise.all(
    moved.map(async ({ itemId, kind }) => ({
      itemId,
      kind,
      killed: kind === 'premerge' ? await premerge.interruptRun(itemId, graceMs === undefined ? {} : { graceMs }) : false,
    })),
  )
  return { interrupted }
}

export function endDrain() {
  blockedUntil = 0
}
