// HO-838: Execute's dispatch re-check against a fake farm — what the server
// does with each /preflight answer. Fail closed on every bad answer, name the
// failed checks, keep the approval, carry the prereq_drift tag (and only on a
// refusal), never auto-retry, and dispatch again on Resume once the host is
// fixed. The real-farm chain is prereq-drift-dispatch-e2e.test.mjs.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-prereq-table-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
// The injected timeout: a farm that never answers refuses in 50 ms, not 30 s.
process.env.FARM_PREFLIGHT_TIMEOUT_MS = '50'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const PLAN = '## Commands\n1. run\n\n## Run plan block\n```json run-plan\n' + JSON.stringify({ cwd: '.', commands: ['echo hi'], budget_minutes: 5 }) + '\n```'
const reply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data })
const PASS = { ok: true, failed: [], unmet: [], deferred: [], elapsed_ms: 1 }

// The fake farm: `preflightAnswer` decides each /preflight; every request is recorded.
let preflightAnswer = () => reply(PASS)
let calls = []
globalThis.fetch = async (url, opts = {}) => {
  const path = new URL(String(url)).pathname
  calls.push({ path, body: opts.body ? JSON.parse(opts.body) : null })
  if (path === '/preflight') return preflightAnswer(opts)
  return reply({})
}
beforeEach(() => {
  preflightAnswer = () => reply(PASS)
  calls = []
})
const stepsRunCalls = () => calls.filter((c) => c.path === '/steps/run')

let seq = 0
function approvedTask() {
  const id = `T-838-${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, 'host')").run(
    id,
    `Task ${id}`,
    EXECUTE_STEP_INDEX,
    sha256(PLAN),
  )
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))").run(
    id,
    RUN_PLAN_STEP_INDEX,
    STEPS[RUN_PLAN_STEP_INDEX].agent,
    PLAN,
  )
  return id
}
const activeRun = (id) =>
  Number(db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid)
const approval = (id) => db.prepare('SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?').get(id)
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

async function untilPaused(id) {
  for (let i = 0; i < 100 && !store.getItem(id).paused; i++) await wait(10)
  return store.getItem(id)
}

test('metric 2: a running deploy — the event names no_deploy_running and nothing reaches /steps/run', async () => {
  const id = approvedTask()
  preflightAnswer = () =>
    reply({ ok: false, failed: ['no_deploy_running'], unmet: [{ kind: 'precondition', name: 'no_deploy_running', reason: 'a deploy of horizon v1 is deploying' }] })
  orchestrator.kick(id)
  const item = await untilPaused(id)
  assert.ok(item.paused)
  const refusal = eventTexts(id).find((t) => t.includes(`(${REASON.PREREQ_DRIFT})`))
  assert.ok(refusal, JSON.stringify(eventTexts(id)))
  assert.match(refusal, /failed: no_deploy_running/)
  assert.equal(calls.filter((c) => c.path === '/preflight').length, 1)
  assert.deepEqual(stepsRunCalls(), [])
})

test('metric 4: a dispatch refusal leaves approved_plan_hash and approved_runner unchanged', async () => {
  const id = approvedTask()
  const before = approval(id)
  preflightAnswer = () => reply({ ok: false, failed: ['MY_VAR'], unmet: [{ kind: 'env', name: 'MY_VAR', reason: 'not set' }] })
  const refused = await orchestrator.refuseUnapprovedRun(activeRun(id), id, EXECUTE_STEP_INDEX)
  assert.equal(refused.error, REASON.PREREQ_DRIFT)
  assert.deepEqual(refused.failed, ['MY_VAR'])
  assert.deepEqual(approval(id), before)
})

test('metric 4: a farm-gate refusal (farmd forwards prereq_refused) keeps the approval, is not auto-retried, and Resume dispatches with no re-approval', async () => {
  const id = approvedTask()
  const before = approval(id)
  orchestrator.kick(id)
  await wait(20)
  assert.equal(stepsRunCalls().length, 1, 'a clean re-check dispatches')
  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, EXECUTE_STEP_INDEX).id

  // What farmd forwards to /api/farm/steps/:runId/fail for a prereq_refused job.
  orchestrator.failFarmRun(runId, 'Execute refused: prerequisites changed since approval — failed: MY_VAR', REASON.PREREQ_DRIFT)
  await wait(20)
  const item = store.getItem(id)
  assert.ok(item.paused)
  assert.deepEqual(approval(id), before)
  assert.ok(!eventTexts(id).some((t) => /auto-retrying/.test(t)), 'prereq_drift is never auto-retried')
  assert.equal(stepsRunCalls().length, 1)

  // The host is fixed: Resume re-checks and dispatches the same approved plan.
  const resumed = orchestrator.resumeJob(id)
  assert.equal(resumed.ok, true)
  await wait(20)
  const dispatched = stepsRunCalls()
  assert.equal(dispatched.length, 2, 'Resume reaches /steps/run')
  assert.equal(dispatched[1].body.approved_hash, before.approved_plan_hash)
  assert.equal(dispatched[1].body.runner, before.approved_runner)
  orchestrator.cancel(id)
})

test('metric 5: a refusal carries the prereq_drift tag; a plain Execute work failure does not', async () => {
  const id = approvedTask()
  preflightAnswer = () => reply({ ok: false, failed: ['MY_VAR'], unmet: [] })
  await orchestrator.refuseUnapprovedRun(activeRun(id), id, EXECUTE_STEP_INDEX)
  assert.ok(eventTexts(id).at(-1).includes(`(${REASON.PREREQ_DRIFT})`), eventTexts(id).at(-1))

  const work = approvedTask()
  orchestrator.failFarmRun(activeRun(work), 'scripts/a.sh exited 1', null)
  assert.ok(eventTexts(work).length > 0)
  assert.ok(!eventTexts(work).some((t) => t.includes(REASON.PREREQ_DRIFT)), JSON.stringify(eventTexts(work)))
})

test('guardrail: every bad /preflight answer refuses with prereq_drift and sends no /steps/run', async () => {
  const farmError = (status) => () => reply({ error: `farm said ${status}` }, status)
  const cases = [
    ['400', farmError(400)],
    ['500', farmError(500)],
    ['503', farmError(503)],
    ['504', farmError(504)],
    [
      'connection refused',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    ['invalid JSON', () => ({ ok: true, status: 200, json: async () => JSON.parse('{not json') })],
    ['200 without ok', () => reply({ failed: [] })],
    ['200 ok:false, failed:[]', () => reply({ ok: false, failed: [] })],
    // Never answers; only the injected 50 ms timeout ends it.
    ['timeout', (opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))],
  ]
  for (const [name, answer] of cases) {
    const id = approvedTask()
    preflightAnswer = answer
    calls = []
    const runId = activeRun(id)
    const refused = await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)
    assert.equal(refused?.error, REASON.PREREQ_DRIFT, name)
    assert.notEqual(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'active', name)
    assert.ok(eventTexts(id).at(-1).includes(`(${REASON.PREREQ_DRIFT})`), `${name}: ${eventTexts(id).at(-1)}`)
    assert.deepEqual(stepsRunCalls(), [], name)
  }
})

test('guardrail: a Stop during the re-check dispatches nothing', async () => {
  const id = approvedTask()
  let answer
  preflightAnswer = () => new Promise((resolve) => (answer = resolve))
  orchestrator.kick(id)
  await wait(10)
  orchestrator.cancel(id)
  answer(reply(PASS))
  await wait(20)
  assert.deepEqual(stepsRunCalls(), [])
})
