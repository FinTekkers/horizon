// HZ-229: the item list carries one top-level set of expected durations — the
// median of the 20 most recent successful runs per agent step and per gate
// action kind (premerge, resolve), null below 5 samples. Read-only over the
// step_run / gate_action rows already written; one query per list call.
//
// Its own file because config.js reads the environment at import time.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-duration-estimates-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp, snapshot } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { agentStepIndexes, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
await app.ready()
after(() => app.close())

const insertItem = db.prepare("INSERT OR IGNORE INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', 0)")
const insertStepRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, agent, status, output, started_at, ended_at) VALUES ('D-STEPS', ?, 'eng', ?, ?, ?, ?)",
)
const insertGateAction = db.prepare(
  `INSERT INTO gate_action (item_id, kind, state, run_token, epoch, started_at, deadline_at, finished_at)
   VALUES (?, ?, ?, 'tok', 'ep', ?, '2099-01-01T00:00:00.000Z', ?)`,
)
insertItem.run('D-STEPS', 'Step run fixture')

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
// step_run's own format: datetime('now'), e.g. "2026-01-01 10:00:00".
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
let clock = 0

// One step run, `sec` long, starting after every run seeded before it.
function seedStep(stepIndex, sec, { status = 'done', output = null, ended = true } = {}) {
  const start = BASE + clock++ * 3_600_000
  insertStepRun.run(stepIndex, status, output, sqlTime(start), ended ? sqlTime(start + sec * 1000) : null)
}

// One gate action on its own item (gate_action keeps one row per item and
// kind), with gate_action's own ISO "...Z" timestamps.
let gateItem = 0
function seedGate(kind, state, startMs, durMs) {
  const id = `D-GATE-${gateItem++}`
  insertItem.run(id, 'Gate action fixture')
  const finished = durMs == null ? null : new Date(startMs + durMs).toISOString()
  insertGateAction.run(id, kind, state, new Date(startMs).toISOString(), finished)
}

beforeEach(() => {
  db.prepare('DELETE FROM step_run').run()
  db.prepare('DELETE FROM gate_action').run()
})

test('a step takes the 20 most recent done runs by id, and averages an even middle pair to the nearest second', () => {
  // The oldest run (lowest id) is a 1s outlier: counted, it would pull the
  // median down to 600.
  seedStep(0, 1)
  const kept = [700, 510, 760, 600, 540, 780, 500, 720, 601, 570, 740, 520, 710, 560, 750, 530, 730, 580, 770, 550]
  for (const sec of kept) seedStep(0, sec)

  assert.deepEqual(store.durationEstimates()['0'], { medianSec: 601, count: 20 })
})

test('a gate kind takes its 20 most recently finished successful runs, in whole seconds from ISO millisecond timestamps', () => {
  // Samples are 300.8s … 319.8s (".400Z" to ".200Z" a whole number of seconds
  // later); the middle pair 309.8 / 310.8 averages to 310.3 → 310.
  for (let i = 0; i < 20; i++) seedGate('premerge', 'merged', BASE + i * 3_600_000 + 400, (300 + i) * 1000 + 800)
  // Inserted last, but finished first: the oldest by finished_at, so excluded.
  seedGate('premerge', 'merged', BASE - 86_400_000, 1000)

  const estimate = store.durationEstimates().premerge
  assert.deepEqual(estimate, { medianSec: 310, count: 20 })
  assert.ok(Number.isInteger(estimate.medianSec))
})

test('fewer than 5 samples give null; 5 give the median', () => {
  for (const sec of [100, 200, 300, 400]) seedStep(1, sec)
  assert.equal(store.durationEstimates()['1'], null)

  seedStep(1, 50)
  assert.deepEqual(store.durationEstimates()['1'], { medianSec: 200, count: 5 })
})

