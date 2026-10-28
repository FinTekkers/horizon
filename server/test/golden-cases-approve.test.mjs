// HZ-541 metric line 3 (the server's side) and guardrail 2. The first gate
// serves the golden-cases set with each source resolved against the HZ-537
// knowledge index, and one approve with the shown hash stores the whole set.
// An unindexed source, a stale hash or no hash is refused with a 409 and
// writes no row. Approvers with no table — WhatsApp and the Autopilot
// caretaker — are refused and told to approve in Horizon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('golden-cases-approve test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-approve-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)
const WA_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = '15550001111'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const golden = await import('../src/goldenCases.js')
const { ACT_GATES, NEVER_ACT, ACTOR } = await import('../src/caretakerActor.js')
const { kindStepIndex, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const CHANGE_GATE = requiredStepIndex('Approve & prioritize this work')
const TASK_GATE = kindStepIndex('Approve & prioritize', 'task')
const snapshot = (anchor) =>
  JSON.stringify([{ id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor, persona: null, output: 'golden_cases', applies: { labels: ['valuation'], repos: [], paths: [] } }])
const CASES = [
  { id: 'accrual-30-360', inputs: { notional: 1000000, rate: 0.05, days: 30 }, measure: 'accrued_interest', expected: 4166.67, tolerance: { abs: 0.01 }, source: 'bond-math#accrual' },
  { id: 'price-par', inputs: { coupon: 0.05, yield: 0.05 }, measure: 'clean_price', expected: 100, tolerance: { rel: 0.0001 }, source: 'bond-math#pricing' },
]
const METRIC = '1. Accrual matches the spec.\n2. Every case in the approved `golden_cases` set has a passing test.'

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden approve', 1, 1)").run().lastInsertRowid)
db.prepare(
  "INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, sections_json, extracted_at) VALUES (?, 'bond-math', 'FinTekkers/docs', 'specs/bond math.pdf', 'abc', 'extracted', ?, datetime('now'))",
).run(projectId, JSON.stringify([{ id: 'accrual', title: '2.1 Accrual', page: 4 }, { id: 'pricing', title: '3 Pricing', page: 9 }]))

const block = (cases) => '## Golden cases\n\n```json golden-cases\n' + JSON.stringify({ cases }) + '\n```'
function seed(id, { cursor = CHANGE_GATE, kind = 'change', cases = CASES } = {}) {
  const anchor = kind === 'change' ? 1 : TASK_GATE - 2
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json, metric) VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    kind,
    projectId,
    snapshot(anchor),
    METRIC,
  )
  db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, ?, 'golden-cases', 1, 'PM', 'done', ?)").run(
    id,
    anchor,
    block(cases),
  )
}

