// HZ-221 metric 7: a /conflicts/resolve that answers only after fetch's
// header ceiling (the repo's ~8 min suite, in production) records farmd's real
// outcome — resolved or escalated — instead of a "could not run (fetch
// failed)" escalation. Drives resolveConflicts() against a loopback farmd stub
// on an ephemeral port, with the ceiling lowered to 200ms so a 600ms reply
// crosses it. Also pins, on this node:http path, the request farmd receives
// and the 409 resolve_in_progress semantics.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPLY_DELAY_MS = 600

// What the stub answers next, and every request it saw.
let nextReply = { status: 200, body: { ok: true, resolved: true, summary: 'merged and pushed' } }
let requests = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    const { status, body } = nextReply
    const t = setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }, REPLY_DELAY_MS)
    res.on('close', () => clearTimeout(t))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-resolve-long-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${server.address().port}`
process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '5000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
orchestrator.setFarmFetchHeaderCeilingForTest(200)

after(() => {
  orchestrator.setFarmFetchHeaderCeilingForTest(null)
  server.closeAllConnections()
  server.close()
})

beforeEach(() => {
  requests = []
})

const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable)
   VALUES (?, ?, 'Medium', ?, 'acme/demo', ?, 0)`,
)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n

test('the resolve call really takes the node:http path here', () => {
  assert.equal(orchestrator.farmFetchTransport(5000), 'http')
})

test('a resolved reply after the ceiling is recorded as resolved, and farmd got the same request as ever', async () => {
  insertItem.run('LC-1', 'Slow resolve', ACCEPT_GATE_INDEX, 401)
  nextReply = { status: 200, body: { ok: true, resolved: true, summary: 'merged and pushed' } }

  const started = Date.now()
  const result = await orchestrator.resolveConflicts('LC-1', 'Alice')

  assert.ok(Date.now() - started >= REPLY_DELAY_MS - 50, 'the reply really did arrive after the ceiling')
  assert.deepEqual(result, { ok: true, resolved: true })
  assert.equal(orchestrator.getConflictRun('LC-1').state, 'resolved')
  assert.equal(cursorOf('LC-1'), ACCEPT_GATE_INDEX)

  assert.equal(requests.length, 1)
  const [req] = requests
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/conflicts/resolve')
  assert.equal(req.headers['content-type'], 'application/json')
  assert.equal(req.headers.authorization, undefined, 'no auth header is added')
  assert.deepEqual(JSON.parse(req.body), { item: { id: 'LC-1', repo: 'acme/demo' }, branch: 'horizon/lc-1' })
})

test("an escalated reply after the ceiling records farmd's reason, never fetch failed", async () => {
  insertItem.run('LC-2', 'Slow escalation', ACCEPT_GATE_INDEX, 402)
  nextReply = { status: 200, body: { ok: true, resolved: false, reason: 'merge_conflict', detail: 'conflicts in: a.txt' } }

  const result = await orchestrator.resolveConflicts('LC-2', 'Alice')

  assert.deepEqual(result, {
    ok: true,
    resolved: false,
    escalated: true,
    reason: orchestrator.CONFLICT_ESCALATION_REASONS.merge_conflict,
  })
  const run = orchestrator.getConflictRun('LC-2')
  assert.equal(run.state, 'escalated')
  assert.equal(run.reason, orchestrator.CONFLICT_ESCALATION_REASONS.merge_conflict)
  assert.doesNotMatch(run.reason, /fetch failed/)
  assert.equal(cursorOf('LC-2'), IMPLEMENT_STEP_INDEX)
})

test("farmd's 409 resolve_in_progress after the ceiling still sends nothing back", async () => {
  insertItem.run('LC-3', 'Farm busy', ACCEPT_GATE_INDEX, 403)
  nextReply = { status: 409, body: { error: 'resolve_in_progress' } }
  const events = count('event', 'LC-3')
  const runs = count('step_run', 'LC-3')

  const result = await orchestrator.resolveConflicts('LC-3', 'Alice')

  assert.deepEqual(result, { error: 'resolve_in_progress' })
  assert.equal(cursorOf('LC-3'), ACCEPT_GATE_INDEX, 'still at the Accept gate')
  assert.equal(count('feedback', 'LC-3'), 0, 'no requestChanges')
  assert.equal(count('event', 'LC-3'), events, 'no event row')
  assert.equal(count('step_run', 'LC-3'), runs, 'no step_run row')
  assert.equal(orchestrator.getConflictRun('LC-3').state, 'failed')
})

test("farmd's 409 farm_not_running after the ceiling still escalates", async () => {
  insertItem.run('LC-4', 'Farm paused', ACCEPT_GATE_INDEX, 404)
  nextReply = { status: 409, body: { error: 'farm_not_running (status=paused)' } }

  const result = await orchestrator.resolveConflicts('LC-4', 'Alice')

  assert.equal(result.escalated, true)
  assert.match(result.reason, /farm_not_running/)
  assert.equal(cursorOf('LC-4'), IMPLEMENT_STEP_INDEX)
  assert.equal(orchestrator.getConflictRun('LC-4').state, 'escalated')
})
