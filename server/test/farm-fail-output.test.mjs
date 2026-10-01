// HZ-184: a failed implement run's error is the check-failure digest — every
// `not ok`/FAILED line plus the counts — and it is what a human and the next
// attempt read to learn what broke. failFarmRun used to keep only its first
// 300 characters, which were usually passing tests. This drives the real
// route, so the /fail body's `error` maxLength is part of what is proven: the
// farm caps its error at that limit (farm/step_agent.py ERROR_MAX_CHARS), and
// anything the route accepts must be stored whole.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-fail-output-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })

function activeImplementRun(itemId) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    itemId,
    'Checks failed',
    'Medium',
    IMPLEMENT_STEP_INDEX,
  )
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
    .run(itemId, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid
}

function fail(runId, error) {
  return app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/fail`,
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
    payload: { error },
  })
}

// A digest at exactly the route's limit, with the failure and counts at the end.
function digestOf(length) {
  const head = 'repo checks failed (sh -c npm test):\n'
  const tail = '\nnot ok 900 - x\n# pass 899\n# fail 1'
  return head + 'ok - passing\n'.repeat(Math.ceil(length / 13)).slice(0, length - head.length - tail.length) + tail
}

test('a 2,000-char check digest is accepted and stored whole, failure line included', async () => {
  const runId = activeImplementRun('FO-1')
  const error = digestOf(2000)
  assert.equal(error.length, 2000)

  const res = await fail(runId, error)

  assert.equal(res.statusCode, 200, res.body)
  const row = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.output, `FAILED: ${error}`)
  assert.ok(row.output.indexOf('not ok 900 - x') > 300, 'the failure sits past the old 300-char cut')
  assert.match(row.output, /# fail 1$/)
  assert.equal(store.getItem('FO-1').paused, true)
  // The event text keeps its old 200-char cut — HZ-94 consumers parse it.
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'FO-1' AND text LIKE 'agent step failed%'").get()
  assert.ok(event.text.length < 300)
})

test('an error over the route limit is rejected with a 400 and the run stays active', async () => {
  const runId = activeImplementRun('FO-2')

  const res = await fail(runId, digestOf(2001))

  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.statusCode, 400)
  assert.equal(body.error, 'Bad Request')
  assert.match(body.message, /error/)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'active')
})
