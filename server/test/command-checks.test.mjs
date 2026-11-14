// HO-845: per-command re-approval runs contract audit, preflight and
// rehearsal on the patched command k, in that order, keyed by k's hash, before
// k's PIN Approve card. A stage that fails, errors, cannot run or times out
// sends the item back to Run plan, paused, naming the stage: k stays
// unapproved, every other command keeps its approval, nothing dispatches.
//
// Driven through the real Fastify app with a stubbed farm: every farm request
// is recorded, POST /commands/check answers as `farmReply` says, and each
// stage's result arrives on POST /api/farm/command-checks/:id/result as farmd
// posts it. The farm side (farm/command_checks.py) is
// farm/tests/test_command_checks.py; the card is Tracker.approveRun.test.jsx;
// demo mode is run-plan-patch-demo.test.mjs and e2e 73-task-command-checks.
//
// Its own file because config.js reads the environment at import time.

import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'horizon-command-checks-'))
process.env.HORIZON_DB = join(TMP, 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_APPROVAL_SECRET']) delete process.env[key]

// Metric 5: a fixture secret the plan names by reference, and a fixture file
// the plan names by path. Neither value may appear anywhere below.
const SECRET = 'hz845-fixture-secret-value-3a7f'
const FILE_CONTENTS = 'hz845-fixture-file-contents-b81c'
process.env.HZ845_FIXTURE_SECRET = SECRET
const FIXTURE_FILE = join(TMP, 'db.conf')
writeFileSync(FIXTURE_FILE, `password=${FILE_CONTENTS}\n`)

const dispatches = []
// What POST /commands/check answers: 'ok' (202), a status code, or 'refused' (ECONNREFUSED).
let farmReply = 'ok'
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  if (String(url).includes('/runs/status')) return { ok: true, status: 200, json: async () => ({ states: {} }) }
  if (String(url).endsWith('/commands/check')) {
    if (farmReply === 'refused') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    if (farmReply === 500) return { ok: false, status: 500, json: async () => ({ error: 'internal' }) }
    if (farmReply === 409) return { ok: false, status: 409, json: async () => ({ error: 'sandbox_unavailable' }) }
    return { ok: true, status: 202, json: async () => ({ accepted: true }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

// Every server log line: Fastify's logger, and anything written to stdout or stderr.
const logLines = []
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream)
  stream.write = (chunk, ...rest) => {
    logLines.push(String(chunk))
    return write(chunk, ...rest)
  }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { COMMAND_STAGE_TIMEOUT_MS } = await import('../src/commandChecks.js')
const { STEPS, kindStepIndex, stepKeyAt, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, IMPACT_REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { seedPreflight } = await import('./helpers/preflight.mjs')
const { runPlanPatchHarness, patchPlanArtifact: planArtifact, sha256 } = await import('./helpers/runPlanPatch.mjs')

store.purgeDemoItems()

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

const PIN = 'hz845-PIN-k2w'
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Olive Owner' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, owner.user.id)
}
const session = { cookie: owner.cookie }
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('HO-845 project', 1)").run().lastInsertRowid)

const ASSESS = kindStepIndex('Assess', 'task')
const COMMANDS = ['make lint', 'make test', 'make e2e']
const PLAN = planArtifact(COMMANDS, {
  env: { DB_URL: '$HZ845_FIXTURE_SECRET' },
  requires: [{ env: 'HZ845_FIXTURE_SECRET' }, { file: FIXTURE_FILE, access: 'r' }],
})
const K = 1
const NEW_K = 'make test -k fast'
const STAGES = ['audit', 'preflight', 'rehearsal']
const h = runPlanPatchHarness({ db, store, orchestrator, app, dispatches, session, pin: PIN })

const doneRun = (itemId, stepIndex, artifact) =>
  db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))")
    .run(itemId, stepIndex, STEPS[stepIndex].agent, artifact)

// A Task approved in full, at Execute with no job running, then command K
// patched and driven to Approve the run, its audit dispatched and pending.
async function patchedAtGate(id, command = NEW_K) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, 'task', ?)").run(id, `Task ${id}`, APPROVE_RUN_GATE_INDEX, projectId)
  doneRun(id, ASSESS, '## Scripts found\n- make')
  doneRun(id, RUN_PLAN_STEP_INDEX, PLAN)
  doneRun(id, IMPACT_REVIEW_STEP_INDEX, '## Verdict\n**pass**')
  seedPreflight(db, store, id)
  await h.approveInFull(id)
  const prior = approvals(id)
  const res = await h.patchAtExecute(id, K, command)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().mode, 'command')
  await h.driveToGate(id, { checks: false })
  // Metric 4, after the patch: every other command's hash, the frame and the
  // decisions are as approved. (HO-843's patch itself clears the whole-plan
  // hash and runner, which bind the old artifact; they stay cleared below.)
  const before = approvals(id)
  assert.deepEqual([before.others, before.frame, before.decisions], [prior.others, prior.frame, prior.decisions])
  assert.notEqual(prior.others, null)
  return before
}

