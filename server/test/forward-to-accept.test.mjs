// HZ-185: a human with the gate PIN forwards an item the latest automated
// review just rejected to Accept the code, with that failing verdict attached,
// instead of another implement cycle. These drive the real Fastify route
// against a fake farmd and a fake GitHub (both through globalThis.fetch), with
// the rejection itself produced by the real finalizeReviewStep via
// completeFarmRun — so the state being forwarded is exactly what review leaves.
//
// The real HZ-179 API-token case can't be written until API tokens exist; the
// Bearer-header case below stands in for it.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-forward-to-accept-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
// HZ-304: implement and deploy dispatches need a ready repo; readiness itself
// is orchestrator-readiness.test.mjs's subject.
connectReadyRepo(db, 'acme/demo')

const app = buildApp({ logger: false })
const { user, pin, cookie } = loginFixtureUser(auth, config)

const IMPLEMENT_AGENT = STEPS[IMPLEMENT_STEP_INDEX].agent
const REVIEWED_SHA = 'sha-reviewed'
const SUFFIX_RE = / — forwarded to the human gate with the failing verdict attached \(review run #\d+\)$/

// ---- fakes ----
// GitHub: PR head per PR number (a string, or an Error for a failed read).
// farmd: every /steps/cancel is recorded, and cancelHook can hold it open or
// "push" a commit before it resolves. `order` records cancel-ack vs head-read.
let prHeads = {}
let githubCalls = []
let farmCancels = []
let farmDispatches = []
let cancelHook = null
let order = []
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  if (url.startsWith('https://api.github.com/')) {
    githubCalls.push({ url, method: opts.method || 'GET' })
    const m = url.match(/\/pulls\/(\d+)$/)
    if (m) {
      order.push('head-read')
      const head = prHeads[m[1]]
      if (head instanceof Error) return { ok: false, status: 502, json: async () => ({}) }
      return ok({ head: { sha: head } })
    }
    return ok({})
  }
  if (url.endsWith('/steps/cancel')) {
    const body = JSON.parse(opts.body)
    farmCancels.push(body)
    if (cancelHook) await cancelHook(body)
    order.push('cancel-ack')
    return ok({ ok: true })
  }
  if (url.endsWith('/steps/run')) farmDispatches.push(JSON.parse(opts.body))
  return ok({})
}

function resetFakes() {
  githubCalls = []
  farmCancels = []
  farmDispatches = []
  cancelHook = null
  order = []
}

const FAIL_VERDICT = {
  code_review: { verdict: 'fail', findings: [{ file: 'server/src/x.js', line: 7, severity: 'block', detail: 'unchecked input' }] },
  qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
}

const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, repo, pr, issue, review_cycle_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
)

// Runs one real failing review on a fresh item. Returns the review run id.
async function failReview(id, { pr = null, repo = pr == null ? null : 'acme/demo', issue = null, cycles = 0, artifact } = {}) {
  insertItem.run(id, `Item ${id}`, 'Medium', REVIEW_STEP_INDEX, repo, pr, issue, cycles)
  if (pr != null) prHeads[pr] = REVIEWED_SHA
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, REVIEW_STEP_INDEX, cycles + 1, STEPS[REVIEW_STEP_INDEX].agent).lastInsertRowid
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'review failed',
    artifacts: { artifact_md: artifact || `## Findings for ${id}\n- unchecked input`, verdict: FAIL_VERDICT, reviewed_sha: REVIEWED_SHA },
  })
  assert.deepEqual(result, { ok: true })
  return Number(runId)
}

// A rejected item with its implement run already going: the rejection's own
// kick() dispatched it to the (fake) farm, which marked the findings
// delivered exactly as production does.
async function rejectedWithRun(id, opts) {
  const reviewRunId = await failReview(id, opts)
  const implementRunId = activeImplementRun(id)
  assert.ok(implementRunId, 'the rejection started an implement run')
  resetFakes()
  return { reviewRunId, implementRunId }
}

const activeImplementRun = (id) =>
  db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, IMPLEMENT_STEP_INDEX)?.id

