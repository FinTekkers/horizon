// HO-843: the owner patches one command of a Task's approved run plan
// (POST /api/items/:id/run-plan/patch). Only a one-command patch of a plan
// approved with per-command hashes keeps the other commands' approval; every
// other patch, and every doubt, clears them all and needs full approval. The
// patched plan is re-checked at Run plan, then Impact review and Preflight
// run, and only then does Approve the run show the command's diff. Every way
// out of a patch — approval, a failed check, a send-back, a return — clears
// it. A command that looks like a literal secret is refused by shape name.
//
// Driven through the real Fastify app with a stubbed farm (each /steps/run
// payload recorded); farm runs are completed and failed the way farmd's
// callbacks complete them. Metric 1 and guardrail 2's no-PIN case are in
// task-approve-run-gate.test.mjs; demo mode is run-plan-patch-demo.test.mjs.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-run-plan-patch-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_APPROVAL_SECRET']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  // HO-838: Execute's dispatch re-check finds no drift on this farm.
  if (String(url).includes('/preflight')) return { ok: true, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, kindStepIndex, stepKeyAt, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, IMPACT_REVIEW_STEP_INDEX, EXECUTE_STEP_INDEX, IMPLEMENT_STEP_INDEX } =
  await import('../../domain/js/lifecycle.js')
const { seedPreflight } = await import('./helpers/preflight.mjs')
const { runPlanPatchHarness, patchPlanArtifact: planArtifact, sha256 } = await import('./helpers/runPlanPatch.mjs')

store.purgeDemoItems()

const logLines = []
const app = buildApp({
  logger: {
    level: 'trace',
    stream: new Writable({
      write(chunk, _enc, done) {
        logLines.push(chunk.toString())
        done()
      },
    }),
  },
})
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

const PIN = 'hz843-PIN-qv9'
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Olive Owner' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, owner.user.id)
}
const session = { cookie: owner.cookie }
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('HO-843 project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

const ASSESS = kindStepIndex('Assess', 'task')
const COMMANDS = ['make lint', 'make test', 'make e2e']
const PLAN = planArtifact(COMMANDS)
const h = patchHarness()

function patchHarness() {
  return runPlanPatchHarness({ db, store, orchestrator, app, dispatches, session, pin: PIN })
}

const doneRun = (itemId, stepIndex, artifact) =>
  db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))")
    .run(itemId, stepIndex, STEPS[stepIndex].agent, artifact)