const checks = (id) => db.prepare('SELECT * FROM command_check WHERE item_id = ? ORDER BY id').all(id)
const checkDispatches = (id) => dispatches.filter((d) => d.url.endsWith('/commands/check') && d.body?.item?.id === id).map((d) => d.body)
const stepDispatches = (id) => dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === id)
// Every approval record of the commands other than K, whole.
function approvals(id) {
  const row = h.row(id)
  const hashes = JSON.parse(row.approved_command_hashes_json ?? 'null')
  return {
    others: hashes?.map((x, i) => (i === K ? '<k>' : x)) ?? null,
    frame: row.approved_frame_hash,
    planHash: row.approved_plan_hash,
    runner: row.approved_runner,
    decisions: h.decisions(id),
  }
}
const result = (checkId, body) =>
  app.inject({ method: 'POST', url: `/api/farm/command-checks/${checkId}/result`, headers: { 'x-farm-secret': config.FARM_SHARED_SECRET }, payload: body })
async function answer(id, status = 'pass', extra = {}) {
  const check = await h.pendingCheck(id)
  const res = await result(check.id, { stage: check.stage, status, command_hash: check.command_hash, summary: {}, ...extra })
  assert.equal(res.statusCode, 200, res.body)
  return { check, body: res.json() }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
// The item as the board's item API serves it.
const getItem = async (id) => (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: session })).json().items.find((it) => it.id === id)

// After a fail: back at Run plan, paused, the failed stage named, no approval
// for K, every other approval unchanged, and nothing dispatched after a tick.
async function assertReturned(id, stage, reason, before) {
  const row = h.row(id)
  assert.deepEqual([row.cursor, row.paused], [RUN_PLAN_STEP_INDEX, 1])
  assert.equal(h.hashes(id)[K], null, 'k stays unapproved')
  assert.deepEqual(approvals(id), before, 'every other command keeps its approval')
  const view = h.view(id).runPlan.patchedCommand
  assert.deepEqual([view.failedStage, view.approvable], [stage, false])
  assert.equal(view.stages.find((s) => s.stage === stage).reason, reason)
  const later = STAGES.slice(STAGES.indexOf(stage) + 1)
  assert.ok(checks(id).every((c) => !later.includes(c.stage)), 'no later stage started')
  const steps = stepDispatches(id).length
  const sent = checkDispatches(id).length
  orchestrator.kick(id)
  await settle()
  assert.equal(stepDispatches(id).length, steps, 'no Run plan agent and no Execute after a tick')
  assert.equal(checkDispatches(id).length, sent)
  assert.deepEqual(approvals(id), before, 'still unchanged after the tick')
  const item = await getItem(id)
  assert.deepEqual([item.runPlan.patchedCommand.failedStage, item.runPlan.patchedCommand.approvable], [stage, false])
}

