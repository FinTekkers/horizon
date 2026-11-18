// HO-880: POST /api/project-imports — the owner-only import of an old GitHub
// project into a new project on an sl repo.
//
//   metric 1: a non-owner (a member of both projects, or of neither) gets 403,
//             and the target gets no item, tracker record or project_event.
//   metric 4: one import writes exactly one project_event with source,
//             target, open count and closed count.
//   metric 5: 2 open + 1 closed source items → exactly 2 records from the
//             target's Tracker port (the real sl adapter, farmd stubbed), the
//             closed item copied as closed history, all 3 copies linked.
//   guardrail 1: the import makes no GitHub call and leaves the source's
//             items, history, repos and backend byte-identical.
//   guardrail 4: a refused import (same backend, a running job) freezes
//             nothing, so the source still edits as today.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'
import { FARM_SECRET, SOURCE_REPO, TARGET_REPO, countWhere, postImport, seedImport, sourceSnapshot } from './helpers/importFixture.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-import-route-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = FARM_SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_TEST_HOOKS']) delete process.env[key]

const stub = createFarmTasksStub({ secret: FARM_SECRET })
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const fx = seedImport({ db, store, auth, config, lifecycle })
const { owner, member, outsider, source, target, ids, targetPrefix } = fx
const body = { sourceProjectId: source, targetProjectId: target }

const targetCounts = () => ({
  items: countWhere(db, 'work_item', 'project_id = ?', target),
  ledger: countWhere(db, 'item_import', 'target_project_id = ?', target),
  events: countWhere(db, 'project_event', 'project_id = ?', target),
})
const NOTHING = { items: 0, ledger: 0, events: 0 }

test('metric 1: a member of both projects and a member of neither each get 403 owner_required; nothing is written or filed', async () => {
  const before = sourceSnapshot(db, source)
  for (const who of [member, outsider]) {
    const res = await postImport(app, who, body)
    assert.equal(res.statusCode, 403, res.body)
    assert.deepEqual(res.json(), { error: 'owner_required' })
    // Refused before the body is validated, too (owner check first).
    const malformed = await postImport(app, who, { sourceProjectId: 'x' })
    assert.equal(malformed.statusCode, 403, malformed.body)
  }
  assert.deepEqual(targetCounts(), NOTHING)
  assert.equal(countWhere(db, 'item_import', '1 = 1'), 0)
  assert.equal(stub.calls.length, 0, 'the Tracker port was never called')
  assert.deepEqual(sourceSnapshot(db, source), before)
})

test('the owner without a PIN-verified session gets 401 and nothing is frozen', async () => {
  const res = await postImport(app, owner, body, { pin: false })
  assert.equal(res.statusCode, 401, res.body)
  assert.equal(res.json().error, 'human_gate_key_required')
  assert.deepEqual(targetCounts(), NOTHING)
})

test('guardrail 4: a refused import (same backend, a running job) freezes nothing, and the source still edits as before', async () => {
  const sameBackend = store.createProject('Another GitHub').id
  assert.equal(store.addRepoToProject(sameBackend, 'acme/other-gh').ok, true)
  const same = await postImport(app, owner, { sourceProjectId: source, targetProjectId: sameBackend })
  assert.equal(same.statusCode, 400, same.body)
  assert.equal(same.json().error, 'same_backend')

  const [first] = ids.open
  const run = db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'pm', 'active')").run(first, 0).lastInsertRowid
  try {
    const busy = await postImport(app, owner, body)
    assert.equal(busy.statusCode, 409, busy.body)
    assert.deepEqual(busy.json(), { error: 'source_has_running_jobs', items: [first] })
  } finally {
    db.prepare('DELETE FROM step_run WHERE id = ?').run(run)
  }
  assert.equal(countWhere(db, 'item_import', '1 = 1'), 0)
  assert.deepEqual(targetCounts(), NOTHING)
  assert.equal(stub.calls.length, 0)

  const headers = { cookie: owner.cookie, 'x-human-key': owner.pin }
  const edit = await app.inject({ method: 'POST', url: `/api/items/${first}/priority`, headers, payload: { priority: 'Low' } })
  assert.equal(edit.statusCode, 200, edit.body)
  const back = await app.inject({ method: 'POST', url: `/api/items/${first}/priority`, headers, payload: { priority: 'High' } })
  assert.equal(back.statusCode, 200, back.body)
})

