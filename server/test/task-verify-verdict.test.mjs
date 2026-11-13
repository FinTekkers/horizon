// HZ-429: a Task's Verify & report records a structured verdict (pass/fail)
// and a summary of at most 3 lines beside its artifact, so the item page can
// show a failed run as failed without parsing the markdown. Display only —
// every case checks the run is done and the cursor advanced either way.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

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

// ---- HO-841: three Verify outcomes and an Execute cause ----

const { EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { executeFailed, readVerifyOutcome } = await import('../src/verifyOutcome.js')

const CLEAN_JOB = {
  status: 'finished',
  commands: [
    { command: './backfill.sh --dry-run', status: 'done', exit_code: 0 },
    { command: './backfill.sh', status: 'done', exit_code: 0 },
  ],
  logTail: [],
}
const FAILED_JOB = {
  status: 'finished',
  commands: [{ command: 'psql -f fix.sql', status: 'done', exit_code: 127 }],
  logTail: ['psql: command not found'],
}

// An Execute run of `id` in `status`, holding `view` as its stored job view.
function seedExecute(id, view, status = 'done', attempt = 1) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'High', ?, 'task') ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX)
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status, job_view) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, EXECUTE_STEP_INDEX, attempt, STEPS[EXECUTE_STEP_INDEX].agent, status, view == null ? null : JSON.stringify(view)).lastInsertRowid
}
const outcomeRow = (runId) => db.prepare('SELECT verdict, verify_outcome, execute_cause FROM step_run WHERE id = ?').get(runId)

async function verifyAfter(id, view, verdict, { status = 'done' } = {}) {
  seedExecute(id, view, status)
  const runId = seedActiveRun(id, VERIFY_REPORT_STEP_INDEX)
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'judged the job', artifacts: { artifact_md: '## Verdict', verdict } }), {
    ok: true,
  })
  return outcomeRow(runId)
}

test('metric 1: normalizeVerifyVerdict reads only the Verify value set', () => {
  const outcome = (raw) => orchestrator.normalizeVerifyVerdict(raw, 'x').outcome
  for (const v of ['pass', 'work_failed', 'done_proof_incomplete']) {
    assert.equal(orchestrator.normalizeVerifyVerdict({ verdict: v, summary: 's' }, 'x', { executeFailed: false }).outcome, v)
  }
  assert.equal(outcome({ verdict: 'fail', summary: 's' }), 'work_failed')
  for (const raw of [undefined, null, {}, { verdict: 'maybe' }, 'pass']) {
    const got = orchestrator.normalizeVerifyVerdict(raw, 'x')
    assert.deepEqual(got, { verdict: 'fail', outcome: 'work_failed', executeCause: null, summary: 'No parseable verdict was returned.' }, String(raw))
  }
  // The coarse column keeps pass/fail.
  assert.equal(orchestrator.normalizeVerifyVerdict({ verdict: 'pass' }, 'x').verdict, 'pass')
  assert.equal(orchestrator.normalizeVerifyVerdict({ verdict: 'work_failed' }, 'x').verdict, 'fail')
})

test('metric 1 / guardrail 3: Review and Deploy still reject both new values, and VERDICT_VALUES is unchanged', () => {
  for (const v of ['work_failed', 'done_proof_incomplete']) {
    const qa = { verdict: v, regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true }
    assert.equal(orchestrator.validateVerdict({ code_review: { verdict: v }, qa_review: qa }), false, v)
    assert.equal(orchestrator.validateDeployVerdict({ verdict: v }), false, v)
  }
  // Positive control: the shared pass/fail set still validates.
  assert.equal(orchestrator.validateDeployVerdict({ verdict: 'fail' }), true)
  const source = readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /^const VERDICT_VALUES = new Set\(\['pass', 'fail'\]\)$/m)
})

