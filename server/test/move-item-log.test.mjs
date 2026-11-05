// HZ-710 metric 3: every caller of the move writes exactly one item_move row —
// who, from key, to key, action and note — through its own real entry point:
// the send-back and restart routes, forward to Accept, boot recovery, a PR
// merged on GitHub, an issue reopened on GitHub, conflict escalation and
// POST /api/items/:id/move. (The Caretaker's ruling and a WhatsApp vote are
// asserted in caretaker-ruling.test.mjs and wa-poll-votes.test.mjs, which
// already drive those entry points.) Every refusal writes no row.
//
// The farm and GitHub are a fetch stub; the orchestrator is the real one.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-item-log-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '60000'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

let conflictReply = { ok: true, resolved: false, reason: 'merge_conflict', detail: 'conflicts in: shared.txt' }
const farmRuns = []
const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.endsWith('/conflicts/resolve')) return ok(conflictReply)
  if (u.endsWith('/steps/run')) farmRuns.push(JSON.parse(opts.body))
  if (u.startsWith('https://api.github.com/')) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
  return ok({ ok: true })
}

const { db, dropLegacyRejectedColumn, hasRejectedColumn } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const github = await import('../src/github.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { CLOSED_KEY, MERGED_HINT } = await import('../src/moveItem.js')
const { STEPS, stepIndexOf } = await import('../../domain/js/lifecycle.js')
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { user, pin, cookie } = loginFixtureUser(auth, config)
const REPO = 'acme/moves'
connectReadyRepo(db, REPO, { noDeploy: true })
db.prepare("UPDATE project SET enabled = 1 WHERE name = 'Ready repos'").run()

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const at = (key) => stepIndexOf(key)
const insert = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, kind, repo, pr, issue, merged_at, review_cycle_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
)
function seed(id, key, { kind = 'change', repo = null, pr = null, issue = null, merged = null, cycles = 0, cursor = at(key) } = {}) {
  insert.run(id, `Item ${id}`, 'Medium', cursor, kind, repo, pr, issue, merged, cycles)
  return id
}
const moves = (id) => db.prepare('SELECT who, from_key, to_key, action, note FROM item_move WHERE item_id = ? ORDER BY id').all(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const runsAt = (id, key) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, at(key)).n
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const post = (url, payload = {}, headers = { 'x-human-key': pin }) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie, ...headers } })
const move = (id, body, headers) => post(`/api/items/${id}/move`, body, headers)

test('send back (POST /reject): one return row, by the human, with the feedback', async () => {
  const id = seed('L-SEND', 'change.approve-design')
  const res = await post(`/api/items/${id}/reject`, { target: 'Architect', feedback: 'consider option B' })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(moves(id), [
    { who: user.name, from_key: 'change.approve-design', to_key: 'change.plan-options', action: 'return', note: 'consider option B' },
  ])
})

test('restart (POST /phases/:phase/restart): one return row to the phase’s first step, with the reason', async () => {
  const id = seed('L-RESTART', 'change.review-before-exec')
  const phase = STEPS[at('change.review-before-exec')].phase
  const res = await post(`/api/items/${id}/phases/${phase}/restart`, { reason: 'start the plan over' })
  assert.equal(res.statusCode, 200, res.body)
  const first = STEPS.find((s) => s.key.startsWith('change.') && s.phase === phase).key
  assert.deepEqual(moves(id), [
    { who: user.name, from_key: 'change.review-before-exec', to_key: first, action: 'return', note: 'start the plan over' },
  ])
})

test('forward to Accept (POST /forward-to-accept): one approve row at Accept the code, the findings in its note', async () => {
  const id = seed('L-FWD', 'change.auto-review')
  const reviewRun = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, 'QA')")
    .run(id, at('change.auto-review')).lastInsertRowid
  const verdict = {
    code_review: { verdict: 'fail', findings: [{ file: 'server/src/x.js', line: 7, severity: 'block', detail: 'unchecked input' }] },
    qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
  }
  assert.deepEqual(await orchestrator.completeFarmRun(reviewRun, { summary: 'review failed', artifacts: { verdict } }), { ok: true })
  assert.equal(cursorOf(id), at('change.implement'))
  assert.deepEqual(moves(id), [], 'the failing review is a step completion, not a move')

  const res = await post(`/api/items/${id}/forward-to-accept`)
  assert.equal(res.statusCode, 200, res.body)
  const rows = moves(id)
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], note: undefined }, { who: user.name, from_key: 'change.implement', to_key: 'change.accept-code', action: 'approve', note: undefined })
  assert.match(rows[0].note, /^skipped the remaining automated review cycles/)
  assert.match(rows[0].note, /Outstanding findings:\n- server\/src\/x\.js:7: unchecked input/)
  assert.equal(cursorOf(id), at('change.accept-code'))
  assert.equal(db.prepare('SELECT merged_at FROM work_item WHERE id = ?').get(id).merged_at, null, 'Accept the code still decides')
})

