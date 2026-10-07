// HZ-321: a self-deploy no longer throws away a running agent step. The
// drain lists it, holds new dispatches, and when its wait runs out asks the
// farm to checkpoint and stop it (reason "deploy"). The run is closed as
// deploy-interrupted: its feedback goes back undelivered (guardrail 8), a late
// result or /fail from its dying agent is ignored, and once the drain ends the
// step is redispatched at the same attempt and auto-retry count, with the same
// feedback. Driven through the real deployDrain / orchestrator / app modules
// against a fake farmd (globalThis.fetch).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-requeue-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-hz321'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real watchdogs must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.HZ_PAUSE_CHECKPOINT_TIMEOUT_S = '90' // above the cap: the deploy wait is clamped

const { db } = await import('../src/db.js')
const { STEPS, IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const store = await import('../src/store.js')
const deployDrain = await import('../src/deployDrain.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
// init() is what registers the runner and the drain-end resume.
await orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
const app = buildApp({ logger: false })

let cancels = []
let dispatches = []
let cancelReply = () => ({ ok: true, removed: true, killed: 'farm-run-x', checkpoint: { outcome: 'saved', detail: 'pushed a WIP checkpoint to horizon/x' } })
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  const body = opts.body ? JSON.parse(opts.body) : null
  if (url.endsWith('/steps/cancel')) {
    cancels.push(body)
    return reply(cancelReply(body))
  }
  if (url.endsWith('/steps/run')) dispatches.push(body)
  if (url.endsWith('/runs/alive')) return reply({ alive: {} })
  if (url.endsWith('/status')) return reply({ status: 'running' })
  return reply({ ok: true })
}

after(() => {
  deployDrain.endDrain()
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await wait(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

const runRow = (runId) => db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
const activeRun = (id) => db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const runsOf = (id) => db.prepare('SELECT * FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

function implementItem(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(id, `Item ${id}`, 'Medium', IMPLEMENT_STEP_INDEX, 'acme/demo')
}

test('line 2 / guardrail 8: drain → deploy checkpoint → drain end redispatches at the same attempt, retry count and feedback', async () => {
  implementItem('DR-1')
  db.prepare("INSERT INTO feedback (item_id, target, message) VALUES ('DR-1', 'Eng', 'please keep the old flag')").run()

  // Attempt 2, already one automatic retry in: a deploy stop must keep both.
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('DR-1', ?, 1, ?, 'cancelled')").run(
    IMPLEMENT_STEP_INDEX,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
  )
  orchestrator.kick('DR-1', { autoRetryCount: 1 })
  await until(() => dispatches.length === 1, 'the first dispatch')
  const first = dispatches[0]
  const runId = first.run_id
  assert.equal(first.attempt, 2)
  assert.deepEqual(first.feedback.map((f) => f.message), ['please keep the old flag'])

  // beginDrain lists the step; a dispatch asked for meanwhile is held.
  const begin = deployDrain.beginDrain({ ttlS: 600 })
  assert.deepEqual(begin.steps.map(({ runId: r, itemId, stepIndex, step }) => ({ r, itemId, stepIndex, step })), [
    { r: runId, itemId: 'DR-1', stepIndex: IMPLEMENT_STEP_INDEX, step: 'specialist-agent-implements' },
  ])
  assert.deepEqual(begin.running, [], 'the gate-run list is unchanged')

  const stopped = await orchestrator.interruptStepsForDeploy([runId])
  assert.deepEqual(stopped, [
    { runId, itemId: 'DR-1', step: 'specialist-agent-implements', interrupted: true, checkpoint: { outcome: 'saved', detail: 'pushed a WIP checkpoint to horizon/x' } },
  ])
  assert.deepEqual(cancels, [{ run_id: runId, reason: 'deploy', checkpoint_timeout_s: orchestrator.DEPLOY_CHECKPOINT_TIMEOUT_S }])
  assert.equal(orchestrator.DEPLOY_CHECKPOINT_TIMEOUT_S, 40, 'clamped inside the helper\'s 60 s interrupt bound')
  const row = runRow(runId)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.deploy_interrupted, 1)
  assert.equal(db.prepare("SELECT delivered_at FROM feedback WHERE item_id = 'DR-1'").get().delivered_at, null, 'the feedback is handed back')
  assert.deepEqual(deployDrain.drainStatus().steps, [], 'a stopped step is no longer waited for')
  assert.match(eventTexts('DR-1').at(-1), /^stopped for a Horizon deploy — saved a WIP checkpoint on horizon\/dr-1; restarts after the deploy at the same attempt$/)

  // O1: the dying agent's late /fail and result are stale: no retry, no pause, no new run.
  assert.deepEqual(orchestrator.failFarmRun(runId, 'session gone', 'unreachable'), { ok: true, stale: true })
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'late' }), { ok: true, stale: true })
  assert.equal(store.getItem('DR-1').paused, false)
  assert.equal(activeRun('DR-1'), undefined)

  // Held while the drain lasts.
  orchestrator.kick('DR-1')
  await wait(20)
  assert.equal(dispatches.length, 1, 'no dispatch while a deploy drains')
  assert.equal(activeRun('DR-1'), undefined)

  // The drain ends without a restart (the ERR trap's release): redispatched.
  deployDrain.endDrain()
  await until(() => dispatches.length === 2, 'the redispatch')
  const second = dispatches[1]
  assert.equal(second.attempt, 2, 'the same attempt — a deploy stop is not a failed attempt')
  assert.deepEqual(second.feedback.map((f) => f.message), ['please keep the old flag'], 'the same feedback reaches the next attempt')
  const resumed = runRow(second.run_id)
  assert.equal(resumed.attempt, 2)
  assert.equal(resumed.auto_retry_count, 1, 'the auto-retry budget is untouched')
  assert.equal(resumed.deploy_interrupted, 0)
  assert.equal(db.prepare("SELECT delivered_run_id FROM feedback WHERE item_id = 'DR-1'").get().delivered_run_id, second.run_id)

  // Guardrail 4: any other stop still costs an attempt, exactly as before.
  orchestrator.failFarmRun(second.run_id, 'could not reach the farm', 'unreachable')
  await until(() => dispatches.length === 3, 'the auto-retry')
  assert.equal(dispatches[2].attempt, 3)
  assert.equal(runRow(dispatches[2].run_id).auto_retry_count, 2)
  orchestrator.cancel('DR-1')
})

