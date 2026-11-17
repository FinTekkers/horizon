// HO-851 metric line 2: "Design it anyway" — POST
// /api/items/:id/substeps/:substepId/force — on a design sub-step its verdict
// skipped. With a reason it runs the sub-step, and the finished round stores
// the override and its reason. Without one — missing, empty or whitespace —
// it is refused with 400 reason_required and writes nothing: no round, no
// move, no event. A round that was not a skip, an item away from a gate and
// a sub-step that is not the item's design are refused too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('design-force-route test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-force-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = '1'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } }
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design force', 1, 1)").run().lastInsertRowid)

const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT step_index, substep_id, status FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const roundRows = (id) => db.prepare('SELECT * FROM substep_round WHERE item_id = ? ORDER BY round').all(id)
const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n
const force = (id, payload, { substepId = DESIGN.id, withPin = true } = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/substeps/${substepId}/force`, headers: withPin ? { cookie, 'x-human-key': pin } : { cookie }, payload })

async function waitFor(what, predicate, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const atGate = (id) => () => {
  const it = row(id)
  return it.cursor === FIRST_GATE && it.substep_cursor === null && !runs(id).some((r) => r.status === 'active')
}

async function skippedAtGate(id) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, ?, 'Medium', ?, ?, 'Ship it.', ?, 'Tests pass.', ?)",
  ).run(id, `Item ${id}`, METRIC_STEP, projectId, '1. m\ndesign_needed: no — backend only', JSON.stringify([DESIGN]))
  orchestrator.kick(id)
  await waitFor(`${id} skipped and at the gate`, atGate(id))
  assert.equal(roundRows(id).at(-1).kind, 'skip')
}

test('metric 2: without a reason — missing, empty or whitespace — the force is refused with 400 and writes nothing', async () => {
  const id = 'DF-NOREASON'
  await skippedAtGate(id)
  const before = { rounds: count('substep_round', id), moves: count('item_move', id), events: count('event', id), runs: runs(id).length }
  for (const payload of [{}, { reason: '' }, { reason: '   \n ' }, undefined]) {
    const res = await force(id, payload)
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`)
    assert.equal(res.json().error, 'reason_required')
  }
  assert.deepEqual({ rounds: count('substep_round', id), moves: count('item_move', id), events: count('event', id), runs: runs(id).length }, before)
  assert.deepEqual([row(id).cursor, row(id).substep_cursor], [FIRST_GATE, null])
})

test('metric 2: with a reason it runs the sub-step, comes back to the gate, and stores the override and its reason', async () => {
  const id = 'DF-FORCE'
  await skippedAtGate(id)
  const guardrailsBefore = runs(id).filter((r) => r.step_index === GUARDRAILS).length

  const res = await force(id, { reason: '  Checkout flow changes; owner wants screens  ' })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.item.substep_cursor, DESIGN.id, 'the item is at the design sub-step')
  assert.equal(body.restart.attempt, 1)

  await waitFor('the forced round back at the gate', atGate(id))
  const forced = roundRows(id).at(-1)
  assert.deepEqual(
    [forced.round, forced.kind, forced.brief, forced.override_reason],
    [2, 'forced', 'Checkout flow changes; owner wants screens', 'Checkout flow changes; owner wants screens'],
  )
  assert.ok(forced.run_id)
  assert.equal(runs(id).filter((r) => r.substep_id === DESIGN.id).length, 1)
  assert.equal(runs(id).filter((r) => r.step_index === GUARDRAILS).length, guardrailsBefore, '"Set guardrails" did not re-run')
  const texts = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  assert.ok(texts.includes('Design it anyway: Checkout flow changes; owner wants screens'))
  const note = db.prepare('SELECT note FROM item_move WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id).note
  assert.equal(note, 'Checkout flow changes; owner wants screens')

  // Its latest round is no longer a skip: a second force is refused.
  const again = await force(id, { reason: 'once more' })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().error, 'not_skipped')
})

test('metric 2: an unknown sub-step is 404, an item away from a gate 409, and no gate PIN 401', async () => {
  const id = 'DF-REFUSE'
  await skippedAtGate(id)
  const unknown = await force(id, { reason: 'x' }, { substepId: 'golden-cases' })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error, 'unknown_substep')
  const missing = await force('DF-NOPE', { reason: 'x' })
  assert.equal(missing.statusCode, 404)

  const noPin = await force(id, { reason: 'x' }, { withPin: false })
  assert.equal(noPin.statusCode, 401)

  db.prepare('UPDATE work_item SET cursor = ?, paused = 1 WHERE id = ?').run(GUARDRAILS, id)
  const away = await force(id, { reason: 'x' })
  assert.equal(away.statusCode, 409)
  assert.equal(away.json().error, 'not_at_gate')
  assert.equal(roundRows(id).length, 1)
})
