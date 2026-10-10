// HZ-384: a Task's Approve the run gate passes only for a human with the gate
// PIN — on every route, even on an Autopilot project — and approving records
// the exact run plan that was approved.
//
// Driven through the real Fastify app: the browser route (session + PIN), a
// personal API token, both WhatsApp legs, and a direct gateActions.approve
// the way the caretaker and any later route would call it. Every item lives
// in an enabled project with Autopilot on. The farm is a stubbed fetch that
// records each /steps/run payload.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-approve-run-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-approve-run'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.WA_NOTIFY_ENABLED = '1'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const gateNotifier = await import('../src/gateNotifier.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, requiredStepIndex, kindStepIndex, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } =
  await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()

// Every line the app logs, so the PIN can be looked for in it.
const logLines = []
const logStream = new Writable({
  write(chunk, _enc, done) {
    logLines.push(chunk.toString())
    done()
  },
})
const app = buildApp({ logger: { level: 'trace', stream: logStream } })
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(async () => {
  await app.close()
})

// A PIN no timestamp, id or hash could contain by chance.
const PIN = 'zq7-PIN-hz384-xk'
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, alice.user.id)
}
const { token } = auth.createApiToken(alice.user.id, 'scripts')

const DAVID = '15550001111@s.whatsapp.net'
const ASSESS = kindStepIndex('Assess', 'task')
const IMPACT_REVIEW = kindStepIndex('Impact review', 'task')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const PLAN_GATE = requiredStepIndex('Review before execution')

const planArtifact = (commands, budget = 20) =>
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands, budget_minutes: budget }, null, 2) +
  '\n```'
const PLAN = planArtifact(['scripts/a.sh', 'scripts/b.sh', 'scripts/c.sh'])
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Autopilot project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

const doneRun = (itemId, stepIndex, artifact) =>
  Number(
    db
      .prepare(
        "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
      )
      .run(itemId, stepIndex, STEPS[stepIndex].agent, artifact).lastInsertRowid,
  )

// A Task parked at Approve the run, with the planning steps' artifacts on
// record — or none for the Run plan when `plan` is null.
function seedTask(id, { plan = PLAN } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task fixture ${id}`,
    APPROVE_RUN_GATE_INDEX,
    projectId,
  )
  doneRun(id, ASSESS, '## Scripts found\n- scripts/a.sh')
  if (plan !== null) doneRun(id, RUN_PLAN_STEP_INDEX, plan)
  doneRun(id, IMPACT_REVIEW, '## Verdict\n**pass**')
}

function seedChange(id, cursor) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', ?, ?)").run(
    id,
    `Change fixture ${id}`,
    cursor,
    projectId,
  )
}

const row = (id) => db.prepare('SELECT cursor, approved_plan_hash FROM work_item WHERE id = ?').get(id)
const eventsOf = (id) => db.prepare('SELECT who, text FROM event WHERE item_id = ? ORDER BY id').all(id)

const approveUrl = (id, stepIndex = APPROVE_RUN_GATE_INDEX) => `/api/items/${id}/gates/${stepIndex}/approve`
const approveAs = (id, headers, payload = {}, stepIndex) =>
  app.inject({ method: 'POST', url: approveUrl(id, stepIndex), headers, payload })
const withSession = (pin) => ({ cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) })
const waApprove = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${APPROVE_RUN_GATE_INDEX}/approve-via-whatsapp`,
    headers: { 'x-wa-approval-secret': config.WA_APPROVAL_SECRET },
    payload: { senderJid: DAVID, sender: 'David' },
  })
let voteSeq = 0
async function pollVote(id) {
  const msgId = `MSG-${id}-${++voteSeq}`
  const pollId = votes.registerPoll({ itemId: id, stepIndex: APPROVE_RUN_GATE_INDEX, recipient: DAVID, question: `${id} — Approve the run` })
  votes.attachPollMessageId(pollId, msgId)
  return app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers: { 'x-wa-approval-secret': config.WA_APPROVAL_SECRET },
    payload: { voteId: `V-${voteSeq}`, pollMessageId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
  })
}

// ---- metric 1: every route without a valid PIN is refused; the gate stays ----