test('boot recovery: one return row by Horizon, noted "boot recovery", then the column is gone', () => {
  const id = seed('L-BOOT', 'change.approve-design')
  db.exec('ALTER TABLE work_item ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0')
  db.prepare('UPDATE work_item SET rejected = 1 WHERE id = ?').run(id)
  assert.equal(store.recoverLegacyRejected(), 1)
  assert.equal(dropLegacyRejectedColumn(), true)
  assert.equal(hasRejectedColumn(), false)
  assert.deepEqual(moves(id), [
    { who: 'Horizon', from_key: 'change.approve-design', to_key: 'change.plan-options', action: 'return', note: 'boot recovery' },
  ])
  assert.equal(store.recoverLegacyRejected(), 0, 'no column, nothing to recover')
})

test('GitHub merge: one approve row by GitHub at Accept the code', () => {
  const id = seed('L-MERGE', 'change.accept-code', { repo: REPO, pr: 41 })
  assert.equal(github.handlePrStateChange(REPO, 41, { merged: true, state: 'closed' }), true)
  assert.deepEqual(moves(id), [
    { who: 'GitHub', from_key: 'change.accept-code', to_key: 'change.deploy', action: 'approve', note: 'PR #41 was merged on GitHub' },
  ])
})

test('GitHub close and reopen: one close row, then one reopen row, both by GitHub', () => {
  const issue = { number: 51, title: 'Reopened', body: '## Outcome\nx', state: 'open', labels: [] }
  store.upsertFromGithub(issue, REPO)
  const id = store.findItemByIssue(REPO, 51).id
  store.upsertFromGithub({ ...issue, state: 'closed' }, REPO)
  store.upsertFromGithub({ ...issue, state: 'open' }, REPO)
  assert.deepEqual(moves(id), [
    { who: 'GitHub', from_key: 'change.define-outcome', to_key: CLOSED_KEY, action: 'close', note: 'closed issue #51' },
    { who: 'GitHub', from_key: CLOSED_KEY, to_key: 'change.define-outcome', action: 'reopen', note: 'reopened issue #51' },
  ])
})

test('conflict escalation: one return row to implement, by whoever asked for the resolve', async () => {
  const id = seed('L-CONFLICT', 'change.accept-code', { repo: REPO, pr: 61 })
  db.prepare('UPDATE work_item SET pr_mergeable = 0 WHERE id = ?').run(id)
  const result = await orchestrator.resolveConflicts(id, 'Alice')
  assert.equal(result.escalated, true, JSON.stringify(result))
  const rows = moves(id)
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], note: undefined }, { who: 'Alice', from_key: 'change.accept-code', to_key: 'change.implement', action: 'return', note: undefined })
  assert.match(rows[0].note, /^PR #61: /)
})

// ---- POST /api/items/:id/move ----

test('the move route: a return writes one row and answers with it', async () => {
  const id = seed('L-ROUTE', 'change.implement')
  const res = await move(id, { action: 'return', from: 'change.implement', to: 'change.draft-plan', note: 'Plan misses the migration' })
  assert.equal(res.statusCode, 200, res.body)
  const row = { who: user.name, from_key: 'change.implement', to_key: 'change.draft-plan', action: 'return', note: 'Plan misses the migration' }
  assert.deepEqual(moves(id), [row])
  const { move: answered } = res.json()
  assert.deepEqual(answered, { id: answered.id, itemId: id, who: user.name, fromKey: 'change.implement', toKey: 'change.draft-plan', action: 'return', note: 'Plan misses the migration' })
  const fb = db.prepare('SELECT message, step_key FROM feedback WHERE item_id = ?').get(id)
  assert.deepEqual(fb, { message: 'Plan misses the migration', step_key: 'change.draft-plan' })
})