// ---- metric 1: in order, keyed by hash; the card only after the rehearsal ----

test('metric 1: audit, then preflight, then rehearsal — no later stage starts early, an out-of-order callback is stale, and approve waits for all three', async () => {
  const id = 'T-ORDER'
  const before = await patchedAtGate(id)
  const k = sha256(NEW_K)
  assert.deepEqual(checkDispatches(id).map((d) => [d.stage, d.command_index, d.command_hash]), [['audit', K, k]])
  assert.deepEqual(checks(id).map((c) => [c.stage, c.status]), [['audit', 'pending']])
  assert.equal(h.view(id).runPlan.patchedCommand.approvable, false)

  // A rehearsal result while the audit is pending is refused and writes nothing.
  const [audit] = checks(id)
  const early = await result(audit.id, { stage: 'rehearsal', status: 'pass', command_hash: k, summary: {} })
  assert.deepEqual([early.statusCode, early.json().error], [409, 'stale_check'])
  assert.deepEqual(checks(id).map((c) => [c.stage, c.status]), [['audit', 'pending']])

  for (const [i, stage] of STAGES.entries()) {
    const { body } = await answer(id)
    assert.equal(body.next, STAGES[i + 1] ?? null)
    if (stage === 'rehearsal') break
    // The next stage started, and nothing after it.
    assert.deepEqual(checkDispatches(id).map((d) => d.stage), STAGES.slice(0, i + 2))
    assert.deepEqual(checks(id).map((c) => c.stage), STAGES.slice(0, i + 2))
    assert.equal(h.view(id).runPlan.patchedCommand.approvable, false)
    // A valid PIN is refused until all three passed.
    const res = await h.approveCommand(id)
    assert.deepEqual([res.statusCode, res.json().error], [409, 'command_checks_incomplete'])
    assert.equal(h.hashes(id)[K], null)
    assert.deepEqual(approvals(id), before)
  }
  assert.deepEqual(h.view(id).runPlan.patchedCommand.stages.map((s) => s.status), ['pass', 'pass', 'pass'])
  assert.equal(h.view(id).runPlan.patchedCommand.approvable, true)
  assert.deepEqual(approvals(id), before, 'a pass changes no other approval')

  const ok = await h.approveCommand(id)
  assert.equal(ok.statusCode, 200, ok.body)
  const added = h.decisions(id).slice(before.decisions.length)
  assert.equal(added.length, 1)
  assert.deepEqual([added[0].command_index, added[0].command_hash], [K, k])
  assert.equal(h.hashes(id)[K], k)
  assert.deepEqual(h.hashes(id).filter((_, i) => i !== K), before.others.filter((_, i) => i !== K))
  orchestrator.cancel(id)
})

// ---- metric 2, metric 4: a fail at each stage ----

for (const stage of STAGES) {
  test(`metric 2: a failed ${stage} sends the item back to Run plan naming it — no approval for k, no later stage, nothing dispatched, others kept`, async () => {
    const id = `T-FAIL-${stage.toUpperCase()}`
    const before = await patchedAtGate(id)
    for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) assert.equal((await answer(id)).check.stage, earlier)
    const decisions = h.decisions(id).length
    const summary = {
      audit: { gaps: [{ kind: 'tool', name: 'jq' }] },
      preflight: { gaps: [{ kind: 'env', name: 'HZ845_FIXTURE_SECRET' }], env: [{ name: 'HZ845_FIXTURE_SECRET', set: false }] },
      rehearsal: { failures: [{ what: 'dry run', reason: 'rehearsal_dry_run_failed', exit: 1 }] },
    }[stage]
    const { check, body } = await answer(id, 'fail', { reason: 'command_check_failed', summary })
    assert.equal(check.stage, stage)
    assert.deepEqual(body, { ok: true, next: null, returnedTo: STEPS[RUN_PLAN_STEP_INDEX].label })
    assert.equal(h.decisions(id).length, decisions, 'no approval record for k')
    assert.ok(h.view(id).runPlan.patchedCommand.findings.length > 0)
    await assertReturned(id, stage, 'command_check_failed', before)
    // From Run plan, approve is refused; and even back at the gate the failed check refuses a valid PIN.
    assert.equal((await h.approveCommand(id)).statusCode, 409)
    db.prepare('UPDATE work_item SET cursor = ?, paused = 0 WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, id)
    const refused = await h.approveCommand(id)
    assert.deepEqual([refused.statusCode, refused.json().error, refused.json().failedStage], [409, 'command_check_failed', stage])
    assert.equal(h.decisions(id).length, decisions)
    assert.equal(h.hashes(id)[K], null)
  })
}

