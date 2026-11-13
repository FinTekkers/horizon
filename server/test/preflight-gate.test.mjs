// HO-837: the Preflight step's server half — its dispatch, its stored
// result, the Approve the run card's `runPlan.preflight`, and the PIN bind.
// The farm half (the checks themselves) is farm/tests/test_preflight.py.
//
// The stored-plan replays run the real farm code: the /steps/run body this
// server dispatched is handed to farm/preflight.py in a python process, as
// farmd would, and its result comes back through completeFarmRun.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { resolveFarmPython } from './helpers/farmd.mjs'
import { preflightPass } from './helpers/preflight.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-preflight-gate-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  const preflight = preflightPass(url)
  if (preflight) return preflight
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
const { buildApp } = await import('../src/app.js')
const { STEPS, stepKeyAt, stepsFor, APPROVE_RUN_GATE_INDEX, PREFLIGHT_STEP_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } =
  await import('../../domain/js/lifecycle.js')
const { seedPreflight } = await import('./helpers/preflight.mjs')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })
after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

const PIN = 'zq7-PIN-hz837-pf'
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, alice.user.id)
}
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Preflight project', 1)").run().lastInsertRowid)
const SENTINEL = 'hz837-server-sentinel-4f1a'

// The Task repo's deploy-target checkout: a real directory, so the farm code
// resolves the plan's cwd in it.
const REPO = 'acme/ledger'
const CHECKOUT = mkdtempSync(join(tmpdir(), 'horizon-preflight-checkout-'))
writeFileSync(join(CHECKOUT, 'requirements.txt'), 'grpcio\n')
db.prepare(
  `INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
    VALUES ('ledger', ?, 'deploy-horizon.sh', 'horizon-server', ?, 'ledger', 'http://127.0.0.1:9/', 'json-health')`,
).run(REPO, CHECKOUT)

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const artifactOf = (block) => `## Commands\n1. run\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify(block, null, 2)}\n\`\`\``
const SIMPLE = artifactOf({ cwd: '.', commands: ['bash -c "echo run"'], budget_minutes: 5, requires: [{ tool: 'bash' }] })

const doneRun = (id, stepIndex, artifact) =>
  db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))")
    .run(id, stepIndex, STEPS[stepIndex].agent, artifact).lastInsertRowid

// A Task at `cursor` with a Run plan on record (and the steps before it).
function seedTask(id, { cursor = APPROVE_RUN_GATE_INDEX, plan = SIMPLE, repo = REPO } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, ?, 'High', ?, 'task', ?, ?)").run(
    id,
    `Preflight fixture ${id}`,
    cursor,
    projectId,
    repo,
  )
  doneRun(id, RUN_PLAN_STEP_INDEX, plan)
  return id
}

const row = (id) => db.prepare('SELECT cursor, approved_plan_hash FROM work_item WHERE id = ?').get(id)
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const refusals = (id) => eventsOf(id).filter((t) => t.startsWith('could not approve “Approve the run”'))
const viewOf = (id) => store.itemViewById(id)
const approve = (id, payload = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie: alice.cookie, 'x-human-key': PIN },
    payload: { action: 'approve', from: stepKeyAt(APPROVE_RUN_GATE_INDEX), ...payload },
  })
const moveTo = (id, stepKey, from = stepKeyAt(APPROVE_RUN_GATE_INDEX)) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie: alice.cookie, 'x-human-key': PIN },
    payload: { stepKey, from, note: '' },
  })

// Puts the item on Preflight, lets the server dispatch it, and returns the
// active run and the /steps/run body it sent.
async function dispatchPreflight(id) {
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(PREFLIGHT_STEP_INDEX, id)
  const before = dispatches.length
  orchestrator.kick(id)
  for (let i = 0; i < 100 && !dispatches.slice(before).some((d) => d.body?.item?.id === id); i += 1) await new Promise((r) => setTimeout(r, 10))
  const body = dispatches.slice(before).find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)?.body
  assert.ok(body, `${id}: Preflight was dispatched`)
  const run = db.prepare("SELECT * FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, PREFLIGHT_STEP_INDEX)
  return { run, body }
}