test('route matrix on an Autopilot project: only a session with the right PIN approves Approve the run', async () => {
  seedTask('T-ROUTES')
  const pending = () => assert.deepEqual(row('T-ROUTES'), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })

  const noPin = await approveAs('T-ROUTES', withSession())
  assert.equal(noPin.statusCode, 401)
  assert.deepEqual(noPin.json(), { error: 'human_gate_key_required' })
  pending()

  const wrongPin = await approveAs('T-ROUTES', withSession('000000'))
  assert.equal(wrongPin.statusCode, 401)
  assert.deepEqual(wrongPin.json(), { error: 'human_gate_key_required' })
  pending()

  // HZ-179: a token is refused even with the VALID PIN.
  const tokenWithPin = await approveAs('T-ROUTES', { authorization: `Bearer ${token}`, 'x-human-key': PIN })
  assert.equal(tokenWithPin.statusCode, 401)
  assert.deepEqual(tokenWithPin.json(), { error: 'human_gate_key_required' })
  pending()

  const whatsapp = await waApprove('T-ROUTES')
  assert.equal(whatsapp.statusCode, 403)
  assert.deepEqual(whatsapp.json(), { error: 'human_pin_required' })
  pending()

  const vote = await pollVote('T-ROUTES')
  assert.equal(vote.statusCode, 409, 'a store refusal is final — the bridge must not retry it')
  assert.deepEqual(vote.json(), { error: 'human_pin_required' })
  assert.equal(db.prepare(`SELECT outcome FROM gate_poll_vote WHERE vote_id = 'V-${voteSeq}'`).get().outcome, 'failed')
  pending()

  // The two refused attempts that reached the gate are in the activity log.
  const refusals = eventsOf('T-ROUTES').filter((e) => e.text.startsWith('could not approve “Approve the run”'))
  assert.equal(refusals.length, 2)
  assert.equal(refusals[0].who, 'David via WhatsApp')

  const ok = await approveAs('T-ROUTES', withSession(PIN))
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json(), { ok: true, closed: false })
  assert.equal(row('T-ROUTES').cursor, EXECUTE_STEP_INDEX)
})

test('a valid PIN with no Run plan artifact is 409 run_plan_missing: the gate stays and no hash is written', async () => {
  seedTask('T-NOPLAN', { plan: null })
  const res = await approveAs('T-NOPLAN', withSession(PIN))
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'run_plan_missing' })
  assert.deepEqual(row('T-NOPLAN'), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = 'T-NOPLAN'").get().n, 0)
})

// ---- guardrail 3: no path approves without the PIN ----

test('a direct gateActions.approve — the caretaker, or any route added later — is refused', async () => {
  seedTask('T-DIRECT')
  const result = await app.gateActions.approve('T-DIRECT', APPROVE_RUN_GATE_INDEX, '', 'Caretaker')
  assert.deepEqual(result, { error: 'human_pin_required', status: 403 })
  assert.equal(row('T-DIRECT').cursor, APPROVE_RUN_GATE_INDEX)
})

test('a forged proof literal is refused: only a proof humanAuthorized minted counts', () => {
  seedTask('T-FORGED')
  const result = store.approveGate('T-FORGED', APPROVE_RUN_GATE_INDEX, '', 'X', {
    proof: Object.freeze({ pinVerified: true, userId: alice.user.id }),
  })
  assert.deepEqual(result, { error: 'human_pin_required' })
  assert.equal(row('T-FORGED').cursor, APPROVE_RUN_GATE_INDEX)
  assert.equal(row('T-FORGED').approved_plan_hash, null)
})

test('only app.js mints a human proof', () => {
  const dir = join(REPO_ROOT, 'server/src')
  const minting = readdirSync(dir, { recursive: true })
    .filter((f) => /\.(m?js)$/.test(f))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('mintHumanProof'))
    .sort()
  assert.deepEqual(minting, ['app.js', 'humanProof.js'])
})

// ---- metric 3: the approved plan is recorded and checked ----