const forwardPost = (id, headers = { 'x-human-key': pin }) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/forward-to-accept`, payload: {}, headers: { cookie, ...headers } })
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const events = (id) => db.prepare('SELECT who, text, color, initials FROM event WHERE item_id = ? ORDER BY id').all(id)
const lastEvent = (id) => events(id).at(-1)
const feedbackRow = (fid) => db.prepare('SELECT * FROM feedback WHERE id = ?').get(fid)
const rejectionFeedback = (id) =>
  db.prepare("SELECT * FROM feedback WHERE item_id = ? AND message LIKE 'Automated review cycle%' ORDER BY id").get(id)
// Dispatched runs hold queue watchdogs open; stop them so the process exits.
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const listItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((i) => i.id === id)
}

test('the forward lands on the gate, which still sits right after review (pin)', () => {
  // forwardToAcceptGate sets cursor = ACCEPT_GATE_INDEX where the cap path used
  // cursor + 1 from review; the two are equal only while this holds.
  assert.equal(ACCEPT_GATE_INDEX, REVIEW_STEP_INDEX + 1)
})

test('forwarding moves the item to Accept the code and cancels the implement run the rejection started (metric 1)', async () => {
  const { implementRunId } = await rejectedWithRun('FW-1', { pr: 501 })
  assert.equal(row('FW-1').cursor, IMPLEMENT_STEP_INDEX)

  const res = await forwardPost('FW-1')

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, forwarded: true })
  assert.equal(row('FW-1').cursor, ACCEPT_GATE_INDEX)
  assert.equal(runStatus(implementRunId), 'cancelled')
  assert.deepEqual(farmCancels, [{ run_id: implementRunId }])
})

test('the log records who forwarded it with the findings attached, and GET /api/items carries them (metric 2)', async () => {
  const { reviewRunId } = await rejectedWithRun('FW-2', { pr: 502, artifact: '## Code review\n**fail**\n- unchecked input in x.js' })

  assert.equal((await forwardPost('FW-2')).statusCode, 200)

  const ev = lastEvent('FW-2')
  assert.equal(ev.who, user.name)
  assert.match(ev.text, SUFFIX_RE)
  assert.ok(ev.text.includes(`review run #${reviewRunId}`))
  const item = await listItem('FW-2')
  assert.deepEqual(item.forwardedReview, {
    runId: reviewRunId,
    by: user.name,
    sha: REVIEWED_SHA,
    attempt: 1,
    artifact: '## Code review\n**fail**\n- unchecked input in x.js',
  })
  assert.equal(item.reviewRejected, false)
})

test('the review cap and a human forward produce the same event shape and item state (metric 3)', async () => {
  // Cap path: the third failing review on an item already at two cycles.
  resetFakes()
  const capRunId = await failReview('FW-CAP', { pr: 503, issue: 77, cycles: 2 })
  const capEvent = lastEvent('FW-CAP')
  assert.ok(
    githubCalls.some((c) => c.method === 'POST' && c.url.endsWith('/issues/77/comments')),
    'the cap path still posts the review result to the issue',
  )
  // Human path.
  const { reviewRunId } = await rejectedWithRun('FW-HUM', { pr: 504 })
  assert.equal((await forwardPost('FW-HUM')).statusCode, 200)
  const humanEvent = lastEvent('FW-HUM')

  assert.deepEqual(Object.keys(capEvent), Object.keys(humanEvent))
  assert.equal(capEvent.color, humanEvent.color)
  assert.match(capEvent.text, SUFFIX_RE)
  assert.match(humanEvent.text, SUFFIX_RE)
  assert.equal(capEvent.who, 'Horizon')
  assert.ok(capEvent.text.startsWith('automated review cap (3) reached'))

  const pick = (r) => ({ cursor: r.cursor, fix_pass: r.fix_pass, fix_findings_json: r.fix_findings_json, forwarded_sha: r.forwarded_sha })
  assert.deepEqual(pick(row('FW-CAP')), pick(row('FW-HUM')))
  assert.equal(row('FW-CAP').forwarded_review_run_id, capRunId)
  assert.equal(row('FW-HUM').forwarded_review_run_id, reviewRunId)
  assert.equal((await listItem('FW-CAP')).forwardedReview.by, 'Horizon')
  assert.equal((await listItem('FW-HUM')).forwardedReview.by, user.name)
})

