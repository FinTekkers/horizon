// HZ-182 metric 5, server half: HZ-125's recorded attempt-4 rejection (the
// unguarded composeRole lookup) replayed through the orchestrator. The task it
// dispatches must match farm/tests/fixtures/hz125/dispatch.json, which
// farm/tests/test_hz125_replay.py then runs as the farm half.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz125-replay-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../farm/tests/fixtures/hz125/${name}`, import.meta.url), 'utf8'))
const recorded = fixture('verdict.json')
const expected = fixture('dispatch.json')

const tasks = []
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/steps/run')) tasks.push(JSON.parse(init.body))
  return { ok: true, json: async () => ({}) }
}
after(() => orchestrator.cancel('HZ-125R'))

test("HZ-125's attempt-4 rejection produces a fix-only run, then a delta review", async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'HZ-125R',
    'Personas become agent-scoped',
    'High',
    REVIEW_STEP_INDEX,
  )
  orchestrator.kick('HZ-125R')
  assert.deepEqual(tasks.at(-1).scope, { mode: 'full' })

  await orchestrator.completeFarmRun(tasks.at(-1).run_id, {
    summary: 'code review failed; QA review passed',
    artifacts: { artifact_md: '## Code review\n**fail**', verdict: recorded.verdict, reviewed_sha: recorded.reviewed_sha },
  })

  const implement = tasks.at(-1)
  assert.equal(implement.step.index, IMPLEMENT_STEP_INDEX)
  assert.equal(implement.step.label, expected.step.label)
  assert.deepEqual(implement.scope, expected.scope)
  // Only the one Blocking finding is the fix's record; the three notes are not.
  assert.equal(implement.scope.findings.length, 1)
  assert.equal(implement.feedback[0].message, expected.feedback_message)

  // The recorded fix (adb44d7) changed 156 lines: under the limit.
  await orchestrator.completeFarmRun(implement.run_id, {
    summary: 'guarded every persona-registry lookup',
    artifacts: { fix_diff_lines: 156, fix_diff_files: ['server/src/definitions.js'] },
  })
  const deltaReview = tasks.at(-1)
  assert.equal(deltaReview.step.index, REVIEW_STEP_INDEX)
  assert.equal(deltaReview.scope.mode, 'delta')
  assert.equal(deltaReview.scope.base_sha, recorded.reviewed_sha)
  assert.deepEqual(deltaReview.scope.previous_findings, [{ index: 0, ...expected.scope.findings[0] }])
})
