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
const { STEPS, requiredStepIndex, kindStepIndex, stepKeyAt, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } =
  await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { seedPreflight } = await import('./helpers/preflight.mjs')

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
  // HZ-378: the approvals above dispatch the Execute job (and T-REJECT
  // redispatches Run plan), each arming a queue watchdog. The inline cancels
  // are skipped when an assertion above them throws, so cancel everything here
  // too — a leaked watchdog used to wedge this file for the whole timeout.
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
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
// record — or none for the Run plan when `plan` is null. HO-837: and a
// Preflight that passed for that plan, as the step before the gate leaves.
// The view without it, for the shape pins below; its own tests are
// preflight-gate.test.mjs. HO-839: and without its rehearsal, whose own
// tests are task-rehearsal-sendback.test.mjs.
const planView = ({ preflight, rehearsal, ...rest }) => rest
function seedTask(id, { plan = PLAN, repo = null } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, ?, 'High', ?, 'task', ?, ?)").run(
    id,
    `Task fixture ${id}`,
    APPROVE_RUN_GATE_INDEX,
    projectId,
    repo,
  )
  doneRun(id, ASSESS, '## Scripts found\n- scripts/a.sh')
  if (plan !== null) doneRun(id, RUN_PLAN_STEP_INDEX, plan)
  doneRun(id, IMPACT_REVIEW, '## Verdict\n**pass**')
  if (plan !== null) seedPreflight(db, store, id)
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

// HZ-712: the gate's approve is POST /move's approve, from the gate's key.
const approveUrl = (id) => `/api/items/${id}/move`
const approveAs = (id, headers, payload = {}, stepIndex = APPROVE_RUN_GATE_INDEX) =>
  app.inject({ method: 'POST', url: approveUrl(id), headers, payload: { action: 'approve', from: stepKeyAt(stepIndex), ...payload } })
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
  // /move adds the item and its item_move row to the approve's own answer.
  const { item, move, ...answer } = ok.json()
  assert.deepEqual(answer, { ok: true, closed: false })
  assert.equal(item.id, 'T-ROUTES')
  assert.deepEqual([move.action, move.fromKey, move.toKey], ['approve', stepKeyAt(APPROVE_RUN_GATE_INDEX), stepKeyAt(EXECUTE_STEP_INDEX)])
  assert.equal(row('T-ROUTES').cursor, EXECUTE_STEP_INDEX)
  orchestrator.cancel('T-ROUTES') // HZ-378: approving dispatches the Execute job — clear its watchdog so the process can exit
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
  assert.deepEqual(store.approvedPlanCheck('T-HASH'), { ok: true, hash: sha256(PLAN), runner: 'host' })

  const edited = planArtifact(['scripts/a.sh', 'rm -rf /tmp/x'])
  doneRun('T-HASH', RUN_PLAN_STEP_INDEX, edited)
  assert.deepEqual(store.approvedPlanCheck('T-HASH'), {
    error: REASON.PLAN_CHANGED_SINCE_APPROVAL,
    approvedHash: sha256(PLAN),
    currentHash: sha256(edited),
    approvedRunner: 'host',
    runner: 'host',
  })
  orchestrator.cancel('T-HASH') // HZ-378: the approval dispatched the Execute job — clear its watchdog so the process can exit
})

test('a return to Run plan clears the approved hash; re-approving records the NEW plan', async () => {
  seedTask('T-RESET')
  assert.equal((await approveAs('T-RESET', withSession(PIN))).statusCode, 200)
  assert.equal(row('T-RESET').approved_plan_hash, sha256(PLAN))

  // HZ-710: a send-back on Execute retries Execute alone — the approval of
  // the gate before it stands. A return to Run plan redoes that gate.
  assert.deepEqual(store.requestChanges('T-RESET', 'Execute', 'hold on', 'Alice'), { ok: true })
  assert.equal(row('T-RESET').approved_plan_hash, sha256(PLAN))
  assert.equal(store.moveByHuman('T-RESET', { action: 'return', toKey: 'task.run-plan', who: 'Alice' }).ok, true)
  assert.equal(row('T-RESET').approved_plan_hash, null)

  // Run plan re-runs with a different plan and the item is back at the gate.
  const second = planArtifact(['scripts/a.sh'], 5)
  doneRun('T-RESET', RUN_PLAN_STEP_INDEX, second)
  seedPreflight(db, store, 'T-RESET')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-RESET')
  assert.equal((await approveAs('T-RESET', withSession(PIN))).statusCode, 200)
  assert.equal(row('T-RESET').approved_plan_hash, sha256(second))
  assert.deepEqual(store.approvedPlanCheck('T-RESET'), { ok: true, hash: sha256(second), runner: 'host' })
  orchestrator.cancel('T-RESET')
})