test('the move route: approve, retry, abandon and reopen each write one row', async () => {
  const gate = seed('L-R-APPROVE', 'change.approve-design')
  assert.equal((await move(gate, { action: 'approve', from: 'change.approve-design', note: 'go' })).statusCode, 200)
  assert.deepEqual(moves(gate).map((r) => [r.action, r.from_key, r.to_key, r.note]), [['approve', 'change.approve-design', 'change.draft-plan', 'go']])

  const running = seed('L-R-RETRY', 'change.draft-plan')
  assert.equal((await move(running, { action: 'retry', from: 'change.draft-plan' })).statusCode, 200)
  assert.deepEqual(moves(running).map((r) => [r.action, r.from_key, r.to_key]), [['retry', 'change.draft-plan', 'change.draft-plan']])

  const dropped = seed('L-R-ABANDON', 'change.draft-plan')
  assert.equal((await move(dropped, { action: 'abandon', from: 'change.draft-plan' })).statusCode, 400, 'abandon needs a note')
  assert.equal((await move(dropped, { action: 'abandon', from: 'change.draft-plan', note: 'duplicate' })).statusCode, 200)
  assert.deepEqual(moves(dropped).map((r) => [r.action, r.note]), [['abandon', 'duplicate']])

  const closed = seed('L-R-REOPEN', 'change.define-outcome', { cursor: at('change.review-close') + 1, merged: '2026-11-01 00:00:00' })
  const reopened = await move(closed, { action: 'reopen', from: CLOSED_KEY })
  assert.equal(reopened.statusCode, 200, reopened.body)
  assert.deepEqual(moves(closed).map((r) => [r.action, r.from_key, r.to_key]), [['reopen', CLOSED_KEY, 'change.define-outcome']])

  // An item with a GitHub issue is reopened on GitHub, which Horizon follows.
  const synced = seed('L-R-REOPEN-GH', 'change.define-outcome', { cursor: at('change.review-close') + 1, repo: REPO, issue: 999 })
  const refused = await move(synced, { action: 'reopen', from: CLOSED_KEY })
  assert.equal(refused.statusCode, 409)
  assert.equal(refused.json().error, 'reopen_on_github')
  assert.deepEqual(moves(synced), [])
})

test('the move route: every refusal writes no row — no PIN, stale step, not earlier, merged, a human-only gate', async () => {
  const id = seed('L-REFUSE', 'change.implement')
  const noPin = await move(id, { action: 'return', from: 'change.implement', to: 'change.draft-plan' }, {})
  assert.equal(noPin.statusCode, 401)

  const stale = await move(id, { action: 'return', from: 'change.draft-plan', to: 'change.plan-options' })
  assert.equal(stale.statusCode, 409)
  assert.deepEqual(stale.json(), { error: 'stale_step' })

  const later = await move(id, { action: 'return', from: 'change.implement', to: 'change.accept-code' })
  assert.equal(later.statusCode, 409)
  assert.deepEqual(later.json(), { error: 'not_earlier' })

  const missing = await move(id, { action: 'return', from: 'change.implement' })
  assert.equal(missing.statusCode, 400)
  assert.equal((await move('L-NONE', { action: 'retry', from: 'change.implement' })).statusCode, 404)
  assert.equal(cursorOf(id), at('change.implement'))
  assert.deepEqual(moves(id), [])

  const merged = seed('L-MERGED', 'change.deploy', { merged: '2026-11-01 00:00:00' })
  const rewind = await move(merged, { action: 'return', from: 'change.deploy', to: 'change.implement' })
  assert.equal(rewind.statusCode, 409)
  assert.deepEqual(rewind.json(), { error: 'merged', hint: MERGED_HINT })
  assert.match(rewind.json().hint, /follow-up item/)
  assert.deepEqual(moves(merged), [])

  // A human-only gate approved without the PIN (the Caretaker's and WhatsApp's path).
  const task = seed('L-HUMAN', 'task.approve-run', { kind: 'task' })
  const refused = await app.gateActions.approve(task, at('task.approve-run'), '', 'Caretaker')
  assert.equal(refused.error, 'human_pin_required')
  assert.equal(refused.status, 403)
  assert.deepEqual(moves(task), [])
})

test('an outer failure after approveGate rolls back its move: no row, no cursor change', () => {
  const id = seed('L-NESTED', 'change.approve-design')
  assert.throws(
    () =>
      db.transaction(() => {
        assert.equal(store.approveGate(id, at('change.approve-design'), '', 'You').ok, true)
        throw new Error('outer failure')
      })(),
    /outer failure/,
  )
  assert.equal(cursorOf(id), at('change.approve-design'))
  assert.deepEqual(moves(id), [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n, 0)
})

test('a return to a gate dispatches nothing; a return to a server step runs it again', async () => {
  const gated = seed('L-TO-GATE', 'change.implement')
  const runsBefore = runsAt(gated, 'change.draft-plan')
  assert.equal((await move(gated, { action: 'return', from: 'change.implement', to: 'change.review-before-exec' })).statusCode, 200)
  await tick()
  assert.equal(cursorOf(gated), at('change.review-before-exec'), 'the item waits at the gate')
  assert.equal(runsAt(gated, 'change.draft-plan'), runsBefore, 'the step before the gate is not re-run')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'active'").get(gated).n, 0)
  assert.ok(!farmRuns.some((r) => r.item?.id === gated))

  const plan = seed('L-TO-SERVER', 'plan.review-close', { kind: 'plan' })
  assert.equal(runsAt(plan, 'plan.file-items'), 0)
  assert.equal((await move(plan, { action: 'return', from: 'plan.review-close', to: 'plan.file-items' })).statusCode, 200)
  for (let i = 0; i < 50 && runsAt(plan, 'plan.file-items') === 0; i++) await tick()
  assert.equal(runsAt(plan, 'plan.file-items'), 1, 'File items ran again')
})
