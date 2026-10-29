// HZ-449 metrics 2-4 and guardrails 2-3: approving a Plan's Approve & file
// (with the gate PIN) runs File items, which files every draft as a real
// GitHub issue through spawn.js, in dependency order, with each `#n` in text
// and dependencies rewritten to the real key. A filing that fails part-way
// keeps what it filed and its retry files only the rest; a second kick or a
// restart mid-filing files no duplicate. After filing the draft is not
// editable, and File items' output links every filed key.
//
// Driven through the real Fastify app and orchestrator on a stateful GitHub
// stub. Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-filing-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_SENTINEL'
process.env.HORIZON_UI_URL = 'https://horizon.test'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_NOTIFY_ENABLED']) delete process.env[key]

const stub = splitGithubStub()
stub.hooks.keepLabels = true
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const planDraft = await import('../src/planDraft.js')
const { filedMap } = await import('../src/planFiling.js')
const { priorityLabelName } = await import('../src/priorityLabels.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, kindStepIndex, APPROVE_FILE_GATE_INDEX, PLAN_DRAFT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

const app = buildApp({ logger: false })
await app.ready()
await orchestrator.init({ info() {}, warn() {}, error() {} })
await new Promise((r) => setTimeout(r, 50))

after(async () => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
  await app.close()
})

// This spec's own PIN, never one an earlier file set.
const PIN = 'f1le-PIN-hz449-zq'
const owner = loginFixtureUser(auth, config, { email: 'filer@example.com', name: 'Plan Filer' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, owner.user.id)
}

const FILE_ITEMS = kindStepIndex('File items', 'plan')
const REVIEW_CLOSE = kindStepIndex('Review & close', 'plan')
const [ALPHA, BETA, USERS] = ['acme/alpha', 'acme/beta', 'acme/users']

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Roadmap', 1, 'on')").run().lastInsertRowid)
for (const [repo, prefix] of [
  [ALPHA, 'AL'],
  [BETA, 'BE'],
  [USERS, 'US'],
]) {
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, repo, prefix)
}
// An existing item a draft depends on and names: filing never touches it.
db.prepare(
  "INSERT INTO work_item (id, title, priority, desc, cursor, repo, issue, project_id) VALUES ('US-216', 'Existing users API', 'Low', 'Already here.', 3, ?, 216, ?)",
).run(USERS, projectId)
stub.addIssue(USERS, { number: 216, title: 'Existing users API' })

const lines = (prefix) => [1, 2, 3].map((n) => `${prefix} line ${n}.`)
const draft = (id, repo, title, dependsOn, extra = {}) => ({
  id,
  repo,
  title,
  outcome: `${title}, done well.`,
  metric: lines(`${title} metric`),
  guardrails: lines(`${title} guardrail`),
  depends_on: dependsOn,
  must_also_cover: [],
  ...extra,
})
// Eight drafts over three repos, in display order. #6 names #3 in its text
// only, so it is filed after #3 although it is listed first.
const DOC = {
  items: [
    draft('#1', ALPHA, 'Lay the schema', []),
    draft('#2', BETA, 'Read the schema', ['#1'], { outcome: 'Reads what #1 lays down, through acme/alpha#7.' }),
    draft('#6', USERS, 'Users page', [], { outcome: 'Shows what #3 serves.', must_also_cover: ['the empty state'] }),
    draft('#3', USERS, 'Users endpoint', ['US-216'], { outcome: 'Extends US-216.', priority: 'Critical', lane: 'trivial' }),
    draft('#4', ALPHA, 'Join them', ['#2', '#3']),
    draft('#5', BETA, 'Backfill run', ['#4'], { kind: 'task', priority: 'Low' }),
    draft('#7', ALPHA, 'Wire it up', ['#5', '#6']),
    draft('#8', BETA, 'Next roadmap', ['#7'], { kind: 'plan' }),
  ],
  shared_guardrails: ['No new runtime dependency.'],
  open_questions: [],
}
const FILING_ORDER = ['#1', '#2', '#3', '#6', '#4', '#5', '#7', '#8']

