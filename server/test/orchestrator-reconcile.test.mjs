// HZ-100: liveness for a farm-dispatched step used to live ONLY in the
// server's in-memory `timers` map — a step_run row left `active` with a lost
// timer had nothing watching it and stalled forever (HZ-93's run 640 sat
// active for 16 minutes beside an idle, healthy farm; it moved only when a
// human failed it by hand). reconcileActiveRuns() is the DB-backed backstop:
// any `active` row with no local timer is checked against the farm's own
// /runs/alive endpoint before being failed through the existing
// failFarmRun/never_picked_up path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-reconcile-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// alive[runId] answers a /runs/alive call; aliveBehavior overrides it (e.g.
// to throw, simulating an unreachable farm) when set for a test.
let alive = {}
let aliveBehavior = null
const calls = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  calls.push({ url: String(url), body })
  if (String(url).includes('/runs/alive')) {
    if (aliveBehavior) return aliveBehavior(body)
    return { ok: true, json: async () => ({ alive }) }
  }
  return { ok: true, json: async () => ({}) }
}

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// A raw active step_run row with NO local timer — exactly the HZ-93 shape: a
// run the server has lost track of, bypassing kick()'s normal dispatch path
// (which would always arm one).
function strandedActiveRow(itemId, stepIndex = IMPLEMENT_STEP_INDEX) {
  const agent = STEPS[stepIndex].agent
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, ?)')
    .run(itemId, stepIndex, agent, 'active').lastInsertRowid
}

function stepRun(runId) {
  return db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
}

function eventTexts(itemId) {
  return db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(itemId).map((r) => r.text)
}

test.beforeEach(() => {
  alive = {}
  aliveBehavior = null
  calls.length = 0
})

// ---- HZ-93 regression: this must fail against pre-HZ-100 code (no sweep exists) ----

test('a step_run left active with no timer, no task file, and no session is failed as never_picked_up, and the item is re-dispatched', async () => {
  insertItem.run('RC-1', 'Stranded like run 640', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = strandedActiveRow('RC-1')
  alive = { [String(runId)]: false } // farm has no claim, no session — HZ-101's own farm-side check would agree

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 1 })
  assert.equal(stepRun(runId).status, 'cancelled')
  assert.match(stepRun(runId).output, /^FAILED:/)
  assert.ok(
    eventTexts('RC-1').some((t) => /never_picked_up/.test(t) && /auto-retrying/.test(t)),
    'must be classified never_picked_up and auto-retried (HZ-76: only tagged reasons ever auto-retry)',
  )
  assert.equal(store.getItem('RC-1').paused, false, 'never_picked_up is retryable — must not pause on the first miss')

  const redispatched = db.prepare("SELECT * FROM step_run WHERE item_id = 'RC-1' AND status = 'active'").get()
  assert.ok(redispatched, 'the item must have been re-dispatched, no human action required')
  assert.equal(redispatched.auto_retry_count, 1)

  orchestrator.cancel('RC-1')
})

// ---- an armed server timer always wins ----

test('a run the server\'s own queue or execution timer still legitimately owns is left alone by the sweep', async () => {
  insertItem.run('RC-2', 'Owned by a real timer', 'Medium', IMPLEMENT_STEP_INDEX)
  orchestrator.kick('RC-2') // real dispatch — arms the queue watchdog, keyed by run id
  await wait(10)
  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = 'RC-2' AND status = 'active'").get().id

  // If the sweep asked the farm at all, answer "not alive" — proving the
  // timer check alone is what shields it, not a lucky farm response.
  alive = { [String(runId)]: false }
  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 0, failed: 0 }, 'a run with an armed timer must never even become a candidate')
  assert.equal(stepRun(runId).status, 'active')
  assert.ok(!calls.some((c) => c.url.includes('/runs/alive')), 'no farm call was needed — the local timer already proves it')

  orchestrator.cancel('RC-2')
})

// ---- a live session (proven via the farm) is never failed ----

test('a run the farm reports alive is never failed by the sweep, even with no local timer', async () => {
  insertItem.run('RC-3', 'Alive per the farm, timer lost', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = strandedActiveRow('RC-3')
  alive = { [String(runId)]: true } // a live session or an active farm claim — proof of life

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 0 })
  assert.equal(stepRun(runId).status, 'active', 'a live run must never be failed, timer or no timer')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'RC-3'").get().n, 0)
  orchestrator.cancel('RC-3') // leave no active row behind for later tests' candidate queries
})

// ---- an unreachable farm is unknown, not dead ----

test('a farm the sweep cannot reach is treated as unknown — every candidate is left alone', async () => {
  // Covers both an immediate network failure AND farmFetch's own bounded
  // AbortController timeout (config.js's DEFAULT_FARM_FETCH_TIMEOUT_MS) — a
  // timed-out /runs/alive call surfaces to reconcileActiveRuns identically to
  // any other rejection (a thrown Error), so both are the same code path;
  // farmFetch itself is what guarantees this never hangs unbounded.
  insertItem.run('RC-4', 'Farm unreachable during sweep', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = strandedActiveRow('RC-4')
  aliveBehavior = () => {
    throw new Error('fetch failed')
  }

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 0 })
  assert.equal(stepRun(runId).status, 'active', 'an unreachable farm is not evidence of death')
  orchestrator.cancel('RC-4')
})

// ---- idempotent under overlapping ticks ----

test('overlapping sweep ticks do not double-fail the same row', async () => {
  insertItem.run('RC-6', 'Overlapping ticks', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = strandedActiveRow('RC-6')

  let releaseAlive
  aliveBehavior = () =>
    new Promise((resolve) => {
      releaseAlive = () => resolve({ ok: true, json: async () => ({ alive: { [String(runId)]: false } }) })
    })

  const first = orchestrator.reconcileActiveRuns()
  await wait(10) // let the first tick start its farm call and set reconcileInFlight

  const second = await orchestrator.reconcileActiveRuns() // a tick firing while the first is still in flight
  assert.deepEqual(second, { checked: 0, failed: 0 }, 'a sweep already in flight must short-circuit, not run a second pass concurrently')

  releaseAlive()
  const firstResult = await first
  assert.deepEqual(firstResult, { checked: 1, failed: 1 })

  const failCalls = calls.filter((c) => c.url.includes('/runs/alive'))
  assert.equal(failCalls.length, 1, 'only one /runs/alive call must have been made across both overlapping ticks')
  assert.equal(stepRun(runId).status, 'cancelled')

  orchestrator.cancel('RC-6')
})

// ---- retry-cap exhaustion pauses instead of retrying again ----

test('a sweep-triggered failure at the retry cap pauses rather than auto-retrying past the budget', async () => {
  insertItem.run('RC-7', 'At the retry cap', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, auto_retry_count)
       VALUES (?, ?, 1, ?, 'active', ?)`,
    )
    .run('RC-7', IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, orchestrator.AUTO_RETRY_CAP).lastInsertRowid
  alive = { [String(runId)]: false }

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 1 })
  assert.equal(stepRun(runId).status, 'cancelled')
  assert.equal(store.getItem('RC-7').paused, true, 'the auto-retry budget is exhausted — this must pause, not retry again')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'RC-7' AND status = 'active'").get().n,
    0,
    'no further run may be dispatched once the cap is reached',
  )
  assert.ok(eventTexts('RC-7').some((t) => /budget \(3\) exhausted/.test(t)))
})
