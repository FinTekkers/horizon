// HO-875 metrics 4 and 5, guardrails 1 and 3: one sl item's whole journey
// through the real Fastify app — create, a feedback comment, one poll tick,
// the final gate, then a reload on the same database — with farmd stubbed
// (helpers/farmTasksStub.mjs).
//
//   - Metric 4: the final gate closes the item's Task through farmd, once,
//     with a non-empty summary and reason 'completed'. A farm refusal leaves
//     the gate open (502, cursor unchanged, a "Task close failed" event), and
//     approving again closes the item once farmd answers already_closed.
//   - Metric 5 / guardrail 1: every fetch URL is farmd's Task routes
//     (^http://farm.test/api/farm/tasks) — so no api.github.com,
//     delegate-to-agent or claim call — and child_process records no spawn
//     (no git, no gh). Positive controls prove both interceptors see a call.
//   - Guardrail 3: FARM_SHARED_SECRET is a sentinel. It reaches farmd in the
//     header and nowhere else: not the fastify log, item events or any
//     response body, the refusal paths included.

import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { loginFixtureUser } from './helpers/session.mjs'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'

const SENTINEL = 'farm-secret-SENTINEL-ho875-never-logged'
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'horizon-sl-no-github-')), 'test.db')
process.env.HORIZON_DB = DB_PATH
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = SENTINEL
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN']) delete process.env[key]

// ---- the interceptors, before any server module loads ----

const farm = createFarmTasksStub({ secret: SENTINEL })
const fetched = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  fetched.push(String(input))
  return farm.fetch(input, init)
}
const spawns = []
const childProcess = createRequire(import.meta.url)('node:child_process')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name]
  mock.method(childProcess, name, function spied(...args) {
    spawns.push(`${name} ${String(args[0])}`)
    return original.apply(this, args)
  })
}
syncBuiltinESMExports()

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { forKind } = await import('../src/backends/index.js')
const { endIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { spawnGitVersion } = await import('./helpers/spawnProbe.mjs')
const { CLOSED_KEY } = await import('../src/moveItem.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const logLines = []
const logger = { level: 'trace', stream: { write: (line) => logLines.push(line) } }
const app = buildApp({ logger })
await app.ready()
const { cookie, pin } = loginFixtureUser(auth, config)
const responses = []
async function inject(opts) {
  const res = await app.inject({ ...opts, headers: { cookie, 'x-human-key': pin, ...opts.headers } })
  responses.push(res.body)
  return res
}
const pollLog = { info: (m) => logLines.push(String(m)), warn: (m) => logLines.push(String(m)), error() {}, debug() {} }

after(async () => {
  globalThis.fetch = realFetch
  mock.restoreAll()
  syncBuiltinESMExports()
  await app.close()
})

const REPO = 'acme/sl-journey'
const project = store.createProject('sl journey').id
assert.equal(store.addRepoToProject(project, REPO, 'sl').ok, true)

const FARM_TASKS = /^http:\/\/farm\.test\/api\/farm\/tasks(\/|\?|$)/
const until = async (check, what) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(check(), `timed out waiting for ${what}`)
}
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const finalGate = (kind) => endIndex(kind) - 1
const approveFinal = (id, kind) =>
  inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(finalGate(kind)) } })
