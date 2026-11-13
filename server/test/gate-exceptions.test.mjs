// HO-844: Accept with exceptions at a Task's Review & close.
//
// A Task whose stored Verify outcome is done_proof_incomplete may be closed
// by a human with the gate PIN, naming each open metric line with a reason.
// Driven through the real route (POST /api/items/:id/gate/accept-with-
// exceptions) on a real buildApp(), with GitHub stubbed where an issue is
// closed. Each case seeds its own item, so the cases are independent.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureToken, loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gate-exceptions-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = 'gate-exceptions-secret'
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.FARM_URL
delete process.env.HORIZON_TEST_HOOKS

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const { readVerifyOutcome } = await import('../src/verifyOutcome.js')
const { STEPS, TASK_REVIEW_CLOSE_GATE_INDEX, VERIFY_REPORT_STEP_INDEX, EXECUTE_STEP_INDEX, endIndex, firstStepIndex, stepKeyAt, acceptsWithExceptions } =
  await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Dana Owner' })
const asOwner = { cookie: owner.cookie, 'x-human-key': owner.pin }

const REPO = 'acme/gate-exceptions'
const { id: projectId } = store.createProject('HO-844 fixture project')
assert.ok(store.addRepoToProject(projectId, REPO).ok)

const GATE = TASK_REVIEW_CLOSE_GATE_INDEX
const FROM = stepKeyAt(GATE)
const URL_OF = (id) => `/api/items/${id}/gate/accept-with-exceptions`
const LINES = ['The backfill exits 0.', 'Every row has a region.', 'The report lists the totals.']
const METRIC = LINES.map((line, i) => `${i + 1}. ${line}`).join('\n')

let seq = 0
// A Task at Review & close (or `cursor`) whose newest Verify run stored
// `outcome`, naming `openLines` when given. Optionally with a repo issue.
function seedTask({ outcome = 'done_proof_incomplete', openLines = [2, 3], kind = 'task', cursor = null, issue = null, metric = METRIC } = {}) {
  const id = `GX-${++seq}`
  const at = cursor ?? (kind === 'task' ? GATE : endIndex(kind) - 1)
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, kind, metric, project_id, repo, issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `Fixture ${id}`, 'Medium', at, kind, metric, projectId, issue == null ? null : REPO, issue)
  if (kind === 'task' && outcome) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, verdict, verify_outcome, verify_open_lines) VALUES (?, ?, 1, 'QA', 'done', ?, ?, ?)",
    ).run(id, VERIFY_REPORT_STEP_INDEX, outcome === 'pass' ? 'pass' : 'fail', outcome, openLines ? JSON.stringify(openLines) : null)
  }
  return id
}

const offerOf = (id) => store.itemViewById(id).acceptWithExceptions ?? null
const exceptionRows = (id) => db.prepare('SELECT * FROM gate_exception WHERE item_id = ? ORDER BY id').all(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const decisions = (id) => db.prepare('SELECT * FROM gate_decision WHERE item_id = ? ORDER BY id').all(id)
const validBody = (id, reasons = { 2: 'Checked by hand in the SQL console.', 3: 'The report needs the staging login.' }) => ({
  from: FROM,
  linesHash: offerOf(id).linesHash,
  exceptions: Object.entries(reasons).map(([lineId, reason]) => ({ lineId, reason })),
})
const accept = (id, payload, headers = asOwner) => app.inject({ method: 'POST', url: URL_OF(id), headers, payload })

// The item is still open at the gate, with no exception and no decision.
function assertUntouched(id, cursor = GATE) {
  assert.equal(cursorOf(id), cursor)
  assert.deepEqual(exceptionRows(id), [])
  assert.deepEqual(decisions(id), [])
}

function stubGithub({ patchStatus = 200 } = {}) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const status = opts.method === 'PATCH' ? patchStatus : 200
    return { ok: status < 400, status, json: async () => ({}), text: async () => '' }
  }
  return () => (globalThis.fetch = realFetch)
}

function issuesWebhook(issue, state) {
  const body = JSON.stringify({
    action: state === 'closed' ? 'closed' : 'reopened',
    repository: { full_name: REPO },
    issue: { number: issue, title: 'Fixture', body: '', state, labels: [] },
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', 'gate-exceptions-secret').update(body).digest('hex')
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sig },
    payload: body,
  })
}

// ---- metric 1: offered only for done_proof_incomplete ----