let nextPlan = 90
function draftedPlan(doc = DOC, { local = false } = {}) {
  const issue = nextPlan++
  const id = `AL-${issue}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, issue) VALUES (?, ?, 'High', ?, 'plan', ?, ?, ?)",
  ).run(id, `Plan ${id}`, PLAN_DRAFT_STEP_INDEX, projectId, local ? null : ALPHA, local ? null : issue)
  const saved = planDraft.ingestDraft(store.getItem(id), null, doc, 'PM')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, id)
  return id
}

const approve = (id, pin = PIN, payload = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${APPROVE_FILE_GATE_INDEX}/approve`,
    headers: { cookie: owner.cookie, ...(pin ? { 'x-human-key': pin } : {}) },
    payload,
  })
const putDraft = (id, body) =>
  app.inject({ method: 'PUT', url: `/api/items/${id}/plan-draft`, headers: { cookie: owner.cookie, 'x-human-key': PIN }, payload: body })
const getDraft = (id) => app.inject({ method: 'GET', url: `/api/items/${id}/plan-draft`, headers: { cookie: owner.cookie } })

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const cursorOf = (id) => store.getItem(id).cursor
const keysOf = (id) => Object.fromEntries(Object.entries(filedMap(id)).map(([n, e]) => [n, e.key]))
const marker = (id) => `horizon-spawned-by: ${id} key=plan-file `
const planIssues = (id) => [ALPHA, BETA, USERS].flatMap((repo) => stub.repoIssues(repo).filter((i) => i.body.includes(marker(id))))
const planCreates = (id) => stub.creates().filter((c) => c.body.body.includes(marker(id)))
const filingRuns = (id) => db.prepare('SELECT status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(id, FILE_ITEMS)
const depsOf = (id) => db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ? ORDER BY depends_on_id').all(id).map((r) => r.depends_on_id)
const byId = new Map(DOC.items.map((d) => [d.id, d]))

let filedPlan
let filedKeys

test('an 8-draft Plan over 3 repos files every draft in dependency order, with every #n rewritten, while other items are created', async () => {
  const id = draftedPlan()
  // Other issues and local items appear between the filing's GitHub calls.
  let others = 0
  stub.hooks.beforeCreate = async (repo) => {
    const other = stub.addIssue(repo, { title: `Concurrent ${++others}` })
    store.upsertFromGithub(other, repo)
    await new Promise((r) => setTimeout(r, 1))
  }
  try {
    const res = await approve(id)
    assert.equal(res.statusCode, 200, res.body)
    await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
  } finally {
    stub.hooks.beforeCreate = null
  }
  assert.ok(others >= 8)

  const keys = keysOf(id)
  assert.deepEqual(Object.keys(keys).sort(), [...FILING_ORDER].sort())
  assert.deepEqual(filingRuns(id), [{ status: 'done' }])
  // Filed in dependency order: the spawn rows' insertion order.
  const order = db.prepare("SELECT seq FROM item_spawn WHERE parent_id = ? AND request_key = 'plan-file' ORDER BY id").all(id)
  assert.deepEqual(
    order.map((r) => `#${r.seq}`),
    FILING_ORDER,
  )

  const creates = planCreates(id)
  assert.equal(creates.length, 8)
  for (const [i, local] of FILING_ORDER.entries()) {
    const d = byId.get(local)
    const key = keys[local]
    const child = store.getItem(key)
    assert.equal(child.repo, d.repo, `${local} filed in the wrong repo`)
    // Each item's dependencies became edges to the real keys, all filed first.
    const expected = d.depends_on.map((dep) => keys[dep] ?? dep).sort()
    assert.deepEqual(depsOf(key), expected, `${local}'s edges`)
    for (const dep of d.depends_on.filter((dep) => dep.startsWith('#'))) assert.ok(FILING_ORDER.indexOf(dep) < i, `${local} filed before ${dep}`)
    // Its issue names the Plan and carries no plan-local id.
    const body = creates.find((c) => c.path === `/repos/${d.repo}/issues` && c.body.title === d.title).body.body
    assert.match(body, new RegExp(`Filed by Plan ${id}\\.`))
    assert.doesNotMatch(body, /(?<![\w/.-])#[1-9]/, `${local}'s issue still names a plan-local id`)
    assert.match(child.desc, new RegExp(`Filed by Plan ${id}`))
    assert.equal(child.kind, d.kind ?? 'change')
    assert.equal(child.lane, d.lane ?? null)
    assert.equal(child.priority, d.priority ?? 'High')
  }
  // Text references became real keys; a real key and owner/repo#n stayed.
  assert.match(store.getItem(keys['#2']).desc, new RegExp(`Reads what ${keys['#1']} lays down, through acme/alpha#7\\.`))
  assert.match(store.getItem(keys['#6']).desc, new RegExp(`Shows what ${keys['#3']} serves\\.\\n\\n\\*\\*Must also cover\\*\\*\\n- the empty state`))
  assert.match(store.getItem(keys['#3']).desc, /^Extends US-216\./)
  // The shared guardrail is on every item, after its own.
  assert.match(store.getItem(keys['#4']).guardrails, /Join them guardrail line 3\.\n- No new runtime dependency\./)
  // US-216 is untouched: no write to its issue, no new edge from it.
  const existing = store.getItem('US-216')
  assert.deepEqual([existing.title, existing.desc, existing.priority, existing.cursor], ['Existing users API', 'Already here.', 'Low', 3])
  assert.deepEqual(depsOf('US-216'), [])
  assert.deepEqual(stub.calls.filter((c) => c.method !== 'GET' && c.path.startsWith(`/repos/${USERS}/issues/216`)), [])
  // The Plan does not wait on what it filed.
  assert.deepEqual(depsOf(id), [])
  filedPlan = id
  filedKeys = keys
})

test('every filed issue carries exactly the labels its draft asked for', () => {
  const creates = planCreates(filedPlan)
  for (const d of DOC.items) {
    const create = creates.find((c) => c.path === `/repos/${d.repo}/issues` && c.body.title === d.title)
    const expected = [priorityLabelName(d.priority ?? 'High'), ...(d.kind && d.kind !== 'change' ? [d.kind] : []), ...(d.lane ? [d.lane] : [])]
    assert.deepEqual([...create.body.labels].sort(), expected.sort(), `${d.id}'s labels`)
  }
})

test("File items' output links every filed key, and the Review & close card shows it", () => {
  const { output } = db.prepare('SELECT output FROM step_run WHERE item_id = ? AND step_index = ?').get(filedPlan, FILE_ITEMS)
  for (const local of FILING_ORDER) {
    const key = filedKeys[local]
    assert.ok(output.includes(`- ${local} → [${key}](https://horizon.test/${key.toLowerCase()})`), `${key} is not linked:\n${output}`)
  }
  assert.equal(store.listItems().find((it) => it.id === filedPlan).stepOutputs[FILE_ITEMS].output, output)
})

test('after filing the draft is read-only: GET maps every #n, and PUT is refused with 409 not_editable — also after a send-back', async () => {
  const read = (await getDraft(filedPlan)).json()
  assert.equal(read.editable, false)
  for (const local of FILING_ORDER) assert.deepEqual(read.filed[local], { key: filedKeys[local], status: 'filed' })
  const edited = structuredClone(DOC)
  edited.items[0].title = 'Lay the schema again'
  const refused = await putDraft(filedPlan, { base_version: read.version, doc: edited })
  assert.equal(refused.statusCode, 409)
  assert.deepEqual(refused.json(), { error: 'not_editable' })
  // Back inside the edit window, a filed Plan still refuses.
  orchestrator.cancel(filedPlan)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, filedPlan)
  const again = await putDraft(filedPlan, { base_version: read.version, doc: edited })
  assert.deepEqual([again.statusCode, again.json()], [409, { error: 'not_editable' }])
  assert.equal(planDraft.currentDraft(filedPlan).version, read.version)
})

test('a filing that fails at draft #5 keeps #1-#4 and their keys; the retry files only the rest — 8 items, no duplicates', async () => {
  const id = draftedPlan()
  stub.hooks.afterCreate = () => {
    if (planCreates(id).length === 5) stub.hooks.createStatus[BETA] = 502 // #1, #2, #3, #6, #4 filed; #5 is next
  }
  try {
    assert.equal((await approve(id)).statusCode, 200)
    await until(() => store.getItem(id).paused, 'the failed filing to pause the Plan')
  } finally {
    stub.hooks.afterCreate = null
    delete stub.hooks.createStatus[BETA]
  }
  assert.equal(cursorOf(id), FILE_ITEMS)
  const first = filedMap(id)
  assert.equal(first['#5'].status, 'failed')
  assert.match(first['#5'].error, /GitHub returned 502/)
  const firstKeys = keysOf(id)
  for (const local of ['#1', '#2', '#3', '#4', '#6']) assert.equal(first[local].status, 'filed')

  assert.equal(store.setPaused(id, false).ok, true)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'the retry to finish')
  const keys = keysOf(id)
  assert.equal(Object.keys(keys).length, 8)
  assert.ok(Object.values(filedMap(id)).every((e) => e.status === 'filed' && e.key))
  for (const local of ['#1', '#2', '#3', '#4', '#6']) assert.equal(keys[local], firstKeys[local], `${local} got a new key`)
  assert.equal(planIssues(id).length, 8, 'exactly 8 issues')
  assert.equal(new Set(Object.values(keys)).size, 8, 'no duplicate key')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_spawn WHERE parent_id = ? AND request_key = 'plan-file'").get(id).n, 8)
  assert.deepEqual(depsOf(keys['#5']), [keys['#4']])
  assert.deepEqual(
    filingRuns(id).map((r) => r.status),
    ['cancelled', 'done'],
  )
})

