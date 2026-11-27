// HZ-976 metric line 3 and guardrail 4: items whose golden-cases sub-step
// never ran because their anchor finished before HZ-976 (LM-508, VS-169) are
// never held for cases that cannot arrive. Past the anchor, with no run of
// the sub-step and no approved set, the item is stranded: its first gate
// approves with no hash, its guarded steps run, it gets one waiver event, and
// nothing re-runs a finished step or moves it back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('golden-cases-stranded test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-stranded-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = '1'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { IMPLEMENT_STEP_INDEX, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const GOLDEN = { id: 'quant-golden-cases', label: 'Quant golden cases', kind: 'opening', anchor: METRIC_STEP, persona: 'quant', output: 'golden_cases' }
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden stranded', 1, 1)").run().lastInsertRowid)

function seed(id, cursor) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, ?, 'Medium', ?, ?, 'Price it.', '1. m', 'Tests pass.', ?)",
  ).run(id, `Item ${id}`, cursor, projectId, JSON.stringify([GOLDEN]))
}
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT step_index, substep_id, status, output FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const waivers = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).filter((e) => e.text.startsWith(golden.WAIVER_PREFIX))
const notApproved = (id) => runs(id).filter((r) => r.output === `FAILED: ${golden.NOT_APPROVED_TEXT}`)

async function waitFor(what, predicate, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('stranded at "Draft implementation plan": the plan runs, one waiver event even after a second dispatch, and no golden-cases panel', async () => {
  const id = 'GS-PLAN'
  seed(id, PLAN_STEP)
  assert.equal(golden.goldenCasesRequired(row(id)), true, 'the project and snapshot still use golden cases')
  assert.equal(golden.goldenCasesStranded(row(id)), true)
  orchestrator.kick(id)
  await waitFor(`${id}'s plan run`, () => runs(id).some((r) => r.step_index === PLAN_STEP && r.status !== 'active'))
  orchestrator.cancel(id)
  assert.equal(runs(id).find((r) => r.step_index === PLAN_STEP).status, 'done')
  assert.deepEqual(notApproved(id), [])
  // A second dispatch of a guarded step is not refused and logs no second event.
  assert.equal(orchestrator.refuseWithoutGoldenCases(0, id, PLAN_STEP), false)
  assert.equal(waivers(id).length, 1)
  assert.match(waivers(id)[0].text, /“Quant golden cases” never ran/)
  assert.deepEqual(golden.goldenCasesFields(row(id)), {})
  assert.ok(!Object.hasOwn(store.itemViewById(id), 'goldenCases'))
  assert.ok(row(id).cursor >= PLAN_STEP, 'never moved back')
})

test('stranded at the first gate (LM-508): approve with no golden hash moves it on, with one waiver event', async () => {
  const id = 'GS-GATE'
  seed(id, FIRST_GATE)
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie, 'x-human-key': pin },
    payload: { action: 'approve', from: stepKeyAt(FIRST_GATE) },
  })
  assert.equal(res.statusCode, 200, res.body)
  orchestrator.cancel(id)
  assert.ok(row(id).cursor > FIRST_GATE, 'the item moved on')
  assert.equal(waivers(id).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM golden_case_set WHERE item_id = ?').get(id).n, 0, 'no set is invented')
})

test('stranded at "Specialist agent implements": not refused, the sub-step never re-runs, and the cursor never drops (guardrail 4)', async () => {
  const id = 'GS-IMPL'
  seed(id, IMPLEMENT_STEP_INDEX)
  orchestrator.kick(id)
  await waitFor(`${id}'s implement run`, () => runs(id).some((r) => r.step_index === IMPLEMENT_STEP_INDEX && r.status !== 'active'))
  orchestrator.cancel(id)
  assert.equal(runs(id).find((r) => r.step_index === IMPLEMENT_STEP_INDEX).status, 'done')
  assert.deepEqual(notApproved(id), [])
  assert.deepEqual(runs(id).filter((r) => r.substep_id === GOLDEN.id), [], 'no golden-cases run is started')
  assert.ok(row(id).cursor >= IMPLEMENT_STEP_INDEX, 'never moved back')
  assert.equal(waivers(id).length, 1)
})

test('not stranded: a sub-step run of any status, even a failed one, keeps the cases required', () => {
  const id = 'GS-FAILED'
  seed(id, PLAN_STEP)
  db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status) VALUES (?, ?, ?, 1, 'PM', 'cancelled')").run(id, METRIC_STEP, GOLDEN.id)
  assert.equal(golden.goldenCasesStranded(row(id)), false)
  assert.equal(golden.goldenCasesEnforced(row(id)), true)
})