test('the domain flag sits on the Task Review & close gate only', () => {
  assert.equal(STEPS[GATE].key, 'task.review-close')
  assert.equal(STEPS[GATE].acceptWithExceptions, true)
  assert.equal(STEPS[GATE].sendBackTo, 'task.verify-report', 'sendBackTo is unchanged')
  assert.deepEqual(
    STEPS.map((_, i) => i).filter(acceptsWithExceptions),
    [GATE],
  )
})

test('metric 1: offered for done_proof_incomplete with the named lines; absent for pass, work_failed and other kinds', () => {
  const offer = offerOf(seedTask())
  assert.deepEqual(offer.openLines, [
    { id: '2', text: LINES[1] },
    { id: '3', text: LINES[2] },
  ])
  assert.match(offer.linesHash, /^[0-9a-f]{64}$/)
  assert.equal(offerOf(seedTask({ outcome: 'pass' })), null)
  assert.equal(offerOf(seedTask({ outcome: 'work_failed' })), null)
  // An old `fail` row with no outcome reads as work_failed.
  const legacy = seedTask({ outcome: null })
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, verdict) VALUES (?, ?, 1, 'QA', 'done', 'fail')").run(legacy, VERIFY_REPORT_STEP_INDEX)
  assert.equal(offerOf(legacy), null)
  assert.equal(offerOf(seedTask({ kind: 'change' })), null)
  assert.equal(offerOf(seedTask({ kind: 'plan' })), null)
  assert.equal(offerOf(seedTask({ cursor: EXECUTE_STEP_INDEX })), null)
})

test('metric 1: a done_proof_incomplete run that named no lines (or none still in the metric) leaves every metric line open', () => {
  for (const openLines of [null, [7, 9]]) {
    assert.deepEqual(
      offerOf(seedTask({ openLines })).openLines.map((l) => l.id),
      ['1', '2', '3'],
      JSON.stringify(openLines),
    )
  }
})

test('metric 1: Verify keeps the open lines only on done_proof_incomplete', () => {
  const norm = (raw, executeFailed = false) => orchestrator.normalizeVerifyVerdict(raw, 'x', { executeFailed })
  assert.deepEqual(norm({ verdict: 'done_proof_incomplete', open_lines: [3, 2, 2, 0, 'x', 1.5] }).openLines, [2, 3])
  assert.equal(norm({ verdict: 'done_proof_incomplete' }).openLines, undefined)
  assert.equal(norm({ verdict: 'pass', open_lines: [1] }).openLines, undefined)
  assert.equal(norm({ verdict: 'work_failed', open_lines: [1] }, true).openLines, undefined)
  // Downgraded to work_failed when Execute's record is not clean: no lines.
  assert.equal(norm({ verdict: 'done_proof_incomplete', open_lines: [1] }, null).openLines, undefined)
})

test('metric 1: a farm Verify reply stores its open lines beside the outcome', async () => {
  const id = seedTask({ outcome: null, cursor: EXECUTE_STEP_INDEX })
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, job_view) VALUES (?, ?, 1, 'DevOps', 'done', ?)").run(
    id,
    EXECUTE_STEP_INDEX,
    JSON.stringify({ status: 'finished', commands: [{ command: './run.sh', status: 'done', exit_code: 0 }], logTail: [] }),
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(VERIFY_REPORT_STEP_INDEX, id)
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'QA', 'active')")
    .run(id, VERIFY_REPORT_STEP_INDEX).lastInsertRowid
  const verdict = { verdict: 'done_proof_incomplete', summary: 'Line 3 has no proof.', open_lines: [3] }
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'judged', artifacts: { artifact_md: '## Verdict', verdict } }), { ok: true })
  const row = db.prepare('SELECT verify_outcome, verify_open_lines FROM step_run WHERE id = ?').get(runId)
  assert.deepEqual(row, { verify_outcome: 'done_proof_incomplete', verify_open_lines: '[3]' })
  assert.deepEqual(offerOf(id).openLines, [{ id: '3', text: LINES[2] }])
})

// ---- metric 2: refusals leave the item open ----

