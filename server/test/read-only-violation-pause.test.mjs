// HZ-387: a read-only step that changed the worktree fails with the
// non-retryable read-only reason. The farm's message (the shared fixture
// farm/tests/test_read_only_guard.py builds and compares) goes through the
// real /fail route: the item pauses, nothing is retried or dispatched, the
// event shows the one-line headline naming the provider, and every changed
// file is in its detail.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-read-only-violation-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')
const { REASON, isRetryable } = await import('../../domain/js/reasons.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

store.purgeDemoItems()
const farmCalls = []
globalThis.fetch = async (url) => {
  farmCalls.push(String(url))
  return { ok: true, json: async () => ({}) }
}

const app = buildApp({ logger: false })
const MESSAGE = readFileSync(join(REPO_ROOT, 'farm/tests/fixtures/read_only/violation_message.txt'), 'utf8')
const ENG_PLAN_INDEX = STEPS.findIndex((s) => s.label === 'Draft implementation plan')

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function activePlanRun(itemId) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(itemId, 'Read-only', 'Medium', ENG_PLAN_INDEX)
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
    .run(itemId, ENG_PLAN_INDEX, STEPS[ENG_PLAN_INDEX].agent).lastInsertRowid
}

test('a read-only violation pauses the item, dispatches nothing, and shows the headline with every file behind it', async () => {
  assert.ok(ENG_PLAN_INDEX > 0)
  assert.equal(isRetryable(REASON.READ_ONLY_VIOLATED), false)
  const [headline, ...files] = MESSAGE.split('\n')
  assert.match(headline, /\(provider: muse\)/)
  const runId = activePlanRun('RO-1')

  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/fail`,
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
    payload: { error: MESSAGE, reason: REASON.READ_ONLY_VIOLATED },
  })
  await wait(10)

  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getItem('RO-1').paused, true)
  const runs = db.prepare('SELECT status FROM step_run WHERE item_id = ?').all('RO-1')
  assert.deepEqual(runs, [{ status: 'cancelled' }], 'no new step_run was dispatched')
  assert.ok(!farmCalls.some((url) => url.endsWith('/steps')), farmCalls.join(', '))

  const events = db.prepare('SELECT text, detail FROM event WHERE item_id = ? ORDER BY id').all('RO-1')
  assert.ok(!events.some((e) => /auto-retrying/.test(e.text)), 'a read-only violation is never auto-retried')
  const pauseEvent = events.find((e) => e.text.startsWith('agent step failed'))
  assert.equal(pauseEvent.text, `agent step failed (${REASON.READ_ONLY_VIOLATED}): ${headline} — item paused; resume to retry`)
  assert.equal(pauseEvent.detail, MESSAGE)
  assert.ok(files.length >= 3)
  for (const file of files) {
    assert.ok(pauseEvent.detail.includes(file), file)
    assert.ok(!pauseEvent.text.includes(file), file)
  }
})
