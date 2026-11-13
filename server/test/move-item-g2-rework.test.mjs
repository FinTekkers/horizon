// HZ-710 metric 4: the "G2 rework" golden run. From a running "Specialist
// agent implements", a human returns the item to "Draft implementation plan"
// through POST /api/items/:id/move; the running implement run is superseded,
// and its late completion moves nothing. The plan is redone, "Review before
// execution" is approved again — refused without the gate PIN — and the item
// runs to close with exactly the expected moves on record.
//
// Driven through the real orchestrator with the farm as a captured fetch stub
// (the trivial-lane.test.mjs harness).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-item-g2-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_hz710_stub'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const BODY = '## Outcome\nShip the report.\n\n## Success metric\n1. The report renders.\n\n## Guardrails\n- Nothing else changes.\n'
const farmCalls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  if (u.startsWith('https://api.github.com/')) {
    if (method === 'GET' && /\/issues\/\d+$/.test(u)) return { ok: true, status: 200, json: async () => ({ number: 1, body: BODY }) }
    // The final gate closes the issue with a summary: every write succeeds.
    if (method !== 'GET') return { ok: true, status: 200, json: async () => ({ number: 1, state: 'closed' }) }
    return { ok: false, status: 500, json: async () => ({ message: 'stub' }) }
  }
  farmCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { STEPS, isClosed, stepIndexOf, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { user, cookie, pin } = loginFixtureUser(auth, config)

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

const at = (key) => stepIndexOf(key)
const IMPLEMENT = at('change.implement')
const REVIEW = at('change.auto-review')
const PLAN = at('change.draft-plan')
const PLAN_GATE = at('change.review-before-exec')

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const REVIEW_PASS = {
  code_review: { verdict: 'pass', findings: [] },
  qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
}
function replyFor(stepIndex) {
  if (stepIndex === REVIEW) return { summary: 'review passed', artifacts: { verdict: REVIEW_PASS } }
  if (stepIndex === PLAN) return { summary: 'planned', artifacts: { artifact_md: '## Files & lines\n**1. `server/src/app.js` — EDIT.**\n- `snapshot()` changes.\n' } }
  return { summary: `did ${STEPS[stepIndex].label}`, artifacts: { artifact_md: `## ${STEPS[stepIndex].label}\ndone` } }
}

const cursorOf = (id) => store.getItem(id).cursor
const activeRun = (id, index) => db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, index)?.id
const moves = (id) => db.prepare('SELECT who, action, from_key, to_key FROM item_move WHERE item_id = ? ORDER BY id').all(id)
const move = (id, body, headers = { 'x-human-key': pin }) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, payload: body, headers: { cookie, ...headers } })

// Starts the agent step the item is on and waits until the farm has it.
async function dispatched(id) {
  const index = cursorOf(id)
  orchestrator.kick(id)
  let run = null
  await waitFor(() => {
    run = activeRun(id, index)
    return run && farmCalls.some((c) => c.body?.run_id === run)
  }, `${id} to dispatch ${STEPS[index].label}`)
  return run
}

// Completes each agent step with a canned reply and approves each gate as the
// human, through the move route, until `until` or closed.
async function drive(id, { until = null } = {}) {
  for (let guard = 0; guard < 40; guard++) {
    const it = store.getItem(id)
    if (isClosed(it) || it.cursor === until) return
    assert.equal(it.paused, false, `paused at ${STEPS[it.cursor].label}`)
    if (STEPS[it.cursor].kind === 'gate') {
      const res = await move(id, { action: 'approve', from: stepKeyAt(it.cursor) })
      assert.equal(res.statusCode, 200, res.body)
      continue
    }
    const index = it.cursor
    const run = await dispatched(id)
    if (cursorOf(id) === index) assert.equal((await orchestrator.completeFarmRun(run, replyFor(index))).ok, true)
  }
  throw new Error(`${id} never closed`)
}

test('G2 rework: from a running implement, return to Draft implementation plan, approve again, and finish', async () => {
  connectReadyRepo(db, 'hz710/g2', { noDeploy: true })
  db.prepare("UPDATE project SET enabled = 1 WHERE name = 'Ready repos'").run()
  store.upsertFromGithub({ number: 1, title: 'G2 rework', body: BODY, state: 'open', labels: [] }, 'hz710/g2')
  const id = store.findItemByIssue('hz710/g2', 1).id

  await drive(id, { until: IMPLEMENT })
  const implementRun = await dispatched(id)
  assert.equal(cursorOf(id), IMPLEMENT)

  // The return: the running implement run is superseded, the plan step redone.
  const res = await move(id, { action: 'return', from: 'change.implement', to: 'change.draft-plan', note: 'the plan misses the migration' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(implementRun).status, 'superseded')
  assert.equal(cursorOf(id), PLAN)

  // The superseded run reports late: nothing moves and nothing is logged.
  const movesBefore = moves(id).length
  await orchestrator.completeFarmRun(implementRun, replyFor(IMPLEMENT))
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(implementRun).status, 'superseded')
  assert.equal(cursorOf(id), PLAN)
  assert.equal(moves(id).length, movesBefore)

  // Redo the plan, up to the gate; approval there needs the gate PIN.
  await drive(id, { until: PLAN_GATE })
  const noPin = await move(id, { action: 'approve', from: 'change.review-before-exec' }, {})
  assert.equal(noPin.statusCode, 401)
  assert.equal(cursorOf(id), PLAN_GATE)

  await drive(id)
  assert.equal(isClosed(store.getItem(id)), true)
  assert.deepEqual(
    moves(id).map((m) => [m.action, m.from_key, m.to_key]),
    [
      ['approve', 'change.approve-prioritize', 'change.plan-options'],
      ['approve', 'change.approve-design', 'change.draft-plan'],
      ['approve', 'change.review-before-exec', 'change.implement'],
      ['return', 'change.implement', 'change.draft-plan'],
      ['approve', 'change.review-before-exec', 'change.implement'],
      ['approve', 'change.accept-code', 'change.deploy'],
      ['approve', 'change.review-close', 'closed'],
    ],
  )
  assert.ok(moves(id).every((m) => m.who === user.name))
})