// The real farm code on that body, with what farmd stamps.
function farmPreflight(body, { jobEnvNames = [], env = {} } = {}) {
  const script = [
    'import json, os, sys, time',
    'from farm import preflight',
    'task = json.load(sys.stdin)',
    // What farmd stamps (farmd._stamp_preflight_context): its job switch, the uid and the deploy.lock.
    'task.update(jobs_enabled=True, job_uid=os.geteuid(), deploy_lock_held=preflight.deploy_lock_held(task.get("deploy_state_key")))',
    'print(json.dumps(preflight.run(task, deadline=time.monotonic() + preflight.CAP_S)))',
  ].join('\n')
  const input = JSON.stringify({ ...body, job_env_names: jobEnvNames })
  const out = execFileSync(resolveFarmPython(REPO_ROOT), ['-c', script], { cwd: REPO_ROOT, input, encoding: 'utf8', env: { ...process.env, ...env } })
  return JSON.parse(out.trim().split('\n').at(-1))
}

async function completePreflight(runId, preflight) {
  const res = await orchestrator.completeFarmRun(runId, {
    summary: 'preflight ran',
    artifacts: { artifact_md: '## Preflight', ...(preflight === undefined ? {} : { preflight }) },
    step_key: 'task.preflight',
  })
  assert.equal(res.ok, true, JSON.stringify(res))
}

const PASSED = (runner = 'host') => ({ passed: true, runner, run_user: 'ubuntu', unmet: [] })

// ==== metric 1: the stored plans are blocked at the card, every name listed ====

for (const [name, jobEnvNames, expected] of [
  ['hz514', ['GITHUB_TOKEN'], ['HORIZON_API_TOKEN']],
  ['hz532', [], ['RECORD_SITE_URL', 'RECORD_ITEM']],
  ['hz533', ['TASK_ITEM'], ['PLAN_ITEM']],
]) {
  test(`metric 1: the stored ${name} plan is blocked at Approve the run, naming ${expected.join(' and ')}, and the PIN is refused`, async () => {
    const block = JSON.parse(readFileSync(join(REPO_ROOT, `farm/tests/fixtures/run_plans/${name}.json`), 'utf8'))
    const id = seedTask(`PF-${name}`, { plan: artifactOf(block) })
    const { run, body } = await dispatchPreflight(id)
    await completePreflight(run.id, farmPreflight(body, { jobEnvNames }))
    assert.equal(row(id).cursor, APPROVE_RUN_GATE_INDEX)

    const card = viewOf(id).runPlan.preflight
    assert.equal(card.status, 'unmet')
    const envNames = card.unmet.filter((u) => u.kind === 'env').map((u) => u.name)
    for (const variable of expected) assert.ok(envNames.includes(variable), `${variable} is on the card: ${JSON.stringify(card.unmet)}`)

    const res = await approve(id, { planHash: viewOf(id).runPlan.hash, runner: 'host' })
    assert.equal(res.statusCode, 409)
    const answer = res.json()
    assert.equal(answer.error, 'preflight_unmet')
    for (const variable of expected) assert.ok(answer.unmet.some((u) => u.kind === 'env' && u.name === variable))
    for (const u of answer.unmet) assert.deepEqual(Object.keys(u).sort(), ['kind', 'name', 'reason'])
    assert.deepEqual(row(id), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
    assert.equal(refusals(id).length, 1)
    assert.match(refusals(id)[0], /Preflight has \d+ unmet prerequisites? \(.*env/)
  })
}

test('metric 1: a valid PIN with no Preflight on record is refused preflight_missing — an item at the gate from before the step', async () => {
  const id = seedTask('PF-MISSING')
  const res = await approve(id)
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'preflight_missing' })
  assert.deepEqual(row(id), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
  assert.deepEqual(refusals(id), ['could not approve “Approve the run”: Preflight has not run for this plan — the gate stays open'])
  assert.equal(viewOf(id).runPlan.preflight.status, 'missing')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?").get(id).n, 0)
})

test('metric 1: a wrong PIN is refused as before, before anything about Preflight', async () => {
  const id = seedTask('PF-WRONG-PIN')
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie: alice.cookie, 'x-human-key': 'not-the-pin' },
    payload: { action: 'approve', from: stepKeyAt(APPROVE_RUN_GATE_INDEX) },
  })
  assert.notEqual(res.statusCode, 200)
  assert.ok(!JSON.stringify(res.json()).includes('preflight'))
})

// ==== metric 2: a running deploy of the repo's target, seen by the server ====

