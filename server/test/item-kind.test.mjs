// HZ-377a: every item has a kind — `change` or `task`. Items with no stored
// kind read as `change`, an unknown kind is refused, the change rows keep
// their labels, order and step numbers with the task rows after them, and a
// stored closed change cursor still reads closed. Cursor movement for a task
// (restart, send-back, gate advance) stays inside the task rows.
//
// Step positions are always derived through kindStepIndex/firstStepIndex/
// endIndex — never typed — so this file cannot go stale on an insertion the
// way a hardcoded cursor would.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-item-kind-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const {
  STEPS,
  isClosed,
  curStep,
  phaseIdx,
  itemKindOf,
  phasesFor,
  stepsFor,
  firstStepIndex,
  endIndex,
  kindStepIndex,
  requiredStepIndex,
  IMPLEMENT_STEP_INDEX,
} = await import('../../domain/js/lifecycle.js')

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
// A legacy row, written as if the kind column did not exist yet.
const insertLegacyItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

test('an item with no stored kind reads as change', () => {
  insertLegacyItem.run('K-LEGACY', 'Legacy item', 'Medium', firstStepIndex('change'))
  assert.equal(store.getItem('K-LEGACY').kind, 'change')
  assert.equal(
    store.listItems().find((it) => it.id === 'K-LEGACY').kind,
    'change',
  )
  assert.equal(itemKindOf({ cursor: firstStepIndex('change') }), 'change')
})

test('a stored task reads as task, through getItem and the list payload', () => {
  const assess = kindStepIndex('Assess', 'task')
  insertItem.run('K-TASK', 'Task item', 'Medium', assess, 'task')
  const item = store.getItem('K-TASK')
  assert.equal(item.kind, 'task')
  const view = store.listItems().find((it) => it.id === 'K-TASK')
  assert.equal(view.kind, 'task')
  assert.equal(view.currentStep.label, STEPS[assess].label)
  assert.equal(view.currentStep.phase, phasesFor('task')[STEPS[assess].phase])
})

test('creating an item with an unknown kind fails unknown_item_kind and writes nothing', () => {
  assert.deepEqual(
    store.createLocalItem({ title: 'Bad kind', outcome: 'o', metric: 'm', priority: 'Medium', kind: 'banana' }),
    { error: 'unknown_item_kind' },
  )
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id LIKE 'LOC-%'").get().n, 0)
})

test('creating an item without a kind stores a change at the first change step', () => {
  const id = store.createLocalItem({ title: 'Plain item', outcome: 'o', metric: 'm', priority: 'Medium' })
  const item = store.getItem(id)
  assert.equal(item.kind, 'change')
  assert.equal(item.cursor, firstStepIndex('change'))
})

test('index stability: change rows carry no kind marker and keep indices 0..N-1 in order', () => {
  const boundary = firstStepIndex('task')
  const changeRows = stepsFor('change')
  assert.deepEqual(
    changeRows.map((row) => row.index),
    changeRows.map((_, i) => i),
  )
  for (const row of changeRows) {
    assert.ok(!Object.prototype.hasOwnProperty.call(STEPS[row.index], 'itemKind'))
    assert.equal(STEPS[row.index].label, row.label)
  }
  assert.equal(endIndex('change'), boundary)
  // Global label resolution still lands on the change row at its own position.
  for (const row of changeRows) {
    assert.equal(requiredStepIndex(row.label), row.index)
    assert.equal(kindStepIndex(row.label, 'change'), row.index)
  }
})

test('index stability: every task row sits after every change row', () => {
  const changeMax = endIndex('change') - 1
  const taskRows = stepsFor('task')
  assert.ok(taskRows.length > 0)
  for (const row of taskRows) {
    assert.ok(row.index > changeMax, `task row "${row.label}" is not after the change rows`)
    assert.equal(STEPS[row.index].itemKind, 'task')
    assert.equal(kindStepIndex(row.label, 'task'), row.index)
  }
  assert.equal(firstStepIndex('task'), endIndex('change'))
  assert.equal(endIndex('task'), STEPS.length)
})

test('a change item stored with the old closed cursor still reads closed', () => {
  const closedCursor = endIndex('change')
  insertLegacyItem.run('K-OLD-CLOSED', 'Closed before kinds', 'Medium', closedCursor)
  const item = store.getItem('K-OLD-CLOSED')
  assert.equal(item.kind, 'change')
  assert.equal(isClosed(item), true)
  assert.equal(curStep(item), null)
  assert.equal(phaseIdx(item), phasesFor('change').length - 1)
})

test('restartPhase on a task restarts that kind\'s phase, never a change row', () => {
  insertItem.run('K-RESTART', 'Task restart', 'Medium', kindStepIndex('Run plan', 'task'), 'task')
  assert.deepEqual(store.restartPhase('K-RESTART', 1, 'try again'), { ok: true })
  assert.equal(store.getItem('K-RESTART').cursor, kindStepIndex('Assess', 'task'))
})

// HZ-384: Approve the run sends back to Run plan instead (task-approve-run-gate.test.mjs).
test('a send-back from a task gate walks to that kind\'s nearest agent step', () => {
  insertItem.run('K-SENDBACK', 'Task send-back', 'Medium', kindStepIndex('Approve & prioritize', 'task'), 'task')
  assert.deepEqual(store.requestChanges('K-SENDBACK', 'intake gate', 'needs work'), { ok: true })
  assert.equal(store.getItem('K-SENDBACK').cursor, kindStepIndex('Guardrails', 'task'))
})

