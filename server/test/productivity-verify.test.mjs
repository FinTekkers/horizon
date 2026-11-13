// HO-841: the Verify verdict report. GET /api/admin/productivity/verify takes
// a start date and N, and lists the first N Tasks closed strictly after that
// date, in close order, each with its newest Verify verdict and Execute cause,
// plus the verdict and cause totals beside firstPassYield over the same Tasks.
// Metric 5: rework().firstPassYield over existing pass/fail data is the value
// it had before this change — this file's first test was run on the base
// commit, before any production change, so its constant is the old value.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { loginFixtureUser } from './helpers/session.mjs'
import { validate } from '../../domain/validate.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-productivity-verify-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { productivityReport, verifyVerdictReport } = await import('../src/productivity.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { STEPS, endIndex, kindStepIndex, EXECUTE_STEP_INDEX, VERIFY_REPORT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers })
const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/productivityVerify.schema.json'), 'utf8'))
const URL_PATH = '/api/admin/productivity/verify'

const TASK_DONE = endIndex('task')
const APPROVE_RUN = kindStepIndex('Approve the run', 'task')
const NOW = Date.parse('2026-10-24T12:00:00Z')

const project = (name) => db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid

function task(id, projectId, { kind = 'task', cursor = TASK_DONE, abandoned = false } = {}) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, abandoned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    id,
    'Medium',
    cursor,
    kind,
    projectId,
    'acme/x',
    abandoned ? '2026-10-18 13:00:00' : null,
  )
}
// A done Verify run storing only the HZ-429 pass/fail column, as every run
// before HO-841 did.
const legacyVerify = (itemId, verdict, at) =>
  db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, ended_at, verdict) VALUES (?, ?, 1, ?, 'done', ?, ?, ?)")
    .run(itemId, VERIFY_REPORT_STEP_INDEX, STEPS[VERIFY_REPORT_STEP_INDEX].agent, at, at, verdict).lastInsertRowid
const decide = (itemId, stepIndex, decision, at) =>
  db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, created_at) VALUES (?, ?, ?, ?)').run(itemId, stepIndex, decision, at)
const event = (itemId, who, text, at) =>
  db.prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, ?, ?, '#000', 'X', ?)").run(itemId, who, text, at)
const close = (itemId, at) => decide(itemId, TASK_DONE - 1, 'approved', at)

// ---- metric 5: firstPassYield over existing pass/fail data ----

// Four Tasks closed in the window: L1 clean (pass), L2 sent back once (fail),
// L3 one failed automated review (fail), L4 clean (fail). Two of four have no
// send-back and no review fail: 0.5. L5 is abandoned and counts nowhere.
const LEGACY = project('Legacy')
const LEGACY_VERIFY = {}
task('L1', LEGACY)
LEGACY_VERIFY.L1 = legacyVerify('L1', 'pass', '2026-10-19 10:00:00')
close('L1', '2026-10-19 12:00:00')
task('L2', LEGACY)
decide('L2', APPROVE_RUN, 'rejected', '2026-10-19 09:00:00')
LEGACY_VERIFY.L2 = legacyVerify('L2', 'fail', '2026-10-20 10:00:00')
close('L2', '2026-10-20 12:00:00')
task('L3', LEGACY)
event('L3', 'Review', 'automated review failed (cycle 1/3) — sent back', '2026-10-21 08:00:00')
LEGACY_VERIFY.L3 = legacyVerify('L3', 'fail', '2026-10-21 10:00:00')
close('L3', '2026-10-21 12:00:00')
task('L4', LEGACY)
LEGACY_VERIFY.L4 = legacyVerify('L4', 'fail', '2026-10-22 10:00:00')
close('L4', '2026-10-22 12:00:00')
task('L5', LEGACY, { abandoned: true })
legacyVerify('L5', 'pass', '2026-10-17 10:00:00')
close('L5', '2026-10-17 12:00:00')

const LEGACY_FIRST_PASS_YIELD = 0.5
const legacyYield = () => productivityReport({ range: '7d', project: String(LEGACY) }, { now: NOW }).rework.firstPassYield

test('metric 5: firstPassYield over existing pass/fail Verify data is its pre-change value', () => {
  assert.equal(legacyYield(), LEGACY_FIRST_PASS_YIELD)
})

test('metric 5: still the same value once those rows also carry an HO-841 outcome and cause', () => {
  const set = db.prepare('UPDATE step_run SET verify_outcome = ?, execute_cause = ? WHERE id = ?')
  set.run('pass', null, LEGACY_VERIFY.L1)
  set.run('work_failed', 'prereq', LEGACY_VERIFY.L2)
  set.run('done_proof_incomplete', null, LEGACY_VERIFY.L3)
  set.run('work_failed', 'unforeseeable', LEGACY_VERIFY.L4)
  assert.equal(legacyYield(), LEGACY_FIRST_PASS_YIELD)
})