// A Task at Approve the run with a plan and a passing Preflight for it.
function seedTask(id, plan = PLAN) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task ${id}`,
    APPROVE_RUN_GATE_INDEX,
    projectId,
  )
  doneRun(id, ASSESS, '## Scripts found\n- make')
  doneRun(id, RUN_PLAN_STEP_INDEX, plan)
  doneRun(id, IMPACT_REVIEW_STEP_INDEX, '## Verdict\n**pass**')
  seedPreflight(db, store, id)
}

// A Task approved in full, at Execute with no job running.
async function approvedTask(id, plan = PLAN) {
  seedTask(id, plan)
  await h.approveInFull(id)
}

const allCleared = (id) => {
  const row = h.row(id)
  return row.approved_command_hashes_json === null && row.approved_frame_hash === null && row.command_patch_json === null
}
const eventsOf = (id) => db.prepare('SELECT who, text, detail FROM event WHERE item_id = ? ORDER BY id').all(id)

// ---- guardrail 1: the server's per-command hash is the farm's ----

test('commandHashesOf matches the shared fixture byte for byte (farm/task_job.py command_hash_of is the other half)', () => {
  const cases = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/run-plan-cases.json'), 'utf8')).command_hash
  assert.ok(cases.some((c) => /[^\x00-\x7f]/.test(c.command)), 'sanity: a non-ASCII case')
  assert.deepEqual(store.commandHashesOf({ commands: cases.map((c) => c.command) }), cases.map((c) => c.hash))
})

// ---- metric 5: the Approve card for k appears only after its checks pass ----

test('metric 5: the patch goes back to Run plan with no card; the farm re-checks the patched artifact, then Impact review and Preflight run, then the card names k', async () => {
  await approvedTask('T-POS')
  const res = await h.patchAtExecute('T-POS', 1, 'make test -k fast')
  assert.equal(res.statusCode, 200, res.body)
  const answer = res.json()
  assert.equal(answer.item.currentStepKey, 'task.run-plan')
  assert.equal(answer.patchedHash, sha256(h.patchState('T-POS').artifact))
  // No Approve card: the item is at Run plan and the view names no patch yet.
  assert.equal(h.row('T-POS').cursor, RUN_PLAN_STEP_INDEX)
  assert.equal(h.view('T-POS').runPlan.commandPatch, null)

  const runPlan = await h.dispatchFor('T-POS', RUN_PLAN_STEP_INDEX)
  assert.equal(runPlan.patched_artifact, h.patchState('T-POS').artifact)
  assert.equal(runPlan.runner, 'host')
  // The patched block differs from the approved one at command 2 only.
  const patchedBlock = JSON.parse(runPlan.patched_artifact.match(/```json run-plan\n([\s\S]*?)\n```/)[1])
  assert.deepEqual(patchedBlock.commands, ['make lint', 'make test -k fast', 'make e2e'])

  await h.completeStep('T-POS', RUN_PLAN_STEP_INDEX, { artifact_md: runPlan.patched_artifact })
  assert.equal(h.patchState('T-POS').checked, true)
  assert.equal(h.row('T-POS').cursor, IMPACT_REVIEW_STEP_INDEX)
  assert.notEqual(h.row('T-POS').cursor, APPROVE_RUN_GATE_INDEX, 'still no card while Impact review runs')
  const impact = await h.dispatchFor('T-POS', IMPACT_REVIEW_STEP_INDEX)
  assert.equal(impact.command_patch, true, 'Impact review leaves the task clone where the passed commands ran')

  await h.completeStep('T-POS', IMPACT_REVIEW_STEP_INDEX, { artifact_md: '## Verdict\n**pass**' })
  assert.notEqual(h.row('T-POS').cursor, APPROVE_RUN_GATE_INDEX, 'Preflight runs before the gate')
  await h.completeStep('T-POS', kindStepIndex('Preflight', 'task'), {
    artifact_md: '## Preflight',
    preflight: { passed: true, runner: 'host', run_user: 'ubuntu', unmet: [] },
    rehearsal: { clean: true, reason: null, scope: 'full', seconds: 3, failures: [] },
  })
  assert.equal(h.row('T-POS').cursor, APPROVE_RUN_GATE_INDEX)
  assert.deepEqual(h.view('T-POS').runPlan.commandPatch, { index: 1, count: 3, before: 'make test', after: 'make test -k fast', commandHash: sha256('make test -k fast') })
})

test('metric 5: a requires gap fails the patch check — the item stays at Run plan, every hash is cleared, and there is no card', async () => {
  await approvedTask('T-GAP')
  assert.equal((await h.patchAtExecute('T-GAP', 2, 'DEPLOY_ENV=$STAGING_ENV make e2e')).statusCode, 200)
  await h.dispatchFor('T-GAP', RUN_PLAN_STEP_INDEX)
  await h.failStep('T-GAP', RUN_PLAN_STEP_INDEX, 'the run plan needs what the runner lacks: env STAGING_ENV is not set')
  const row = h.row('T-GAP')
  assert.deepEqual([row.cursor, row.paused, row.approved_plan_hash], [RUN_PLAN_STEP_INDEX, 1, null])
  assert.ok(allCleared('T-GAP'), 'every per-command hash and the patch are gone')
  assert.equal(h.view('T-GAP').runPlan.commandPatch, null)
  assert.ok(eventsOf('T-GAP').some((e) => e.text.startsWith('the patched command did not pass its check — every approval of the plan is cleared')))
  // Forced to the gate, the plan needs full approval: a per-command approve is refused.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-GAP')
  const forced = await h.approve('T-GAP', { planHash: h.view('T-GAP').runPlan.hash, commandIndex: 2, commandHash: sha256('x') })
  assert.equal(forced.statusCode, 409)
})

// ---- metric 4: anything but one changed command needs full approval ----

test('metric 4: a plan approved without per-command hashes takes a full patch — every hash NULL, no diff card, full approval', async () => {
  await approvedTask('T-LEGACY')
  db.prepare("UPDATE work_item SET approved_command_hashes_json = NULL, approved_frame_hash = NULL WHERE id = 'T-LEGACY'").run()
  const res = await h.patchAtExecute('T-LEGACY', 0, 'make lint --fix')
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual([res.json().mode, res.json().commandIndex], ['full', null])
  assert.equal(h.row('T-LEGACY').approved_command_hashes_json, null)
  assert.equal(h.row('T-LEGACY').approved_frame_hash, null)
  await h.driveToGate('T-LEGACY')
  assert.equal(h.view('T-LEGACY').runPlan.commandPatch, null)
  const refused = await h.approveCommand('T-LEGACY', { commandIndex: 0, commandHash: sha256('make lint --fix') })
  assert.deepEqual([refused.statusCode, refused.json().error], [409, 'run_plan_changed'])
  const ok = await h.approveCommand('T-LEGACY')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(h.hashes('T-LEGACY'), ['make lint --fix', 'make test', 'make e2e'].map(sha256))
  assert.equal(h.decisions('T-LEGACY').at(-1).command_index, null)
  orchestrator.cancel('T-LEGACY')
})

test('metric 4: patching k, then j before approval, is a full patch with every hash NULL', async () => {
  await approvedTask('T-KJ')
  assert.equal((await h.patchAtExecute('T-KJ', 0, 'make lint --fix')).statusCode, 200)
  await h.driveToGate('T-KJ')
  // Re-patching the same command stays a one-command patch...
  const again = await h.patch('T-KJ', { from: stepKeyAt(APPROVE_RUN_GATE_INDEX), planHash: h.view('T-KJ').runPlan.hash, index: 0, command: 'make lint --fix --quiet' })
  assert.deepEqual([again.statusCode, again.json().mode], [200, 'command'])
  await h.driveToGate('T-KJ')
  // ...a second command is not.
  const second = await h.patch('T-KJ', { from: stepKeyAt(APPROVE_RUN_GATE_INDEX), planHash: h.view('T-KJ').runPlan.hash, index: 2, command: 'make e2e --headed' })
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual([second.json().mode, second.json().commandIndex], ['full', null])
  assert.equal(h.row('T-KJ').approved_command_hashes_json, null)
  assert.equal(h.row('T-KJ').approved_frame_hash, null)
  await h.driveToGate('T-KJ')
  assert.equal(h.view('T-KJ').runPlan.commandPatch, null)
})

for (const [name, rewrite] of [
  ['changes env', planArtifact(['make lint', 'make test -k fast', 'make e2e'], { env: { CI: '$CI_FLAG' } })],
  ['changes two commands', planArtifact(['make lint --fix', 'make test -k fast', 'make e2e'])],
]) {
  test(`metric 4: an agent rewrite that ${name} while a patch waits needs full approval`, async () => {
    const id = `T-RW-${name.split(' ')[1].toUpperCase()}`
    await approvedTask(id)
    assert.equal((await h.patchAtExecute(id, 1, 'make test -k fast')).statusCode, 200)
    await h.driveToGate(id)
    assert.ok(h.view(id).runPlan.commandPatch)
    doneRun(id, RUN_PLAN_STEP_INDEX, rewrite)
    seedPreflight(db, store, id)
    assert.equal(h.view(id).runPlan.commandPatch, null)
    const refused = await h.approveCommand(id, { commandIndex: 1, commandHash: sha256('make test -k fast') })
    assert.deepEqual([refused.statusCode, refused.json().error], [409, 'run_plan_changed'])
    const ok = await h.approveCommand(id)
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(h.row(id).approved_plan_hash, sha256(rewrite))
    assert.equal(h.decisions(id).at(-1).command_index, null)
    orchestrator.cancel(id)
  })
}

test('metric 4: a non-Task item is refused not_a_task and nothing changes', async () => {
  const cursor = IMPLEMENT_STEP_INDEX
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, paused) VALUES ('C-PATCH', 'Change', 'High', ?, ?, 1)").run(cursor, projectId)
  const res = await h.patch('C-PATCH', { from: stepKeyAt(cursor), planHash: 'x', index: 0, command: 'make test' })
  assert.deepEqual([res.statusCode, res.json().error], [409, 'not_a_task'])
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'C-PATCH'").get().cursor, cursor)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_move WHERE item_id = 'C-PATCH'").get().n, 0)
})

// ---- metric 4, guardrail 3: every doubt refuses, or clears every approval ----

test('guardrail 3: the stepKey approve while a patch waits is command_patch_pending; a wrong index or hash is run_plan_changed', async () => {
  await approvedTask('T-DOUBT')
  assert.equal((await h.patchAtExecute('T-DOUBT', 1, 'make test -k fast')).statusCode, 200)
  await h.driveToGate('T-DOUBT')
  const waiting = h.hashes('T-DOUBT')

  const byKey = await app.inject({
    method: 'POST',
    url: '/api/items/T-DOUBT/move',
    headers: { ...session, 'x-human-key': PIN },
    payload: { stepKey: 'task.execute', from: stepKeyAt(APPROVE_RUN_GATE_INDEX) },
  })
  assert.deepEqual([byKey.statusCode, byKey.json().error], [409, 'command_patch_pending'])
  for (const wrong of [{ commandIndex: 0 }, { commandHash: sha256('make test') }, { planHash: sha256(PLAN) }]) {
    const res = await h.approveCommand('T-DOUBT', wrong)
    assert.deepEqual([res.statusCode, res.json().error], [409, 'run_plan_changed'], JSON.stringify(wrong))
  }
  assert.deepEqual(h.hashes('T-DOUBT'), waiting)
  assert.equal(h.row('T-DOUBT').cursor, APPROVE_RUN_GATE_INDEX)
  assert.equal(h.decisions('T-DOUBT').length, 1, 'only the first, full approval')
})

test('guardrail 3: a stale planHash, a running job and a bad command are refused, and nothing is written', async () => {
  await approvedTask('T-STALE')
  const before = h.row('T-STALE')
  const stale = await h.patch('T-STALE', { from: 'task.execute', planHash: sha256('an older plan'), index: 0, command: 'make lint --fix' })
  assert.deepEqual([stale.statusCode, stale.json().error], [409, 'run_plan_changed'])
  const fromGate = await h.patch('T-STALE', { from: stepKeyAt(APPROVE_RUN_GATE_INDEX), planHash: before.approved_plan_hash, index: 0, command: 'make lint --fix' })
  assert.deepEqual([fromGate.statusCode, fromGate.json().error], [409, 'stale_step'])
  for (const [body, error] of [
    [{ index: 3, command: 'make x' }, 'bad_patch'],
    [{ index: 0, command: 'make lint\nrm -rf /' }, 'bad_patch'],
    [{ index: 0, command: 'make lint' }, 'no_change'],
  ]) {
    const res = await h.patch('T-STALE', { from: 'task.execute', planHash: before.approved_plan_hash, ...body })
    assert.deepEqual([res.statusCode, res.json().error], [400, error])
  }
  // A token is not a signed-in human.
  const { token } = auth.createApiToken(owner.user.id, 'scripts')
  const byToken = await h.patchAtExecute('T-STALE', 0, 'make lint --fix', { authorization: `Bearer ${token}` })
  assert.equal(byToken.statusCode, 403)
  assert.deepEqual(h.row('T-STALE'), before)

  await approvedTask('T-RUNNING')
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('T-RUNNING', ?, 2, 'DevOps', 'active')").run(EXECUTE_STEP_INDEX)
  const running = await h.patchAtExecute('T-RUNNING', 0, 'make lint --fix')
  assert.deepEqual([running.statusCode, running.json().error], [409, 'not_patchable'])
  db.prepare("UPDATE step_run SET status = 'cancelled' WHERE item_id = 'T-RUNNING' AND status = 'active'").run()
  assert.ok(h.hashes('T-RUNNING').every((x) => x !== null))
})

test('guardrail 3: Return to… Run plan while a patch waits clears every hash and the patch', async () => {
  await approvedTask('T-RETURN')
  assert.equal((await h.patchAtExecute('T-RETURN', 1, 'make test -k fast')).statusCode, 200)
  await h.driveToGate('T-RETURN')
  assert.equal(store.moveByHuman('T-RETURN', { action: 'return', toKey: 'task.run-plan', who: 'Olive Owner' }).ok, true)
  assert.ok(allCleared('T-RETURN'))
})

// ---- guardrail 3: every way out of a patch clears it ----

test('guardrail 3: an Impact review send-back while a patch waits drops it and every per-command hash', async () => {
  await approvedTask('T-SENDBACK')
  assert.equal((await h.patchAtExecute('T-SENDBACK', 2, 'psql -c "select 1"')).statusCode, 200)
  await h.completeStep('T-SENDBACK', RUN_PLAN_STEP_INDEX, { artifact_md: h.patchState('T-SENDBACK').artifact })
  await h.completeStep('T-SENDBACK', IMPACT_REVIEW_STEP_INDEX, {
    artifact_md: '## Verdict\n**concerns**',
    contract_gaps: [{ kind: 'tool', name: 'psql', command: 3 }],
  })
  assert.equal(h.row('T-SENDBACK').cursor, RUN_PLAN_STEP_INDEX)
  assert.ok(allCleared('T-SENDBACK'))
  // The next Run plan is an agent run: no patched artifact rides with it.
  const next = await h.dispatchFor('T-SENDBACK', RUN_PLAN_STEP_INDEX)
  assert.equal(Object.hasOwn(next, 'patched_artifact'), false)
})

// ---- metric 3: what Execute is sent ----

test('metric 3: after a full approval Execute gets every approved hash and no carry marker', async () => {
  seedTask('T-FULLJOB')
  const shown = h.view('T-FULLJOB')
  assert.equal((await h.approve('T-FULLJOB', { planHash: shown.runPlan.hash, runner: 'host' })).statusCode, 200)
  const job = await h.dispatchFor('T-FULLJOB', EXECUTE_STEP_INDEX)
  assert.deepEqual(job.approved_command_hashes, COMMANDS.map(sha256))
  assert.equal(Object.hasOwn(job, 'carry_through'), false)
  orchestrator.cancel('T-FULLJOB')
})

// ---- guardrail 4: a literal secret is refused by shape name ----

test('guardrail 4: a command with a literal token is refused 400 with shape names only; nothing stores or logs it', async () => {
  await approvedTask('T-SECRET')
  const before = h.row('T-SECRET')
  const token = ['gh', 'p_', 'Zq8Wm3Kd7Xr2Lp5Nv9Bt4Hy6'].join('')
  const res = await h.patchAtExecute('T-SECRET', 1, `GITHUB_TOKEN=${token} make test`)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'literal_secret', shapes: ['github-token', 'secret-assignment'] })
  assert.deepEqual(h.row('T-SECRET'), before)
  assert.ok(eventsOf('T-SECRET').some((e) => e.text.includes('looks like a literal secret (github-token, secret-assignment)')))
  const stored = JSON.stringify([
    db.prepare("SELECT * FROM work_item WHERE id = 'T-SECRET'").all(),
    db.prepare("SELECT * FROM event WHERE item_id = 'T-SECRET'").all(),
    db.prepare("SELECT * FROM gate_decision WHERE item_id = 'T-SECRET'").all(),
    db.prepare("SELECT * FROM item_move WHERE item_id = 'T-SECRET'").all(),
    db.prepare("SELECT output, artifact FROM step_run WHERE item_id = 'T-SECRET'").all(),
  ])
  assert.ok(!stored.includes(token), 'the token is stored somewhere')
  for (const line of logLines) assert.ok(!line.includes(token), `the token is in a log line: ${line}`)
})
