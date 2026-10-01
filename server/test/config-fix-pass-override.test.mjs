// HZ-182: both fix-pass thresholds are configurable. Its own file because
// config.js reads the environment once, at import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-fix-pass-config-')), 'test.db')
process.env.FIX_PASS_TURN_DIVISOR = '4'
process.env.FIX_PASS_MAX_LINES = '50'

const config = await import('../src/config.js')
const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const fixItem = { fix_pass: 1, last_reviewed_sha: 'aaaaaaa1', fix_findings_json: JSON.stringify([{ file: 'a.js', line: 1, detail: 'x' }]) }

test('FIX_PASS_TURN_DIVISOR sets the fix-pass budget', () => {
  assert.equal(config.FIX_PASS_TURN_DIVISOR, 4)
  const scope = orchestrator.implementScope(fixItem)
  assert.equal(scope.max_turns, 40) // 160 / 4
  assert.equal(scope.timeout_s, 675) // 2700 / 4
})

test('FIX_PASS_MAX_LINES sets the full-review threshold', async () => {
  assert.equal(config.FIX_PASS_MAX_LINES, 50)
  const settle = async (id, lines) => {
    db.prepare('INSERT INTO work_item (id, title, priority, cursor, fix_pass, last_reviewed_sha, fix_findings_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, id, 'Medium', IMPLEMENT_STEP_INDEX, 1, fixItem.last_reviewed_sha, fixItem.fix_findings_json,
    )
    const runId = db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, scope_json) VALUES (?, ?, 1, ?, ?)')
      .run(id, IMPLEMENT_STEP_INDEX, 'Eng', JSON.stringify(orchestrator.implementScope(fixItem))).lastInsertRowid
    await orchestrator.completeFarmRun(runId, { summary: 'fixed', artifacts: { fix_diff_lines: lines } })
    const item = store.getItem(id)
    assert.equal(item.cursor, REVIEW_STEP_INDEX)
    orchestrator.cancel(id)
    return orchestrator.reviewScope(item).mode
  }
  assert.equal(await settle('CFG-50', 50), 'delta')
  assert.equal(await settle('CFG-51', 51), 'full')
})