// ---- metric 3: an error, a refusal, an unreachable farm and a timeout are fails ----

for (const [name, stage, reply, reason] of [
  ['a farm 500', 'audit', 500, 'command_check_error'],
  ['ECONNREFUSED', 'preflight', 'refused', 'command_check_unavailable'],
  ['409 sandbox_unavailable', 'rehearsal', 409, 'command_check_unavailable'],
]) {
  test(`metric 3: ${name} handing the ${stage} to the farm is a fail — back to Run plan, k unapproved, nothing dispatched`, async () => {
    const id = `T-ERR-${stage.toUpperCase()}`
    farmReply = stage === 'audit' ? reply : 'ok'
    try {
      const before = await patchedAtGate(id)
      for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) {
        if (earlier === STAGES[STAGES.indexOf(stage) - 1]) farmReply = reply
        await answer(id)
      }
      await h.waitFor(() => checks(id).find((c) => c.stage === stage)?.status === 'fail', `the ${stage} to fail`)
      await assertReturned(id, stage, reason, before)
    } finally {
      farmReply = 'ok'
    }
  })
}

test('metric 3: a status "error" callback is a fail, never a pass', async () => {
  const id = 'T-ERR-CALLBACK'
  const before = await patchedAtGate(id)
  await answer(id)
  const { body } = await answer(id, 'error')
  assert.equal(body.returnedTo, STEPS[RUN_PLAN_STEP_INDEX].label)
  await assertReturned(id, 'preflight', 'command_check_error', before)
})

test('metric 3: a stage that runs past its timeout fails (mock timers, no sleep); a late pass is stale', async () => {
  const id = 'T-TIMEOUT'
  const before = await patchedAtGate(id)
  await answer(id)
  const preflight = await h.pendingCheck(id)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    assert.equal(orchestrator.settleCommandStage(preflight.id, { stage: 'preflight', status: 'pass', command_hash: preflight.command_hash }).next, 'rehearsal')
    await Promise.resolve()
    mock.timers.tick(COMMAND_STAGE_TIMEOUT_MS.rehearsal - 1)
    assert.equal(checks(id).at(-1).status, 'pending')
    mock.timers.tick(1)
  } finally {
    mock.timers.reset()
  }
  const rehearsal = checks(id).at(-1)
  assert.deepEqual([rehearsal.stage, rehearsal.status, rehearsal.reason], ['rehearsal', 'fail', 'command_check_timeout'])
  const late = await result(rehearsal.id, { stage: 'rehearsal', status: 'pass', command_hash: rehearsal.command_hash, summary: {} })
  assert.deepEqual([late.statusCode, late.json().error], [409, 'stale_check'])
  assert.equal(checks(id).at(-1).status, 'fail')
  await assertReturned(id, 'rehearsal', 'command_check_timeout', before)
})