test('metrics 4 and 5, guardrail 1: 2 open + 1 closed → 2 port records, 1 closed history copy, 3 linked copies, one project_event, no source write', async () => {
  const before = sourceSnapshot(db, source)
  // The guardrail 4 case's priority edits mirrored labels to GitHub; only the import's calls count here.
  const straysBefore = stub.strays.length
  const res = await postImport(app, owner, body)
  assert.equal(res.statusCode, 200, res.body)
  const result = res.json()
  assert.deepEqual(
    { ok: result.ok, open: result.open, closed: result.closed, skipped: result.skipped, targetRepo: result.targetRepo },
    { ok: true, open: 2, closed: 1, skipped: 0, targetRepo: TARGET_REPO },
  )

  // Metric 5: exactly two records, one per open item, each carrying its source id.
  const creates = stub.callsTo('create')
  assert.equal(creates.length, 2)
  assert.equal([...stub.tasks.values()].filter((t) => t.repo === TARGET_REPO).length, 2)
  const sentFor = creates.map((c) => /horizon-imported-from: (\S+) /.exec(c.body.body)?.[1]).sort()
  assert.deepEqual(sentFor, [...ids.open].sort(), 'the port received exactly the open items')

  const copies = db.prepare('SELECT * FROM work_item WHERE project_id = ? ORDER BY source_item_id').all(target)
  assert.equal(copies.length, 3)
  assert.deepEqual(copies.map((c) => c.source_item_id), [...ids.open, ids.closed].sort())
  for (const copy of copies) {
    assert.equal(copy.repo, TARGET_REPO)
    assert.equal(copy.backend, 'sl')
    assert.equal(copy.issue, null, 'a copy never keeps the source GitHub issue')
  }
  for (const id of ids.open) {
    const copy = copies.find((c) => c.source_item_id === id)
    const src = before.items.find((i) => i.id === id)
    assert.ok(copy.task_id, `${copy.id} has its sl Task`)
    assert.equal(copy.cursor, lifecycle.firstStepIndex('change'), 'an open copy restarts at its first step')
    assert.deepEqual([copy.title, copy.desc, copy.metric, copy.priority], [src.title, src.desc, src.metric, src.priority])
  }

  // The closed item is closed history: no record, its history copied, plus one "imported from".
  const closed = copies.find((c) => c.source_item_id === ids.closed)
  assert.equal(closed.id, `${targetPrefix}H${ids.closed}`)
  assert.equal(lifecycle.isClosed(closed), true)
  assert.equal(closed.task_id, null)
  assert.equal(closed.merged_at, '2026-01-02 03:04:05')
  assert.equal(closed.pr_url, 'https://github.com/acme/old-app/pull/9')
  const closedEvents = db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(closed.id).map((e) => e.text)
  const sourceEvents = before.events.filter((e) => e.item_id === ids.closed).map((e) => e.text)
  assert.deepEqual(closedEvents, [...sourceEvents, `imported from ${ids.closed} as history`])
  assert.deepEqual(
    db.prepare('SELECT step_index, decision, notes, decided_by FROM gate_decision WHERE item_id = ?').all(closed.id),
    db.prepare('SELECT step_index, decision, notes, decided_by FROM gate_decision WHERE item_id = ?').all(ids.closed),
  )

  // Metric 4: exactly one project_event, with source, target and both counts.
  const events = db.prepare('SELECT * FROM project_event WHERE project_id = ?').all(target)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'import')
  assert.equal(events[0].who, 'Import Owner')
  assert.deepEqual(JSON.parse(events[0].new_value), { source, target, open: 2, closed: 1, skipped: 0 })
  assert.equal(result.eventId, events[0].id)
  assert.equal(countWhere(db, 'project_event', 'project_id = ?', source), 0)

  // Guardrail 1: no GitHub (or any non-farm) call; the source is untouched.
  assert.deepEqual(stub.strays.slice(straysBefore), [])
  assert.deepEqual(sourceSnapshot(db, source), before)
  assert.equal(store.findRepo(SOURCE_REPO).backend, 'github')

  // The board shows both ends of the link.
  const board = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: owner.cookie } })
  const byId = new Map(board.json().items.map((i) => [i.id, i]))
  for (const id of [...ids.open, ids.closed]) assert.equal(byId.get(id)?.imported, true, id)
  for (const copy of copies) assert.equal(byId.get(copy.id)?.sourceItemId, copy.source_item_id)
})

test('a source already imported cannot go to a second target, and a target with its own items is not new', async () => {
  const second = store.createProject('Second sl').id
  assert.equal(store.addRepoToProject(second, 'acme/second-sl', 'sl').ok, true)
  const again = await postImport(app, owner, { sourceProjectId: source, targetProjectId: second })
  assert.equal(again.statusCode, 409, again.body)
  assert.equal(again.json().error, 'already_imported')

  const other = store.createProject('Other GitHub').id
  assert.equal(store.addRepoToProject(other, 'acme/other-app').ok, true)
  const notNew = await postImport(app, owner, { sourceProjectId: other, targetProjectId: target })
  assert.equal(notNew.statusCode, 409, notNew.body)
  assert.equal(notNew.json().error, 'target_not_new')
  assert.equal(countWhere(db, 'item_import', 'target_project_id = ?', second), 0)
})
