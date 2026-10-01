// HZ-134 success metric 4: "a PM revision can write a field up to the same
// length the API accepts. Test with a 1,999-char guardrails revision."
//
// farm/tests/test_pm_agent.py proves the AGENT side: validate() now returns a
// 1,999-char guardrails value byte-for-byte instead of cutting it at 400 and
// marking it. That is only half the claim. This file is the other half — the
// whole server-side write path, driven over real HTTP through the real route:
//
//   POST /api/farm/steps/:runId/complete  ->  completeFarmRun  ->  UPDATE work_item
//
// Nothing on that path caps a patch field (the route declares `patch: { type:
// 'object' }` with no per-field limit, and completeFarmRun writes the trimmed
// value raw), and this pins that. Before HZ-134 it would have been untestable:
// no PM revision could produce a value this long to begin with.
//
// `guardrails` is the field under test, deliberately, and it is the field the
// metric names. `desc` would be the wrong choice: store.js's upsertFromGithub
// rewrites `desc` unconditionally from the parsed issue body, with no
// `|| row.desc` fallback, so a long outcome revision is reverted by the next
// webhook sync. That is pre-existing behaviour at any length, unchanged here and
// out of scope — but it means `desc` cannot carry this proof.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-pm-revision-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const { FARM_SHARED_SECRET } = config
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { patchLimits } = await import('../../domain/js/fields.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// The farm is a stub: every dispatch POST succeeds and nothing is asserted about
// it. What matters here is the run row it produces.
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })

// The guardrails step itself, resolved by label — completing it lands on the
// following gate, so no further mock/farm dispatch runs during the test.
const GUARDRAILS_STEP = requiredStepIndex('Set guardrails')
const GUARDRAILS_LIMIT = patchLimits().guardrails

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function reviseGuardrails(id, value) {
  insertItem.run(id, 'Guardrails revision', 'Medium', GUARDRAILS_STEP)
  orchestrator.kick(id)
  await wait(10)
  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id)?.id
  assert.ok(runId, `no active run was dispatched for ${id}`)
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
    payload: { summary: 'revised the guardrails', patch: { guardrails: value } },
  })
  assert.equal(res.statusCode, 200, `the complete route rejected the revision: ${res.body}`)
  assert.notEqual(res.json().stale, true, 'the run was treated as stale — the fixture is wrong, not the write path')
  return db.prepare('SELECT guardrails FROM work_item WHERE id = ?').get(id).guardrails
}

test('sanity: the declared guardrails limit is above the 1,999 chars the metric names', () => {
  assert.ok(
    GUARDRAILS_LIMIT >= 1999,
    `the declared guardrails limit is ${GUARDRAILS_LIMIT} — metric 4's 1,999-char case is no longer meaningful`,
  )
})

test('a 1,999-char guardrails revision is stored in full, byte for byte (metric 4)', async () => {
  const revision = 'x'.repeat(1999)
  const stored = await reviseGuardrails('PR-1999', revision)
  assert.equal(stored.length, 1999)
  assert.equal(stored, revision, 'the server altered a 1,999-char guardrails revision')
})

// The trio, not just 1,999: "1,999 fits" only proves the write path has no cap
// BELOW 1,999. These prove it has none at the declared limit either, and none
// above it — which is what makes the marked-overflow case (next) land intact.
test('a revision at exactly the declared limit is stored in full', async () => {
  const revision = 'y'.repeat(GUARDRAILS_LIMIT)
  const stored = await reviseGuardrails('PR-AT-LIMIT', revision)
  assert.equal(stored, revision)
})

test("a MARKED revision longer than the declared limit reaches the database intact — maxLength is an intake cap, not a DB invariant", async () => {
  // The exact shape farm/pm_agent.py's _mark_truncated produces: content cut to
  // the budget, then a note appended AFTER it, so the stored string is longer
  // than the API's own declared maximum for the column. Deliberate (HZ-114), and
  // the server must not "help" by re-truncating it — that would eat the marker
  // and turn a marked cut back into a silent one.
  const marked = `${'z'.repeat(GUARDRAILS_LIMIT)} […7 chars omitted — agent reply exceeded the ${GUARDRAILS_LIMIT}-char budget for this field; do not infer the field is complete.]`
  assert.ok(marked.length > GUARDRAILS_LIMIT)
  const stored = await reviseGuardrails('PR-MARKED', marked)
  assert.equal(stored, marked)
  assert.ok(stored.length > GUARDRAILS_LIMIT)
  assert.match(stored, /chars omitted/)
})

test('the revision still advances the item to the next step — the long value did not break the transition', () => {
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'PR-1999'").get().cursor, GUARDRAILS_STEP + 1)
})