test('metric 2: executeFailed reads the stored job view only', () => {
  assert.equal(executeFailed(null), null)
  assert.equal(executeFailed({ status: 'finished' }), null, 'no commands array is no view')
  assert.equal(executeFailed(CLEAN_JOB), false)
  // A command resumed from an earlier attempt stays done/0: passed.
  assert.equal(executeFailed({ status: 'finished', commands: [{ command: 'a', status: 'done', exit_code: 0 }] }), false)
  // Pinned: a finished job with no commands ran nothing that failed.
  assert.equal(executeFailed({ status: 'finished', commands: [] }), false)
  assert.equal(executeFailed({ ...CLEAN_JOB, status: 'budget_exceeded' }), true)
  assert.equal(executeFailed({ ...CLEAN_JOB, status: 'stopped' }), true)
  for (const status of ['stopped', 'running', 'pending']) {
    assert.equal(executeFailed({ status: 'finished', commands: [{ command: 'a', status, exit_code: null }] }), true, status)
  }
  assert.equal(executeFailed({ status: 'finished', commands: [{ command: 'a', status: 'done', exit_code: 1 }] }), true)
})

test('metric 2: every command passed but a proof is missing stores done_proof_incomplete', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, ...rest) => {
    calls.push(String(url))
    return realFetch(url, ...rest)
  }
  try {
    const row = await verifyAfter('T-DPI', CLEAN_JOB, { verdict: 'done_proof_incomplete', execute_cause: 'prereq', summary: 'Line 2: report field absent.' })
    assert.deepEqual(row, { verdict: 'fail', verify_outcome: 'done_proof_incomplete', execute_cause: null })
  } finally {
    globalThis.fetch = realFetch
  }
  // Guardrail 2: deciding the verdict asked the farm for nothing — no re-run.
  assert.deepEqual(calls.filter((url) => url.startsWith(process.env.FARM_URL)), [])
  const out = store.itemStepOutputs('T-DPI')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verifyOutcome, 'done_proof_incomplete')
  assert.equal(out.executeCause, null)
  assert.equal(out.verdict, 'fail')
})

test('metric 2: the newest Execute run decides — a failed attempt then a clean retry keeps done_proof_incomplete', async () => {
  seedExecute('T-RETRY', FAILED_JOB, 'cancelled', 1)
  const row = await verifyAfter('T-RETRY', CLEAN_JOB, { verdict: 'done_proof_incomplete', summary: 'Line 1: no proof.' })
  assert.equal(row.verify_outcome, 'done_proof_incomplete')
})

test('metric 2: a cancelled Execute run with a view counts as failed', async () => {
  const stopped = { status: 'stopped', commands: [{ command: './a.sh', status: 'stopped', exit_code: null }], logTail: [] }
  const row = await verifyAfter('T-CANCEL', stopped, { verdict: 'done_proof_incomplete', summary: 'x' }, { status: 'cancelled' })
  assert.deepEqual(row, { verdict: 'fail', verify_outcome: 'work_failed', execute_cause: 'unforeseeable' })
})

test('metric 2: with no Execute record, done_proof_incomplete stores work_failed and no cause', async () => {
  const runId = seedActiveRun('T-NOVIEW', VERIFY_REPORT_STEP_INDEX)
  await orchestrator.completeFarmRun(runId, {
    summary: 'judged',
    artifacts: { artifact_md: '## Verdict', verdict: { verdict: 'done_proof_incomplete', execute_cause: 'prereq', summary: 'x' } },
  })
  assert.deepEqual(outcomeRow(runId), { verdict: 'fail', verify_outcome: 'work_failed', execute_cause: null })
  // An Execute run that recorded no view is no record either.
  const row = await verifyAfter('T-NULLVIEW', null, { verdict: 'work_failed', execute_cause: 'prereq', summary: 'x' }, { status: 'cancelled' })
  assert.deepEqual(row, { verdict: 'fail', verify_outcome: 'work_failed', execute_cause: null })
})

