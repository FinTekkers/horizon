// HZ-481: the facts the card's deploy line reads, on each item's
// `deploy_queue` — the batch id, the drain (when it began, its deadline, the
// steps it waits on) while a Horizon self-deploy drains, and "live about".
// The drain read is wired by the real orchestrator init(), and read back
// through the board's own snapshot(); the drain is the real deployDrain.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('deploy-queue-label-facts test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-label-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon'), { recursive: true })
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { snapshot } = await import('../src/app.js')
const deployDrain = await import('../src/deployDrain.js')
const { DEPLOY_STEP_INDEX, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { sqlTime } = await import('../src/sqlTime.js')

store.purgeDemoItems()
// init() is what registers the drain read this line depends on.
await orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })

after(() => {
  deployDrain.endDrain()
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const DRAIN_KEYS = ['drain_started_at', 'drain_deadline', 'drain_waiting']
const OLD_KEYS = ['target', 'status', 'batch_status', 'window_closes_at', 'tag']
const T0 = Date.parse('2026-10-15T04:00:00Z')

function item(id, cursor = DEPLOY_STEP_INDEX) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, 'Medium', ?, 'FinTekkers/horizon')").run(id, `fixture ${id}`, cursor)
}
function batch(target, status, { startedAt = null, liveAt = null, tag = null } = {}) {
  return Number(
    db
      .prepare('INSERT INTO deploy_batch (target, repo, status, window_closes_at, tag, started_at, live_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(target, `FinTekkers/${target}`, status, sqlTime(T0), tag, startedAt == null ? null : sqlTime(startedAt), liveAt == null ? null : sqlTime(liveAt))
      .lastInsertRowid,
  )
}
// A finished deploy of `target` that took `seconds`, publish start to live.
const took = (target, seconds, i) => batch(target, 'done', { startedAt: T0 - 86_400_000 + i * 3_600_000, liveAt: T0 - 86_400_000 + i * 3_600_000 + seconds * 1000 })
function queue(itemId, target, batchId, status = 'queued') {
  db.prepare('INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, status) VALUES (?, ?, ?, ?, ?)').run(itemId, target, 'c'.repeat(40), batchId, status)
}
const board = (id) => snapshot({ scope: 'enabled' }).items.find((it) => it.id === id).deploy_queue

// An older, slow horizon deploy that is not among the last 5, then the last
// 5 (60/90/120/150/600 s, median 120 s), and a fast ui-service deploy.
took('horizon', 6000, 0)
for (const [i, s] of [60, 90, 120, 150, 600].entries()) took('horizon', s, i + 1)
took('ui-service', 5, 7)

item('DQ-H')
item('DQ-U')
item('DQ-OPEN')
item('DQ-S1', IMPLEMENT_STEP_INDEX)
item('DQ-S2', REVIEW_STEP_INDEX)
const deploying = batch('horizon', 'deploying', { startedAt: T0, tag: 'deploy-horizon-20261015-b9' })
queue('DQ-H', 'horizon', deploying)
const uiDeploying = batch('ui-service', 'deploying', { startedAt: T0, tag: 'deploy-ui-service-20261015-b10' })
queue('DQ-U', 'ui-service', uiDeploying)
const open = batch('horizon', 'open')
queue('DQ-OPEN', 'horizon', open)
db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES ('DQ-S1', ?, 'eng', 'active')").run(IMPLEMENT_STEP_INDEX)
db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES ('DQ-S2', ?, 'review', 'active')").run(REVIEW_STEP_INDEX)

test('metric 2: a Horizon drain with 2 running steps puts its start, deadline and steps on the queued item, then takes them off', () => {
  try {
    const before = Date.now()
    const begun = deployDrain.beginDrain({ ttlS: 600 })
    const q = board('DQ-H')
    assert.ok(Date.parse(q.drain_started_at) >= before && Date.parse(q.drain_started_at) <= Date.now())
    assert.equal(q.drain_deadline, begun.blockedUntil)
    assert.deepEqual(q.drain_waiting, [
      { item_id: 'DQ-S1', step: 'implement' },
      { item_id: 'DQ-S2', step: 'review' },
    ])
    // Additive: the HZ-333 keys keep their names and meaning.
    assert.deepEqual(
      Object.fromEntries(OLD_KEYS.map((k) => [k, q[k]])),
      { target: 'horizon', status: 'queued', batch_status: 'deploying', window_closes_at: new Date(T0).toISOString().replace('.000', ''), tag: 'deploy-horizon-20261015-b9' },
    )
    assert.equal(q.batch_id, deploying)
    assert.equal(q.deploying_since, new Date(T0).toISOString().replace('.000', ''))
    // While draining, "live about" counts from the drain's deadline.
    assert.equal(q.live_eta, new Date(Date.parse(begun.blockedUntil) + 120_000).toISOString())

    // metric 4: the drain is process-wide, but only a Horizon deploy drains.
    const ui = board('DQ-U')
    for (const key of DRAIN_KEYS) assert.ok(!(key in ui), `ui-service has no ${key}`)
    assert.equal(ui.batch_status, 'deploying')
  } finally {
    deployDrain.endDrain()
  }
  const q = board('DQ-H')
  for (const key of DRAIN_KEYS) assert.ok(!(key in q), `${key} is gone once the drain ends`)
  assert.equal(q.status, 'queued')
})

test('metric 3: "live about" is the drain end, else now, plus the median of the target\'s last 5 deploys', () => {
  const drainEndMs = Date.parse('2026-10-15T05:18:00Z')
  const nowMs = Date.parse('2026-10-15T05:30:00Z')
  assert.equal(store.liveEtaFor('horizon', { drainEndMs, nowMs }), '2026-10-15T05:20:00.000Z')
  assert.equal(store.liveEtaFor('horizon', { drainEndMs: null, nowMs }), '2026-10-15T05:32:00.000Z')
  // ui-service's own history is its one 5 s deploy; no history, no estimate.
  assert.equal(store.liveEtaFor('ui-service', { nowMs }), '2026-10-15T05:30:05.000Z')
  assert.equal(store.liveEtaFor('ledger-models', { nowMs }), null)
  // On the item, with no drain, from the injected clock.
  assert.equal(store.deployQueueStateFor('DQ-H', nowMs).live_eta, '2026-10-15T05:32:00.000Z')
})

test('the open, released-while-verifying and finished stages reach the board', () => {
  const opened = board('DQ-OPEN')
  assert.equal(opened.batch_status, 'open')
  assert.ok(Number.isFinite(opened.batch_id))
  assert.equal(opened.batch_id, open)
  assert.ok(!('live_eta' in opened) && !('drain_deadline' in opened))

  // The batch goes live: its entries are released to the smoke check.
  const liveMs = T0 + 120_000
  db.prepare("UPDATE deploy_batch SET status = 'verifying', live_at = ? WHERE id = ?").run(sqlTime(liveMs), deploying)
  db.prepare("UPDATE deploy_queue_entry SET status = 'released' WHERE item_id = 'DQ-H'").run()
  const live = board('DQ-H')
  assert.equal(live.status, 'released')
  assert.equal(live.batch_status, 'verifying')
  assert.equal(live.batch_id, deploying)
  assert.equal(live.live_at, new Date(liveMs).toISOString().replace('.000', ''))

  // Once the batch leaves verifying the item is off the queue again.
  db.prepare("UPDATE deploy_batch SET status = 'done' WHERE id = ?").run(deploying)
  assert.equal(board('DQ-H'), null)
})
