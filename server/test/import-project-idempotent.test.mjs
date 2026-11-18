// HO-880: an import creates nothing twice.
//
//   metric 3: a sequential re-run creates zero items and zero tracker
//             records; the counts match the first run.
//   metric 3 + 4 (R6): a second POST while the first is held inside the
//             Tracker port gets 409 import_in_progress; there are exactly 2
//             records and 1 project_event; a later re-run adds exactly one
//             more event, with open 0 and closed 0.
//   guardrail 3 (R5): a record that lands in the target backend but whose
//             answer is lost fails the run with 502; the re-run finds that
//             record by its marker and creates no second one.
//
// Each case gets its own source and target projects. The Tracker port is the
// real sl adapter (backends/slTracker.js) against the farmd stub, so these
// run under `npm test` against the adapter production uses.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'
import { FARM_SECRET, countWhere, postImport } from './helpers/importFixture.mjs'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-import-idempotent-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = FARM_SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_TEST_HOOKS']) delete process.env[key]

const stub = createFarmTasksStub({ secret: FARM_SECRET })
// A create can be held on a deferred promise (R6); everything else is the stub.
let hold = null
globalThis.fetch = async (input, init = {}) => {
  if (hold && (init.method || 'GET').toUpperCase() === 'POST' && new URL(String(input)).pathname === '/api/farm/tasks') {
    const gate = hold
    hold = null
    gate.reached()
    await gate.released
  }
  return stub.fetch(input, init)
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { endIndex, firstStepIndex } = await import('../../domain/js/lifecycle.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config, { email: 'idem-owner@example.com', name: 'Idem Owner', role: 'owner' })

// A fresh GitHub source with 2 open + 1 closed items, and a fresh sl target.
let seq = 0
function fixture() {
  const n = ++seq
  const source = store.createProject(`Idem old ${n}`).id
  const sourceRepo = `acme/idem-old-${n}`
  assert.equal(store.addRepoToProject(source, sourceRepo).ok, true)
  const target = store.createProject(`Idem new ${n}`).id
  const targetRepo = `acme/idem-new-${n}`
  assert.equal(store.addRepoToProject(target, targetRepo, 'sl').ok, true)
  store.setProjectEnabled(target, true)
  const prefix = store.findRepo(sourceRepo).prefix
  const insert = db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, issue, repo, project_id, cursor, backend) VALUES (?, ?, 'High', 'An outcome.', '1. A line.', ?, ?, ?, ?, 'github')",
  )
  const open = [`${prefix}-1`, `${prefix}-2`]
  insert.run(open[0], 'Open one', 1, sourceRepo, source, firstStepIndex('change'))
  insert.run(open[1], 'Open two', 2, sourceRepo, source, firstStepIndex('change'))
  insert.run(`${prefix}-3`, 'Closed', 3, sourceRepo, source, endIndex('change'))
  return { source, target, targetRepo, open, body: { sourceProjectId: source, targetProjectId: target } }
}

const counts = (fx) => ({
  items: countWhere(db, 'work_item', 'project_id = ?', fx.target),
  records: [...stub.tasks.values()].filter((t) => t.repo === fx.targetRepo).length,
  creates: stub.callsTo('create').filter((c) => c.body.repo === fx.targetRepo).length,
  events: countWhere(db, 'project_event', "project_id = ? AND kind = 'import'", fx.target),
})
const lastEvent = (fx) => JSON.parse(db.prepare("SELECT new_value FROM project_event WHERE project_id = ? AND kind = 'import' ORDER BY id DESC").get(fx.target).new_value)

test('metric 3: a sequential re-run creates zero items and zero tracker records; the counts match the first run', async () => {
  const fx = fixture()
  const first = await postImport(app, owner, fx.body)
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual([first.json().open, first.json().closed], [2, 1])
  const afterFirst = counts(fx)
  assert.deepEqual(afterFirst, { items: 3, records: 2, creates: 2, events: 1 })

  const again = await postImport(app, owner, fx.body)
  assert.equal(again.statusCode, 200, again.body)
  assert.deepEqual([again.json().open, again.json().closed, again.json().skipped], [0, 0, 3])
  assert.deepEqual(counts(fx), { ...afterFirst, events: 2 }, 'only the run’s own project_event is new')
  assert.deepEqual(lastEvent(fx), { source: fx.source, target: fx.target, open: 0, closed: 0, skipped: 3 })
})

test('R6: a second POST while the first is held in the Tracker port gets 409; 2 records and 1 event; a later re-run adds one event with open 0, closed 0', async () => {
  const fx = fixture()
  let reached
  const reachedPromise = new Promise((resolve) => (reached = resolve))
  let release
  hold = { reached, released: new Promise((resolve) => (release = resolve)) }
  const firstPromise = postImport(app, owner, fx.body)
  await reachedPromise

  const second = await postImport(app, owner, fx.body)
  assert.equal(second.statusCode, 409, second.body)
  assert.equal(second.json().error, 'import_in_progress')
  release()
  const first = await firstPromise
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(counts(fx), { items: 3, records: 2, creates: 2, events: 1 })

  const later = await postImport(app, owner, fx.body)
  assert.equal(later.statusCode, 200, later.body)
  assert.equal(counts(fx).events, 2)
  assert.deepEqual(lastEvent(fx), { source: fx.source, target: fx.target, open: 0, closed: 0, skipped: 3 })
  assert.equal(counts(fx).records, 2)
})

test('guardrail 3 (R5): a record that lands but whose answer is lost fails the run with 502; the re-run finds it and leaves exactly 2 records and 2 open copies', async () => {
  const fx = fixture()
  // The first open item files cleanly. The second's create lands in the farm
  // twice over (the adapter's one same-key retry) with both answers lost.
  const realFetch = globalThis.fetch
  let creates = 0
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method || 'GET').toUpperCase() === 'POST' && new URL(String(input)).pathname === '/api/farm/tasks' && ++creates === 2) {
      stub.timeoutNextCreate()
      stub.timeoutNextCreate()
    }
    return realFetch(input, init)
  }
  let crashed
  try {
    crashed = await postImport(app, owner, fx.body)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(crashed.statusCode, 502, crashed.body)
  assert.equal(crashed.json().error, 'tracker_failed')
  assert.equal(crashed.json().item, fx.open[1])
  assert.equal(counts(fx).records, 2, 'the second record landed in the target backend')
  assert.equal(countWhere(db, 'work_item', 'project_id = ? AND source_item_id = ?', fx.target, fx.open[1]), 0, 'but no copy was recorded for it')

  const rerun = await postImport(app, owner, fx.body)
  assert.equal(rerun.statusCode, 200, rerun.body)
  assert.deepEqual([rerun.json().open, rerun.json().closed], [1, 0])
  const total = counts(fx)
  assert.equal(total.records, 2, 'no second record for the lost answer')
  assert.equal(total.creates, 3, 'the re-run created nothing: 1 clean create + the lost create and its same-key retry')
  const openCopies = db
    .prepare('SELECT source_item_id FROM work_item WHERE project_id = ? AND task_id IS NOT NULL ORDER BY source_item_id')
    .all(fx.target)
    .map((r) => r.source_item_id)
  assert.deepEqual(openCopies, [...fx.open].sort())
  assert.equal(total.items, 3)
})
