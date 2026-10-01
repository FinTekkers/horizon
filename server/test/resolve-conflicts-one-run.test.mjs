// HZ-188: one resolve-conflicts run per item. Each click used to start
// another farmd resolver in the same worktree (HZ-125: 4 runs, HZ-157: 5) and
// they reset each other's merges. These drive the real Fastify route against
// a fake farmd whose reply the test holds open, so two requests genuinely
// overlap — then check the HTTP contract (409 {error:'resolve_in_progress'}),
// that exactly one farm call went out, that `conflictRun` is visible on
// GET /api/items while the run is in flight (the reload case), and that the
// guard is released on every exit path.
//
// farmd's own refusal is tested without the server in
// farm/tests/test_farmd.py.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-resolve-one-run-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// HZ-216: a gate_action row left running by an earlier test would answer a
// later one's click with a false 409.
beforeEach(() => {
  db.prepare('DELETE FROM gate_action').run()
})

const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const resolvePost = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/resolve-conflicts`, payload: {}, headers: { cookie, 'x-human-key': pin } })
const listItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((i) => i.id === id)
}

// The fake farmd: every /conflicts/resolve call is recorded and parked until
// the test releases it with a reply.
let farmCalls = []
globalThis.fetch = (url, opts) =>
  new Promise((resolve, reject) => {
    farmCalls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null, resolve, reject })
  })
const replyOk = (body) => ({ ok: true, status: 200, json: async () => body })
const replyErr = (status, body) => ({ ok: false, status, json: async () => body })

async function untilFarmCalls(n) {
  for (let i = 0; i < 200 && farmCalls.length < n; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(farmCalls.length, n, `expected ${n} farm call(s)`)
}

const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable)
   VALUES (?, ?, 'Medium', ?, 'acme/demo', ?, 0)`,
)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const eventCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(id).n
const feedbackCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE item_id = ?').get(id).n

test('a second request while one is running is 409 resolve_in_progress and makes no farm call', async () => {
  insertItem.run('OR-1', 'Two clicks', ACCEPT_GATE_INDEX, 301)
  farmCalls = []

  const first = resolvePost('OR-1')
  await untilFarmCalls(1)
  const second = await resolvePost('OR-1')

  assert.equal(second.statusCode, 409)
  assert.deepEqual(second.json(), { error: 'resolve_in_progress' })
  assert.equal(farmCalls.length, 1, 'exactly one farm resolver run')

  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  const res = await first
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, resolved: true })
})

test('five rapid clicks (HZ-157) make one farm call and four 409s', async () => {
  insertItem.run('OR-2', 'Five clicks', ACCEPT_GATE_INDEX, 302)
  farmCalls = []

  const clicks = Array.from({ length: 5 }, () => resolvePost('OR-2'))
  await untilFarmCalls(1)
  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  const results = await Promise.all(clicks)

  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409, 409, 409])
  assert.equal(farmCalls.length, 1)
})

test('GET /api/items carries conflictRun: null before any run, running while in flight, then the outcome', async () => {
  insertItem.run('OR-3', 'Visible progress', ACCEPT_GATE_INDEX, 303)
  insertItem.run('OR-3B', 'Never resolved', ACCEPT_GATE_INDEX, 313)
  farmCalls = []

  const idle = await listItem('OR-3B')
  assert.ok(Object.hasOwn(idle, 'conflictRun'), 'conflictRun is always present')
  assert.equal(idle.conflictRun, null)

  const pending = resolvePost('OR-3')
  await untilFarmCalls(1)
  const during = await listItem('OR-3')
  assert.equal(during.conflictRun.state, 'running')
  assert.equal(during.conflictRun.reason, null)
  assert.ok(!Number.isNaN(Date.parse(during.conflictRun.since)), 'since is an ISO timestamp')

  farmCalls[0].resolve(replyOk({ ok: true, resolved: false, reason: 'conflict_too_large', detail: '9 files' }))
  const res = await pending
  assert.deepEqual(res.json(), {
    ok: true,
    resolved: false,
    escalated: true,
    reason: 'too many conflicted files or lines for a scoped fix — needs a full implement cycle',
  })
  const after = await listItem('OR-3')
  assert.equal(after.conflictRun.state, 'escalated')
  assert.match(after.conflictRun.reason, /too many conflicted files/)
})

test("farmd's own 409 resolve_in_progress is not a send-back: nothing changes and the guard is released", async () => {
  insertItem.run('OR-4', 'Farm busy', ACCEPT_GATE_INDEX, 304)
  farmCalls = []
  const events = eventCount('OR-4')

  const pending = resolvePost('OR-4')
  await untilFarmCalls(1)
  farmCalls[0].resolve(replyErr(409, { error: 'resolve_in_progress' }))
  const res = await pending

  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'resolve_in_progress' })
  assert.equal(cursorOf('OR-4'), ACCEPT_GATE_INDEX, 'still at the Accept gate')
  assert.equal(feedbackCount('OR-4'), 0, 'no requestChanges')
  assert.equal(eventCount('OR-4'), events, 'no event row')
  const run = orchestrator.getConflictRun('OR-4')
  assert.equal(run.state, 'failed')
  assert.match(run.reason, /another run is still using this item's workspace/)

  // Released: the next click reaches farmd again.
  const retry = resolvePost('OR-4')
  await untilFarmCalls(2)
  farmCalls[1].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  assert.equal((await retry).statusCode, 200)
})