test('race: a newer plan lands after the card loaded — approving the old one is refused, nothing recorded', async () => {
  seedTask('T-RACE')
  const shown = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } }))
    .json()
    .items.find((it) => it.id === 'T-RACE')
  assert.equal(shown.runPlan.preflight.status, 'passed')
  assert.deepEqual(planView(shown.runPlan), { commands: 3, budgetMinutes: 20, hash: sha256(PLAN), runner: 'host', imagePinned: false, runnerWarning: null, uncoveredLines: [], commandPatch: null, patchedCommand: null })
  assert.equal(shown.approvedPlanHash, null)

  doneRun('T-RACE', RUN_PLAN_STEP_INDEX, planArtifact(['scripts/z.sh']))
  const res = await approveAs('T-RACE', withSession(PIN), { planHash: shown.runPlan.hash })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'run_plan_changed' })
  assert.deepEqual(row('T-RACE'), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
})

// ---- HZ-491: the effective runner — the plan's own, else the repo's image ----

const IMAGE_REPO = 'acme/imaged'
const BARE_REPO = 'acme/bare'
const IMAGE = `docker.io/library/python@sha256:${'d'.repeat(64)}`
const runnerPlan = (runner) =>
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 5, ...(runner ? { runner } : {}) }, null, 2) +
  '\n```'
const pinImage = (image) => db.prepare('UPDATE deploy_target SET container_image = ? WHERE repo = ?').run(image, IMAGE_REPO)
for (const [key, repo] of [['hz491-imaged', IMAGE_REPO], ['hz491-bare', BARE_REPO]]) {
  db.prepare(
    `INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
      VALUES (?, ?, 'deploy-horizon.sh', 'horizon-server', ?, ?, 'http://127.0.0.1:9/', 'json-health')`,
  ).run(key, repo, `/opt/${key}`, key)
}
pinImage(IMAGE)
const loadItem = async (id) =>
  (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })).json().items.find((it) => it.id === id)
const executeDispatch = async (id) => {
  await new Promise((r) => setTimeout(r, 30))
  return dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === id && d.body?.step?.index === EXECUTE_STEP_INDEX).at(-1)
}

test('HZ-491: with no runner, a repo with no image runs on the host and one with an image in the container', async () => {
  seedTask('T-491-BARE', { plan: runnerPlan(null), repo: BARE_REPO })
  seedTask('T-491-IMG', { plan: runnerPlan(null), repo: IMAGE_REPO })
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(planView((await loadItem('T-491-BARE')).runPlan), {
      commands: 1, budgetMinutes: 5, hash: sha256(runnerPlan(null)), runner: 'host', imagePinned: false, runnerWarning: null, uncoveredLines: [], commandPatch: null, patchedCommand: null,
    })
    assert.deepEqual(planView((await loadItem('T-491-IMG')).runPlan), {
      commands: 1, budgetMinutes: 5, hash: sha256(runnerPlan(null)), runner: 'container', imagePinned: true, runnerWarning: null, uncoveredLines: [], commandPatch: null, patchedCommand: null,
    })
  }
  for (const [id, runner] of [['T-491-BARE', 'host'], ['T-491-IMG', 'container']]) {
    assert.equal((await approveAs(id, withSession(PIN), { planHash: sha256(runnerPlan(null)), runner })).statusCode, 200)
    assert.equal(db.prepare('SELECT approved_runner FROM work_item WHERE id = ?').get(id).approved_runner, runner)
    const dispatch = await executeDispatch(id)
    orchestrator.cancel(id)
    assert.equal(dispatch.body.runner, runner, `${id}: the job carries the effective runner`)
    assert.equal((await loadItem(id)).runPlan.runner, runner, 'a reload after approving shows the same runner')
  }
  const bare = await executeDispatch('T-491-BARE')
  assert.equal(bare.body.container_image, null)
  assert.ok(!eventsOf('T-491-BARE').some((e) => e.text.includes('job_container_unavailable')))
})