test('a second kick while File items is filing is a no-op: one run, 8 issues', async () => {
  const id = draftedPlan()
  let release
  const held = new Promise((r) => (release = r))
  stub.hooks.beforeCreate = async () => {
    if (planCreates(id).length === 1) await held
  }
  try {
    assert.equal((await approve(id)).statusCode, 200)
    await until(() => planCreates(id).length === 1, 'the second create to start')
    orchestrator.kick(id)
    orchestrator.kick(id)
    assert.deepEqual(filingRuns(id), [{ status: 'active' }])
    release()
    await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
  } finally {
    stub.hooks.beforeCreate = null
  }
  assert.deepEqual(filingRuns(id), [{ status: 'done' }])
  assert.equal(planIssues(id).length, 8)
})

test('a restart mid-filing re-runs File items and files no duplicate, even of an issue created just before it', async () => {
  const id = draftedPlan()
  // The first run stops after three drafts…
  stub.hooks.afterCreate = () => {
    if (planCreates(id).length === 3) stub.hooks.createStatus[USERS] = 500 // #6 is next
  }
  try {
    assert.equal((await approve(id)).statusCode, 200)
    await until(() => store.getItem(id).paused, 'the first run to stop')
  } finally {
    stub.hooks.afterCreate = null
    delete stub.hooks.createStatus[USERS]
  }
  // …and the database is left as a crash would leave it: #6's issue exists on
  // GitHub but its row still says 'filing', and the run is still active.
  const row = db.prepare("SELECT * FROM item_spawn WHERE parent_id = ? AND request_key = 'plan-file' AND seq = 6").get(id)
  const payload = JSON.parse(row.payload_json)
  stub.addIssue(USERS, { title: payload.title, body: `Already created.\n\n<!-- ${marker(id)}seq=6 -->` })
  db.prepare("UPDATE item_spawn SET status = 'filing', error = NULL WHERE id = ?").run(row.id)
  db.prepare('UPDATE work_item SET paused = 0, paused_at = NULL WHERE id = ?').run(id)
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 2, 'Horizon', 'active')").run(id, FILE_ITEMS)
  // An agent run elsewhere is not a server step's: a restart leaves it alone.
  const other = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('US-216', 3, 1, 'PM', 'active')").run().lastInsertRowid

  // What boot does: close the server step's run, then resume the item.
  assert.equal(orchestrator.closeOrphanedServerRuns(), 1)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(other).status, 'active')
  db.prepare("UPDATE step_run SET status = 'cancelled' WHERE id = ?").run(other)
  orchestrator.kick(id)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'the re-run to finish')
  assert.equal(planIssues(id).length, 8, 'exactly 8 issues')
  assert.equal(planCreates(id).length, 8 + 1 - 1, 'one create per draft, plus the failed one, less the one the crash made')
  assert.deepEqual(
    filingRuns(id).map((r) => r.status),
    ['cancelled', 'cancelled', 'done'],
  )
})

