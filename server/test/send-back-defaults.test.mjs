// HZ-708: with no step chosen, a send-back goes to the step that produced what
// the gate reviews. The table is the issue's, keyed by label; Caretaker and
// WhatsApp votes reach the same default because they choose no step either.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-send-back-defaults-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, kindStepIndex, firstStepIndex, laneSkips } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const DEFAULTS = [
  ['change', 'Approve & prioritize this work', 'Define the outcome'],
  ['change', 'Approve the high-level design', 'Plan options & trade-offs (pros / cons)'],
  ['change', 'Review before execution', 'Draft implementation plan'],
  ['change', 'Accept the code', 'Specialist agent implements'],
  ['change', 'Review the work & close', 'Deploy the changes'],
  ['task', 'Approve & prioritize', 'Define the outcome'],
  ['task', 'Approve the run', 'Run plan'],
  ['task', 'Review & close', 'Verify & report'],
  ['plan', 'Approve & prioritize', 'Define the question'],
  ['plan', 'Approve the design', 'Design options & recommendation'],
  ['plan', 'Approve & file', 'Draft items'],
  ['plan', 'Review & close', 'Draft items'],
]

let seq = 0
function makeItem(kind, cursor, extra = {}) {
  const id = `SBD-${++seq}`
  const cols = ['id', 'title', 'priority', 'cursor', 'kind', ...Object.keys(extra)]
  db.prepare(`INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    id,
    `Send-back default ${id}`,
    'Medium',
    cursor,
    kind,
    ...Object.values(extra),
  )
  return id
}

test('the table covers every gate in steps.json', () => {
  const covered = DEFAULTS.map(([kind, gate]) => kindStepIndex(gate, kind)).sort((a, b) => a - b)
  const gates = STEPS.flatMap((step, index) => (step.kind === 'gate' ? [index] : []))
  assert.deepEqual(covered, gates)
})

for (const [kind, gate, target] of DEFAULTS) {
  test(`${kind}: with no step chosen, "${gate}" sends back to "${target}"`, () => {
    const id = makeItem(kind, kindStepIndex(gate, kind))
    assert.deepEqual(store.requestChanges(id, gate, 'not yet'), { ok: true })
    assert.equal(STEPS[store.getItem(id).cursor].label, target)
    // The feedback goes to the agent that will re-run.
    const fb = db.prepare('SELECT target FROM feedback WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)
    assert.equal(fb.target, STEPS[kindStepIndex(target, kind)].agent || gate)
  })
}

test('plan: a send-back from Review & close passes over File items and files nothing', () => {
  const id = makeItem('plan', kindStepIndex('Review & close', 'plan'))
  assert.deepEqual(store.requestChanges(id, 'Review & close', 'redo'), { ok: true })
  assert.ok(store.getItem(id).cursor < kindStepIndex('File items', 'plan'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(id).n, 0)
})

test('a lane that skips the default target walks back from the gate instead, never past the item\'s first step', () => {
  const gate = kindStepIndex('Approve the high-level design')
  const id = makeItem('change', gate, { lane: 'trivial' })
  const skips = laneSkips(store.getItem(id))
  assert.ok(skips.has(kindStepIndex('Plan options & trade-offs (pros / cons)')), 'the fixture lane no longer skips the default')
  assert.deepEqual(store.requestChanges(id, 'Approve the high-level design', 'redo'), { ok: true })
  const landed = store.getItem(id).cursor
  assert.equal(skips.has(landed), false)
  assert.equal(STEPS[landed].kind, 'agent')
  assert.ok(landed >= firstStepIndex('change') && landed < gate)
  assert.equal(STEPS[landed].label, 'Set guardrails')
})