test('a step that finished before the interrupt is left alone, and a farm that never answers still closes the run', async () => {
  implementItem('DR-2')
  orchestrator.kick('DR-2')
  await until(() => activeRun('DR-2'), 'the dispatch')
  const runId = activeRun('DR-2').id
  orchestrator.failFarmRun(runId, 'ended on its own') // ended before the interrupt (and its watchdog with it)
  assert.deepEqual(await orchestrator.interruptStepsForDeploy([runId]), [
    { runId, itemId: 'DR-2', step: 'specialist-agent-implements', interrupted: false },
  ])
  assert.equal(runRow(runId).deploy_interrupted, 0)

  implementItem('DR-3')
  orchestrator.kick('DR-3')
  await until(() => activeRun('DR-3'), 'the dispatch')
  const live = activeRun('DR-3').id
  cancelReply = () => {
    throw new Error('ECONNREFUSED')
  }
  const [answer] = await orchestrator.interruptStepsForDeploy([live])
  assert.equal(answer.interrupted, true)
  assert.deepEqual(answer.checkpoint, { outcome: 'failed', detail: 'the farm did not answer' })
  assert.equal(runRow(live).deploy_interrupted, 1)
  assert.match(eventTexts('DR-3').at(-1), /progress could not be saved: the farm did not answer/)
  orchestrator.cancel('DR-3')
})

test('the deploy step is never waited for: its run published the release being deployed', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES ('DR-4', 'd', 'Medium', ?, 'acme/demo')").run(DEPLOY_STEP_INDEX)
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('DR-4', ?, 1, ?, 'active')").run(
    DEPLOY_STEP_INDEX,
    STEPS[DEPLOY_STEP_INDEX].agent,
  )
  assert.ok(!store.listRunningAgentSteps().some((s) => s.itemId === 'DR-4'))
  db.prepare("UPDATE step_run SET status = 'cancelled' WHERE item_id = 'DR-4'").run()
})

test('the interrupt route validates `steps` and answers gate-only callers exactly as before', async () => {
  const post = (payload, remoteAddress) =>
    app.inject({ method: 'POST', url: '/api/farm/deploy-drain/interrupt', payload, headers: { 'x-farm-secret': 'farm-secret-hz321' }, ...(remoteAddress ? { remoteAddress } : {}) })
  for (const steps of ['x', [{}], [{ runId: 0 }], [{ runId: '5' }], [null]]) {
    const res = await post({ runs: [], steps })
    assert.equal(res.statusCode, 400, JSON.stringify(steps))
  }
  assert.deepEqual((await post({ runs: [] })).json(), { interrupted: [] }, 'no `steps` key for a gate-only caller')
  assert.deepEqual((await post({ runs: [], steps: [{ runId: 999999 }] })).json(), {
    interrupted: [],
    steps: [{ runId: 999999, itemId: null, step: null, interrupted: false }],
  })
  assert.equal((await post({ runs: [], steps: [] }, '10.0.0.9')).statusCode, 403)
})
