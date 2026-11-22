// HZ-946: the item page's check line (server/src/checkLine.js) — each command
// of the final main check round of the item's latest done implement run, its
// pass or fail exactly as review judges it, and whether it wrote no per-test
// report. A missing report never changes a pass or a fail.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-check-line-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const testResults = await import('../src/testResults.js')
const { itemCheckLine } = await import('../src/checkLine.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const quiet = { info() {}, warn() {}, error() {} }
const SHA = 'c'.repeat(40)

// An item past Implement with one done implement run; returns the run id.
function implemented(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'check line',
    'Medium',
    IMPLEMENT_STEP_INDEX + 1,
    'acme/line',
  )
  return Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output) VALUES (?, ?, 1, ?, 'done', 'done')")
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
}

// The farm's row for a command that wrote no report (no_report omitted: an
// older farm's), and a JUnit test row.
const bare = (command, status, extra = {}) => ({ suite: null, file: null, test: command, status, duration_ms: 5, command, attempt: 1, no_report: true, ...extra })
const junit = (command, test, status, extra = {}) => ({ suite: 'S', file: 'a.test.mjs', test, status, duration_ms: 5, command, attempt: 1, ...extra })
const round = (checkRun, tests, commands) => ({ check_run: checkRun, commit_sha: SHA, tree_sha: SHA, tests, commands })
const exits = (...pairs) => pairs.map(([command, exit_code, attempt = 1]) => ({ command, attempt, exit_code }))

// One post holds every round, as one implement run's upload does.
function upload(itemId, runId, rounds) {
  return testResults.recordTestRuns({ itemId, runId, source: 'implement', testRuns: rounds, log: quiet, notify: false })
}

test('a flagged passing and a flagged failing command keep their outcome and exit; a NULL row is not flagged', async () => {
  const runId = implemented('CL-1')
  await upload('CL-1', runId, [
    round(
      'cr-1',
      [
        bare('npm run lint', 'pass'),
        bare('npm run build', 'fail'),
        junit('npm test', 'adds', 'pass'),
        bare('npm run old', 'pass', { no_report: undefined }),
      ],
      exits(['npm run lint', 0], ['npm run build', 2], ['npm test', 0], ['npm run old', 0]),
    ),
  ])

  assert.deepEqual(itemCheckLine('CL-1'), [
    { command: 'npm run lint', outcome: 'pass', exit: 0, noReport: true },
    { command: 'npm run build', outcome: 'fail', exit: 2, noReport: true },
    { command: 'npm test', outcome: 'pass', exit: 0, noReport: false },
    { command: 'npm run old', outcome: 'pass', exit: 0, noReport: false },
  ])
})

test('only the newest main check run counts, and a command’s last attempt decides', async () => {
  const runId = implemented('CL-2')
  await upload('CL-2', runId, [
    // An earlier fix round: flagged, failing.
    round('cr-old', [bare('npm run lint', 'fail')], exits(['npm run lint', 1])),
    round(
      'cr-new',
      [
        // Attempt 1 wrote no report; the rerun wrote JUnit and passed.
        bare('npm test', 'fail'),
        junit('npm test', 'adds', 'pass', { attempt: 2 }),
        junit('npm run lint', 'lints', 'pass'),
      ],
      exits(['npm test', 1], ['npm test', 0, 2], ['npm run lint', 0]),
    ),
    // A branch run after it never shows on the main line.
    { ...round('cr-branch', [bare('scripts/checks/x.sh', 'fail')], exits(['scripts/checks/x.sh', 1])), label: 'branch' },
  ])

  assert.deepEqual(itemCheckLine('CL-2'), [
    { command: 'npm test', outcome: 'pass', exit: 0, noReport: false },
    { command: 'npm run lint', outcome: 'pass', exit: 0, noReport: false },
  ])
})

test('an item with no stored rows, or no done implement run, has an empty line and no checks output', async () => {
  implemented('CL-3')
  assert.deepEqual(itemCheckLine('CL-3'), [])
  assert.equal(store.itemStepOutputs('CL-3')[IMPLEMENT_STEP_INDEX].checks, undefined)
  assert.deepEqual(itemCheckLine('CL-NONE'), [])
})

test("the Implement card's step output carries the line", async () => {
  const runId = implemented('CL-4')
  await upload('CL-4', runId, [round('cr-4', [bare('npm run lint', 'pass')], exits(['npm run lint', 0]))])

  assert.deepEqual(store.itemStepOutputs('CL-4')[IMPLEMENT_STEP_INDEX].checks, [
    { command: 'npm run lint', outcome: 'pass', exit: 0, noReport: true },
  ])
})
