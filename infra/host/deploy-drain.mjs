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
//   HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S      HZ-321: how long to wait for running agent steps (default 1500; 0 = checkpoint at once)
//   HORIZON_DEPLOY_DRAIN_POLL_S              poll interval (default 5)
//   HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S   bound on each begin/status/release request (default 10)
//   HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S bound on the interrupt request, which waits for checkers to stop (default 60)
//
// Log lines never carry env values, response bodies or error messages — only
// item ids, kinds, counts, HTTP statuses and error codes.
//
// HZ-321: running agent steps (the server's `steps` field) are waited on in
// the same poll loop, against their own deadline. A step still going when it
// passes is checkpointed — a WIP commit pushed to its item's branch — and
// stopped by the server, then redispatched after the deploy at the same
// attempt. Its lines name the item and step:
//   DRAIN waiting up to <n>s for <k> agent step(s): <item> <step>, ...
//   DRAIN finished: <item> <step>
//   DRAIN timed out: <item> <step> — <what happened>, requeued after deploy
//   DRAIN checkpoint failed: <item> <step> (<why>)
// A server without `steps` (one older than this helper) has none to wait for.
// The whole drain ends within max(both waits) + the request bounds + two
// interrupt bounds (one for runs, one for steps).

import { pathToFileURL } from 'node:url'

export const DEFAULT_TIMEOUT_S = 1500
export const DEFAULT_STEP_TIMEOUT_S = 1500
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
    stepTimeoutS: seconds(env.HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S, DEFAULT_STEP_TIMEOUT_S),
    pollS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_POLL_S, 5), 0.05),
    requestTimeoutS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S, 10), 0.1),
    interruptTimeoutS: Math.max(seconds(env.HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S, 60), 0.1),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Ids come from the server's DB; keep a log line one line of plain text.
const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64)
const label = (run) => `${safe(run.itemId)} ${safe(run.kind)}`
const stepLabel = (step) => `${safe(step.itemId)} ${safe(step.step)}`

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
const stepsOf = (reply) => (Array.isArray(reply?.steps) ? reply.steps.filter((step) => Number.isInteger(step?.runId)) : [])

// The block must outlast both waits and both interrupt calls, or new runs
// could start while the drain is still waiting.
export function blockTtlS(cfg) {
  return Math.ceil(Math.max(cfg.timeoutS, cfg.stepTimeoutS ?? 0)) + 2 * Math.ceil(cfg.interruptTimeoutS) + BLOCK_SLACK_S
}

const STEP_STOPPED = {
  saved: 'checkpointed',
  nothing: 'nothing to checkpoint',
  not_running: 'nothing to checkpoint',
}

export async function drain(cfg, print = console.log) {
  if (!cfg.url) {
    print('DRAIN skipped: no drain URL')
    return
  }
  let begin
  try {
    begin = await call(cfg, 'POST', '', { ttl_s: blockTtlS(cfg) }, cfg.requestTimeoutS)
  } catch (err) {
    print(`DRAIN skipped: could not reach the server (${why(err, cfg.requestTimeoutS)})`)
    return
  }
  const pending = new Map(runsOf(begin).map((run) => [keyOf(run), run]))
  const steps = new Map(stepsOf(begin).map((step) => [step.runId, step]))
  if (pending.size === 0 && steps.size === 0) {
    print('DRAIN nothing running')
    return
  }
  if (pending.size > 0) {
    print(`DRAIN waiting up to ${cfg.timeoutS}s for ${pending.size} run(s): ${[...pending.values()].map(label).join(', ')}`)
  }
  if (steps.size > 0) {
    print(`DRAIN waiting up to ${cfg.stepTimeoutS}s for ${steps.size} agent step(s): ${[...steps.values()].map(stepLabel).join(', ')}`)
  }

  const started = Date.now()
  const deadline = started + cfg.timeoutS * 1000
  const stepDeadline = started + cfg.stepTimeoutS * 1000
  let interrupted = false
  for (;;) {
    if (pending.size > 0 && Date.now() >= deadline) {
      interrupted = true
      if (!(await interruptRuns(cfg, pending, print)) && steps.size === 0) return
      pending.clear()
    }
    if (steps.size > 0 && Date.now() >= stepDeadline) {
      interrupted = true
      await interruptSteps(cfg, steps, print)
      steps.clear()
    }
    if (pending.size === 0 && steps.size === 0) break
    const next = Math.min(pending.size > 0 ? deadline : Infinity, steps.size > 0 ? stepDeadline : Infinity)
    await sleep(Math.min(cfg.pollS * 1000, Math.max(next - Date.now(), 0)))
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
    const stillSteps = new Set(stepsOf(status).map((step) => step.runId))
    for (const [runId, step] of steps) {
      if (stillSteps.has(runId)) continue
      print(`DRAIN finished: ${stepLabel(step)}`)
      steps.delete(runId)
    }
  }
  if (!interrupted) print('DRAIN done: nothing running')
}

// The HZ-250 interrupt of pre-merge/resolve runs, its request and lines
// unchanged. False when the request failed (already logged).
async function interruptRuns(cfg, pending, print) {
  const runs = [...pending.values()].map(({ itemId, kind }) => ({ itemId, kind }))
  let reply
  try {
    reply = await call(cfg, 'POST', '/interrupt', { runs }, cfg.interruptTimeoutS)
  } catch (err) {
    print(`DRAIN skipped: interrupt failed (${why(err, cfg.interruptTimeoutS)})`)
    return false
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
  return true
}

// HZ-321: asks the server to checkpoint and stop the steps still running. A
// failed request or checkpoint is logged and the deploy goes on.
async function interruptSteps(cfg, steps, print) {
  let reply
  try {
    reply = await call(cfg, 'POST', '/interrupt', { runs: [], steps: [...steps.keys()].map((runId) => ({ runId })) }, cfg.interruptTimeoutS)
  } catch (err) {
    for (const step of steps.values()) {
      print(`DRAIN timed out: ${stepLabel(step)} — stop not confirmed`)
      print(`DRAIN checkpoint failed: ${stepLabel(step)} (${why(err, cfg.interruptTimeoutS)})`)
    }
    return
  }
  const answers = new Map(stepsOf(reply).map((answer) => [answer.runId, answer]))
  for (const [runId, step] of steps) {
    const answer = answers.get(runId)
    if (answer && answer.interrupted === false) {
      // It finished between the last poll and the interrupt.
      print(`DRAIN finished: ${stepLabel(step)}`)
      continue
    }
    const outcome = answer?.checkpoint?.outcome
    const stopped = answer?.interrupted === true && Object.hasOwn(STEP_STOPPED, outcome ?? '') ? STEP_STOPPED[outcome] : null
    if (stopped) {
      print(`DRAIN timed out: ${stepLabel(step)} — ${stopped}, requeued after deploy`)
    } else {
      print(`DRAIN timed out: ${stepLabel(step)} — ${answer?.interrupted ? 'stopped, requeued after deploy' : 'stop not confirmed'}`)
      print(`DRAIN checkpoint failed: ${stepLabel(step)} (${outcome ? safe(outcome) : 'no answer'})`)
    }
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
