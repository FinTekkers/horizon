// HO-852 metric lines 1 and 4. Approving the first gate through the real
// POST /move copies the latest round's canvas link — the newest done run of
// the design sub-step — into design_spec, and a later edit of that run, or a
// newer run, leaves the frozen link exactly as it was. An approve that names
// no canvas run (WhatsApp, Autopilot, a stale page) is refused with no row,
// as golden cases are. "Approve without design" stores a trimmed, non-empty
// reason and no canvas.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('design-spec-approve test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-spec-approve-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const spec = await import('../src/designSpec.js')
const rounds = await import('../src/designRounds.js')
const { ACTOR } = await import('../src/caretakerActor.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')
const { kindStepIndex, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const CHANGE_GATE = requiredStepIndex('Approve & prioritize this work')
const TASK_GATE = kindStepIndex('Approve & prioritize', 'task')
const TASK_ANCHOR = kindStepIndex("How we'll verify", 'task')
const PLAN_OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_ID = 'design-screens'
const snapshot = (anchor) =>
  JSON.stringify([{ id: DESIGN_ID, label: 'Design the screens', kind: 'opening', anchor, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } }])
const canvasLine = (slug, version = 1) => `**Canvas:** [Open the design canvas](${canvasUrlFor(slug)}) · slug \`${slug}\` · version ${version}\n\nThe board, in three surfaces.`

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design spec approve', 1, 1)").run().lastInsertRowid)

function seed(id, { kind = 'change' } = {}) {
  const cursor = kind === 'change' ? CHANGE_GATE : TASK_GATE
  const anchor = kind === 'change' ? 1 : TASK_ANCHOR
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    kind,
    projectId,
    snapshot(anchor),
  )
  return anchor
}
const writeRun = (id, artifact, { status = 'done', anchor = 1 } = {}) =>
  Number(
    db
      .prepare('INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(id, anchor, DESIGN_ID, 'Design', status, artifact).lastInsertRowid,
  )
const move = (id, payload) => app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers: { cookie, 'x-human-key': pin }, payload })
const approve = (id, body = {}) => move(id, { action: 'approve', from: stepKeyAt(cursorOf(id)), ...body })
const specRow = (id) => db.prepare('SELECT * FROM design_spec WHERE item_id = ?').get(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const lastEvent = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)?.text
const view = async (id) => (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })).json().items.find((it) => it.id === id)

test('metric 1: approve freezes the newest done run’s canvas; editing that run or adding a newer one leaves the frozen link the same', async () => {
  seed('S-FREEZE')
  writeRun('S-FREEZE', canvasLine('round-one'))
  const newest = writeRun('S-FREEZE', canvasLine('round-two', 2))
  writeRun('S-FREEZE', canvasLine('round-three', 3), { status: 'cancelled' })

  const before = (await view('S-FREEZE')).designSpec
  assert.equal(before.approved, false)
  assert.equal(before.pendingRunId, newest, 'the latest round is the newest done run, never a failed (cancelled) one')
  assert.equal(before.canvasUrl, canvasUrlFor('round-two'))

  const res = await approve('S-FREEZE', { designRunId: newest })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorOf('S-FREEZE'), CHANGE_GATE + 1)
  const frozen = specRow('S-FREEZE')
  assert.equal(frozen.canvas_url, canvasUrlFor('round-two'))
  assert.equal(frozen.source_run_id, newest)
  assert.equal(frozen.skip_reason, null)
  assert.equal(frozen.approved_by, 'Fixture User')

  // The canvas record changes under it: the run is edited, and a newer round lands.
  db.prepare('UPDATE step_run SET artifact = ? WHERE id = ?').run(canvasLine('edited-after'), newest)
  writeRun('S-FREEZE', canvasLine('round-four', 4))
  assert.deepEqual(specRow('S-FREEZE'), frozen, 'the frozen row is byte for byte the same')
  assert.match(spec.canvasInput('S-FREEZE', PLAN_OPTIONS).content, /canvas\/round-two\b/)
  const after = (await view('S-FREEZE')).designSpec
  assert.equal(after.approved, true)
  assert.equal(after.canvasUrl, canvasUrlFor('round-two'))
})