test('metric 3: a failed Execute stores prereq or unforeseeable, and nothing else', async () => {
  const cause = async (id, verdict) => (await verifyAfter(id, FAILED_JOB, verdict)).execute_cause
  assert.equal(await cause('T-PREREQ', { verdict: 'work_failed', execute_cause: 'prereq', summary: '`psql` is not installed.' }), 'prereq')
  assert.equal(await cause('T-UNF', { verdict: 'work_failed', execute_cause: 'unforeseeable', summary: 'x' }), 'unforeseeable')
  assert.equal(await cause('T-BOGUS', { verdict: 'work_failed', execute_cause: 'bogus', summary: 'x' }), 'unforeseeable')
  assert.equal(await cause('T-NOCAUSE', { verdict: 'work_failed', summary: 'x' }), 'unforeseeable')
  assert.equal(await cause('T-LEGACY', { verdict: 'fail', summary: 'x' }), 'unforeseeable')
  assert.equal(await cause('T-INHERIT', { verdict: 'work_failed', execute_cause: 'constructor', summary: 'x' }), 'unforeseeable')

  assert.deepEqual(await verifyAfter('T-FPASS', FAILED_JOB, { verdict: 'pass', execute_cause: 'prereq', summary: 'tolerated' }), {
    verdict: 'pass',
    verify_outcome: 'pass',
    execute_cause: null,
  })
  assert.deepEqual(await verifyAfter('T-FDPI', FAILED_JOB, { verdict: 'done_proof_incomplete', execute_cause: 'prereq', summary: 'x' }), {
    verdict: 'fail',
    verify_outcome: 'work_failed',
    execute_cause: 'prereq',
  })
  // An Execute that did not fail carries no cause.
  assert.deepEqual(await verifyAfter('T-CLEANWF', CLEAN_JOB, { verdict: 'work_failed', execute_cause: 'prereq', summary: 'x' }), {
    verdict: 'fail',
    verify_outcome: 'work_failed',
    execute_cause: null,
  })
  const out = store.itemStepOutputs('T-PREREQ')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verifyOutcome, 'work_failed')
  assert.equal(out.executeCause, 'prereq')
})

test('metric 3: the columns refuse any other cause, and a cause beside a pass', () => {
  const runId = seedActiveRun('T-CHECK', VERIFY_REPORT_STEP_INDEX)
  const set = (outcome, cause) => db.prepare('UPDATE step_run SET verify_outcome = ?, execute_cause = ? WHERE id = ?').run(outcome, cause, runId)
  assert.throws(() => set('work_failed', 'other'), /CHECK constraint failed/)
  assert.throws(() => set('pass', 'prereq'), /CHECK constraint failed/)
  assert.throws(() => set('done_proof_incomplete', 'prereq'), /CHECK constraint failed/)
  assert.throws(() => set('other', null), /CHECK constraint failed/)
  set('work_failed', 'prereq') // control
})

test('guardrail 1: a historic fail row is byte-identical after a new run and a re-run migration, and reads work_failed', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-HIST', 'old', 'High', ?, 'task')").run(VERIFY_REPORT_STEP_INDEX + 1)
  const oldId = db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, verdict, verdict_summary) VALUES ('T-HIST', ?, 1, ?, 'done', 'old run', ?, 'fail', 'It failed.')",
    )
    .run(VERIFY_REPORT_STEP_INDEX, STEPS[VERIFY_REPORT_STEP_INDEX].agent, MDI51_ARTIFACT).lastInsertRowid
  const snapshot = () => db.prepare('SELECT * FROM step_run WHERE id = ?').get(oldId)
  const before = snapshot()
  assert.equal(before.verify_outcome, null)

  const out = store.itemStepOutputs('T-HIST')[VERIFY_REPORT_STEP_INDEX]
  assert.equal(out.verdict, 'fail', 'the stored verdict is shown as stored')
  assert.equal(out.verifyOutcome, 'work_failed')
  assert.equal(out.executeCause, null)
  assert.equal(readVerifyOutcome(before), 'work_failed')

  await verifyAfter('T-OTHER-NEW', FAILED_JOB, { verdict: 'work_failed', execute_cause: 'prereq', summary: 'x' })
  await import(`../src/db.js?ho841a=${Date.now()}`)
  await import(`../src/db.js?ho841b=${Date.now()}`)
  assert.deepEqual(snapshot(), before)
  const columns = db.prepare('PRAGMA table_info(step_run)').all().map((c) => c.name)
  assert.ok(columns.includes('verify_outcome'), 'verify_outcome exists')
  assert.ok(columns.includes('execute_cause'), 'execute_cause exists')
  assert.throws(
    () => db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, verify_outcome) VALUES ('T-HIST', ?, 2, 'QA', 'done', 'other')").run(VERIFY_REPORT_STEP_INDEX),
    /CHECK constraint failed/,
  )
})
