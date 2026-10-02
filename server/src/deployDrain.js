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
//   3. interruptForDeploy() — only if runs are left: mark them `interrupted`,
//                             stop their premerge checker process trees, and
//                             cancel their resolvers in farmd
//   4. endDrain()          — the script's ERR trap, when the deploy fails
//
// The block lives in this process's memory on purpose: a restart (the normal
// end of a deploy) clears it by construction, the TTL clears it if the
// script dies, and nothing ever needs a DB edit.
//
// HZ-256: a `resolve` row's resolver runs inside farmd, which a Horizon
// deploy does not restart. So once the row is marked interrupted, farmd's
// loopback-only POST /conflicts/cancel stops that item's resolver — its agent
// and check processes end, it never pushes, and it releases the item's lock —
// before this server restarts. This is the route's only caller.

import * as store from './store.js'
import * as premerge from './premerge.js'
import { DEPLOY_BLOCK_MAX_TTL_S, FARM_URL } from './config.js'

// farmd's own wait (FARM_CONFLICT_CANCEL_WAIT_S, 30s) plus slack, inside
// deploy-drain.mjs's 60s bound on the whole interrupt request.
export const CANCEL_RESOLVE_TIMEOUT_MS = 35_000

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

// Asks farmd to stop one item's resolver. Returns farmd's reply
// ({cancelled, killed, lock_released}), {cancelled: false, error} when the
// call failed, or null when there is no farm (mock mode) or no repo. Plain
// fetch: orchestrator.js's farmFetch would be an import cycle.
export async function cancelResolve(itemId, { timeoutMs = CANCEL_RESOLVE_TIMEOUT_MS } = {}) {
  const repo = store.getItem(itemId)?.repo
  if (!FARM_URL || !repo) return null
  try {
    const res = await fetch(`${FARM_URL}/conflicts/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: itemId, repo }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { cancelled: false, error: `HTTP ${res.status}` }
    return await res.json()
  } catch (err) {
    return { cancelled: false, error: err.name === 'TimeoutError' ? 'timed out' : err.code || err.name || 'unreachable' }
  }
}

// Marks the listed runs that are still running `interrupted` first — so no
// owner write can land after — then stops exactly those rows' work: the
// premerge checkers, and (HZ-256) the resolvers in farmd. `killed` is false
// when nothing was stopped (no tracked checker, a premerge run already past
// its checks and in its merge call, or a resolver farmd could not stop and
// release in time).
export async function interruptForDeploy(runs, { graceMs } = {}) {
  const moved = store.interruptGateActionsForDeploy(runs)
  const interrupted = await Promise.all(
    moved.map(async ({ itemId, kind }) => {
      if (kind === 'premerge') {
        return { itemId, kind, killed: await premerge.interruptRun(itemId, graceMs === undefined ? {} : { graceMs }) }
      }
      const reply = await cancelResolve(itemId)
      return { itemId, kind, killed: Boolean(reply?.cancelled && reply?.lock_released) }
    }),
  )
  return { interrupted }
}

export function endDrain() {
  blockedUntil = 0
}