test('metric 3: at boot, sweepStaleChecks fails a stale pending stage, returns the item and dispatches nothing; a late pass is stale', async () => {
  const id = 'T-SWEEP'
  const before = await patchedAtGate(id)
  const [audit] = checks(id)
  db.prepare("UPDATE command_check SET started_at = '2020-01-01 00:00:00' WHERE id = ?").run(audit.id)
  const sent = dispatches.length
  assert.equal(orchestrator.sweepStaleChecks(), 1)
  assert.equal(dispatches.length, sent, 'the sweep dispatches nothing')
  const late = await result(audit.id, { stage: 'audit', status: 'pass', command_hash: audit.command_hash, summary: {} })
  assert.deepEqual([late.statusCode, late.json().error], [409, 'stale_check'])
  await assertReturned(id, 'audit', 'command_check_timeout', before)
})

// ---- guardrail 1: the PIN ----

test('guardrail 1: with all three passed, an approve without the PIN is human_pin_required and approves nothing', async () => {
  const id = 'T-NOPIN'
  const before = await patchedAtGate(id)
  for (let i = 0; i < 3; i += 1) await answer(id)
  assert.equal(h.view(id).runPlan.patchedCommand.approvable, true)
  // The route wants the gate key; the store's own bind refuses a caller with no proof.
  const res = await h.approveCommand(id, {}, session)
  assert.equal(res.statusCode, 401)
  const plan = h.view(id).runPlan
  const direct = await app.gateActions.approve(id, APPROVE_RUN_GATE_INDEX, '', 'Caretaker', { planHash: plan.hash, commandIndex: K, commandHash: plan.commandPatch.commandHash })
  assert.deepEqual(direct, { error: 'human_pin_required', status: 403 })
  assert.equal(h.hashes(id)[K], null)
  assert.deepEqual(approvals(id), before)
  assert.equal(h.row(id).cursor, APPROVE_RUN_GATE_INDEX)
})

// ---- guardrail 3: no pass from before the patch or another command counts ----

test('guardrail 3: a re-patch of k needs fresh checks, even back to text that passed; another command\'s passes never unlock k; a hash mismatch is no pass', async () => {
  const id = 'T-REUSE'
  await patchedAtGate(id)
  for (let i = 0; i < 3; i += 1) await answer(id)
  assert.equal(h.view(id).runPlan.patchedCommand.approvable, true)

  const repatch = (command) =>
    h.patch(id, { from: stepKeyAt(APPROVE_RUN_GATE_INDEX), planHash: h.view(id).runPlan.hash, index: K, command })
  assert.equal((await repatch('make test -k slow')).statusCode, 200)
  await h.driveToGate(id, { checks: false })
  const refused = await h.approveCommand(id)
  assert.deepEqual([refused.statusCode, refused.json().error], [409, 'command_checks_incomplete'])

  // Pass rows for command 0 at its own hash do not unlock k.
  for (const stage of STAGES) {
    db.prepare("INSERT INTO command_check (item_id, command_index, command_hash, stage, status) VALUES (?, 0, ?, ?, 'pass')").run(id, sha256(COMMANDS[0]), stage)
  }
  assert.equal((await h.approveCommand(id)).json().error, 'command_checks_incomplete')

  // Back to the text that passed before: its old passes are superseded.
  assert.equal((await repatch(NEW_K)).statusCode, 200)
  await h.driveToGate(id, { checks: false })
  assert.deepEqual(h.view(id).runPlan.patchedCommand.stages.map((s) => s.status), ['pending', 'not_started', 'not_started'])
  assert.equal((await h.approveCommand(id)).json().error, 'command_checks_incomplete')

  // A result for another hash is stale; the farm's re-hash mismatch is a fail.
  const audit = await h.pendingCheck(id)
  const wrong = await result(audit.id, { stage: 'audit', status: 'pass', command_hash: sha256('make test -k slow'), summary: {} })
  assert.deepEqual([wrong.statusCode, wrong.json().error], [409, 'stale_check'])
  await answer(id, 'fail', { reason: 'command_hash_changed' })
  assert.equal(checks(id).at(-1).reason, 'command_hash_changed')
  assert.equal(h.view(id).runPlan.patchedCommand.failedStage, 'audit')
  assert.equal(h.hashes(id)[K], null)
})