for (const status of ['publishing', 'deploying', 'verifying']) {
  test(`metric 2: a deploy batch ${status} for the repo's target blocks a passed Preflight, observe-only`, async () => {
    const id = seedTask(`PF-DEPLOY-${status}`)
    seedPreflight(db, store, id)
    const batch = db
      .prepare("INSERT INTO deploy_batch (target, repo, status, window_closes_at, tag) VALUES ('ledger', ?, ?, datetime('now'), ?)")
      .run(REPO, status, `v-${status}`).lastInsertRowid
    try {
      const card = viewOf(id).runPlan.preflight
      assert.equal(card.status, 'unmet')
      assert.deepEqual(card.unmet, [{ kind: 'deploy', name: 'ledger', reason: `a deploy of ledger v-${status} is ${status}` }])
      const res = await approve(id)
      assert.equal(res.json().error, 'preflight_unmet')
      assert.equal(db.prepare('SELECT status FROM deploy_batch WHERE id = ?').get(batch).status, status, 'the batch is only read')
    } finally {
      db.prepare("UPDATE deploy_batch SET status = 'done' WHERE id = ?").run(batch)
    }
    assert.equal(viewOf(id).runPlan.preflight.status, 'passed', 'a finished batch does not block')
    assert.equal((await approve(id)).statusCode, 200)
  })
}

test("metric 2: Horizon's own deploy drain (the block(now) hook) blocks a Horizon Task; a quiet drain does not", async () => {
  // The seeded `horizon` target's own repo.
  const horizonRepo = db.prepare("SELECT repo FROM deploy_target WHERE key = 'horizon'").get().repo
  const id = seedTask('PF-DRAIN', { repo: horizonRepo })
  seedPreflight(db, store, id)
  store.registerDeployDrainProvider({ block: () => ({ blocked: true }) })
  try {
    assert.deepEqual(store.runningDeployFor(horizonRepo), { target: 'horizon', tag: null, status: 'draining' })
    assert.deepEqual(viewOf(id).runPlan.preflight.unmet, [{ kind: 'deploy', name: 'horizon', reason: 'a deploy of horizon is draining' }])
    assert.equal((await approve(id)).json().error, 'preflight_unmet')
    assert.equal(store.runningDeployFor(REPO), null, 'another target is not drained')
  } finally {
    store.registerDeployDrainProvider({ block: () => null })
  }
  assert.equal(viewOf(id).runPlan.preflight.status, 'passed')
})

// ==== metric 3: Re-run preflight after a host fix, then the PIN is accepted ====