const createItem = async (title) => {
  const res = await inject({ method: 'POST', url: '/api/items', payload: { title, outcome: 'The journey runs end to end.', metric: 'One Task closes with a summary.', repo: REPO } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

test('positive controls: the fetch and child_process interceptors each see a real call', async () => {
  await assert.rejects(() => globalThis.fetch('https://api.github.com/zen'))
  assert.deepEqual(farm.strays, ['GET https://api.github.com/zen'])
  spawnGitVersion()
  assert.equal(spawns.length, 1)
  farm.strays.length = 0
  fetched.length = 0
  spawns.length = 0
})

test('the journey: create → feedback comment → poll tick → final gate closes the Task with a summary → reload', async () => {
  // Create: one Task, its number in task_id.
  const created = await createItem('Journey item')
  const { id, task_id: task } = created
  assert.equal(created.issue, null)
  assert.equal(farm.callsTo('create').length, 1)
  assert.equal(store.getItem(id).task_id, String(task))

  // A feedback note is mirrored onto the Task, once, with Horizon's footer.
  const note = await inject({ method: 'POST', url: `/api/items/${id}/feedback`, payload: { message: 'Mind the empty state.' } })
  assert.equal(note.statusCode, 200, note.body)
  await until(() => farm.callsTo('comment').length === 1, 'the mirrored comment')
  const [comment] = farm.callsTo('comment')
  assert.equal(comment.path, `/api/farm/tasks/${task}/comments`)
  assert.match(comment.body.body, /Mind the empty state\.[\s\S]*posted by Horizon_/)

  // One poll tick: a comment left on the Task outside Horizon becomes
  // feedback; Horizon's own mirrored comment does not come back.
  farm.addOutsideComment(task, 'Please also cover the error state.')
  const polled = await forKind('sl').tracker.pollOnce(pollLog)
  assert.equal(polled.changed, 1)
  const feedback = db.prepare('SELECT message, source, task_comment_id FROM feedback WHERE item_id = ? ORDER BY id').all(id)
  assert.deepEqual(
    feedback.map((f) => [f.message, f.source]),
    [
      ['Mind the empty state.', 'ui'],
      ['Please also cover the error state.', 'sl'],
    ],
  )
  assert.ok(Number.isInteger(feedback[1].task_comment_id))
  // A second tick ingests nothing new.
  assert.equal((await forKind('sl').tracker.pollOnce(pollLog)).changed, 0)

  // The final gate: one farmd close, completed, with a non-empty summary.
  const kind = store.getItem(id).kind
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(finalGate(kind), id)
  const approved = await approveFinal(id, kind)
  assert.equal(approved.statusCode, 200, approved.body)
  const closes = farm.callsTo('close')
  assert.equal(closes.length, 1)
  assert.equal(closes[0].path, `/api/farm/tasks/${task}/close`)
  assert.equal(closes[0].body.reason, 'completed')
  assert.ok(closes[0].body.summary.trim().length > 0)
  assert.match(closes[0].body.summary, /One Task closes with a summary\./)
  assert.equal(farm.tasks.get(task).state, 'closed')
  assert.equal(store.getItem(id).cursor, endIndex(kind))
  assert.ok(eventsOf(id).includes(`closed Task ${task} with a summary`), eventsOf(id).join('\n'))

  // The next poll sees the closed Task on a closed item: nothing changes.
  assert.equal((await forKind('sl').tracker.pollOnce(pollLog)).changed, 0)

  // Reload: a second connection and a fresh app on the same database file.
  const reread = new Database(DB_PATH, { readonly: true })
  try {
    const row = reread.prepare('SELECT task_id, issue, cursor FROM work_item WHERE id = ?').get(id)
    assert.deepEqual(row, { task_id: String(task), issue: null, cursor: endIndex(kind) })
  } finally {
    reread.close()
  }
  const fresh = buildApp({ logger })
  await fresh.ready()
  try {
    const res = await fresh.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })
    assert.equal(res.statusCode, 200)
    responses.push(res.body)
    const item = res.json().items.find((i) => i.id === id)
    assert.ok(item, `${id} is on the reloaded board`)
    assert.equal(item.issue, null)
    assert.equal(item.cursor, endIndex(kind))
  } finally {
    await fresh.close()
  }
})

test('metric 4: a farm refusal on the final gate answers 502, keeps the gate open and records "Task close failed"; approving again closes it', async () => {
  const { id, task_id: task } = await createItem('Refused close')
  const kind = store.getItem(id).kind
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(finalGate(kind), id)
  const before = farm.callsTo('close').length

  farm.failNext('close', 502, { error: 'task_service_unavailable' })
  const refused = await approveFinal(id, kind)
  assert.equal(refused.statusCode, 502, refused.body)
  assert.equal(refused.json().error, 'Task close failed: task_service_unavailable')
  assert.equal(store.getItem(id).cursor, finalGate(kind), 'the gate stays open')
  assert.ok(
    eventsOf(id).some((text) => text.includes('Task close failed') && text.includes('the gate stays open')),
    eventsOf(id).join('\n'),
  )

  // The first close landed after all: farmd now answers already_closed.
  farm.setState(task, 'closed')
  const retried = await approveFinal(id, kind)
  assert.equal(retried.statusCode, 200, retried.body)
  assert.equal(store.getItem(id).cursor, endIndex(kind))
  assert.equal(farm.callsTo('close').length - before, 2)
})

test('sync: a Task closed outside Horizon closes its item on the next poll tick', async () => {
  const { id, task_id: task } = await createItem('Closed elsewhere')
  farm.setState(task, 'closed')
  assert.equal((await forKind('sl').tracker.pollOnce(pollLog)).changed, 1)
  const item = store.getItem(id)
  assert.equal(item.cursor, endIndex(item.kind))
  assert.ok(eventsOf(id).includes(`closed Task ${task}`))
})

test('a reopen of an sl item is refused: its Task is reopened, and Horizon follows', async () => {
  const { id, task_id: task } = await createItem('Reopen me')
  const kind = store.getItem(id).kind
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(endIndex(kind), id)
  const res = await inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'reopen', from: CLOSED_KEY } })
  assert.equal(res.statusCode, 409, res.body)
  assert.deepEqual(res.json(), { error: 'reopen_on_task', hint: `Reopen Task ${task}; Horizon follows it.` })
})

test('metric 5 / guardrail 1: every fetch was farmd’s Task routes, and nothing was spawned', () => {
  assert.ok(fetched.length > 0)
  assert.deepEqual(
    fetched.filter((url) => !FARM_TASKS.test(url)),
    [],
  )
  assert.deepEqual(farm.strays, [])
  assert.deepEqual(spawns, [])
  assert.ok(farm.calls.every((c) => c.secretOk), 'every farm call carried the farm secret')
})

test('guardrail 3: the farm secret is in no log line, item event or response body — refusals included', () => {
  assert.ok(logLines.length > 0, 'the log was captured')
  assert.ok(responses.length > 0)
  const events = db.prepare('SELECT text, detail FROM event').all()
  for (const [where, texts] of [
    ['the fastify log', logLines],
    ['item events', events.flatMap((e) => [e.text, e.detail ?? ''])],
    ['response bodies', responses],
  ]) {
    assert.equal(texts.filter((t) => String(t).includes(SENTINEL)).length, 0, where)
  }
})