test('metric 2: a missing line, an empty reason and whitespace-only reasons are refused with 400; nothing is written', async () => {
  const id = seedTask()
  const body = validBody(id)
  const cases = [
    ['a missing line', { ...body, exceptions: body.exceptions.slice(0, 1) }, 'exceptions_mismatch'],
    ['an empty reason', { ...body, exceptions: [body.exceptions[0], { lineId: '3', reason: '' }] }, null],
    ['a spaces-only reason', { ...body, exceptions: [body.exceptions[0], { lineId: '3', reason: '   ' }] }, 'reason_blank'],
    ['a tab-only reason', { ...body, exceptions: [body.exceptions[0], { lineId: '3', reason: '\t\t' }] }, 'reason_blank'],
    ['a newline-only reason', { ...body, exceptions: [{ lineId: '2', reason: '\n\r\n' }, body.exceptions[1]] }, 'reason_blank'],
  ]
  for (const [what, payload, error] of cases) {
    const res = await accept(id, payload)
    assert.equal(res.statusCode, 400, `${what}: ${res.body}`)
    if (error) assert.equal(res.json().error, error, what)
    assertUntouched(id)
  }
})

test('metric 2: an unknown, extra or duplicate lineId is refused with 400 exceptions_mismatch; nothing is written', async () => {
  const id = seedTask()
  const body = validBody(id)
  const [two, three] = body.exceptions
  const cases = [
    ['unknown', [two, { lineId: '1', reason: 'line 1 was proven' }]],
    ['extra', [two, three, { lineId: '1', reason: 'line 1 was proven' }]],
    ['duplicate', [two, { ...two, reason: 'again' }]],
  ]
  for (const [what, exceptions] of cases) {
    const res = await accept(id, { ...body, exceptions })
    assert.equal(res.statusCode, 400, `${what}: ${res.body}`)
    assert.equal(res.json().error, 'exceptions_mismatch', what)
    assertUntouched(id)
  }
})

// ---- metric 3: a valid accept closes and stores every exception ----

test('metric 3: a valid accept closes the item; the API lists every line and reason; the decision is approved; the verdict is unchanged', async () => {
  const id = seedTask()
  const res = await accept(id, validBody(id))
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.closed, true)
  assert.equal(cursorOf(id), endIndex('task'))

  const expected = [
    ['2', LINES[1], 'Checked by hand in the SQL console.'],
    ['3', LINES[2], 'The report needs the staging login.'],
  ]
  const shape = (list) => list.map((e) => [e.lineId, e.metricLine, e.reason])
  assert.deepEqual(shape(body.item.exceptions), expected)
  const listed = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: owner.cookie } })).json().items.find((it) => it.id === id)
  assert.deepEqual(shape(listed.exceptions), expected)
  assert.ok(listed.exceptions.every((e) => e.decidedBy === 'Dana Owner' && e.decisionId === listed.exceptions[0].decisionId))
  assert.equal(listed.acceptWithExceptions, undefined, 'no longer offered once closed')

  const [decision] = decisions(id)
  assert.equal(decision.decision, 'approved')
  assert.equal(decision.step_index, GATE)
  assert.ok(exceptionRows(id).every((row) => row.gate_decision_id === decision.id))
  const run = db.prepare('SELECT verdict, verify_outcome FROM step_run WHERE item_id = ? AND step_index = ?').get(id, VERIFY_REPORT_STEP_INDEX)
  assert.equal(readVerifyOutcome(run), 'done_proof_incomplete')
  assert.equal(run.verdict, 'fail')
  const events = db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
  assert.ok(events.includes('accepted with 2 exceptions: metric lines 2, 3'), events.join('\n'))
})

test('metric 3: a failed GitHub issue close answers 502, writes no rows and leaves the item open', async () => {
  const id = seedTask({ issue: 4401 })
  const restore = stubGithub({ patchStatus: 403 })
  try {
    const res = await accept(id, validBody(id))
    assert.equal(res.statusCode, 502, res.body)
  } finally {
    restore()
  }
  assertUntouched(id)
})

// ---- guardrail 1: a browser session with the gate PIN only; Task items only ----

test('guardrail 1: an API token, a session with no PIN and a cross-site request are refused; nothing is written', async () => {
  const id = seedTask()
  const body = validBody(id)
  const token = loginFixtureToken(auth, owner.user)
  const viaToken = await accept(id, body, { ...token.headers, 'x-human-key': owner.pin })
  assert.equal(viaToken.statusCode, 401, viaToken.body)
  assert.equal(viaToken.json().error, 'human_gate_key_required')

  const freshSession = `${config.SESSION_COOKIE_NAME}=${auth.createSession(owner.user.id)}`
  const noPin = await accept(id, body, { cookie: freshSession, 'x-horizon-csrf': '1' })
  assert.equal(noPin.statusCode, 401, noPin.body)
  assert.equal(noPin.json().error, 'human_gate_key_required')

  const crossSite = await accept(id, body, { ...asOwner, origin: 'https://evil.example' })
  assert.equal(crossSite.statusCode, 403, crossSite.body)
  assert.equal(crossSite.json().error, 'cross_site_refused')
  assertUntouched(id)
})

