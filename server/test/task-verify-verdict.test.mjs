// HZ-429: a Task's Verify & report records a structured verdict (pass/fail)
// and a summary of at most 3 lines beside its artifact, so the item page can
// show a failed run as failed without parsing the markdown. Display only —
// every case checks the run is done and the cursor advanced either way.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-verify-verdict-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, VERIFY_REPORT_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const MDI51_ARTIFACT = '## Verdict\n**fail**: command 1 crashed on import…\n\n## Metric check\nnone of the 5 metric lines hold'

// A Task at `stepIndex` with one active run of it, as a dispatch leaves it.
function seedActiveRun(id, stepIndex, attempt = 1) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'High', ?, 'task') ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
  ).run(id, `Task ${id}`, stepIndex)
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, ?, ?, 'active')")
    .run(id, stepIndex, attempt, STEPS[stepIndex].agent).lastInsertRowid
}

const runRow = (runId) => db.prepare('SELECT status, verdict, verdict_summary, artifact FROM step_run WHERE id = ?').get(runId)
const completionEvent = (id) =>
  db.prepare("SELECT detail, verdict FROM event WHERE item_id = ? AND text LIKE 'completed “Verify & report”%' ORDER BY id DESC").get(id)

async function completeVerify(id, artifacts, summary = 'ran 5 commands; the metric does not hold') {
  const runId = seedActiveRun(id, VERIFY_REPORT_STEP_INDEX)
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary, artifacts }), { ok: true })
  const row = runRow(runId)
  // Display only: the run completes and the cursor advances on any verdict.
  assert.equal(row.status, 'done')
  assert.equal(store.getItem(id).cursor, VERIFY_REPORT_STEP_INDEX + 1)
  return row
}

test('a pass stores verdict pass and its summary', async () => {
  const row = await completeVerify('T-PASS', {
    artifact_md: '## Verdict\n**pass** — the job holds the metric',
    verdict: { verdict: 'pass', summary: 'All 3 commands exited 0.\nEvery metric line holds.' },
  })
  assert.equal(row.verdict, 'pass')
  assert.equal(row.verdict_summary, 'All 3 commands exited 0.\nEvery metric line holds.')
  assert.deepEqual(completionEvent('T-PASS'), { verdict: 'pass', detail: 'All 3 commands exited 0.\nEvery metric line holds.' })
})

test('a fail stores verdict fail, stepOutputs returns its summary, and the full artifact is unchanged', async () => {
  const row = await completeVerify('T-FAIL', {
    artifact_md: MDI51_ARTIFACT,
    verdict: { verdict: 'fail', summary: 'Command 1 crashed on import.\nNone of the 5 metric lines hold.' },
  })
  assert.equal(row.verdict, 'fail')
  assert.ok(row.artifact.startsWith(MDI51_ARTIFACT), 'the full Verify markdown is kept')
  const out = store.itemStepOutputs('T-FAIL')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verdict, 'fail')
  assert.equal(out.verdictSummary, 'Command 1 crashed on import.\nNone of the 5 metric lines hold.')
  const ev = store.itemViewById('T-FAIL').events.find((e) => e.text.startsWith('completed “Verify & report”'))
  assert.equal(ev.verdict, 'fail')
  assert.equal(ev.detail, 'Command 1 crashed on import.\nNone of the 5 metric lines hold.')
})

test('a new run with no parseable verdict is stored as fail', async () => {
  const row = await completeVerify('T-NONE', { artifact_md: MDI51_ARTIFACT })
  assert.equal(row.verdict, 'fail')
  assert.equal(row.verdict_summary, 'No parseable verdict was returned.')

  const bad = await completeVerify('T-BAD', { artifact_md: MDI51_ARTIFACT, verdict: { verdict: 'maybe', summary: 'x' } })
  assert.equal(bad.verdict, 'fail')
})

test('a summary over 3 lines is cut to 3', async () => {
  const row = await completeVerify('T-LONG', {
    artifact_md: MDI51_ARTIFACT,
    verdict: { verdict: 'fail', summary: 'one\n\n  two  \nthree\nfour\nfive' },
  })
  assert.equal(row.verdict_summary, 'one\ntwo\nthree')
})

test('a re-run: the latest verdict wins — fail, then pass, reads pass', async () => {
  await completeVerify('T-RERUN', { artifact_md: MDI51_ARTIFACT, verdict: { verdict: 'fail', summary: 'it failed' } })
  const runId = seedActiveRun('T-RERUN', VERIFY_REPORT_STEP_INDEX, 2)
  await orchestrator.completeFarmRun(runId, {
    summary: 'the job holds the metric',
    artifacts: { artifact_md: '## Verdict\n**pass**', verdict: { verdict: 'pass', summary: 'it holds' } },
  })
  const out = store.itemStepOutputs('T-RERUN')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verdict, 'pass')
  assert.equal(out.verdictSummary, 'it holds')
})

test('a non-Verify Task step whose reply carries a verdict stores none', async () => {
  const runId = seedActiveRun('T-OTHER', RUN_PLAN_STEP_INDEX)
  await orchestrator.completeFarmRun(runId, {
    summary: 'planned 1 command',
    artifacts: { artifact_md: '## Commands\n1. `echo`', verdict: { verdict: 'fail', summary: 'nope' } },
  })
  const row = runRow(runId)
  assert.equal(row.status, 'done')
  assert.equal(row.verdict, null)
  assert.equal(row.verdict_summary, null)
  const out = store.itemStepOutputs('T-OTHER')[RUN_PLAN_STEP_INDEX]
  assert.equal(out.verdict, null)
  assert.ok(store.itemViewById('T-OTHER').events.every((e) => e.verdict === null))
})

test('no backfill: a run and an event with no verdict read null, and the migration re-runs cleanly', async () => {
  // Re-evaluating db.js on the same file runs every additive migration again.
  await import(`../src/db.js?again=${Date.now()}`)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-OLD', 'old', 'High', ?, 'task')").run(
    VERIFY_REPORT_STEP_INDEX + 1,
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES ('T-OLD', ?, 1, ?, 'done', 'old run', ?)",
  ).run(VERIFY_REPORT_STEP_INDEX, STEPS[VERIFY_REPORT_STEP_INDEX].agent, MDI51_ARTIFACT)
  db.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES ('T-OLD', 'QA', 'completed “Verify & report” — old', '#000', 'QA')").run()
  const out = store.itemStepOutputs('T-OLD')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verdict, null)
  assert.equal(out.verdictSummary, null)
  assert.equal(store.itemViewById('T-OLD').events[0].verdict, null)
})
