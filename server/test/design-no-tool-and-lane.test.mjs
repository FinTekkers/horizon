// A design round on a box with no design tool, and a lane that never runs the
// design sub-step's anchor step (HZ-943).
//
// - No tool: a design run whose artifact opens with the no-tool line
//   (domain/js/designCanvas.js) is stored as a skip round, the item moves on
//   like any finished round, and its first gate can approve with no canvas.
// - Lane: the trivial lane confirms "Define how we measure success" with a
//   server-side check, not an agent, so its design sub-step can never run; no
//   design is required of it. A plain lane's item still needs one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('design-no-tool test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-no-tool-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const rounds = await import('../src/designRounds.js')
const designSpec = await import('../src/designSpec.js')
const { formatNoToolLine } = await import('../../domain/js/designCanvas.js')
const { laneCheckIndexes, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: [], repos: ['acme/web'], paths: [] } }
const SNAPSHOT = JSON.stringify([DESIGN])
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('No tool', 1, 1)").run().lastInsertRowid)

function seed(id, { cursor, lane = null, substepCursor = null, pending = null }) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, repo, desc, metric, guardrails, substeps_json, lane, substep_cursor, substep_pending_json) VALUES (?, ?, 'Medium', ?, ?, 'acme/web', 'Ship it.', '1. It works.', 'Tests pass.', ?, ?, ?, ?)",
  ).run(id, `Item ${id}`, cursor, projectId, SNAPSHOT, lane, substepCursor, pending)
}
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

test('no design tool: the round is a skip, the item moves on, and its gate needs no canvas', () => {
  const pending = rounds.encodePending({ brief: 'design_needed: yes — new screen', kind: 'run' })
  seed('NT-1', { cursor: METRIC_STEP, substepCursor: DESIGN.id, pending })
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, substep_id) VALUES ('NT-1', ?, 1, 'Design', 'done', datetime('now'), ?)").run(METRIC_STEP, DESIGN.id).lastInsertRowid,
  )
  const artifact = `${formatNoToolLine('Meta Studio is not installed on this box.')}\n`
  assert.equal(orchestrator.completeDesignSubstep('NT-1', { id: runId, step_index: METRIC_STEP, substep_id: DESIGN.id }, artifact), true)

  const item = row('NT-1')
  assert.equal(item.substep_cursor, null)
  assert.equal(item.cursor, GUARDRAILS, 'it walks on like any finished round')
  const latest = rounds.latestRound('NT-1', DESIGN.id)
  assert.equal(latest.kind, 'skip')
  assert.equal(latest.brief, 'Meta Studio is not installed on this box.')
  assert.ok(events('NT-1').some((t) => t.startsWith('Skipped “Design the screens”: Meta Studio is not installed')))

  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(FIRST_GATE, 'NT-1')
  assert.equal(designSpec.designApprovable(row('NT-1')), true, 'the gate approves with no canvas')
})

test('a trivial-lane item never needs a design; a plain item still does (HZ-943)', () => {
  seed('NT-TRIV', { cursor: FIRST_GATE, lane: 'trivial' })
  seed('NT-PLAIN', { cursor: FIRST_GATE })
  assert.ok(laneCheckIndexes(row('NT-TRIV')).has(METRIC_STEP), 'the trivial lane checks the anchor step instead of running it')
  assert.equal(designSpec.designRequired(row('NT-TRIV')), false)
  assert.equal(designSpec.designApprovable(row('NT-TRIV')), true)
  assert.equal(designSpec.designRequired(row('NT-PLAIN')), true)
  assert.equal(designSpec.designApprovable(row('NT-PLAIN')), false)
})