test('metric 3: a blocked Preflight, Re-run preflight from the gate, a pass, then the PIN is accepted', async () => {
  const id = seedTask('PF-RERUN', { plan: artifactOf({ cwd: '.', commands: ['hz837-tool'], budget_minutes: 5, requires: [{ tool: 'hz837-tool' }] }) })
  const first = await dispatchPreflight(id)
  await completePreflight(first.run.id, farmPreflight(first.body))
  assert.deepEqual(viewOf(id).runPlan.preflight.unmet, [{ kind: 'tool', name: 'hz837-tool', reason: "not on the runner's PATH" }])
  assert.equal((await approve(id)).json().error, 'preflight_unmet')

  // The host gets the tool.
  const bin = join(CHECKOUT, '..', `pf-bin-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'hz837-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const moved = await moveTo(id, 'task.preflight')
  assert.equal(moved.statusCode, 200, moved.body)
  assert.equal(row(id).cursor, PREFLIGHT_STEP_INDEX)
  for (let i = 0; i < 100 && !db.prepare("SELECT 1 FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, PREFLIGHT_STEP_INDEX); i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  const second = db.prepare("SELECT * FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, PREFLIGHT_STEP_INDEX)
  assert.equal(second.attempt, 2)
  const body = dispatches.filter((d) => d.body?.run_id === second.id).at(-1).body
  await completePreflight(second.id, farmPreflight(body, { env: { PATH: `${bin}:${process.env.PATH}` } }))
  assert.equal(viewOf(id).runPlan.preflight.status, 'passed')

  const res = await approve(id, { planHash: viewOf(id).runPlan.hash, runner: 'host' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(row(id).approved_plan_hash, viewOf(id).runPlan.hash)
  orchestrator.cancel(id)
})

test('metric 3: a plan whose prerequisites all hold passes on the first Preflight, and the PIN is accepted', async () => {
  const id = seedTask('PF-FIRST')
  const { run, body } = await dispatchPreflight(id)
  await completePreflight(run.id, farmPreflight(body))
  assert.equal(viewOf(id).runPlan.preflight.status, 'passed')
  assert.equal((await approve(id)).statusCode, 200)
  orchestrator.cancel(id)
})

test('metric 3: the newest Preflight run wins, in both orders, and a sub-step row never counts', async () => {
  const unmet = [{ kind: 'tool', name: 'jq', reason: "not on the runner's PATH" }]
  const a = seedTask('PF-NEWEST-A')
  seedPreflight(db, store, a)
  seedPreflight(db, store, a, { passed: false, unmet })
  assert.equal(viewOf(a).runPlan.preflight.status, 'unmet')
  assert.equal(store.preflightCheck(a).error, 'preflight_unmet')

  const b = seedTask('PF-NEWEST-B')
  seedPreflight(db, store, b, { passed: false, unmet })
  seedPreflight(db, store, b)
  assert.equal(viewOf(b).runPlan.preflight.status, 'passed')
  assert.deepEqual(store.preflightCheck(b), { ok: true })

  const subRun = seedPreflight(db, store, b, { passed: false, unmet })
  db.prepare("UPDATE step_run SET substep_id = 'pf-sub' WHERE id = ?").run(subRun)
  assert.equal(viewOf(b).runPlan.preflight.status, 'passed', 'a sub-step row is ignored')
})

// ==== metric 5: a stale Preflight never passes the PIN ====

test('metric 5: Preflight passed on plan A, the plan is now B — the PIN is refused preflight_stale', async () => {
  const id = seedTask('PF-STALE')
  seedPreflight(db, store, id)
  const planA = viewOf(id).runPlan.hash
  const planB = artifactOf({ cwd: '.', commands: ['bash -c "echo other"'], budget_minutes: 7 })
  doneRun(id, RUN_PLAN_STEP_INDEX, planB)
  assert.equal(viewOf(id).runPlan.preflight.status, 'stale')
  const res = await approve(id, { planHash: sha256(planB), runner: 'host' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'preflight_stale', preflightHash: planA, currentHash: sha256(planB), preflightRunner: 'host', runner: 'host' })
  assert.deepEqual(row(id), { cursor: APPROVE_RUN_GATE_INDEX, approved_plan_hash: null })
  assert.deepEqual(refusals(id), ['could not approve “Approve the run”: the plan changed since Preflight ran — the gate stays open'])
})

test('metric 5: the same hash checked on another runner is stale too', async () => {
  const id = seedTask('PF-STALE-RUNNER')
  seedPreflight(db, store, id, { runner: 'container' })
  assert.equal(viewOf(id).runPlan.preflight.status, 'stale')
  const res = await approve(id)
  assert.equal(res.json().error, 'preflight_stale')
  assert.equal(res.json().preflightRunner, 'container')
  assert.equal(res.json().runner, 'host')
})

// ==== guardrail 2: no result, or a malformed one, blocks ====

test('guardrail 2: a Preflight run that reports no result is stored as unmet probe "no result", and the PIN is refused', async () => {
  const id = seedTask('PF-NO-RESULT')
  const { run } = await dispatchPreflight(id)
  await completePreflight(run.id, undefined)
  const stored = JSON.parse(db.prepare('SELECT preflight_json FROM step_run WHERE id = ?').get(run.id).preflight_json)
  assert.deepEqual(stored, { passed: false, runner: null, run_user: null, unmet: [{ kind: 'probe', name: 'preflight', reason: 'no result' }] })
  assert.equal(viewOf(id).runPlan.preflight.status, 'unmet')
  assert.equal((await approve(id)).json().error, 'preflight_unmet')
})

test('guardrail 2: sanitizePreflight keeps names and reasons only, capped, and never turns a bad shape into a pass', () => {
  const long = 'x'.repeat(500)
  const clean = orchestrator.sanitizePreflight({ passed: false, runner: 'host', run_user: 'u', unmet: [{ kind: 'env', name: long, reason: long, value: SENTINEL }], extra: SENTINEL })
  assert.deepEqual(Object.keys(clean.unmet[0]), ['kind', 'name', 'reason'])
  assert.equal(clean.unmet[0].name.length, 200)
  assert.ok(!JSON.stringify(clean).includes(SENTINEL))
  assert.equal(orchestrator.sanitizePreflight({ passed: true, unmet: [{ kind: 'tool', name: 'jq', reason: 'r' }] }).passed, false)
  assert.equal(orchestrator.sanitizePreflight({ passed: 'yes', unmet: [] }).passed, false)
  assert.equal(orchestrator.sanitizePreflight({ passed: true, runner: 'moon', unmet: [] }).runner, null)
})

// ==== dispatch: a code-run step, bound to the plan it checks ====

test('the Preflight dispatch is code-run: the plan, its hash and runner, the deploy state and target tags — no inputs, no model', async () => {
  const plan = artifactOf({
    cwd: '.',
    commands: ['bash -c "echo run"'],
    budget_minutes: 5,
    requires: [{ service: { name: 'ledger', version_cmd: 'cat VERSION', expect: 'v1' } }, { service: { name: 'api.example.com', version_cmd: 'curl -fsS https://api.example.com', expect: '200' } }],
  })
  const id = seedTask('PF-DISPATCH', { plan })
  db.prepare("INSERT INTO feedback (item_id, target, message) VALUES (?, 'DevOps', 'a note for later')").run(id)
  const { run, body } = await dispatchPreflight(id)
  assert.equal(run.plan_hash, sha256(plan), 'the server binds the run to the plan at dispatch')
  assert.equal(run.runs_on, null, 'no model was picked')
  assert.equal(body.plan_artifact, plan)
  assert.equal(body.plan_hash, sha256(plan))
  assert.equal(body.runner, 'host')
  assert.equal(body.repo_dir, CHECKOUT)
  assert.equal(body.deploy_state_key, 'ledger')
  assert.equal(body.deploy_running, null)
  assert.deepEqual(body.service_tags, { ledger: null }, 'only deploy targets the plan names, with their last-good tag')
  assert.deepEqual(body.artifacts, [])
  assert.deepEqual(body.feedback, [])
  assert.ok(!('providerChoices' in body.item) && !('personas' in body.item) && !('rules' in body))
  assert.equal(db.prepare('SELECT delivered_at FROM feedback WHERE item_id = ?').get(id).delivered_at, null, 'feedback waits for a model step')
  orchestrator.cancel(id)
})

// ==== guardrail 3: Task only ====

test('guardrail 3: Preflight is a Task step only — a Plan item at a shifted index dispatches its own step, never Preflight', async () => {
  assert.equal(STEPS[PREFLIGHT_STEP_INDEX].itemKind, 'task')
  for (const kind of ['change', 'plan']) assert.ok(!stepsFor(kind).some((s) => s.codeRun), kind)
  const inventory = stepsFor('plan').find((s) => s.key === 'plan.inventory').index
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES ('PL-837', 'Plan', 'High', ?, 'plan', ?)").run(inventory, projectId)
  const before = dispatches.length
  orchestrator.kick('PL-837')
  for (let i = 0; i < 100 && !dispatches.slice(before).some((d) => d.body?.item?.id === 'PL-837'); i += 1) await new Promise((r) => setTimeout(r, 10))
  const sent = dispatches.slice(before).filter((d) => d.body?.item?.id === 'PL-837')
  assert.deepEqual(sent.map((d) => d.body.step.key), ['plan.inventory'])
  orchestrator.cancel('PL-837')
})

// ==== guardrail 4: names only ====

test('guardrail 4: a secret value set on the runner never reaches the stored result, the card, an event or the refusal', async () => {
  const block = JSON.parse(readFileSync(join(REPO_ROOT, 'farm/tests/fixtures/run_plans/hz514.json'), 'utf8'))
  const id = seedTask('PF-SECRET', { plan: artifactOf(block) })
  const { run, body } = await dispatchPreflight(id)
  await completePreflight(run.id, farmPreflight(body, { jobEnvNames: ['GITHUB_TOKEN'], env: { GITHUB_TOKEN: SENTINEL } }))
  const res = await approve(id)
  const stored = db.prepare('SELECT preflight_json, artifact, output FROM step_run WHERE id = ?').get(run.id)
  for (const text of [JSON.stringify(stored), JSON.stringify(viewOf(id).runPlan), eventsOf(id).join('\n'), res.body]) {
    assert.ok(!text.includes(SENTINEL))
  }
  assert.ok(viewOf(id).runPlan.preflight.unmet.some((u) => u.name === 'HORIZON_API_TOKEN'))
})

// ==== Execute's own refusals stay as the backstop ====

test("Execute's refuseUnapprovedRun still refuses an unapproved item, whatever Preflight says", async () => {
  const id = seedTask('PF-BACKSTOP', { cursor: EXECUTE_STEP_INDEX })
  seedPreflight(db, store, id)
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'DevOps', 'active')").run(id, EXECUTE_STEP_INDEX).lastInsertRowid,
  )
  assert.equal((await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)).error, 'plan_not_approved')
})