test('guardrail 3: the hash each stage is bound to is the shared fixture\'s, non-ASCII included', async () => {
  const cases = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/run-plan-cases.json'), 'utf8')).command_hash
  const unicode = cases.find((c) => /[^\x00-\x7f]/.test(c.command))
  await patchedAtGate('T-UNICODE', unicode.command)
  assert.equal(checkDispatches('T-UNICODE')[0].command_hash, unicode.hash)
  assert.equal(checks('T-UNICODE')[0].command_hash, unicode.hash)
})

// ---- metric 5: values never stored, logged or answered ----

test('metric 5: the fixture secret and file contents appear in no check row, rehearsal summary, farm payload, log line or item API body; a value in an allowed field is refused', async () => {
  const id = 'T-REDACT'
  await patchedAtGate(id)
  // A value smuggled into an allowed field is refused, stored nowhere, echoed nowhere.
  const audit = await h.pendingCheck(id)
  for (const smuggled of [
    { reason: SECRET },
    { summary: { gaps: [{ kind: 'env', name: `${SECRET} ${FILE_CONTENTS}` }] } },
    { summary: { gaps: [{ kind: SECRET, name: 'jq' }] } },
    { summary: { env: [{ name: SECRET, set: false }] } },
    { summary: { files: [{ path: FIXTURE_FILE, readable: false, contents: FILE_CONTENTS }] } },
    { summary: { failures: [{ what: FILE_CONTENTS, reason: 'rehearsal_parser_failed', exit: 1 }] } },
    { value: SECRET },
  ]) {
    const res = await result(audit.id, { stage: 'audit', status: 'fail', command_hash: audit.command_hash, ...smuggled })
    assert.deepEqual([res.statusCode, res.json()], [400, { error: 'bad_body' }], JSON.stringify(smuggled).slice(0, 80))
    assert.ok(!res.body.includes(SECRET) && !res.body.includes(FILE_CONTENTS))
  }
  assert.equal(checks(id)[0].status, 'pending')
  // Names and flags only, then a rehearsal fail with its reason ids.
  await answer(id, 'pass', { summary: { gaps: [] } })
  await answer(id, 'pass', { summary: { env: [{ name: 'HZ845_FIXTURE_SECRET', set: true }], files: [{ path: FIXTURE_FILE, readable: true }] } })
  await answer(id, 'fail', { summary: { failures: [{ what: 'proof command 1 (metric line 1)', reason: 'rehearsal_parser_failed', exit: 5 }] } })
  const approve = await h.approve(id, { planHash: 'x' })

  const surfaces = [
    JSON.stringify(checks(id)),
    JSON.stringify(checkDispatches(id)),
    approve.body,
    JSON.stringify(await getItem(id)),
    (await app.inject({ method: 'GET', url: '/api/items', headers: session })).body,
    (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: session })).body,
    JSON.stringify(db.prepare('SELECT * FROM event WHERE item_id = ?').all(id)),
    JSON.stringify(db.prepare('SELECT * FROM feedback WHERE item_id = ?').all(id)),
    logLines.join(''),
  ]
  const rehearsal = checks(id).find((c) => c.stage === 'rehearsal')
  assert.deepEqual(JSON.parse(rehearsal.summary_json), { failures: [{ what: 'proof command 1 (metric line 1)', reason: 'rehearsal_parser_failed', exit: 5 }] })
  for (const text of surfaces) {
    assert.ok(!text.includes(SECRET), 'no secret value')
    assert.ok(!text.includes(FILE_CONTENTS), 'no file contents')
  }
  assert.ok(logLines.some((line) => line.includes('bad_body')), 'the refusals were logged — without the value')
})
