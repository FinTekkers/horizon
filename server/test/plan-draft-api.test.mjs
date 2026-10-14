// HZ-448 metrics 1 and 3: a Plan's Draft items reply is ingested as the
// Plan's first draft version, and an owner's edits of it are saved and
// re-validated as new versions. A malformed or missing draft, a guessed key
// and an edit that makes a cycle are each refused, and none of them saves
// anything. Nothing on any path here files an item, an issue or a dependency
// link: the row counts stay put and the GitHub stub sees no call.
//
// Driven through the real Fastify app and orchestrator.completeFarmRun, with
// a stubbed fetch recording every outbound call. Its own file because
// config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-draft-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_NOTIFY_ENABLED']) {
  delete process.env[key]
}

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, PLAN_DRAFT_STEP_INDEX, APPROVE_FILE_GATE_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')
const { REASON_IDS } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

// This spec's own PIN, never one an earlier file set.
const PIN = 'dr4ft-PIN-hz448-kx'
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Plan Owner' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, owner.user.id)
}

const fixtures = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/plan-draft-cases.json'), 'utf8'))
const BASE = fixtures.base

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Roadmap', 1)").run().lastInsertRowid)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/horizon', 'HZ')").run(projectId)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/ui-service', 'UI')").run(projectId)
// The real keys the fixture names: HZ-446 open, HZ-100 shipped (closed).
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES ('HZ-446', 'The Plan kind', 'High', 0, 'FinTekkers/horizon')").run()
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES ('HZ-100', 'Shipped long ago', 'High', ?, 'FinTekkers/horizon')").run(
  endIndex('change'),
)