test('guardrail 1: a direct store call with no proof is refused, and an Autopilot approve writes no exceptions', async () => {
  const id = seedTask()
  const { exceptions, linesHash } = validBody(id)
  assert.deepEqual(store.approveGate(id, GATE, '', 'Autopilot', { exceptions: { exceptions, linesHash } }), { error: 'human_pin_required' })
  assertUntouched(id)

  // Autopilot (caretakerActor) and WhatsApp approve through gateActions.approve
  // with no human proof: a plain approve, never one with exceptions.
  const result = await app.gateActions.approve(id, GATE, '', 'Autopilot')
  assert.equal(result.ok, true)
  assert.equal(cursorOf(id), endIndex('task'))
  assert.deepEqual(exceptionRows(id), [])
})

test('guardrail 1: the concierge has no tool that reaches Accept with exceptions', () => {
  const concierge = readFileSync(join(REPO_ROOT, 'farm/concierge_agent.py'), 'utf8')
  assert.doesNotMatch(concierge, /accept-with-exceptions|acceptWithExceptions|accept_with_exceptions/)
  assert.deepEqual(Object.keys(app.gateActions).sort(), ['approve', 'resolveConflicts', 'sendBack'])
})

test('guardrail 1: the route refuses work_failed, Change and Plan items, and a Task not at the gate, with 409', async () => {
  const cases = [
    ['work_failed', seedTask({ outcome: 'work_failed' }), 'verdict_not_incomplete'],
    ['pass', seedTask({ outcome: 'pass' }), 'verdict_not_incomplete'],
    ['a Change', seedTask({ kind: 'change' }), 'not_task_item'],
    ['a Plan', seedTask({ kind: 'plan' }), 'not_task_item'],
  ]
  const payload = { from: FROM, linesHash: 'a'.repeat(64), exceptions: [{ lineId: '2', reason: 'r' }] }
  for (const [what, id, error] of cases) {
    const cursor = cursorOf(id)
    const res = await accept(id, payload)
    assert.equal(res.statusCode, 409, `${what}: ${res.body}`)
    assert.equal(res.json().error, error, what)
    assertUntouched(id, cursor)
  }
  // A Task at Execute: the page's step is its own, so only the gate check refuses.
  const early = seedTask({ cursor: EXECUTE_STEP_INDEX })
  const res = await accept(early, { ...payload, from: stepKeyAt(EXECUTE_STEP_INDEX) })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error, 'not_at_gate')
  assertUntouched(early, EXECUTE_STEP_INDEX)
})

// ---- guardrail 2: the server never trusts a client verdict or line list ----

test('guardrail 2: a body carrying a verdict or open lines is refused with 400; a stale open-lines hash with 409', async () => {
  const id = seedTask()
  const body = validBody(id)
  for (const extra of [{ verdict: 'done_proof_incomplete' }, { openLines: [{ id: '2', text: 'x' }] }]) {
    const res = await accept(id, { ...body, ...extra })
    assert.equal(res.statusCode, 400, `${JSON.stringify(extra)}: ${res.body}`)
    assertUntouched(id)
  }
  const extraKey = await accept(id, { ...body, exceptions: [{ ...body.exceptions[0], text: 'mine' }, body.exceptions[1]] })
  assert.equal(extraKey.statusCode, 400, extraKey.body)

  const stale = await accept(id, { ...body, linesHash: 'f'.repeat(64) })
  assert.equal(stale.statusCode, 409, stale.body)
  assert.equal(stale.json().error, 'open_lines_changed')
  // The metric changed since the page loaded: the hash it showed is stale.
  db.prepare('UPDATE work_item SET metric = ? WHERE id = ?').run(METRIC.replace(LINES[1], 'Every row has a region code.'), id)
  const edited = await accept(id, body)
  assert.equal(edited.statusCode, 409, edited.body)
  assert.equal(edited.json().error, 'open_lines_changed')
  assertUntouched(id)
})

