// HZ-710 guardrail 4: the migration leaves every live item at its current
// step, with no runs cancelled. Boot requeues any row still flagged
// `rejected` (one boot-recovery move each), then drops the column; a second
// boot changes nothing. The database here is given the legacy column the way
// an old one has it — the same statement the rollback runbook uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-item-migration-')), 'test.db')
delete process.env.FARM_URL

const { db, dropLegacyRejectedColumn, hasRejectedColumn } = await import('../src/db.js')
const store = await import('../src/store.js')
const { stepIndexOf, endIndex } = await import('../../domain/js/lifecycle.js')

const kicks = []
store.registerAgentRunner({ kick: (id) => kicks.push(id), cancel: () => assert.fail('the migration cancelled a run') })

const LIVE = [
  ['MG-1', 'change', 'change.define-outcome'],
  ['MG-2', 'change', 'change.approve-design'],
  ['MG-3', 'change', 'change.implement'],
  ['MG-4', 'change', 'change.accept-code'],
  ['MG-5', 'task', 'task.execute'],
  ['MG-6', 'task', 'task.approve-run'],
  ['MG-7', 'plan', 'plan.file-items'],
]
const snapshot = () => ({
  items: db.prepare('SELECT id, cursor, substep_cursor, paused FROM work_item ORDER BY id').all(),
  runs: db.prepare('SELECT id, item_id, status FROM step_run ORDER BY id').all(),
  moves: db.prepare('SELECT item_id, who, from_key, to_key, action, note FROM item_move ORDER BY id').all(),
})
const boot = () => ({ recovered: store.recoverLegacyRejected(), dropped: dropLegacyRejectedColumn() })

test('a fresh database has no rejected column, and boot there is a no-op', () => {
  assert.equal(hasRejectedColumn(), false)
  assert.deepEqual(boot(), { recovered: 0, dropped: false })
})

test('guardrail 4: live items keep their steps and runs; the one flagged row is requeued with one move; the column goes', () => {
  db.exec('ALTER TABLE work_item ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0')
  const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
  for (const [id, kind, key] of LIVE) {
    insert.run(id, id, 'Medium', stepIndexOf(key), kind)
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'active')").run(id, stepIndexOf(key))
  }
  insert.run('MG-CLOSED', 'closed', 'Medium', endIndex('change'), 'change')
  insert.run('MG-FLAGGED', 'flagged', 'Medium', stepIndexOf('change.review-before-exec'), 'change')
  db.prepare("UPDATE work_item SET rejected = 1 WHERE id = 'MG-FLAGGED'").run()
  const before = snapshot()

  assert.deepEqual(boot(), { recovered: 1, dropped: true })
  assert.equal(hasRejectedColumn(), false)
  const after = snapshot()
  const others = (s) => s.items.filter((row) => row.id !== 'MG-FLAGGED')
  assert.deepEqual(others(after), others(before), 'every other item is where it was')
  assert.deepEqual(after.runs, before.runs, 'no run was cancelled')
  // As before: the nearest agent step before the gate it was rejected at.
  assert.equal(after.items.find((row) => row.id === 'MG-FLAGGED').cursor, stepIndexOf('change.summarize-reviews'))
  assert.deepEqual(after.moves, [
    { item_id: 'MG-FLAGGED', who: 'Horizon', from_key: 'change.review-before-exec', to_key: 'change.summarize-reviews', action: 'return', note: 'boot recovery' },
  ])
  assert.deepEqual(kicks, ['MG-FLAGGED'])
})

test('guardrail 4: a second boot changes nothing', () => {
  const before = snapshot()
  assert.deepEqual(boot(), { recovered: 0, dropped: false })
  assert.deepEqual(snapshot(), before)
})

test('boot requeues before it drops: orchestrator.init calls them in that order', () => {
  const source = readFileSync(join(REPO_ROOT, 'server/src/orchestrator.js'), 'utf8')
  const recover = source.indexOf('recoverLegacyRejected()')
  const drop = source.indexOf('dropLegacyRejectedColumn()')
  assert.ok(recover > 0 && drop > recover, 'recoverLegacyRejected() must run before dropLegacyRejectedColumn()')
})
