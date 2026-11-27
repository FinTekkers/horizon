// HZ-976 metric lines 1 and 2 and guardrail 2, on the mock path, through the
// real POST /move: an item whose snapshot has an opening golden_cases
// sub-step after "Define how we measure success".
//
// - Metric 1: the sub-step runs after its anchor, then "Set guardrails", and
//   the item stops at the first gate with the cases pending approval.
// - Metric 2: approving the cases at the gate stores the sub-step run's set,
//   and "Draft implementation plan" then runs.
// - Guardrail 2: with the cases pending but not approved, "Draft
//   implementation plan" is still refused.
// The farm path is golden-cases-opening-farm.test.mjs; items whose sub-step
// never ran are golden-cases-stranded.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('golden-cases-opening-run test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-opening-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = '1'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const GOLDEN = {
  id: 'quant-golden-cases',
  label: 'Quant golden cases',
  kind: 'opening',
  anchor: METRIC_STEP,
  persona: 'quant',
  output: 'golden_cases',
  applies: { labels: ['quant'], repos: [], paths: [] },
}

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden opening', 1, 1)").run().lastInsertRowid)
// The mock round cites mock-golden#case-1: indexed, so the gate can approve it.
db.prepare(
  "INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, sections_json, extracted_at) VALUES (?, 'mock-golden', 'o/r', 'mock.pdf', 'abc', 'extracted', ?, datetime('now'))",
).run(projectId, JSON.stringify([{ id: 'case-1', title: '1 Case', page: 1 }]))
const headers = { cookie, 'x-human-key': pin }

const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design' }

function seed(id, { metric = '1. Prices match.', substeps = [GOLDEN] } = {}) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, ?, 'Medium', ?, ?, 'Price it.', ?, 'Tests pass.', ?)",
  ).run(id, `Item ${id}`, METRIC_STEP, projectId, metric, JSON.stringify(substeps))
}
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT id, step_index, substep_id, status, output FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const served = async (id) => (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items.find((it) => it.id === id)
const approve = (id, stepIndex, body = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers, payload: { action: 'approve', from: stepKeyAt(stepIndex), ...body } })

async function waitFor(what, predicate, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const idleAt = (id, cursor) => () => row(id).cursor === cursor && row(id).substep_cursor === null && !runs(id).some((r) => r.status === 'active')

async function walkToGate(id, opts) {
  seed(id, opts)
  orchestrator.kick(id)
  await waitFor(`${id} at the first gate`, idleAt(id, FIRST_GATE))
}

test('metric 1: the golden-cases sub-step runs after its anchor, then "Set guardrails", and the item stops at the first gate with the cases pending', async () => {
  const id = 'GO-JOURNEY'
  await walkToGate(id)
  assert.deepEqual(
    runs(id).map((r) => [r.step_index, r.substep_id, r.status]),
    [
      [METRIC_STEP, null, 'done'],
      [METRIC_STEP, GOLDEN.id, 'done'],
      [GUARDRAILS, null, 'done'],
    ],
  )
  assert.equal(events(id).filter((t) => /runs after/.test(t)).length, 1)
  assert.ok(events(id).includes(`“${GOLDEN.label}” runs after “Define how we measure success”`))
  assert.equal(row(id).substep_cursor, null)
  // Dispatched with its persona (the farm path asserts the body itself).
  assert.equal(orchestrator.substepTaskField(row(id), METRIC_STEP, GOLDEN.id).persona, 'quant')

  const pending = golden.pendingGoldenCases(row(id))
  assert.equal(pending.runId, runs(id)[1].id)
  assert.deepEqual(pending.cases.map((c) => c.source), [orchestrator.MOCK_GOLDEN_SOURCE])
  const { goldenCases } = await served(id)
  assert.equal(goldenCases.approved, false)
  assert.equal(goldenCases.gateIndex, FIRST_GATE)
  assert.equal(goldenCases.hash, pending.hash)
  assert.ok(goldenCases.hash)
  assert.deepEqual(goldenCases.errors, [])
  assert.deepEqual(goldenCases.cases.map((c) => [c.source, c.sourceIndexed]), [[orchestrator.MOCK_GOLDEN_SOURCE, true]])
})

test('metric 2: approving the cases at the gate stores the sub-step run’s set, and "Draft implementation plan" runs', async () => {
  const id = 'GO-APPROVE'
  await walkToGate(id)
  const substepRun = runs(id).find((r) => r.substep_id === GOLDEN.id)
  const { goldenCases } = await served(id)
  const res = await approve(id, FIRST_GATE, { goldenHash: goldenCases.hash })
  assert.equal(res.statusCode, 200, res.body)
  const set = db.prepare('SELECT * FROM golden_case_set WHERE item_id = ?').get(id)
  assert.equal(set.source_run_id, substepRun.id)
  assert.equal(set.hash, goldenCases.hash)

  await waitFor(`${id} at the design gate`, idleAt(id, DESIGN_GATE))
  const next = await approve(id, DESIGN_GATE)
  assert.equal(next.statusCode, 200, next.body)
  await waitFor(`${id}'s plan run`, () => runs(id).some((r) => r.step_index === PLAN_STEP && r.status !== 'active'))
  orchestrator.cancel(id)
  assert.equal(runs(id).find((r) => r.step_index === PLAN_STEP).status, 'done')
})

test('metric 2 and guardrail 2: with the cases pending but not approved, "Draft implementation plan" is still refused', async () => {
  const id = 'GO-PENDING'
  await walkToGate(id)
  // Past the gate without an approve: only a seed can put it there.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(PLAN_STEP, id)
  assert.equal(golden.goldenCasesStranded(row(id)), false, 'the sub-step ran, so it is not stranded')
  orchestrator.kick(id)
  await waitFor(`${id}'s plan run`, () => runs(id).some((r) => r.step_index === PLAN_STEP && r.status !== 'active'))
  const plan = runs(id).find((r) => r.step_index === PLAN_STEP)
  assert.deepEqual([plan.status, plan.output], ['cancelled', `FAILED: ${golden.NOT_APPROVED_TEXT}`])
  assert.equal(row(id).cursor, PLAN_STEP)
  assert.match(store.itemViewById(id).events[0].text, new RegExp(`\\(${REASON.GOLDEN_CASES_NOT_APPROVED}\\)`))
  assert.ok(!events(id).some((t) => t.startsWith(golden.WAIVER_PREFIX)))
})

test('design and golden cases at one anchor: design is decided first, then the golden-cases sub-step runs, then "Set guardrails"', async () => {
  const substeps = [GOLDEN, DESIGN]
  await walkToGate('GO-DESIGN-NO', { metric: '1. m\ndesign_needed: no — backend only', substeps })
  assert.deepEqual(
    runs('GO-DESIGN-NO').map((r) => [r.step_index, r.substep_id]),
    [
      [METRIC_STEP, null],
      [METRIC_STEP, GOLDEN.id],
      [GUARDRAILS, null],
    ],
  )
  await walkToGate('GO-DESIGN-YES', { metric: '1. m\ndesign_needed: yes — adds a panel', substeps })
  assert.deepEqual(
    runs('GO-DESIGN-YES').map((r) => [r.step_index, r.substep_id]),
    [
      [METRIC_STEP, null],
      [METRIC_STEP, DESIGN.id],
      [METRIC_STEP, GOLDEN.id],
      [GUARDRAILS, null],
    ],
  )
})