// ---- metric 4: the cohort report ----

// A Verify run as HO-841 stores it: the coarse verdict, the outcome, a cause.
const verifyRun = (itemId, outcome, cause = null, status = 'done') =>
  db
    .prepare(
      'INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, ended_at, verdict, verify_outcome, execute_cause) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      itemId,
      VERIFY_REPORT_STEP_INDEX,
      STEPS[VERIFY_REPORT_STEP_INDEX].agent,
      status,
      '2026-10-01 01:00:00',
      '2026-10-01 01:00:00',
      outcome === 'pass' ? 'pass' : 'fail',
      outcome,
      cause,
    )

const COHORT = project('Cohort')
const SINCE = '2026-10-01'
// C0 closed exactly at SINCE 00:00:00: not after it, so not counted.
task('C0', COHORT)
verifyRun('C0', 'pass')
close('C0', '2026-10-01 00:00:00')
task('C1', COHORT)
verifyRun('C1', 'pass')
close('C1', '2026-10-02 09:00:00')
// C2 and C3 close in the same second: by id, though C3's close is written first.
task('C3', COHORT)
verifyRun('C3', 'work_failed', 'prereq')
decide('C3', APPROVE_RUN, 'rejected', '2026-10-02 10:00:00') // a send-back
close('C3', '2026-10-03 10:00:00')
task('C2', COHORT)
legacyVerify('C2', 'fail', '2026-10-02 11:00:00')
verifyRun('C2', 'pass') // the newest done run wins
verifyRun('C2', 'work_failed', null, 'cancelled') // a later run that never finished does not
close('C2', '2026-10-03 10:00:00')
// C4: a historic fail with no outcome reads work_failed, in neither cause total.
task('C4', COHORT)
legacyVerify('C4', 'fail', '2026-10-03 11:00:00')
event('C4', 'Review', 'automated review cap reached — forwarded to the gate', '2026-10-03 12:00:00')
close('C4', '2026-10-04 08:00:00')
// C5: closed with no Verify run.
task('C5', COHORT)
close('C5', '2026-10-05 08:00:00')
// C6: closed on GitHub.
task('C6', COHORT)
verifyRun('C6', 'work_failed', 'unforeseeable')
event('C6', 'GitHub', 'closed issue #6', '2026-10-06 08:00:00')
task('C7', COHORT)
verifyRun('C7', 'done_proof_incomplete')
close('C7', '2026-10-07 08:00:00')
// Never in the cohort: an abandoned Task, a Plan and a change closed after SINCE.
task('CX', COHORT, { abandoned: true })
verifyRun('CX', 'pass')
close('CX', '2026-10-02 08:00:00')
task('CP', COHORT, { kind: 'plan', cursor: endIndex('plan') })
decide('CP', endIndex('plan') - 1, 'approved', '2026-10-02 08:00:00')
task('CC', COHORT, { kind: 'change', cursor: endIndex('change') })
event('CC', 'GitHub', 'closed issue #9', '2026-10-02 08:00:00')

const cohortReport = (n) => verifyVerdictReport({ since: SINCE, n, project: String(COHORT) })

test('metric 4: n = 3 is exactly the first 3 Tasks closed after since, in close order, with totals beside firstPassYield', () => {
  const report = cohortReport(3)
  assert.deepEqual(validate(schema, report), [])
  assert.deepEqual(report.tasks, [
    { id: 'C1', closedAt: '2026-10-02 09:00:00', verdict: 'pass', executeCause: null },
    { id: 'C2', closedAt: '2026-10-03 10:00:00', verdict: 'pass', executeCause: null },
    { id: 'C3', closedAt: '2026-10-03 10:00:00', verdict: 'work_failed', executeCause: 'prereq' },
  ])
  assert.equal(report.returned, 3)
  assert.deepEqual(report.totals, {
    verdicts: { pass: 2, work_failed: 1, done_proof_incomplete: 0, none: 0 },
    executeCauses: { prereq: 1, unforeseeable: 0 },
  })
  assert.equal(report.prereqShare, 1)
  // C3 was sent back: 2 of these 3.
  assert.equal(report.firstPassYield, 0.6667)
})

