// HZ-279 metric 4: an item whose gate action is running gets no gate notice,
// and exactly one when the run ends blocked, failed, timed out, interrupted or
// resolved. A merge is notified once, at the next gate, never at Accept.
//
// Runs go through the real store.claimGateAction / finishGateAction /
// sweepGateActions / interruptGateActionsForDeploy, and the sweep is hung on
// store.onChange the way init() hangs it — so finishGateAction's notify()
// firing BEFORE the gate advances is exercised, not assumed.
//
// WA_APPROVER_JIDS is ONE jid, so a gate_notice row is one notice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gatenotify-ga-')), 'test.db')
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const ACCEPT = requiredStepIndex('Accept the code')
const CLOSE_GATE = requiredStepIndex('Review the work & close')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')

store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
store.onChange(() => notifier.sweepGates())

const rows = (itemId) => db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').all(itemId)

let seq = 0
// An item parked at `cursor` whose arrival has already been notified once.
function atGate(cursor = ACCEPT) {
  const id = `GA-N${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, pr) VALUES (?, 'Gate action notices', 'High', ?, 7)").run(id, cursor)
  notifier.sweepGates()
  assert.equal(rows(id).length, 1, 'fixture: the arrival itself is notified once')
  return id
}

function claim(id, kind) {
  const c = store.claimGateAction(id, kind, { detail: null, timeoutMs: 60_000 })
  assert.ok(c, 'fixture: the claim won')
  return c
}

// Two sweeps plus one bare onChange: "exactly 1" must survive repeats.
function settle() {
  notifier.sweepGates()
  notifier.sweepGates()
  store.notifyChange()
}

const END = {
  blocked: (id, kind, c) => store.finishGateAction(id, kind, c.token, { state: 'blocked', reason: 'checks failed' }),
  failed: (id, kind, c) => store.finishGateAction(id, kind, c.token, { state: 'failed', reason: 'boom' }),
  timed_out: (id) => {
    db.prepare("UPDATE gate_action SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE item_id = ?").run(id)
    assert.equal(store.sweepGateActions({ bootedAt: '1999-01-01T00:00:00.000Z' }), 1)
    assert.equal(db.prepare('SELECT state FROM gate_action WHERE item_id = ?').get(id).state, 'timed_out')
  },
  interrupted: (id, kind) => assert.equal(store.interruptGateActionsForDeploy([{ itemId: id, kind }]).length, 1),
}

for (const kind of ['premerge', 'resolve']) {
  test(`${kind}: a running gate action gets 0 notices across repeated sweeps`, () => {
    const id = atGate()
    claim(id, kind)
    settle()
    assert.equal(rows(id).length, 1)
    assert.equal(db.prepare('SELECT notified_step FROM work_item WHERE id = ?').get(id).notified_step, null)
  })

  for (const [state, end] of Object.entries(END)) {
    if (kind === 'resolve' && state === 'blocked') continue // a resolve run never ends blocked
    test(`${kind}: a run that ends ${state} gets exactly 1 new notice`, () => {
      const id = atGate()
      const c = claim(id, kind)
      settle()
      end(id, kind, c)
      settle()
      const all = rows(id)
      assert.equal(all.length, 2)
      assert.equal(all[1].step_index, ACCEPT)
    })
  }
}

test('operator ruling 1: a Resolve-conflicts run that ends resolved gets exactly 1 notice', () => {
  const id = atGate()
  const c = claim(id, 'resolve')
  settle()
  store.finishGateAction(id, 'resolve', c.token, { state: 'resolved' })
  settle()
  assert.equal(rows(id).length, 2)
})

test('a merge is notified 0 times at Accept and exactly once at the next gate', () => {
  const id = atGate()
  const c = claim(id, 'premerge')
  settle()
  // The real path: finishGateAction notifies (and so sweeps) with the cursor
  // still on Accept, then the approval advances it.
  store.finishGateAction(id, 'premerge', c.token, { state: 'merged' })
  settle()
  assert.equal(rows(id).length, 1, 'no notice for the Accept gate being left')
  assert.equal(store.approveGate(id, ACCEPT, '').ok, true)
  settle()
  assert.equal(rows(id).length, 1, 'the deploy step is not a gate')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(CLOSE_GATE, id)
  settle()
  const all = rows(id)
  assert.equal(all.length, 2)
  assert.equal(all[1].step_index, CLOSE_GATE)
})

test('operator ruling 2: a merge whose advance was refused sends no new notice', () => {
  const id = atGate()
  const c = claim(id, 'premerge')
  store.finishGateAction(id, 'premerge', c.token, { state: 'merged' })
  settle()
  assert.equal(rows(id).length, 1)
  assert.equal(db.prepare('SELECT notified_step FROM work_item WHERE id = ?').get(id).notified_step, ACCEPT)
})

test('existing rules: a paused item at a gate is still notified; a closed item and a disabled project are not', () => {
  const paused = `GA-P${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, paused) VALUES (?, 'Paused', 'High', ?, 1)").run(paused, DESIGN_GATE)
  settle()
  assert.equal(rows(paused).length, 1)

  const closed = `GA-C${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'Closed', 'High', ?)").run(closed, CLOSE_GATE + 1)
  settle()
  assert.equal(rows(closed).length, 0)

  const project = store.createProject(`Off ${seq}`)
  store.setProjectEnabled(project.id, false)
  const off = `GA-D${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'Disabled', 'High', ?, ?)").run(off, ACCEPT, project.id)
  settle()
  assert.equal(rows(off).length, 0)
})
