#!/usr/bin/env node
// HZ-250: deploy-horizon.sh's drain stage. Before the script restarts
// horizon-server it waits a bounded time for any running pre-merge or resolve
// run to finish, so a deploy no longer strands another item's run with nobody
// left to read its result. The server owns every DB write and every process
// it signals (server/src/deployDrain.js); this helper only drives its
// loopback-only /api/farm/deploy-drain routes:
//
//   node deploy-drain.mjs drain    block new runs, wait, interrupt what is left
//   node deploy-drain.mjs release  lift the block (the script's ERR trap)
//
// It prints one line per event on stdout, which the script appends to
// self-deploy.log, and ALWAYS exits 0: a server that is down, hung or
// answering errors is logged as "DRAIN skipped" and the deploy goes on. Every
// request carries its own timeout, so the drain can never hold the deploy
// (and its flock) past timeout + the request bounds below.
//
// Environment (all set by server/src/deploy.js or the operator):
//   HORIZON_DEPLOY_DRAIN_URL                 the server's drain route (required)
//   FARM_SHARED_SECRET                       sent as x-farm-secret, never printed
//   HORIZON_DEPLOY_DRAIN_TIMEOUT_S           how long to wait for runs (default 1500 = 25 min; 0 = interrupt at once)
//   HORIZON_DEPLOY_DRAIN_POLL_S              poll interval (default 5)
//   HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S   bound on each begin/status/release request (default 10)
//   HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S bound on the interrupt request, which waits for checkers to stop (default 60)
//
// Log lines never carry env values, response bodies or error messages — only
// item ids, kinds, counts, HTTP statuses and error codes.

import { pathToFileURL } from 'node:url'

export const DEFAULT_TIMEOUT_S = 1500
// Extra block time past the wait, for the restart and the health check. The
// restarted server starts unblocked anyway; this only bounds a dead script.
const BLOCK_SLACK_S = 600

function seconds(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function drainConfig(env = process.env) {
  return {
    url: env.HORIZON_DEPLOY_DRAIN_URL || '',
    secret: env.FARM_SHARED_SECRET || 'dev-secret',
    timeoutS: seconds(env.HORIZON_DEPLOY_DRAIN_TIMEOUT_S, DEFAULT_TIMEOUT_S),
    pollS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_POLL_S, 5), 0.05),
    requestTimeoutS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S, 10), 0.1),
    interruptTimeoutS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S, 60), 0.1),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Ids come from the server's DB; keep a log line one line of plain text.
const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64)
const label = (run) => `${safe(run.itemId)} ${safe(run.kind)}`

class DrainError extends Error {}

// Why a request failed, without its message (which can echo headers or URLs).
function why(err, timeoutS) {
  if (err instanceof DrainError) return err.message
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no response within ${timeoutS}s`
  return safe(err?.cause?.code || err?.code || err?.name || 'error')
}

async function call(cfg, method, path, body, timeoutS) {
  const res = await fetch(cfg.url + path, {
    method,
    headers: { 'x-farm-secret': cfg.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutS * 1000),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new DrainError(`HTTP ${res.status}`)
  }
  return res.json()
}

const runsOf = (reply) => (Array.isArray(reply?.running) ? reply.running : [])
const keyOf = (run) => `${run.itemId}\u0000${run.kind}`

export async function drain(cfg, print = console.log) {
  if (!cfg.url) {
    print('DRAIN skipped: no drain URL')
    return
  }
  let begin
  try {
    begin = await call(cfg, 'POST', '', { ttl_s: Math.ceil(cfg.timeoutS) + BLOCK_SLACK_S }, cfg.requestTimeoutS)
  } catch (err) {
    print(`DRAIN skipped: could not reach the server (${why(err, cfg.requestTimeoutS)})`)
    return
  }
  const pending = new Map(runsOf(begin).map((run) => [keyOf(run), run]))
  if (pending.size === 0) {
    print('DRAIN nothing running')
    return
  }
  print(`DRAIN waiting up to ${cfg.timeoutS}s for ${pending.size} run(s): ${[...pending.values()].map(label).join(', ')}`)

  const deadline = Date.now() + cfg.timeoutS * 1000
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(Math.min(cfg.pollS * 1000, Math.max(deadline - Date.now(), 0)))
    let status
    try {
      status = await call(cfg, 'GET', '', undefined, cfg.requestTimeoutS)
    } catch (err) {
      print(`DRAIN skipped: status check failed (${why(err, cfg.requestTimeoutS)})`)
      return
    }
    const still = new Set(runsOf(status).map(keyOf))
    for (const [key, run] of pending) {
      if (still.has(key)) continue
      print(`DRAIN finished: ${label(run)}`)
      pending.delete(key)
    }
  }
  if (pending.size === 0) {
    print('DRAIN done: nothing running')
    return
  }

  const runs = [...pending.values()].map(({ itemId, kind }) => ({ itemId, kind }))
  let reply
  try {
    reply = await call(cfg, 'POST', '/interrupt', { runs }, cfg.interruptTimeoutS)
  } catch (err) {
    print(`DRAIN skipped: interrupt failed (${why(err, cfg.interruptTimeoutS)})`)
    return
  }
  const interrupted = new Set((Array.isArray(reply?.interrupted) ? reply.interrupted : []).map(keyOf))
  for (const [key, run] of pending) {
    // Not interrupted: it finished between the last poll and the interrupt.
    print(
      interrupted.has(key)
        ? `DRAIN timed out: ${label(run)} — interrupted (server restarted for deploy)`
        : `DRAIN finished: ${label(run)}`,
    )
  }
}

export async function release(cfg, print = console.log) {
  if (!cfg.url) return
  try {
    await call(cfg, 'DELETE', '', undefined, cfg.requestTimeoutS)
    print('DRAIN released: new runs allowed again')
  } catch (err) {
    print(`DRAIN release failed (${why(err, cfg.requestTimeoutS)}) — the block expires by itself`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2]
  const cfg = drainConfig()
  const run = command === 'drain' ? drain : command === 'release' ? release : null
  if (!run) {
    console.log(`DRAIN skipped: unknown command ${safe(command)}`)
  } else {
    try {
      await run(cfg)
    } catch (err) {
      console.log(`DRAIN skipped: ${why(err, cfg.requestTimeoutS)}`)
    }
  }
  process.exit(0)
}