test('metric 4: fewer than n Tasks closed since lists them all; historic fail and no-Verify rows count as known', () => {
  const report = cohortReport(10)
  assert.deepEqual(validate(schema, report), [])
  assert.equal(report.n, 10)
  assert.equal(report.returned, 7)
  assert.deepEqual(
    report.tasks.map((t) => [t.id, t.verdict, t.executeCause]),
    [
      ['C1', 'pass', null],
      ['C2', 'pass', null],
      ['C3', 'work_failed', 'prereq'],
      ['C4', 'work_failed', null],
      ['C5', null, null],
      ['C6', 'work_failed', 'unforeseeable'],
      ['C7', 'done_proof_incomplete', null],
    ],
  )
  assert.deepEqual(report.totals, {
    verdicts: { pass: 2, work_failed: 3, done_proof_incomplete: 1, none: 1 },
    executeCauses: { prereq: 1, unforeseeable: 1 },
  })
  assert.equal(report.prereqShare, 0.5)
  // C3 sent back, C4 one failed review: 5 of these 7 — this cohort only.
  assert.equal(report.firstPassYield, 0.7143)
})

test('metric 4 journey: a Verify finalized through the farm path shows in the report row', async () => {
  task('J1', COHORT, { cursor: EXECUTE_STEP_INDEX })
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, job_view) VALUES ('J1', ?, 1, ?, 'done', ?)").run(
    EXECUTE_STEP_INDEX,
    STEPS[EXECUTE_STEP_INDEX].agent,
    JSON.stringify({ status: 'finished', commands: [{ command: 'psql -f fix.sql', status: 'done', exit_code: 127 }], logTail: [] }),
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(VERIFY_REPORT_STEP_INDEX, 'J1')
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('J1', ?, 1, ?, 'active')")
    .run(VERIFY_REPORT_STEP_INDEX, STEPS[VERIFY_REPORT_STEP_INDEX].agent).lastInsertRowid
  const done = await orchestrator.completeFarmRun(runId, {
    summary: 'command 1 exited 127',
    artifacts: { artifact_md: '## Verdict', verdict: { verdict: 'work_failed', execute_cause: 'prereq', summary: '`psql` is not installed.' } },
  })
  assert.deepEqual(done, { ok: true })
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(TASK_DONE, 'J1')
  close('J1', '2026-10-09 12:00:00')

  const res = await get(`${URL_PATH}?since=2026-10-08&n=5&project=${COHORT}`, { cookie: admin.cookie })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(validate(schema, body), [])
  assert.deepEqual(body.tasks, [{ id: 'J1', closedAt: '2026-10-09 12:00:00', verdict: 'work_failed', executeCause: 'prereq' }])
  assert.deepEqual(body.totals.executeCauses, { prereq: 1, unforeseeable: 0 })
  assert.equal(body.firstPassYield, 1)
  // Guardrail 4: the summary's evidence text never leaves through the report.
  assert.doesNotMatch(res.body, /psql/)
})

test('metric 4 route: owner 200 valid against the schema, query echoed, n defaulted', async () => {
  const res = await get(`${URL_PATH}?since=${SINCE}&project=${COHORT}`, { cookie: admin.cookie })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(validate(schema, body), [])
  assert.deepEqual([body.since, body.n, body.project], [SINCE, 50, String(COHORT)])
  assert.equal(body.tasks[0].id, 'C1')
})

test('metric 4 route: a bad or missing since, or n out of range, is a 400', async () => {
  for (const query of ['since=yesterday', '', `since=${SINCE}&n=0`, `since=${SINCE}&n=501`, `since=${SINCE}&n=1.5`]) {
    const res = await get(`${URL_PATH}?${query}`, { cookie: admin.cookie })
    assert.equal(res.statusCode, 400, `${query}: ${res.body}`)
  }
})

test('metric 4 route: a non-owner session gets 404, an API token 403, no login 401', async () => {
  const url = `${URL_PATH}?since=${SINCE}`
  const member = loginFixtureUser(auth, config, { email: 'ho841-member@example.com', name: 'Member', role: 'member' })
  const asMember = await get(url, { cookie: member.cookie })
  assert.equal(asMember.statusCode, 404, asMember.body)
  assert.deepEqual(asMember.json(), { error: 'not_found' })

  const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: admin.cookie }, payload: { name: 'ho841-bot' } })
  assert.equal(created.statusCode, 201, created.body)
  const asToken = await get(url, { authorization: `Bearer ${created.json().token}` })
  assert.equal(asToken.statusCode, 403, asToken.body)
  assert.deepEqual(asToken.json(), { error: 'session_required' })

  const anonymous = await get(url)
  assert.equal(anonymous.statusCode, 401, anonymous.body)
  assert.deepEqual(anonymous.json(), { error: 'login_required' })
})