test('approving stores the plan hash; approvedPlanCheck passes, then refuses once the plan changes', async () => {
  seedTask('T-HASH')
  assert.deepEqual(store.approvedPlanCheck('T-HASH'), { error: 'plan_not_approved' })
  const res = await approveAs('T-HASH', withSession(PIN), { planHash: sha256(PLAN) })
  assert.equal(res.statusCode, 200)
  assert.equal(row('T-HASH').approved_plan_hash, sha256(PLAN))
  assert.equal(
    db.prepare("SELECT plan_hash FROM gate_decision WHERE item_id = 'T-HASH' AND decision = 'approved'").get().plan_hash,
    sha256(PLAN),
  )
  assert.deepEqual(store.approvedPlanCheck('T-HASH'), { ok: true, hash: sha256(PLAN) })

  const edited = planArtifact(['scripts/a.sh', 'rm -rf /tmp/x'])
  doneRun('T-HASH', RUN_PLAN_STEP_INDEX, edited)
  assert.deepEqual(store.approvedPlanCheck('T-HASH'), {
    error: REASON.PLAN_CHANGED_SINCE_APPROVAL,
    approvedHash: sha256(PLAN),
    currentHash: sha256(edited),
  })
})

test('a send-back clears the approved hash; re-approving records the NEW plan', async () => {
  seedTask('T-RESET')
  assert.equal((await approveAs('T-RESET', withSession(PIN))).statusCode, 200)
  assert.equal(row('T-RESET').approved_plan_hash, sha256(PLAN))

  assert.deepEqual(store.requestChanges('T-RESET', 'Execute', 'hold on', 'Alice'), { ok: true })
  assert.equal(row('T-RESET').approved_plan_hash, null)

  // Run plan re-runs with a different plan and the item is back at the gate.
  const second = planArtifact(['scripts/a.sh'], 5)
  doneRun('T-RESET', RUN_PLAN_STEP_INDEX, second)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-RESET')
  assert.equal((await approveAs('T-RESET', withSession(PIN))).statusCode, 200)
  assert.equal(row('T-RESET').approved_plan_hash, sha256(second))
  assert.deepEqual(store.approvedPlanCheck('T-RESET'), { ok: true, hash: sha256(second) })
  orchestrator.cancel('T-RESET')
})

test('race: a newer plan lands after the card loaded — approving the old one is refused, nothing recorded', async () => {
  seedTask('T-RACE')
  const shown = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } }))
    .json()
    .items.find((it) => it.id === 'T-RACE')
  assert.deepEqual(shown.runPlan, { commands: 3, budgetMinutes: 20, hash: sha256(PLAN) })
  assert.equal(shown.approvedPlanHash, null)

  doneRun('T-RACE', RUN_PLAN_STEP_INDEX, planArtifact(['scripts/z.sh']))
  const res = await approveAs('T-RACE', withSession(PIN), { planHash: shown.runPlan.hash })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'run_plan_changed' })
  assert.deepEqual(row('T-RACE'), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
})

test("Execute's guard: a matching plan starts, a changed plan fails the run, an unapproved item is refused", async () => {
  const activeRun = (id) =>
    Number(
      db
        .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'DevOps', 'active')")
        .run(id, EXECUTE_STEP_INDEX).lastInsertRowid,
    )
  const runOf = (runId) => db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)

  seedTask('T-EXEC')
  assert.equal((await approveAs('T-EXEC', withSession(PIN))).statusCode, 200)
  const matching = activeRun('T-EXEC')
  assert.equal(orchestrator.refuseUnapprovedRun(matching, 'T-EXEC', EXECUTE_STEP_INDEX), null)
  assert.equal(runOf(matching).status, 'active', 'a matching plan leaves the run alone')
  // Only Execute is guarded.
  assert.equal(orchestrator.refuseUnapprovedRun(matching, 'T-EXEC', RUN_PLAN_STEP_INDEX), null)
  db.prepare("UPDATE step_run SET status = 'cancelled' WHERE id = ?").run(matching)

  doneRun('T-EXEC', RUN_PLAN_STEP_INDEX, planArtifact(['scripts/edited.sh']))
  const changed = activeRun('T-EXEC')
  const refused = orchestrator.refuseUnapprovedRun(changed, 'T-EXEC', EXECUTE_STEP_INDEX)
  assert.equal(refused.error, REASON.PLAN_CHANGED_SINCE_APPROVAL)
  assert.equal(runOf(changed).status, 'cancelled')
  assert.match(runOf(changed).output, /^FAILED: the run plan changed since it was approved/)
  assert.equal(store.getItem('T-EXEC').paused, true)
  const pause = eventsOf('T-EXEC').at(-1).text
  assert.ok(pause.startsWith(`agent step failed (${REASON.PLAN_CHANGED_SINCE_APPROVAL}): the run plan changed`), pause)

  seedTask('T-UNAPPROVED')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(EXECUTE_STEP_INDEX, 'T-UNAPPROVED')
  const unapproved = activeRun('T-UNAPPROVED')
  assert.deepEqual(orchestrator.refuseUnapprovedRun(unapproved, 'T-UNAPPROVED', EXECUTE_STEP_INDEX), {
    error: 'plan_not_approved',
  })
  assert.match(runOf(unapproved).output, /^FAILED: the run plan was never approved/)
})