test('a draft in a repo outside the Plan’s scope files nothing and pauses the Plan', async () => {
  const id = draftedPlan()
  store.setScopeRepos(id, [ALPHA, USERS])
  const before = stub.creates().length
  assert.equal((await approve(id)).statusCode, 200)
  await until(() => store.getItem(id).paused, 'the Plan to pause')
  assert.equal(stub.creates().length, before, 'an issue was created')
  assert.deepEqual(filedMap(id), {})
  assert.match(db.prepare('SELECT output FROM step_run WHERE item_id = ? AND step_index = ?').get(id, FILE_ITEMS).output, /#2's repo acme\/beta is not in the Plan's scope/)
})

test('Approve & file without the PIN is refused on Autopilot and files nothing', async () => {
  const id = draftedPlan()
  const before = stub.creates().length
  const res = await approve(id, null)
  assert.equal(res.statusCode, 401)
  assert.equal(cursorOf(id), APPROVE_FILE_GATE_INDEX)
  assert.equal(stub.creates().length, before)
  assert.equal(STEPS[APPROVE_FILE_GATE_INDEX].humanOnly, true)
})

// ---- HZ-642: one Autopilot choice for every item the Plan files ----

const OFF_LABEL = 'autopilot-off'
const hasOffLabel = (create) => (create.body.labels || []).includes(OFF_LABEL)
const autopilotOffOf = (key) => db.prepare('SELECT autopilot_off FROM work_item WHERE id = ?').get(key).autopilot_off
const fileApprovals = (id) =>
  db
    .prepare("SELECT decision, filed_autopilot FROM gate_decision WHERE item_id = ? AND step_index = ? ORDER BY id")
    .all(id, APPROVE_FILE_GATE_INDEX)
const spawnRows = (id) => db.prepare("SELECT COUNT(*) AS n FROM item_spawn WHERE parent_id = ? AND request_key = 'plan-file'").get(id).n

// The Plan back at Approve & file through a real send-back: the filing run is
// cancelled and the cursor put back at the gate (as the read-only test above
// does), then /reject sends it back to Draft items, and the redrafted Plan
// returns to the gate.
async function sendBackToGate(id) {
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, id)
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/reject`,
    headers: { cookie: owner.cookie, 'x-human-key': PIN },
    payload: { feedback: 'Not yet.', targetStepIndex: PLAN_DRAFT_STEP_INDEX },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorOf(id), PLAN_DRAFT_STEP_INDEX)
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, id)
}

test('HZ-642 metric 1: approving with "Off for these items" files every item with the autopilot-off label and autopilot_off = 1', async () => {
  const id = draftedPlan()
  const res = await approve(id, PIN, { filedAutopilot: 'off' })
  assert.equal(res.statusCode, 200, res.body)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
  assert.deepEqual(fileApprovals(id), [{ decision: 'approved', filed_autopilot: 'off' }])
  const creates = planCreates(id)
  assert.equal(creates.length, 8)
  for (const create of creates) assert.ok(hasOffLabel(create), `${create.body.title} was filed without ${OFF_LABEL}`)
  const keys = keysOf(id)
  for (const local of FILING_ORDER) assert.equal(autopilotOffOf(keys[local]), 1, `${local} imported with Autopilot on`)
})

test('HZ-642 metric 2: approving with "Project default" files every item without the label and autopilot_off = 0', async () => {
  const id = draftedPlan()
  const res = await approve(id, PIN, { filedAutopilot: 'default' })
  assert.equal(res.statusCode, 200, res.body)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
  assert.deepEqual(fileApprovals(id), [{ decision: 'approved', filed_autopilot: 'default' }])
  const creates = planCreates(id)
  assert.equal(creates.length, 8)
  for (const create of creates) assert.ok(!hasOffLabel(create), `${create.body.title} was filed with ${OFF_LABEL}`)
  const keys = keysOf(id)
  for (const local of FILING_ORDER) assert.equal(autopilotOffOf(keys[local]), 0)
})

test('HZ-642 metric 3: the choice is saved with each approval; after a send-back the re-approval files with its own choice', async () => {
  const id = draftedPlan()
  // The first filing stops at the scope check, before any draft is filed.
  store.setScopeRepos(id, [ALPHA, USERS])
  assert.equal((await approve(id, PIN, { filedAutopilot: 'off' })).statusCode, 200)
  await until(() => store.getItem(id).paused, 'the first filing to stop')
  assert.equal(spawnRows(id), 0, 'the old choice was frozen into a filing row')

  await sendBackToGate(id)
  store.setScopeRepos(id, [ALPHA, BETA, USERS])
  assert.equal((await approve(id, PIN, { filedAutopilot: 'default' })).statusCode, 200)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'the re-approved filing to finish')

  // Both approvals keep their own choice; the newest one filed the items.
  assert.deepEqual(fileApprovals(id), [
    { decision: 'approved', filed_autopilot: 'off' },
    { decision: 'rejected', filed_autopilot: null },
    { decision: 'approved', filed_autopilot: 'default' },
  ])
  const creates = planCreates(id)
  assert.equal(creates.length, 8)
  for (const create of creates) assert.ok(!hasOffLabel(create), `${create.body.title} was filed with the old choice`)
  const keys = keysOf(id)
  for (const local of FILING_ORDER) assert.equal(autopilotOffOf(keys[local]), 0)
})

test('HZ-642: items filed before a send-back are never relabelled by a re-approval with the other choice', async () => {
  const id = draftedPlan()
  stub.hooks.afterCreate = () => {
    if (planCreates(id).length === 5) stub.hooks.createStatus[BETA] = 502 // #1, #2, #3, #6, #4 filed; #5 fails
  }
  try {
    assert.equal((await approve(id, PIN, { filedAutopilot: 'off' })).statusCode, 200)
    await until(() => store.getItem(id).paused, 'the failed filing to pause the Plan')
  } finally {
    stub.hooks.afterCreate = null
    delete stub.hooks.createStatus[BETA]
  }
  const early = ['#1', '#2', '#3', '#6', '#4']
  const firstKeys = keysOf(id)
  const earlyIssues = early.map((local) => store.getItem(firstKeys[local]))
  for (const child of earlyIssues) assert.equal(child.autopilot_off, 1)
  const callsBefore = stub.calls.length

  await sendBackToGate(id)
  assert.equal((await approve(id, PIN, { filedAutopilot: 'default' })).statusCode, 200)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'the re-approved filing to finish')

  const keys = keysOf(id)
  for (const local of early) assert.equal(keys[local], firstKeys[local], `${local} was filed again`)
  // No label add, edit or removal on an issue filed before the send-back…
  const later = stub.calls.slice(callsBefore).filter((c) => c.method !== 'GET')
  for (const child of earlyIssues) {
    const issuePath = `/repos/${child.repo}/issues/${child.issue}`
    assert.deepEqual(
      later.filter((c) => c.path === issuePath || c.path.startsWith(`${issuePath}/`)),
      [],
      `${child.id}'s issue was written to`,
    )
    assert.equal(autopilotOffOf(child.id), 1, `${child.id} lost its Autopilot-off label`)
  }
  // …#5 keeps the choice its failed row froze, and the rest file with the new one.
  assert.equal(autopilotOffOf(keys['#5']), 1)
  for (const local of ['#7', '#8']) assert.equal(autopilotOffOf(keys[local]), 0)
  // US-216 stays untouched.
  assert.deepEqual(stub.calls.filter((c) => c.method !== 'GET' && c.path.startsWith(`/repos/${USERS}/issues/216`)), [])
})