test("farmd's 409 farm_not_running keeps today's escalation", async () => {
  insertItem.run('OR-5', 'Farm paused', ACCEPT_GATE_INDEX, 305)
  farmCalls = []

  const pending = resolvePost('OR-5')
  await untilFarmCalls(1)
  farmCalls[0].resolve(replyErr(409, { error: 'farm_not_running (status=paused)' }))
  const res = await pending

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.resolved, false)
  assert.equal(body.escalated, true)
  assert.match(body.reason, /farm_not_running/)
  assert.equal(cursorOf('OR-5'), IMPLEMENT_STEP_INDEX)
  assert.equal(orchestrator.getConflictRun('OR-5').state, 'escalated')
})

test('a connection error releases the guard: a retry reaches farmd', async () => {
  insertItem.run('OR-6', 'Connection refused', ACCEPT_GATE_INDEX, 306)
  farmCalls = []

  const pending = orchestrator.resolveConflicts('OR-6', 'Alice')
  await untilFarmCalls(1)
  farmCalls[0].reject(new TypeError('fetch failed: ECONNREFUSED'))
  const result = await pending
  assert.equal(result.escalated, true)
  assert.notEqual(orchestrator.getConflictRun('OR-6').state, 'running')

  // The item was sent back; put it back at the gate to prove the guard itself let go.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, 'OR-6')
  const retry = orchestrator.resolveConflicts('OR-6', 'Alice')
  await untilFarmCalls(2)
  farmCalls[1].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  assert.deepEqual(await retry, { ok: true, resolved: true })
})

test('the canned e2e reply path takes and releases the guard too', async () => {
  insertItem.run('OR-7', 'Canned', ACCEPT_GATE_INDEX, 307)
  farmCalls = []
  orchestrator.setConflictReplyForTest({ ok: true, resolved: true, summary: 'canned' })

  assert.deepEqual(await orchestrator.resolveConflicts('OR-7', 'Alice'), { ok: true, resolved: true })
  assert.equal(orchestrator.getConflictRun('OR-7').state, 'resolved')
  assert.equal(farmCalls.length, 0)
})

test('a bad PIN during a run is 401 and does not touch the guard', async () => {
  insertItem.run('OR-8', 'Bad PIN mid-run', ACCEPT_GATE_INDEX, 308)
  farmCalls = []

  const pending = resolvePost('OR-8')
  await untilFarmCalls(1)
  const bad = await app.inject({
    method: 'POST',
    url: '/api/items/OR-8/resolve-conflicts',
    payload: {},
    headers: { cookie, 'x-human-key': 'wrong-pin' },
  })
  assert.equal(bad.statusCode, 401)
  assert.equal(orchestrator.getConflictRun('OR-8').state, 'running')

  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  assert.equal((await pending).statusCode, 200)
})

// ---- HZ-216: the run is the persisted gate_action row ----

test('HZ-216: a running resolve shows as gateAction kind resolve, with its own label detail, and clears the same way', async () => {
  insertItem.run('OR-9', 'Gate action', ACCEPT_GATE_INDEX, 309)
  farmCalls = []

  const pending = resolvePost('OR-9')
  await untilFarmCalls(1)
  const during = await listItem('OR-9')
  assert.equal(during.gateAction.kind, 'resolve')
  assert.equal(during.gateAction.state, 'running')
  assert.equal(during.gateAction.detail, 'resolving conflicts on PR #309')
  assert.equal(during.gateAction.since, during.conflictRun.since)

  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  assert.equal((await pending).statusCode, 200)
  const after = await listItem('OR-9')
  assert.equal(after.gateAction.state, 'resolved')
})

test('HZ-216: conflictRun keeps exactly { state, since, reason } — running, resolved and escalated', async () => {
  insertItem.run('OR-10', 'Shape lock resolved', ACCEPT_GATE_INDEX, 310)
  insertItem.run('OR-11', 'Shape lock escalated', ACCEPT_GATE_INDEX, 311)
  farmCalls = []

  const first = resolvePost('OR-10')
  await untilFarmCalls(1)
  const running = (await listItem('OR-10')).conflictRun
  assert.deepEqual(Object.keys(running).sort(), ['reason', 'since', 'state'])
  assert.deepEqual(running, { state: 'running', since: store.getGateAction('OR-10', 'resolve').since, reason: null })
  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  await first
  const resolved = (await listItem('OR-10')).conflictRun
  assert.deepEqual(resolved, { state: 'resolved', since: store.getGateAction('OR-10', 'resolve').finishedAt, reason: null })

  const second = resolvePost('OR-11')
  await untilFarmCalls(2)
  farmCalls[1].resolve(replyOk({ ok: true, resolved: false, reason: 'conflict_too_large' }))
  await second
  const escalated = (await listItem('OR-11')).conflictRun
  assert.deepEqual(Object.keys(escalated).sort(), ['reason', 'since', 'state'])
  assert.equal(escalated.state, 'escalated')
  assert.equal(escalated.since, store.getGateAction('OR-11', 'resolve').finishedAt)
  assert.match(escalated.reason, /too many conflicted files/)
  assert.deepEqual(orchestrator.getConflictRun('OR-11'), escalated)
})

test('HZ-216: a resolve that throws ends the row failed with a reason, and a new resolve is accepted', async () => {
  insertItem.run('OR-12', 'Throws', ACCEPT_GATE_INDEX, 312)
  farmCalls = []
  orchestrator.setConflictReplyForTest({
    get resolved() {
      throw new Error('farmd reply could not be read')
    },
  })

  await assert.rejects(orchestrator.resolveConflicts('OR-12', 'Alice'), /farmd reply could not be read/)
  const after = await listItem('OR-12')
  assert.equal(after.gateAction.state, 'failed')
  assert.equal(after.conflictRun.state, 'failed')
  assert.match(after.conflictRun.reason, /stopped unexpectedly/)

  const retry = resolvePost('OR-12')
  await untilFarmCalls(1)
  farmCalls[0].resolve(replyOk({ ok: true, resolved: true, summary: 'merged' }))
  assert.equal((await retry).statusCode, 200)
})