test('without the PIN, or with a wrong one, the route is 401 and changes nothing (metric 4, R1)', async () => {
  const { implementRunId } = await rejectedWithRun('FW-401', { pr: 505 })
  const eventsBefore = events('FW-401').length

  for (const headers of [{}, { 'x-human-key': 'wrong-pin' }]) {
    const res = await forwardPost('FW-401', headers)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  }
  assert.equal(runStatus(implementRunId), 'active')
  assert.equal(row('FW-401').cursor, IMPLEMENT_STEP_INDEX)
  assert.deepEqual(farmCancels, [])
  assert.equal(events('FW-401').length, eventsBefore)
})

test('a Bearer header does not stand in for the PIN (HZ-179 stand-in, R4)', async () => {
  const { implementRunId } = await rejectedWithRun('FW-BEARER', { pr: 506 })
  const res = await forwardPost('FW-BEARER', { authorization: 'Bearer some-api-token' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.equal(runStatus(implementRunId), 'active')
  assert.equal(row('FW-BEARER').cursor, IMPLEMENT_STEP_INDEX)
})

test('an item whose latest review passed is 409 review_not_rejected and unchanged (metric 4)', async () => {
  insertItem.run('FW-PASSED', 'Passed review', 'Medium', REVIEW_STEP_INDEX, null, null, null, 0)
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('FW-PASSED', REVIEW_STEP_INDEX, STEPS[REVIEW_STEP_INDEX].agent).lastInsertRowid
  const passVerdict = { ...FAIL_VERDICT, code_review: { verdict: 'pass', findings: [] } }
  await orchestrator.completeFarmRun(runId, { summary: 'ok', artifacts: { artifact_md: '# ok', verdict: passVerdict } })
  const before = row('FW-PASSED')
  assert.equal(before.cursor, ACCEPT_GATE_INDEX)

  const res = await forwardPost('FW-PASSED')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'review_not_rejected' })
  assert.deepEqual(row('FW-PASSED'), before)
})

test('an item outside Execute is 409 not_in_execute and unchanged (metric 4)', async () => {
  insertItem.run('FW-PLAN', 'Still planning', 'Medium', 3, null, null, null, 0)
  const before = row('FW-PLAN')
  const res = await forwardPost('FW-PLAN')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'not_in_execute' })
  assert.deepEqual(row('FW-PLAN'), before)
})

test('an unknown item is 404 not_found, and a re-review in progress is 409 review_not_rejected (R2, O5)', async () => {
  const missing = await forwardPost('FW-NOPE')
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })

  insertItem.run('FW-REREVIEW', 'Re-review running', 'Medium', REVIEW_STEP_INDEX, null, null, null, 1)
  db.prepare("UPDATE work_item SET fix_findings_json = '[]' WHERE id = 'FW-REREVIEW'").run()
  const before = row('FW-REREVIEW')
  const res = await forwardPost('FW-REREVIEW')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'review_not_rejected' })
  assert.deepEqual(row('FW-REREVIEW'), before)
})