for (const mode of ['off', 'shadow']) {
  test(`HZ-642: in the ${mode} project a posted "off" is stored as "default", logged, and files no label`, async () => {
    const id = draftedPlan()
    db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(mode, projectId)
    try {
      assert.equal((await approve(id, PIN, { filedAutopilot: 'off' })).statusCode, 200)
    } finally {
      db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)
    }
    await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
    assert.deepEqual(fileApprovals(id), [{ decision: 'approved', filed_autopilot: 'default' }])
    const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
    assert.ok(
      events.some((text) => text.includes(`Autopilot is ${mode} for this project`)),
      `no downgrade event: ${events.join(' | ')}`,
    )
    assert.ok(planCreates(id).every((create) => !hasOffLabel(create)))
  })
}

test('HZ-642: a Plan filed as local items (no GitHub repo) with "Off" files every item with autopilot_off = 1', async () => {
  const id = draftedPlan(DOC, { local: true })
  const before = stub.creates().length
  assert.equal((await approve(id, PIN, { filedAutopilot: 'off' })).statusCode, 200)
  await until(() => cursorOf(id) === REVIEW_CLOSE, 'File items to finish')
  assert.equal(stub.creates().length, before, 'a local Plan created a GitHub issue')
  const keys = keysOf(id)
  assert.equal(Object.keys(keys).length, 8)
  for (const local of FILING_ORDER) {
    assert.match(keys[local], /^LOC-\d+$/)
    assert.equal(autopilotOffOf(keys[local]), 1, `${local} was filed with Autopilot on`)
  }
})