// ---- metric 4: Reject with feedback goes back to Run plan ----

test('rejecting at Approve the run moves the Task to Run plan, and the feedback rides in its next run', async () => {
  seedTask('T-REJECT')
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-REJECT/reject',
    headers: withSession(PIN),
    payload: { target: 'Approve the run', feedback: 'use the staging bucket, not prod' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(row('T-REJECT').cursor, RUN_PLAN_STEP_INDEX)
  await new Promise((r) => setTimeout(r, 30)) // dispatch is fire-and-forget
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'T-REJECT')
  assert.ok(dispatch, 'Run plan was dispatched again')
  assert.equal(dispatch.body.step.index, RUN_PLAN_STEP_INDEX)
  assert.deepEqual(
    dispatch.body.feedback.map((f) => [f.target, f.message]),
    [['Eng', 'use the staging bucket, not prod']],
  )
  orchestrator.cancel('T-REJECT')
})

// ---- guardrail 2: change items' gates are unchanged ----

test('change gates still approve with no proof, and the notifier still polls them — never Approve the run', async () => {
  seedChange('C-DESIGN', DESIGN_GATE)
  assert.deepEqual(store.approveGate('C-DESIGN', DESIGN_GATE, '', 'Caretaker'), { ok: true, closed: false })
  orchestrator.cancel('C-DESIGN')

  seedChange('C-PLAN', PLAN_GATE)
  const viaActions = await app.gateActions.approve('C-PLAN', PLAN_GATE, '', 'Caretaker')
  assert.deepEqual(viaActions, { ok: true, closed: false })
  orchestrator.cancel('C-PLAN')

  assert.equal(config.WA_POLL_ENABLED, true)
  seedChange('C-NOTIFY', PLAN_GATE)
  seedTask('T-NOTIFY')
  gateNotifier.sweepGates({ log: { error() {} } })
  const pollsFor = (id) => db.prepare('SELECT COUNT(*) AS n FROM gate_poll WHERE item_id = ?').get(id).n
  assert.equal(pollsFor('C-NOTIFY'), 1, 'a change gate still gets its poll')
  assert.equal(pollsFor('T-NOTIFY'), 0, 'Approve the run never gets one')
})

// ---- guardrail 4: the PIN never leaks ----

test('the PIN appears in no log line, event, gate decision, artifact or caretaker action', async () => {
  seedTask('T-LEAK')
  await approveAs('T-LEAK', withSession('9-wrong-' + PIN.slice(2)))
  await approveAs('T-LEAK', { authorization: `Bearer ${token}`, 'x-human-key': PIN })
  await waApprove('T-LEAK')
  assert.equal((await approveAs('T-LEAK', withSession(PIN))).statusCode, 200)

  assert.ok(logLines.length > 0, 'sanity: the app logged its requests')
  assert.ok(logLines.some((l) => l.includes(approveUrl('T-LEAK'))), 'sanity: the approve requests were logged')
  for (const line of logLines) assert.ok(!line.includes(PIN), `the PIN is in a log line: ${line}`)
  const tables = {
    event: 'SELECT who, text, detail FROM event',
    gate_decision: 'SELECT notes, decided_by, plan_hash FROM gate_decision',
    step_run: 'SELECT output, artifact FROM step_run',
    caretaker_action: 'SELECT error FROM caretaker_action',
    feedback: 'SELECT message FROM feedback',
  }
  for (const [table, sql] of Object.entries(tables)) {
    const text = JSON.stringify(db.prepare(sql).all())
    assert.ok(!text.includes(PIN), `the PIN is in ${table}`)
  }
})