test('forwarding never approves: no gate decision, no merge, and Accept still needs the PIN (guardrail, R3)', async () => {
  await rejectedWithRun('FW-NOAPPROVE', { pr: 507 })
  assert.equal((await forwardPost('FW-NOAPPROVE')).statusCode, 200)

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = 'FW-NOAPPROVE'").get().n, 0)
  assert.ok(!githubCalls.some((c) => c.url.endsWith('/merge')), 'no merge call')

  const approve = await app.inject({
    method: 'POST',
    url: `/api/items/FW-NOAPPROVE/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie },
  })
  assert.equal(approve.statusCode, 401)
  assert.deepEqual(approve.json(), { error: 'human_gate_key_required' })
  assert.equal(row('FW-NOAPPROVE').cursor, ACCEPT_GATE_INDEX)
})

test('two quick requests forward once: one 200, one 409 forward_in_progress, one forward event', async () => {
  await rejectedWithRun('FW-DOUBLE', { pr: 508 })
  cancelHook = () => new Promise((r) => setTimeout(r, 30))

  const [a, b] = await Promise.all([forwardPost('FW-DOUBLE'), forwardPost('FW-DOUBLE')])

  const codes = [a.statusCode, b.statusCode].sort()
  assert.deepEqual(codes, [200, 409])
  assert.deepEqual((a.statusCode === 409 ? a : b).json(), { error: 'forward_in_progress' })
  assert.equal(events('FW-DOUBLE').filter((e) => SUFFIX_RE.test(e.text)).length, 1)
  assert.equal(farmCancels.length, 1)
})

test('the farm cancel is awaited before the PR head is read; a push during cancel is refused (R5)', async () => {
  const { implementRunId } = await rejectedWithRun('FW-PUSH', { pr: 509 })
  const rejection = rejectionFeedback('FW-PUSH')
  // The dying session pushes one last commit before the kill lands.
  cancelHook = async () => {
    await new Promise((r) => setTimeout(r, 20))
    prHeads[509] = 'sha-pushed-during-cancel'
  }

  const res = await forwardPost('FW-PUSH')

  assert.deepEqual(order, ['cancel-ack', 'head-read'])
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'branch_moved' })
  assert.equal(row('FW-PUSH').cursor, IMPLEMENT_STEP_INDEX)
  assert.notEqual(row('FW-PUSH').fix_findings_json, null, 'still a rejected review')
  assert.equal(row('FW-PUSH').forwarded_review_run_id, null)
  assert.equal(runStatus(implementRunId), 'cancelled')
  assert.match(lastEvent('FW-PUSH').text, /refused — PR #509 moved past the commit the review read/)
  // The findings were re-queued, and the restarted implement run carries them.
  assert.ok(activeImplementRun('FW-PUSH') > implementRunId, 'implement restarted')
  assert.deepEqual(farmDispatches.map((d) => d.feedback.map((f) => f.message)), [[rejection.message]])
})

test('a forward before any implement run has started consumes the queued findings and starts nothing (R6)', async () => {
  // The state before dispatch: rejected, findings queued, no run yet.
  await failReview('FW-NORUN')
  orchestrator.cancel('FW-NORUN')
  db.prepare("DELETE FROM step_run WHERE item_id = 'FW-NORUN' AND step_index = ?").run(IMPLEMENT_STEP_INDEX)
  db.prepare("UPDATE feedback SET delivered_at = NULL WHERE item_id = 'FW-NORUN'").run()
  resetFakes()
  const rejection = rejectionFeedback('FW-NORUN')
  assert.equal(rejection.delivered_at, null)
  const implementRuns = () =>
    db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get('FW-NORUN', IMPLEMENT_STEP_INDEX).n

  const res = await forwardPost('FW-NORUN')

  assert.equal(res.statusCode, 200)
  assert.equal(row('FW-NORUN').cursor, ACCEPT_GATE_INDEX)
  assert.deepEqual(farmCancels, [])
  assert.equal(githubCalls.length, 0, 'no PR (demo mode): the head check is skipped, not faked')
  assert.notEqual(feedbackRow(rejection.id).delivered_at, null, 'consumed')
  orchestrator.kick('FW-NORUN')
  assert.equal(implementRuns(), 0)
})

test("only the rejection's own feedback row is consumed or re-queued (R7)", async () => {
  const otherFeedback = (id, createdAt) =>
    Number(
      db
        .prepare("INSERT INTO feedback (item_id, target, message, created_at) VALUES (?, ?, 'human note', COALESCE(?, datetime('now')))")
        .run(id, IMPLEMENT_AGENT, createdAt).lastInsertRowid,
    )

  // Forward: the rejection row is consumed, unrelated rows stay queued.
  await failReview('FW-FB')
  const earlier = otherFeedback('FW-FB', '2000-01-01 00:00:00')
  const later = otherFeedback('FW-FB', null)
  const rejection = rejectionFeedback('FW-FB')
  assert.equal((await forwardPost('FW-FB')).statusCode, 200)
  assert.notEqual(feedbackRow(rejection.id).delivered_at, null)
  assert.equal(feedbackRow(earlier).delivered_at, null)
  assert.equal(feedbackRow(later).delivered_at, null)

  // Refusal: only the rejection row goes back to undelivered — so it, and
  // nothing else, rides along with the restarted implement run.
  await rejectedWithRun('FW-FB2', { pr: 510 })
  const earlier2 = otherFeedback('FW-FB2', '2000-01-01 00:00:00')
  const later2 = otherFeedback('FW-FB2', null)
  db.prepare("UPDATE feedback SET delivered_at = '2001-01-01 00:00:00' WHERE id IN (?, ?)").run(earlier2, later2)
  prHeads[510] = 'sha-someone-else-pushed'
  const res = await forwardPost('FW-FB2')
  assert.deepEqual(res.json(), { error: 'branch_moved' })
  assert.deepEqual(farmDispatches.map((d) => d.feedback.map((f) => f.message)), [[rejectionFeedback('FW-FB2').message]])
  assert.equal(feedbackRow(earlier2).delivered_at, '2001-01-01 00:00:00')
  assert.equal(feedbackRow(later2).delivered_at, '2001-01-01 00:00:00')
})

test('forwardedReview.by comes from the forwarded_by column, and a send-back clears it (R8)', async () => {
  await rejectedWithRun('FW-COLS', { pr: 511 })
  assert.equal((await forwardPost('FW-COLS')).statusCode, 200)

  db.prepare("UPDATE event SET who = 'Someone Else', text = 'rewritten' WHERE item_id = 'FW-COLS'").run()
  assert.equal((await listItem('FW-COLS')).forwardedReview.by, user.name)

  const sendBack = await app.inject({
    method: 'POST',
    url: '/api/items/FW-COLS/reject',
    payload: { target: 'Accept the code', feedback: 'fix the findings' },
    headers: { cookie, 'x-human-key': pin },
  })
  assert.equal(sendBack.statusCode, 200)
  const r = row('FW-COLS')
  assert.equal(r.forwarded_review_run_id, null)
  assert.equal(r.forwarded_by, null)
  assert.equal(r.forwarded_sha, null)
  assert.equal((await listItem('FW-COLS')).forwardedReview, null)
})

test('a newer review run supersedes the forward, so the gate never shows a stale verdict', async () => {
  await rejectedWithRun('FW-STALE', { pr: 513 })
  assert.equal((await forwardPost('FW-STALE')).statusCode, 200)
  assert.notEqual((await listItem('FW-STALE')).forwardedReview, null)
  // A later review ran (e.g. after a send-back to the review step itself).
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES ('FW-STALE', ?, 2, ?, 'done', '# pass', datetime('now'))",
  ).run(REVIEW_STEP_INDEX, STEPS[REVIEW_STEP_INDEX].agent)
  assert.equal((await listItem('FW-STALE')).forwardedReview, null)
})

test('a failed PR head read refuses without locking the item; the next request goes through (R10)', async () => {
  await rejectedWithRun('FW-THROW', { pr: 512 })
  prHeads[512] = new Error('GitHub down')

  const first = await forwardPost('FW-THROW')
  assert.equal(first.statusCode, 409)
  assert.deepEqual(first.json(), { error: 'branch_unverified' })
  assert.equal(row('FW-THROW').cursor, IMPLEMENT_STEP_INDEX)

  prHeads[512] = REVIEWED_SHA
  const second = await forwardPost('FW-THROW')
  assert.equal(second.statusCode, 200)
  assert.deepEqual(second.json(), { ok: true, forwarded: true })
})