test('metric 1: no designRunId is refused with “approve in Horizon”, a stale one with design_changed, no canvas line with design_missing — no row', async () => {
  seed('S-REFUSE')
  const old = writeRun('S-REFUSE', canvasLine('old'))
  writeRun('S-REFUSE', canvasLine('new', 2))

  const missing = await approve('S-REFUSE')
  assert.equal(missing.statusCode, 409)
  assert.equal(missing.json().error, 'design_changed')
  assert.match(missing.json().message, /approve in Horizon/)
  assert.match(lastEvent('S-REFUSE'), /approve in Horizon.*the gate stays open/)

  const stale = await approve('S-REFUSE', { designRunId: old })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error, 'design_changed')
  assert.equal(stale.json().message, spec.CHANGED_TEXT)
  assert.equal(specRow('S-REFUSE'), undefined)
  assert.equal(cursorOf('S-REFUSE'), CHANGE_GATE)

  seed('S-NOLINE')
  const noLine = writeRun('S-NOLINE', 'A design round that wrote no canvas line.')
  const none = await approve('S-NOLINE', { designRunId: noLine })
  assert.equal(none.statusCode, 409)
  assert.equal(none.json().error, 'design_missing')
  assert.equal(specRow('S-NOLINE'), undefined)
  assert.equal(cursorOf('S-NOLINE'), CHANGE_GATE)
})

test('metric 1: the caretaker cannot freeze a canvas nobody saw', async () => {
  seed('S-AUTO')
  writeRun('S-AUTO', canvasLine('auto'))
  const result = await app.gateActions.approve('S-AUTO', CHANGE_GATE, '', ACTOR)
  assert.equal(result.error, 'design_changed')
  assert.equal(specRow('S-AUTO'), undefined)
  assert.equal(cursorOf('S-AUTO'), CHANGE_GATE)
})

test('metric 4: “Approve without design” stores the trimmed reason and no canvas; a blank reason is refused', async () => {
  seed('S-SKIP')
  const run = writeRun('S-SKIP', canvasLine('ignored'))
  const blank = await approve('S-SKIP', { designSkipReason: '   ' })
  assert.equal(blank.statusCode, 409)
  assert.equal(blank.json().error, 'design_skip_reason_empty')
  assert.equal(specRow('S-SKIP'), undefined)
  assert.equal(cursorOf('S-SKIP'), CHANGE_GATE)

  // A reason wins over a canvas run sent with it.
  const res = await approve('S-SKIP', { designSkipReason: '  Back-end only; no screen changes.  ', designRunId: run })
  assert.equal(res.statusCode, 200, res.body)
  const row = specRow('S-SKIP')
  assert.equal(row.skip_reason, 'Back-end only; no screen changes.')
  assert.equal(row.canvas_url, null)
  assert.equal(row.source_run_id, null)
  assert.equal(lastEvent('S-SKIP'), 'approved without a design: Back-end only; no screen changes.')
  for (const step of spec.CANVAS_STEP_INDEXES) assert.equal(spec.canvasInput('S-SKIP', step), null)
  const served = (await view('S-SKIP')).designSpec
  assert.equal(served.approved, true)
  assert.equal(served.canvasUrl, null)
  assert.equal(served.skipReason, 'Back-end only; no screen changes.')
})

test('a reason over 2000 characters is a 400', async () => {
  seed('S-LONG')
  const res = await approve('S-LONG', { designSkipReason: 'x'.repeat(2001) })
  assert.equal(res.statusCode, 400)
  assert.equal(specRow('S-LONG'), undefined)
})

test('a design the step 1 verdict skipped approves with no canvas, keeping the verdict’s reason', async () => {
  seed('S-VERDICT')
  rounds.recordRound('S-VERDICT', DESIGN_ID, { kind: 'skip', brief: 'backend only' })
  assert.equal((await view('S-VERDICT')).designSpec.verdictSkipReason, 'backend only')
  const res = await approve('S-VERDICT')
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(specRow('S-VERDICT').skip_reason, 'backend only')
  assert.equal(specRow('S-VERDICT').canvas_url, null)
})

test('a Task’s first gate freezes its canvas the same way', async () => {
  const anchor = seed('S-TASK', { kind: 'task' })
  const run = writeRun('S-TASK', canvasLine('task-canvas'), { anchor })
  assert.equal((await approve('S-TASK')).json().error, 'design_changed')
  const res = await approve('S-TASK', { designRunId: run })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(specRow('S-TASK').canvas_url, canvasUrlFor('task-canvas'))
})
