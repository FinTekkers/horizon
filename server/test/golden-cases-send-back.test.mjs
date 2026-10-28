// HZ-541 metric line 2: an approved golden-cases set is kept, byte for byte,
// through send-backs to Design, to Implement and to Review, and to a sub-step
// that is not the golden-cases one. Only a send-back to the golden-cases
// sub-step clears it; its re-run then reopens the first gate unapproved, with
// a new hash, and the old hash is refused. All through the real POST /reject.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('golden-cases-send-back test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-send-back-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const golden = await import('../src/goldenCases.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const DESIGN_STEP = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const PLAN_GATE = requiredStepIndex('Review before execution')
const SNAPSHOT = JSON.stringify([
  { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: null, output: 'golden_cases', applies: { labels: ['valuation'], repos: [], paths: [] } },
  { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: null, output: 'findings', applies: { labels: ['valuation'], repos: [], paths: [] } },
])
const CASES = [{ id: 'c1', inputs: { x: 1 }, measure: 'y', expected: 2, tolerance: { abs: 0.5 }, source: 'spec#one' }]
const NEW_CASES = [{ ...CASES[0], expected: 3 }]

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden send-back', 1, 1)").run().lastInsertRowid)
db.prepare(
  "INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, sections_json, extracted_at) VALUES (?, 'spec', 'o/r', 'spec.pdf', 'abc', 'extracted', ?, datetime('now'))",
).run(projectId, JSON.stringify([{ id: 'one', title: '1 One', page: 1 }]))

const block = (cases) => '```json golden-cases\n' + JSON.stringify({ cases }) + '\n```'
const writeSubstepRun = (id, cases) =>
  db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, 1, 'golden-cases', 1, 'PM', 'done', ?)").run(id, block(cases))

function seedApproved(id, cursor) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?)").run(id, `Item ${id}`, cursor, projectId, SNAPSHOT)
  writeSubstepRun(id, CASES)
  db.prepare("INSERT INTO golden_case_set (item_id, cases_json, hash, source_run_id, approved_by, approved_at) VALUES (?, ?, ?, 1, 'Ada', '2026-10-01 10:00:00')").run(
    id,
    JSON.stringify(CASES),
    golden.hashOf(CASES),
  )
}
const reject = (id, body = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/reject`, headers: { cookie, 'x-human-key': pin }, payload: { target: 'the work', feedback: 'redo', ...body } })
const setRow = (id) => db.prepare('SELECT * FROM golden_case_set WHERE item_id = ?').get(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

for (const [name, gate, body, landsOn] of [
  ['to Design (from the design gate)', DESIGN_GATE, {}, DESIGN_STEP],
  ['to Implement (from Accept the code)', ACCEPT_GATE_INDEX, {}, IMPLEMENT_STEP_INDEX],
  ['to Review (from Accept the code)', ACCEPT_GATE_INDEX, { targetStepIndex: REVIEW_STEP_INDEX }, REVIEW_STEP_INDEX],
  ['to the audit sub-step', ACCEPT_GATE_INDEX, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }, IMPLEMENT_STEP_INDEX],
]) {
  test(`a send-back ${name} keeps the approved set byte for byte`, async () => {
    const id = `K-${gate}-${landsOn}-${body.targetSubstepId ?? 'n'}`
    seedApproved(id, gate)
    const before = setRow(id)
    const res = await reject(id, body)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(cursorOf(id), landsOn)
    assert.deepEqual(setRow(id), before)
  })
}

test('a send-back to the golden-cases sub-step clears the set; its re-run reopens the gate unapproved with a new hash', async () => {
  seedApproved('R-1', PLAN_GATE)
  const oldHash = setRow('R-1').hash
  const res = await reject('R-1', { targetStepIndex: 1, targetSubstepId: 'golden-cases' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(setRow('R-1'), undefined)

  // The sub-step re-runs with new cases, and the item walks back to the gate.
  writeSubstepRun('R-1', NEW_CASES)
  db.prepare('UPDATE work_item SET cursor = ?, substep_cursor = NULL WHERE id = ?').run(FIRST_GATE, 'R-1')
  const view = store.itemViewById('R-1').goldenCases
  assert.equal(view.approved, false)
  assert.notEqual(view.hash, oldHash)
  assert.equal(view.cases[0].expected, 3)

  const stale = await app.inject({
    method: 'POST',
    url: `/api/items/R-1/gates/${FIRST_GATE}/approve`,
    headers: { cookie, 'x-human-key': pin },
    payload: { goldenHash: oldHash },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error, 'golden_cases_changed')
  assert.equal(setRow('R-1'), undefined)

  const fresh = await app.inject({
    method: 'POST',
    url: `/api/items/R-1/gates/${FIRST_GATE}/approve`,
    headers: { cookie, 'x-human-key': pin },
    payload: { goldenHash: view.hash },
  })
  assert.equal(fresh.statusCode, 200, fresh.body)
  assert.deepEqual(JSON.parse(setRow('R-1').cases_json), NEW_CASES)
})

test('an item back at the first gate with its set still approved approves with no hash, and keeps the set', async () => {
  seedApproved('R-2', FIRST_GATE)
  const before = setRow('R-2')
  writeSubstepRun('R-2', NEW_CASES)
  const res = await app.inject({ method: 'POST', url: `/api/items/R-2/gates/${FIRST_GATE}/approve`, headers: { cookie, 'x-human-key': pin }, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(setRow('R-2'), before)
})