test('a send-back naming a change step from a task gate is an invalid target', () => {
  insertItem.run('K-CROSS', 'Task cross-kind target', 'Medium', kindStepIndex('Approve the run', 'task'), 'task')
  assert.deepEqual(store.requestChanges('K-CROSS', 'run gate', 'wrong kind', 'You', IMPLEMENT_STEP_INDEX), {
    error: 'invalid_target',
  })
  assert.equal(store.getItem('K-CROSS').cursor, kindStepIndex('Approve the run', 'task'))
})

// HZ-384: Approve the run itself needs a human proof (task-approve-run-gate.test.mjs).
test('approving a task gate advances within the task rows', () => {
  const gate = kindStepIndex('Approve & prioritize', 'task')
  insertItem.run('K-ADVANCE', 'Task advance', 'Medium', gate, 'task')
  assert.deepEqual(store.approveGate('K-ADVANCE', gate, ''), { ok: true, closed: false })
  assert.equal(store.getItem('K-ADVANCE').cursor, kindStepIndex('Assess', 'task'))
})

test('a closed task reports its own final phase, not the change one', () => {
  assert.equal(
    phaseIdx({ cursor: endIndex('task'), kind: 'task' }),
    phasesFor('task').length - 1,
  )
  assert.equal(isClosed({ cursor: firstStepIndex('task'), kind: 'task' }), false)
})

// ---- HZ-382: POST /api/items takes a kind ----
//
// Through the real route. No-repo cases first: once a repo is connected below,
// the route takes the GitHub path for every later request in this file.

const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { setSetting } = await import('../src/settings.js')
const { loginFixtureUser } = await import('./helpers/session.mjs')

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { cookie } })
const NEW_ITEM = { title: 'Rotate the TLS cert', outcome: 'The cert is rotated before expiry.', metric: 'Expiry > 60 days' }
const storedKind = (id) => db.prepare('SELECT kind FROM work_item WHERE id = ?').get(id)?.kind
const itemCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n

test('POST /api/items, no repo: kind "task" stores a LOC- task at the first task step', async () => {
  const res = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'task' } })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.match(id, /^LOC-/)
  assert.equal(storedKind(id), 'task')
  assert.equal(store.getItem(id).cursor, firstStepIndex('task'))
})

test('POST /api/items, no repo: an unknown kind is 400 unknown_item_kind and stores nothing', async () => {
  const before = itemCount()
  const res = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'bogus' } })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'unknown_item_kind' })
  assert.equal(itemCount(), before)
})

test('POST /api/items/:id/priority with a kind leaves the stored kind unchanged', async () => {
  const created = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'task' } })
  const { id } = created.json()
  const res = await inject({ method: 'POST', url: `/api/items/${id}/priority`, payload: { priority: 'Low', kind: 'change' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT priority FROM work_item WHERE id = ?').get(id).priority, 'Low')
  assert.equal(storedKind(id), 'task')
})

// ---- the repo path, against a stubbed GitHub ----

const REPO = 'acme/item-kind-repo'
// Connected lazily by the first repo test: test bodies run after this whole
// module has loaded, so connecting at top level would flip the no-repo cases
// above onto the GitHub path too.
let repoConnected = false
function connectRepo() {
  if (repoConnected) return
  setSetting('github_token', 'test-token')
  const project = store.createProject('Item kind')
  const connected = store.addRepoToProject(project.id, REPO)
  assert.ok(connected.ok, `fixture repo must connect cleanly: ${JSON.stringify(connected)}`)
  repoConnected = true
}

let ghCalls = []
let failKindLabel = false
let nextIssue = 500
globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(String(url))
  const method = opts.method || 'GET'
  const body = opts.body ? JSON.parse(opts.body) : null
  ghCalls.push({ pathname, method, body })
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => '' })
  if (pathname === `/repos/${REPO}/labels` && method === 'POST') {
    if (failKindLabel && body.name === 'task') return reply(500, {})
    return reply(201, {})
  }
  if (pathname === `/repos/${REPO}/issues` && method === 'POST') {
    const number = nextIssue++
    return reply(201, {
      number,
      title: body.title,
      body: body.body,
      state: 'open',
      labels: body.labels.map((name) => ({ name })),
      html_url: `https://github.com/${REPO}/issues/${number}`,
    })
  }
  return reply(200, [])
}
const issuePosts = () => ghCalls.filter((c) => c.pathname === `/repos/${REPO}/issues` && c.method === 'POST')

test('POST /api/items, repo: kind "task" labels the issue `task` and stores a task', async () => {
  connectRepo()
  ghCalls = []
  const res = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'task' } })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.equal(storedKind(id), 'task')
  assert.equal(store.getItem(id).cursor, firstStepIndex('task'))
  assert.ok(issuePosts()[0].body.labels.includes('task'))
})

test('POST /api/items, repo: an omitted kind stores a change at cursor 0', async () => {
  connectRepo()
  ghCalls = []
  const res = await inject({ method: 'POST', url: '/api/items', payload: NEW_ITEM })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.equal(storedKind(id), 'change')
  assert.equal(store.getItem(id).cursor, 0)
  assert.ok(!issuePosts()[0].body.labels.includes('task'))
})

test('POST /api/items, repo: an unknown kind is 400 with no GitHub call', async () => {
  connectRepo()
  ghCalls = []
  const before = itemCount()
  const res = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'bogus' } })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'unknown_item_kind' })
  assert.deepEqual(ghCalls, [])
  assert.equal(itemCount(), before)
})

test('POST /api/items, repo: a Task whose `task` label cannot be created is 502, with no issue and no item', async () => {
  connectRepo()
  ghCalls = []
  failKindLabel = true
  try {
    const before = itemCount()
    const res = await inject({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, kind: 'task' } })
    assert.equal(res.statusCode, 502)
    assert.match(res.json().error, /task/)
    assert.deepEqual(issuePosts(), [])
    assert.equal(itemCount(), before)
  } finally {
    failKindLabel = false
  }
})