test('HZ-491: an explicit runner wins — host with an image, and container with none is warned about before approval', async () => {
  seedTask('T-491-HOST', { plan: runnerPlan('host'), repo: IMAGE_REPO })
  seedTask('T-491-CONT', { plan: runnerPlan('container'), repo: BARE_REPO })
  const host = (await loadItem('T-491-HOST')).runPlan
  assert.equal(host.runner, 'host')
  assert.equal(host.imagePinned, true)
  assert.equal(host.runnerWarning, null)
  const container = (await loadItem('T-491-CONT')).runPlan
  assert.equal(container.runner, 'container')
  assert.equal(container.runnerWarning, 'no container image for this repo')

  assert.equal((await approveAs('T-491-HOST', withSession(PIN), { runner: 'host' })).statusCode, 200)
  const dispatch = await executeDispatch('T-491-HOST')
  orchestrator.cancel('T-491-HOST')
  assert.equal(dispatch.body.runner, 'host')
  assert.equal(dispatch.body.container_image, IMAGE, 'the image is still sent; the runner says not to use it')
})

test('HZ-491: approving binds the effective runner — pinning or clearing an image after approval refuses Execute', async () => {
  const activeRun = (id) =>
    Number(
      db
        .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'DevOps', 'active')")
        .run(id, EXECUTE_STEP_INDEX).lastInsertRowid,
    )
  seedTask('T-491-BIND', { plan: runnerPlan(null), repo: IMAGE_REPO })
  assert.equal((await approveAs('T-491-BIND', withSession(PIN), { runner: 'container' })).statusCode, 200)
  orchestrator.cancel('T-491-BIND')
  assert.deepEqual(store.approvedPlanCheck('T-491-BIND'), { ok: true, hash: sha256(runnerPlan(null)), runner: 'container' })
  pinImage(null)
  try {
    const check = store.approvedPlanCheck('T-491-BIND')
    assert.equal(check.error, REASON.PLAN_CHANGED_SINCE_APPROVAL)
    assert.equal(check.approvedRunner, 'container')
    assert.equal(check.runner, 'host')
    const run = activeRun('T-491-BIND')
    assert.equal(orchestrator.refuseUnapprovedRun(run, 'T-491-BIND', EXECUTE_STEP_INDEX).error, REASON.PLAN_CHANGED_SINCE_APPROVAL)
    assert.match(db.prepare('SELECT output FROM step_run WHERE id = ?').get(run).output, /^FAILED: the run plan changed since it was approved/)
  } finally {
    pinImage(IMAGE)
  }
  assert.equal(store.approvedPlanCheck('T-491-BIND').ok, true, 'the approved runner holds again once the image is back')

  // A card loaded before the image changed: its runner no longer matches, so
  // the approval is refused and nothing is recorded.
  seedTask('T-491-STALE', { plan: runnerPlan(null), repo: IMAGE_REPO })
  const res = await approveAs('T-491-STALE', withSession(PIN), { planHash: sha256(runnerPlan(null)), runner: 'host' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'run_plan_changed' })
  assert.deepEqual(row('T-491-STALE'), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })

  // A plan approved before the runner was stored has none: re-approval needed.
  seedTask('T-491-LEGACY', { plan: runnerPlan(null), repo: BARE_REPO })
  db.prepare('UPDATE work_item SET cursor = ?, approved_plan_hash = ? WHERE id = ?').run(EXECUTE_STEP_INDEX, sha256(runnerPlan(null)), 'T-491-LEGACY')
  assert.equal(store.approvedPlanCheck('T-491-LEGACY').error, REASON.PLAN_CHANGED_SINCE_APPROVAL)
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
  orchestrator.cancel('T-EXEC') // HZ-378: the approval dispatched the Execute job — clear its watchdog so the process can exit
})

