// HZ-250 metric lines 1-2: infra/host/deploy-drain.mjs (deploy-horizon.sh's
// drain stage) against the real server routes, listening on a real port: it
// waits while a run is running, stops waiting within one poll of it finishing,
// and interrupts what is left when the wait ends. Its one wait knob defaults
// to 25 minutes. The script-level ordering against `systemctl restart` is
// infra/host/test/deploy-drain.test.sh.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-helper-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'farm-secret-helper'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const deployDrain = await import('../src/deployDrain.js')
const helper = await import('../../infra/host/deploy-drain.mjs')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.listen({ host: '127.0.0.1', port: 0 })
const url = `http://127.0.0.1:${app.server.address().port}/api/farm/deploy-drain`
after(() => app.close())

let seq = 0
function running(kind) {
  const id = `HLP-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', ACCEPT_GATE_INDEX, 'acme/demo', seq, 100 + seq)
  return { id, token: store.claimGateAction(id, kind, { timeoutMs: 600_000 }).token }
}

const cfg = (env) => helper.drainConfig({ HORIZON_DEPLOY_DRAIN_URL: url, FARM_SHARED_SECRET: 'farm-secret-helper', ...env })

test('M1: the wait defaults to 1500 s (25 min); HORIZON_DEPLOY_DRAIN_TIMEOUT_S overrides it, 0 included', () => {
  assert.equal(helper.DEFAULT_TIMEOUT_S, 1500)
  assert.equal(helper.drainConfig({}).timeoutS, 1500)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '90' }).timeoutS, 90)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '0' }).timeoutS, 0)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: 'junk' }).timeoutS, 1500)
})

test('M1/M2: waits while a run is running and returns within one poll of it finishing', async () => {
  const run = running('premerge')
  const lines = []
  let finishedAt = null
  const done = helper.drain(cfg({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '30', HORIZON_DEPLOY_DRAIN_POLL_S: '0.5' }), (l) => lines.push(l)).then(() => Date.now())
  const raced = await Promise.race([done, new Promise((r) => setTimeout(() => r('waiting'), 1500))])
  assert.equal(raced, 'waiting', 'still waiting while the run is running')
  assert.equal(deployDrain.isDeployBlocked(), true, 'new runs are blocked meanwhile')
  store.finishGateAction(run.id, 'premerge', run.token, { state: 'merged' })
  finishedAt = Date.now()
  const returnedAt = await done
  assert.ok(returnedAt - finishedAt <= 500 + 400, `returned ${returnedAt - finishedAt}ms after the run finished`)
  assert.deepEqual(lines, [`DRAIN waiting up to 30s for 1 run(s): ${run.id} premerge`, `DRAIN finished: ${run.id} premerge`, 'DRAIN done: nothing running'])
  assert.equal(store.getGateAction(run.id, 'premerge').state, 'merged', 'a finished run keeps its own outcome')
  deployDrain.endDrain()
})

test('M2/M3: when the wait ends, the runs still going are interrupted and named in the log', async () => {
  const run = running('resolve')
  const lines = []
  await helper.drain(cfg({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '1', HORIZON_DEPLOY_DRAIN_POLL_S: '0.2' }), (l) => lines.push(l))
  assert.deepEqual(lines, [
    `DRAIN waiting up to 1s for 1 run(s): ${run.id} resolve`,
    `DRAIN timed out: ${run.id} resolve — interrupted (server restarted for deploy)`,
  ])
  const row = store.getGateAction(run.id, 'resolve')
  assert.equal(row.state, 'interrupted')
  assert.equal(row.reason, 'server restarted for deploy')
  deployDrain.endDrain()
})

test('G2: a wait of 0 interrupts at once', async () => {
  const run = running('premerge')
  const lines = []
  const started = Date.now()
  await helper.drain(cfg({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '0', HORIZON_DEPLOY_DRAIN_POLL_S: '5' }), (l) => lines.push(l))
  assert.ok(Date.now() - started < 2000, 'no poll sleep before the interrupt')
  assert.equal(lines.at(-1), `DRAIN timed out: ${run.id} premerge — interrupted (server restarted for deploy)`)
  assert.equal(store.getGateAction(run.id, 'premerge').state, 'interrupted')
  deployDrain.endDrain()
})

test('release lifts the block', async () => {
  deployDrain.beginDrain({ ttlS: 600 })
  const lines = []
  await helper.release(cfg({}), (l) => lines.push(l))
  assert.equal(deployDrain.isDeployBlocked(), false)
  assert.deepEqual(lines, ['DRAIN released: new runs allowed again'])
})

// ---- HZ-321: agent steps ----

const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

function runningStep() {
  const id = `HLP-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(id, id, 'Medium', IMPLEMENT_STEP_INDEX, 'acme/demo')
  const runId = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
  return { id, runId }
}

test('the step wait defaults to 1500 s; HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S overrides it, 0 included', () => {
  assert.equal(helper.DEFAULT_STEP_TIMEOUT_S, 1500)
  assert.equal(helper.drainConfig({}).stepTimeoutS, 1500)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S: '45' }).stepTimeoutS, 45)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S: '0' }).stepTimeoutS, 0)
  assert.equal(helper.drainConfig({ HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S: 'junk' }).stepTimeoutS, 1500)
})

test('G1: the block outlasts the longer of the two waits plus both interrupt bounds', async () => {
  const c = cfg({ HORIZON_DEPLOY_DRAIN_TIMEOUT_S: '1', HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S: '20', HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S: '60' })
  assert.ok(helper.blockTtlS(c) >= 20 + 2 * 60, `ttl ${helper.blockTtlS(c)}`)
  // Through the real route: the server's block really lasts that long.
  const started = Date.now()
  await helper.drain({ ...c, url }, () => {})
  const until = Date.parse(deployDrain.beginDrain({ ttlS: 0 }).blockedUntil)
  assert.ok(until - started >= (20 + 2 * 60) * 1000, `blocked for ${until - started}ms`)
  deployDrain.endDrain()
})

test('line 3: a step past its wait is checkpointed through the real route and named in the log', async () => {
  const step = runningStep()
  const lines = []
  await helper.drain(cfg({ HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S: '0.5', HORIZON_DEPLOY_DRAIN_POLL_S: '0.2' }), (l) => lines.push(l))
  assert.deepEqual(lines, [
    `DRAIN waiting up to 0.5s for 1 agent step(s): ${step.id} specialist-agent-implements`,
    // No farm in this test: nothing was running on it to save.
    `DRAIN timed out: ${step.id} specialist-agent-implements — nothing to checkpoint, requeued after deploy`,
  ])
  const row = db.prepare('SELECT status, deploy_interrupted FROM step_run WHERE id = ?').get(step.runId)
  assert.deepEqual({ ...row }, { status: 'cancelled', deploy_interrupted: 1 })
  deployDrain.endDrain()
})

test('O8: a server older than HZ-321 (no `steps` field) logs only the HZ-250 lines', async () => {
  const http = await import('node:http')
  const old = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ blocked: true, running: [] }))
  })
  await new Promise((r) => old.listen(0, '127.0.0.1', r))
  const lines = []
  await helper.drain({ ...cfg({}), url: `http://127.0.0.1:${old.address().port}/api/farm/deploy-drain` }, (l) => lines.push(l))
  old.close()
  assert.deepEqual(lines, ['DRAIN nothing running'])
})