let seq = 0
function seedPlan(cursor = PLAN_DRAFT_STEP_INDEX) {
  const id = `HZ-${900 + ++seq}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, ?, 'High', ?, 'plan', ?, 'FinTekkers/horizon')",
  ).run(id, `Plan fixture ${id}`, cursor, projectId)
  return id
}
const activeRun = (id, stepIndex = PLAN_DRAFT_STEP_INDEX) =>
  Number(
    db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
      .run(id, stepIndex, STEPS[stepIndex].agent).lastInsertRowid,
  )
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const draftRows = (id) => db.prepare('SELECT version, source, step_run_id, created_by FROM plan_draft WHERE item_id = ? ORDER BY version').all(id)
const runOf = (runId) => db.prepare('SELECT status, output, artifact FROM step_run WHERE id = ?').get(runId)
const lastEvent = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id).text

const filed = () => ({
  items: db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n,
  deps: db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency').get().n,
  spawns: db.prepare('SELECT COUNT(*) AS n FROM item_spawn').get().n,
})
const githubCalls = () => calls.filter((c) => c.url.includes('github.com'))

// Asserts `fn` files nothing: no item, dependency link or spawn row, no GitHub call.
async function filesNothing(fn) {
  const before = filed()
  calls.length = 0
  const result = await fn()
  assert.deepEqual(filed(), before, 'a work item, dependency link or spawn row was written')
  assert.deepEqual(githubCalls(), [], 'GitHub was called')
  return result
}

const complete = (runId, planDraft, extra = {}) =>
  orchestrator.completeFarmRun(runId, {
    summary: 'drafted the items',
    artifacts: { artifact_md: '## Drafts\nbody', ...(planDraft === undefined ? {} : { plan_draft: planDraft }), ...extra },
  })

// A Plan whose Draft has run, parked at Approve & file with no run active.
async function draftedPlan(cursor = APPROVE_FILE_GATE_INDEX) {
  const id = seedPlan()
  await complete(activeRun(id), BASE)
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(cursor, id)
  return id
}

const getDraft = (id) => app.inject({ method: 'GET', url: `/api/items/${id}/plan-draft`, headers: { cookie: owner.cookie } })
const putDraft = (id, body, { cookie = owner.cookie, pin = PIN } = {}) =>
  app.inject({
    method: 'PUT',
    url: `/api/items/${id}/plan-draft`,
    headers: { ...(cookie ? { cookie } : {}), ...(pin ? { 'x-human-key': pin } : {}) },
    payload: body,
  })

// ---- ingest ----

test('the mock Draft items reply, through completeFarmRun, saves draft v1 as the agent and moves the cursor on', async () => {
  const id = seedPlan()
  const item = store.getItem(id)
  const reply = await orchestrator.MOCK_STEP_BEHAVIOR['Draft items'](item)
  const runId = activeRun(id)
  const res = await filesNothing(() => orchestrator.completeFarmRun(runId, { summary: reply.summary, artifacts: { plan_draft: reply.plan_draft } }))
  assert.deepEqual(res, { ok: true })
  const [row, ...rest] = draftRows(id)
  assert.deepEqual(rest, [])
  assert.deepEqual([row.version, row.source, row.step_run_id], [1, 'agent', runId])
  assert.ok(row.created_by)
  assert.deepEqual((await getDraft(id)).json().doc, reply.plan_draft)
  assert.ok(cursorOf(id) > PLAN_DRAFT_STEP_INDEX, 'the cursor did not move past Draft items')
  assert.equal(runOf(runId).status, 'done')
  // The gate card's artifact carries the items table.
  assert.match(runOf(runId).artifact, /\| #1 \| `FinTekkers\/horizon` \| Lay the groundwork \| — \|/)
  assert.match(runOf(runId).artifact, /\| #2 \| `FinTekkers\/horizon` \| Build on the groundwork \| #1 \|/)
})

test('a draft naming a guessed key (HZ-999) fails the run, names the key and saves nothing', async () => {
  const id = seedPlan()
  const runId = activeRun(id)
  const guessed = structuredClone(BASE)
  guessed.items[1].depends_on = ['#1', 'HZ-999']
  await filesNothing(() => complete(runId, guessed))
  assert.deepEqual(draftRows(id), [])
  assert.equal(cursorOf(id), PLAN_DRAFT_STEP_INDEX)
  assert.match(runOf(runId).output, /^FAILED: invalid plan draft: unknown_key: HZ-999 is not an existing item/)
  assert.match(lastEvent(id), /^agent step failed \(invalid_plan_draft\): .*HZ-999.* — item paused; resume to retry$/)
})

test('a malformed draft (six metric lines) and a missing one each fail the run with a declared reason and save nothing', async () => {
  assert.ok(REASON_IDS.includes('invalid_plan_draft'))
  const sixLines = structuredClone(BASE)
  sixLines.items[0].metric = ['one', 'two', 'three', 'four', 'five', 'six']
  for (const [draft, expected] of [
    [sixLines, /invalid_shape: items\[0\]\.metric must have at most 5 entries/],
    [undefined, /invalid_shape: the reply carries no plan_draft/],
  ]) {
    const id = seedPlan()
    const runId = activeRun(id)
    await filesNothing(() => complete(runId, draft))
    assert.deepEqual(draftRows(id), [])
    assert.equal(cursorOf(id), PLAN_DRAFT_STEP_INDEX)
    assert.match(runOf(runId).output, expected)
    assert.match(lastEvent(id), /^agent step failed \(invalid_plan_draft\): /)
  }
})

test('a draft with a cycle fails the run and names the cycle', async () => {
  const id = seedPlan()
  const runId = activeRun(id)
  const cyclic = structuredClone(BASE)
  cyclic.items[0].depends_on = ['#2']
  await complete(runId, cyclic)
  assert.deepEqual(draftRows(id), [])
  assert.match(runOf(runId).output, /cycle: #1 → #2 → #1 \(at items\[1\]\.depends_on\[0\]\)/)
})

// ---- owner edits ----

test('three owner edits — a text change, a dropped row, a changed dependency — each save the next version and read back', async () => {
  const id = await draftedPlan()
  const first = await getDraft(id)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().version, 1)
  assert.equal(first.json().source, 'agent')
  assert.equal(first.json().editable, true)
  assert.deepEqual(first.json().doc, BASE)

  const edited = structuredClone(BASE)
  edited.items[0].outcome = 'A Plan produces structured drafts the server checks on every save.'
  const dropped = structuredClone(edited)
  dropped.items.splice(1, 1) // #2 is a leaf: nothing depends on it
  const rewired = structuredClone(dropped)
  rewired.items[1].depends_on = ['#1', 'HZ-100'] // #3 now also waits on a shipped item

  let version = 1
  for (const doc of [edited, dropped, rewired]) {
    const res = await filesNothing(() => putDraft(id, { base_version: version, doc }))
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { version: version + 1, doc })
    version += 1
    const read = (await getDraft(id)).json()
    assert.equal(read.version, version)
    assert.equal(read.source, 'owner')
    assert.equal(read.createdBy, 'Plan Owner')
    assert.deepEqual(read.doc, doc)
  }
  assert.deepEqual(
    draftRows(id).map((r) => [r.version, r.source]),
    [[1, 'agent'], [2, 'owner'], [3, 'owner'], [4, 'owner']],
  )
})

test('an edit that makes a cycle, or adds a guessed key, is refused with 422 and leaves the draft as it was', async () => {
  const id = await draftedPlan()
  const cyclic = structuredClone(BASE)
  cyclic.items[0].depends_on = ['#3']
  cyclic.items[2].depends_on = ['#1']
  const guessed = structuredClone(BASE)
  guessed.items[2].outcome = 'Shows the drafts as a table, after HZ-999 lands.'
  for (const [doc, code, named] of [
    [cyclic, 'cycle', '#1 → #3 → #1'],
    [guessed, 'unknown_key', 'HZ-999'],
  ]) {
    const res = await filesNothing(() => putDraft(id, { base_version: 1, doc }))
    assert.equal(res.statusCode, 422, res.body)
    assert.equal(res.json().error, 'invalid_plan_draft')
    assert.equal(res.json().errors[0].code, code)
    assert.ok(res.json().errors[0].message.includes(named), res.json().errors[0].message)
    const read = (await getDraft(id)).json()
    assert.equal(read.version, 1)
    assert.deepEqual(read.doc, BASE)
  }
})

test('PUT refuses a caller with no session, or a session with a wrong PIN, with 401', async () => {
  const id = await draftedPlan()
  const noSession = await putDraft(id, { base_version: 1, doc: BASE }, { cookie: null })
  assert.equal(noSession.statusCode, 401)
  const wrongPin = await putDraft(id, { base_version: 1, doc: BASE }, { pin: 'not-the-pin' })
  assert.equal(wrongPin.statusCode, 401)
  assert.deepEqual(wrongPin.json(), { error: 'human_gate_key_required' })
  assert.equal(draftRows(id).length, 1)
})

test('PUT refuses a stale base version with 409 and names the current one', async () => {
  const id = await draftedPlan()
  assert.equal((await putDraft(id, { base_version: 1, doc: BASE })).statusCode, 200)
  const stale = await putDraft(id, { base_version: 1, doc: BASE })
  assert.equal(stale.statusCode, 409)
  assert.deepEqual(stale.json(), { error: 'stale_version', currentVersion: 2 })
})

test('PUT refuses outside the edit window, on a closed or abandoned Plan, and while a run is active', async () => {
  const pastGate = await draftedPlan(APPROVE_FILE_GATE_INDEX + 1)
  const closed = await draftedPlan(endIndex('plan'))
  const abandoned = await draftedPlan()
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(abandoned)
  for (const id of [pastGate, closed, abandoned]) {
    const res = await putDraft(id, { base_version: 1, doc: BASE })
    assert.equal(res.statusCode, 409, `${id}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'not_editable' })
    assert.equal((await getDraft(id)).json().editable, false)
  }

  const busy = await draftedPlan(PLAN_DRAFT_STEP_INDEX + 1)
  activeRun(busy, PLAN_DRAFT_STEP_INDEX + 1)
  const running = await putDraft(busy, { base_version: 1, doc: BASE })
  assert.equal(running.statusCode, 409)
  assert.deepEqual(running.json(), { error: 'run_active' })
  orchestrator.cancel(busy)
  assert.equal((await putDraft(busy, { base_version: 1, doc: BASE })).statusCode, 200)
})

test('before Draft items has run there is no draft: GET and PUT answer 404 no_plan_draft', async () => {
  const id = seedPlan(APPROVE_FILE_GATE_INDEX)
  assert.deepEqual((await getDraft(id)).json(), { error: 'no_plan_draft' })
  const res = await putDraft(id, { base_version: 1, doc: BASE })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no_plan_draft' })
  assert.equal((await getDraft('HZ-NOPE')).statusCode, 404)
})