// ---- guardrail 4: the exceptions never change once closed ----

test('guardrail 4: a direct UPDATE or DELETE aborts, a second POST is 409, and reopen then re-close leave the rows unchanged', async () => {
  const id = seedTask({ issue: 4402 })
  let restore = stubGithub()
  try {
    assert.equal((await accept(id, validBody(id))).statusCode, 200)
  } finally {
    restore()
  }
  const before = exceptionRows(id)
  assert.equal(before.length, 2)

  assert.throws(() => db.prepare("UPDATE gate_exception SET reason = 'edited' WHERE item_id = ?").run(id), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM gate_exception WHERE item_id = ?').run(id), /append-only/)

  const again = await accept(id, { from: FROM, linesHash: 'a'.repeat(64), exceptions: [{ lineId: '2', reason: 'again' }] })
  assert.equal(again.statusCode, 409, again.body)
  assert.deepEqual(exceptionRows(id), before)

  // Reopened on GitHub (the item starts over), then closed on GitHub again.
  assert.equal((await issuesWebhook(4402, 'open')).statusCode, 204)
  assert.equal(cursorOf(id), firstStepIndex('task'))
  orchestrator.cancel(id, 'cancelled')
  assert.equal((await issuesWebhook(4402, 'closed')).statusCode, 204)
  assert.equal(cursorOf(id), endIndex('task'))
  assert.deepEqual(exceptionRows(id), before)
  const listed = store.itemViewById(id).exceptions.map((e) => e.id)
  assert.deepEqual(listed, before.map((row) => row.id))
})

// ---- metric 4: its own bucket in /api/admin/productivity ----

test('metric 4: the productivity route counts an accept with exceptions in its own bucket, never in pass', async () => {
  const report = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/admin/productivity?range=7d&project=${projectId}`, headers: { cookie: owner.cookie } })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().summary
  }
  const start = await report()
  assert.equal(start.closedOutcomes.pass + start.closedOutcomes.acceptedWithExceptions, start.closed)

  const excepted = seedTask()
  assert.equal((await accept(excepted, validBody(excepted))).statusCode, 200)
  const afterExcepted = await report()
  assert.equal(afterExcepted.closedOutcomes.acceptedWithExceptions, start.closedOutcomes.acceptedWithExceptions + 1)
  assert.equal(afterExcepted.closedOutcomes.pass, start.closedOutcomes.pass, 'not counted in pass')
  assert.equal(afterExcepted.closed, start.closed + 1)

  // A plain approve of the same verdict counts in pass.
  const plain = seedTask()
  const move = await app.inject({ method: 'POST', url: `/api/items/${plain}/move`, headers: asOwner, payload: { action: 'approve', from: FROM } })
  assert.equal(move.statusCode, 200, move.body)
  const afterPlain = await report()
  assert.equal(afterPlain.closedOutcomes.pass, afterExcepted.closedOutcomes.pass + 1)
  assert.equal(afterPlain.closedOutcomes.acceptedWithExceptions, afterExcepted.closedOutcomes.acceptedWithExceptions)
})

test('metric 4: accepted with exceptions, reopened, then closed on GitHub counts in pass', async () => {
  const id = seedTask({ issue: 4403 })
  const restore = stubGithub()
  try {
    assert.equal((await accept(id, validBody(id))).statusCode, 200)
  } finally {
    restore()
  }
  const report = async () =>
    (await app.inject({ method: 'GET', url: `/api/admin/productivity?range=7d&project=${projectId}`, headers: { cookie: owner.cookie } })).json()
      .summary.closedOutcomes
  const accepted = await report()
  // The accept happened a minute before the GitHub close below, so the
  // counted close (the latest) is GitHub's, never the excepted decision.
  db.prepare("UPDATE gate_decision SET created_at = datetime('now', '-1 minute') WHERE item_id = ?").run(id)
  assert.equal((await issuesWebhook(4403, 'open')).statusCode, 204)
  orchestrator.cancel(id, 'cancelled')
  assert.equal((await issuesWebhook(4403, 'closed')).statusCode, 204)
  assert.equal(cursorOf(id), endIndex('task'))
  const reclosed = await report()
  assert.equal(reclosed.acceptedWithExceptions, accepted.acceptedWithExceptions - 1)
  assert.equal(reclosed.pass, accepted.pass + 1)
  assert.equal(exceptionRows(id).length, 2, 'the exceptions themselves stay')
})