// The item as the board feed serves it.
const view = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })
  return res.json().items.find((it) => it.id === id)
}
const approve = (id, stepIndex, body = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${stepIndex}/approve`, headers: { cookie, 'x-human-key': pin }, payload: body })
const setRow = (id) => db.prepare('SELECT * FROM golden_case_set WHERE item_id = ?').get(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

test('the first gate serves the set: each source resolved to its indexed section, and the metric line that names the set', async () => {
  seed('A-VIEW')
  const { goldenCases } = await view('A-VIEW')
  assert.equal(goldenCases.approved, false)
  assert.equal(goldenCases.gateIndex, CHANGE_GATE)
  assert.equal(goldenCases.hash, golden.hashOf(CASES))
  assert.equal(goldenCases.metricLine, 2)
  assert.deepEqual(goldenCases.errors, [])
  assert.equal(goldenCases.cases.length, 2)
  const [first] = goldenCases.cases
  assert.deepEqual(
    { inputs: first.inputs, measure: first.measure, expected: first.expected, tolerance: first.tolerance, source: first.source },
    { inputs: CASES[0].inputs, measure: CASES[0].measure, expected: CASES[0].expected, tolerance: CASES[0].tolerance, source: CASES[0].source },
  )
  assert.equal(first.sourceIndexed, true)
  assert.equal(first.sourceTitle, '2.1 Accrual')
  assert.equal(first.sourceUrl, 'https://github.com/FinTekkers/docs/blob/HEAD/specs/bond%20math.pdf#page=4')
})

test('one approve with the shown hash stores the whole set and moves the gate on', async () => {
  seed('A-OK')
  const { goldenCases } = await view('A-OK')
  const res = await approve('A-OK', CHANGE_GATE, { goldenHash: goldenCases.hash })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorOf('A-OK'), CHANGE_GATE + 1)
  const row = setRow('A-OK')
  assert.equal(row.hash, golden.hashOf(CASES))
  assert.deepEqual(JSON.parse(row.cases_json), CASES)
  assert.equal(row.approved_by, 'Fixture User')
  const after = (await view('A-OK')).goldenCases
  assert.equal(after.approved, true)
  assert.equal(after.cases.length, 2)
  // A second click finds the gate gone: a clean 409, still one row.
  const again = await approve('A-OK', CHANGE_GATE, { goldenHash: goldenCases.hash })
  assert.equal(again.statusCode, 409)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM golden_case_set WHERE item_id = ?').get('A-OK').n, 1)
})

test('a stale or missing hash is refused with golden_cases_changed, and no row is written', async () => {
  seed('A-STALE')
  const stale = await approve('A-STALE', CHANGE_GATE, { goldenHash: 'f'.repeat(64) })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error, 'golden_cases_changed')
  const missing = await approve('A-STALE', CHANGE_GATE, {})
  assert.equal(missing.statusCode, 409)
  assert.equal(missing.json().error, 'golden_cases_changed')
  assert.match(missing.json().message, /approve in Horizon/)
  assert.equal(setRow('A-STALE'), undefined)
  assert.equal(cursorOf('A-STALE'), CHANGE_GATE)
})

test('an unindexed source is refused with golden_cases_invalid, and no row is written', async () => {
  seed('A-UNINDEXED', { cases: [CASES[0], { ...CASES[1], source: 'bond-math#missing' }] })
  const { goldenCases } = await view('A-UNINDEXED')
  assert.equal(goldenCases.cases[1].sourceIndexed, false)
  assert.equal(goldenCases.cases[1].sourceUrl, null)
  assert.match(goldenCases.errors[0], /bond-math#missing is not in the knowledge index/)
  const res = await approve('A-UNINDEXED', CHANGE_GATE, { goldenHash: goldenCases.hash })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'golden_cases_invalid')
  assert.equal(setRow('A-UNINDEXED'), undefined)
  assert.equal(cursorOf('A-UNINDEXED'), CHANGE_GATE)
})

test('a Task’s first gate serves and approves its set the same way', async () => {
  seed('A-TASK', { kind: 'task', cursor: TASK_GATE })
  const { goldenCases } = await view('A-TASK')
  assert.equal(goldenCases.gateIndex, TASK_GATE)
  assert.equal((await approve('A-TASK', TASK_GATE, {})).json().error, 'golden_cases_changed')
  const res = await approve('A-TASK', TASK_GATE, { goldenHash: goldenCases.hash })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(setRow('A-TASK').hash, goldenCases.hash)
})

test('guardrail 2: Autopilot never acts on a first gate, and its approve is refused anyway', async () => {
  assert.ok(NEVER_ACT.includes(CHANGE_GATE))
  assert.ok(!ACT_GATES.includes(TASK_GATE))
  seed('A-AUTO')
  const result = await app.gateActions.approve('A-AUTO', CHANGE_GATE, '', ACTOR)
  assert.equal(result.error, 'golden_cases_changed')
  assert.equal(setRow('A-AUTO'), undefined)
  assert.equal(cursorOf('A-AUTO'), CHANGE_GATE)
})

test('guardrail 2: a WhatsApp approve is refused with “approve in Horizon”', async () => {
  seed('A-WA')
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/A-WA/gates/${CHANGE_GATE}/approve-via-whatsapp`,
    headers: { 'x-wa-approval-secret': WA_SECRET },
    payload: { senderJid: '15550001111@s.whatsapp.net', sender: 'Ada' },
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().message, /approve in Horizon/)
  assert.equal(setRow('A-WA'), undefined)
  assert.equal(cursorOf('A-WA'), CHANGE_GATE)
  const event = db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get('A-WA').text
  assert.match(event, /approve in Horizon/)
})