// ---- metric 4: Reject with feedback goes back to Run plan ----

// HZ-712: through POST /move's return, which replaced the send-back route.
test('rejecting at Approve the run moves the Task to Run plan, and the feedback rides in its next run', async () => {
  seedTask('T-REJECT')
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-REJECT/move',
    headers: withSession(PIN),
    payload: {
      action: 'return',
      from: stepKeyAt(APPROVE_RUN_GATE_INDEX),
      to: stepKeyAt(RUN_PLAN_STEP_INDEX),
      note: 'use the staging bucket, not prod',
    },
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
  orchestrator.cancel('T-LEAK') // HZ-378: the approval dispatched the Execute job — clear its watchdog so the process can exit
})

// ---- HO-843: per-command approval of a one-command owner patch ----

const { runPlanPatchHarness } = await import('./helpers/runPlanPatch.mjs')
const patching = runPlanPatchHarness({ db, store, orchestrator, app, dispatches, session: withSession(), pin: PIN })

test('HO-843 metric 1: approval stores one hash per command; patching command 2 nulls only its hash; its PIN re-approval writes one audit row naming it', async () => {
  seedTask('T-PCMD')
  await patching.approveInFull('T-PCMD')
  const before = patching.hashes('T-PCMD')
  assert.deepEqual(before, ['scripts/a.sh', 'scripts/b.sh', 'scripts/c.sh'].map(sha256), 'one sha256 per command, beside approved_plan_hash')
  assert.equal(patching.row('T-PCMD').approved_plan_hash, sha256(PLAN))
  assert.match(patching.row('T-PCMD').approved_frame_hash, /^[0-9a-f]{64}$/)
  assert.equal(patching.decisions('T-PCMD').at(-1).command_index, null, 'a full approval names no command')
  const frame = patching.row('T-PCMD').approved_frame_hash

  const NEW = 'scripts/b.sh --since 2026-11-01'
  const res = await patching.patchAtExecute('T-PCMD', 1, NEW)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual([res.json().ok, res.json().mode, res.json().commandIndex], [true, 'command', 1])
  // Only command 2's hash is cleared; the other two are byte-equal.
  assert.deepEqual(patching.hashes('T-PCMD'), [before[0], null, before[2]])
  assert.equal(patching.row('T-PCMD').approved_frame_hash, frame)
  assert.equal(patching.row('T-PCMD').approved_plan_hash, null)
  assert.equal(patching.row('T-PCMD').cursor, RUN_PLAN_STEP_INDEX)

  await patching.driveToGate('T-PCMD')
  const patched = patching.patchState('T-PCMD').artifact
  const shown = patching.view('T-PCMD').runPlan
  assert.deepEqual(shown.commandPatch, { index: 1, count: 3, before: 'scripts/b.sh', after: NEW, commandHash: sha256(NEW) })
  assert.equal(shown.hash, sha256(patched))

  const decided = patching.decisions('T-PCMD').length
  const ok = await patching.approveCommand('T-PCMD')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(patching.row('T-PCMD').cursor, EXECUTE_STEP_INDEX)
  assert.deepEqual(patching.hashes('T-PCMD'), [before[0], sha256(NEW), before[2]])
  // The whole hash is recomputed for the patched plan, so Execute's check passes.
  assert.equal(patching.row('T-PCMD').approved_plan_hash, sha256(patched))
  assert.deepEqual(store.approvedPlanCheck('T-PCMD'), { ok: true, hash: sha256(patched), runner: 'host' })
  assert.equal(patching.row('T-PCMD').command_patch_json, null)

  const rows = patching.decisions('T-PCMD').slice(decided)
  assert.equal(rows.length, 1, 'one audit entry for the re-approval')
  assert.deepEqual([rows[0].command_index, rows[0].command_hash, rows[0].plan_hash, rows[0].decided_by], [1, sha256(NEW), sha256(patched), 'Alice Example'])
  assert.ok(patching.view('T-PCMD').events.some((e) => e.text === 'approved: approve the run — command 2 of 3'))
  // No command text in the audit trail: the decision, the events or the moves.
  const trail = JSON.stringify([
    db.prepare("SELECT * FROM gate_decision WHERE item_id = 'T-PCMD'").all(),
    db.prepare("SELECT who, text, detail FROM event WHERE item_id = 'T-PCMD'").all(),
    db.prepare("SELECT note FROM item_move WHERE item_id = 'T-PCMD'").all(),
  ])
  for (const text of ['scripts/b.sh', NEW]) assert.ok(!trail.includes(text), `"${text}" is in the audit trail`)
  for (const line of logLines) assert.ok(!line.includes(NEW), `the new command is in a log line: ${line}`)

  // HO-843 metric 3: Execute is sent every approved hash and the carry marker.
  const job = await patching.dispatchFor('T-PCMD', EXECUTE_STEP_INDEX)
  assert.equal(job.approved_hash, sha256(patched))
  assert.deepEqual(job.approved_command_hashes, [before[0], sha256(NEW), before[2]])
  assert.equal(job.carry_through, 1)
  orchestrator.cancel('T-PCMD')
})