test('cancelled, failed, interrupted and unfinished runs move neither the median nor the count', () => {
  for (const sec of [10, 20, 30, 40, 50]) seedStep(2, sec)
  for (let i = 0; i < 5; i++) seedGate('resolve', 'resolved', BASE + i * 1000, (i + 1) * 60_000)
  for (let i = 0; i < 5; i++) seedGate('premerge', 'merged', BASE + i * 1000, (i + 1) * 30_000)
  const before = store.durationEstimates()
  assert.deepEqual(before['2'], { medianSec: 30, count: 5 })
  assert.deepEqual(before.resolve, { medianSec: 180, count: 5 })
  assert.deepEqual(before.premerge, { medianSec: 90, count: 5 })

  seedStep(2, 1, { status: 'cancelled' })
  seedStep(2, 1, { status: 'cancelled', output: 'FAILED: agent exited 1' })
  seedStep(2, 1, { status: 'superseded' })
  seedStep(2, 1, { status: 'rejected' })
  seedStep(2, 1, { status: 'active', ended: false })
  seedStep(2, 1, { ended: false })
  seedStep(2, -60) // ended_at before started_at
  for (const state of ['failed', 'interrupted', 'timed_out', 'blocked', 'escalated']) {
    seedGate('resolve', state, BASE, 1000)
    seedGate('premerge', state, BASE, 1000)
  }
  seedGate('resolve', 'running', BASE, null)
  seedGate('premerge', 'running', BASE, null)
  seedGate('premerge', 'merged', BASE, null)

  const afterExcluded = store.durationEstimates()
  assert.deepEqual(afterExcluded['2'], before['2'])
  assert.deepEqual(afterExcluded.resolve, before.resolve)
  assert.deepEqual(afterExcluded.premerge, before.premerge)
})

test('GET /api/items carries one top-level durationEstimates object and no item carries one', async () => {
  for (const sec of [60, 120, 180, 240, 300]) seedStep(0, sec)

  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  const estimates = body.durationEstimates
  assert.deepEqual(
    Object.keys(estimates).sort(),
    [...agentStepIndexes().map(String), 'premerge', 'resolve'].sort(),
  )
  for (const [key, value] of Object.entries(estimates)) {
    if (value === null) continue
    assert.deepEqual(Object.keys(value).sort(), ['count', 'medianSec'], `estimate ${key}`)
    assert.ok(Number.isInteger(value.medianSec) && Number.isInteger(value.count), `estimate ${key}`)
  }
  assert.deepEqual(estimates['0'], { medianSec: 180, count: 5 })
  assert.equal(estimates.resolve, null, 'a null estimate survives the response serializer')

  assert.ok(body.items.length > 0)
  for (const item of body.items) assert.ok(!('durationEstimates' in item), `item ${item.id} carries an estimate`)
})

test('GET /api/farm/snapshot keeps its shape: no durationEstimates', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/farm/snapshot?scope=enabled',
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
  })
  assert.equal(res.statusCode, 200)
  assert.ok(Array.isArray(res.json().items))
  assert.ok(!('durationEstimates' in res.json()))
})

test('the estimates add exactly one query to a list call', () => {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'))
  const methods = ['all', 'get', 'iterate']
  const originals = Object.fromEntries(methods.map((m) => [m, proto[m]]))
  let queries = 0
  for (const m of methods) {
    proto[m] = function (...args) {
      queries++
      return originals[m].apply(this, args)
    }
  }
  const countQueries = (fn) => {
    queries = 0
    fn()
    return queries
  }
  try {
    const baseline = countQueries(() => snapshot({ scope: 'enabled', estimates: false }))
    const withEstimates = countQueries(() => snapshot({ scope: 'enabled' }))
    assert.ok(baseline > 0, 'the spy counted nothing')
    assert.equal(withEstimates - baseline, 1)
  } finally {
    Object.assign(proto, originals)
  }
})

test('human gates never get an estimate', () => {
  const gates = gateStepIndexes()
  assert.ok(gates.length > 0)
  for (const index of gates) for (let i = 0; i < 6; i++) seedStep(index, 100)

  const estimates = store.durationEstimates()
  for (const index of gates) assert.ok(!(String(index) in estimates), `gate ${index} has an estimate`)
})

test('a list call writes nothing: schema and row counts are unchanged', async () => {
  for (const sec of [60, 120, 180, 240, 300]) seedStep(0, sec)
  for (let i = 0; i < 5; i++) seedGate('premerge', 'merged', BASE + i * 1000, 60_000)
  const state = () => ({
    schema: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
    stepRuns: db.prepare('SELECT COUNT(*) AS n FROM step_run').get().n,
    gateActions: db.prepare('SELECT COUNT(*) AS n FROM gate_action').get().n,
  })
  const before = state()

  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(state(), before)
})