test('HO-843 guardrail 2: no PIN and a stale runner are refused; the per-command hashes do not change', async () => {
  seedTask('T-PNOPIN')
  await patching.approveInFull('T-PNOPIN')
  assert.equal((await patching.patchAtExecute('T-PNOPIN', 2, 'scripts/c.sh --fast')).statusCode, 200)
  await patching.driveToGate('T-PNOPIN')
  const waiting = patching.hashes('T-PNOPIN')
  assert.equal(waiting[2], null)

  const noPin = await patching.approveCommand('T-PNOPIN', {}, withSession())
  assert.equal(noPin.statusCode, 401)
  // The store's own bind too: a direct call with no proof is refused.
  const direct = await app.gateActions.approve('T-PNOPIN', APPROVE_RUN_GATE_INDEX, '', 'Caretaker', { commandIndex: 2, commandHash: sha256('scripts/c.sh --fast') })
  assert.deepEqual(direct, { error: 'human_pin_required', status: 403 })
  const stale = await patching.approveCommand('T-PNOPIN', { runner: 'container' })
  assert.equal(stale.statusCode, 409)
  assert.deepEqual(stale.json(), { error: 'run_plan_changed' })
  assert.deepEqual(patching.hashes('T-PNOPIN'), waiting)
  assert.equal(patching.row('T-PNOPIN').cursor, APPROVE_RUN_GATE_INDEX)
  assert.equal(patching.row('T-PNOPIN').approved_plan_hash, null)
})

test('HO-843 guardrail 2: a Run plan check that hands back a changed artifact fails the run and approves nothing', async () => {
  seedTask('T-PCHANGED')
  await patching.approveInFull('T-PCHANGED')
  assert.equal((await patching.patchAtExecute('T-PCHANGED', 0, 'scripts/a.sh --dry-run')).statusCode, 200)
  const changed = planArtifact(['scripts/a.sh --dry-run', 'scripts/b.sh', 'rm -rf /tmp/x'])
  await patching.completeStep('T-PCHANGED', RUN_PLAN_STEP_INDEX, { artifact_md: changed })
  const run = db.prepare("SELECT status, output FROM step_run WHERE item_id = 'T-PCHANGED' AND step_index = ? ORDER BY id DESC LIMIT 1").get(RUN_PLAN_STEP_INDEX)
  assert.equal(run.status, 'cancelled')
  assert.match(run.output, /^FAILED: the patched plan came back changed/)
  const after = patching.row('T-PCHANGED')
  assert.deepEqual([after.cursor, after.paused, after.approved_plan_hash, after.approved_command_hashes_json, after.command_patch_json], [RUN_PLAN_STEP_INDEX, 1, null, null, null])
  assert.equal(patching.view('T-PCHANGED').runPlan?.commandPatch ?? null, null)
})
