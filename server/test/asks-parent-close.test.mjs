// HZ-820: a soft ask never outlives its item. Every move that closes the item
// (Review & close approval, the owner's /move approve, a GitHub issue closed
// outside Horizon) or abandons it dismisses its open soft asks in the same
// transaction — `resolved_by` Horizon, reason "Parent item closed" or "Parent
// item abandoned". Blocking and split asks, and asks already filed or
// dismissed, keep their status. Nothing is deleted, a reopen reopens no ask,
// and the auto-resolve makes no GitHub call. File it still files such an ask
// by hand.
//
// GitHub is helpers/splitGithubStub.mjs; every ask drafts an item on LIB, the
// item lives on SRC, so a call on LIB or any issue create is the auto-resolve
// reaching GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-asks-parent-close-')), 'test.db')
process.env.GITHUB_TOKEN = 'ghp_TEST_ASKS_PARENT_CLOSE'
process.env.GITHUB_WEBHOOK_SECRET = 'asks-parent-close-secret'
delete process.env.FARM_URL

const stub = splitGithubStub()
const realFetch = globalThis.fetch
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const asks = await import('../src/asks.js')
const { composeIssueBody } = await import('../src/github.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const { STEPS, endIndex, laneCheckIndexes, LANES, nextCursor, requiredStepIndex, stepKeyAt, stepsFor } = lifecycle

store.purgeDemoItems()
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const project = store.createProject('Asks parent close').id
for (const repo of [SRC, LIB]) store.addRepoToProject(project, repo)

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
loginFixtureToken(auth, owner.user)
await app.ready()
after(async () => {
  await app.close()
  globalThis.fetch = realFetch
})

const ARCH = requiredStepIndex('Architecture review')
const TASK_FINAL = endIndex('task') - 1
const headers = { cookie: owner.cookie, 'x-human-key': owner.pin }

const draft = (title) => ({
  title,
  repo: LIB,
  outcome: 'The publish script commits as the bot.',
  metric: '1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints the identity.',
  guardrails: '1. No new secrets.',
})

let seq = 0
// `withIssue: false` — an item with no GitHub issue, which the owner may
// reopen in Horizon (one with an issue is reopened on GitHub).
function newItem(cursor, kind = 'change', { withIssue = true } = {}) {
  const title = `asker ${++seq}`
  const issue = withIssue ? stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: 'Fix it.', metric: 'Works.', guardrails: '' }) }) : null
  const id = issue ? `LS-${issue.number}` : `LS-LOCAL-${seq}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor, kind) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?, ?)",
  ).run(id, title, issue?.number ?? null, SRC, project, cursor, kind)
  return { id, issue }
}

function seedAsk(itemId, { kind = 'soft', status = 'open', reviewed = true, resolvedBy = null, reason = null, filedItemId = null } = {}) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Architect', 'done')")
    .run(itemId, ARCH).lastInsertRowid
  const askId = Number(
    db
      .prepare(
        'INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why, dismiss_reason, resolved_by, filed_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(itemId, runId, ARCH, kind, status, JSON.stringify(draft(`${kind} ${status} ask on ${itemId}`)), `Architecture review: ${kind}`, reason, resolvedBy, filedItemId)
      .lastInsertRowid,
  )
  if (reviewed) {
    db.prepare("INSERT INTO ask_review (ask_id, provider, status, verdict, reasons_json) VALUES (?, 'muse', 'done', 'accept', ?)").run(askId, JSON.stringify(['Fits.']))
  }
  return askId
}

// One of each ask the guardrails name: the soft one that closes, and the
// blocking, split, owner-dismissed and filed ones that must not change.
function seedAsks(itemId) {
  const { id: filedChild } = newItem(ARCH)
  return {
    soft: seedAsk(itemId),
    blocking: seedAsk(itemId, { kind: 'blocking' }),
    split: seedAsk(itemId, { kind: 'split', reviewed: false }),
    ownerDismissed: seedAsk(itemId, { status: 'dismissed', resolvedBy: 'Owner Example', reason: 'Not needed now' }),
    filed: seedAsk(itemId, { status: 'filed', resolvedBy: 'Owner Example', filedItemId: filedChild }),
  }
}

const askRow = (askId) => db.prepare('SELECT * FROM ask WHERE id = ?').get(askId)
const reviewRow = (askId) => db.prepare('SELECT * FROM ask_review WHERE ask_id = ?').get(askId)
const askCount = (itemId) => db.prepare('SELECT COUNT(*) AS n FROM ask WHERE item_id = ?').get(itemId).n
const pick = (row) => ({ status: row.status, resolved_by: row.resolved_by, dismiss_reason: row.dismiss_reason, filed_item_id: row.filed_item_id })
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

const move = (itemId, payload) => app.inject({ method: 'POST', url: `/api/items/${itemId}/move`, headers, payload })
const fileIt = (itemId, askId) => app.inject({ method: 'POST', url: `/api/items/${itemId}/asks/${askId}/file`, headers, payload: {} })

function issuesWebhook(issue, state) {
  const body = JSON.stringify({
    action: state === 'closed' ? 'closed' : 'reopened',
    repository: { full_name: SRC },
    issue: { number: issue.number, title: issue.title, body: issue.body, state, labels: [] },
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', 'asks-parent-close-secret').update(body).digest('hex')
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sig },
    payload: body,
  })
}

// Every ask, before the move, so the after-state can be compared.
const snapshotOf = (seeded) => Object.fromEntries(Object.entries(seeded).map(([k, id]) => [k, askRow(id)]))

// The guardrails, after a close or an abandon with `reason`.
function assertResolved(itemId, seeded, before, reason, callsBefore) {
  const soft = askRow(seeded.soft)
  assert.equal(soft.status, 'dismissed')
  assert.equal(soft.dismiss_reason, reason)
  assert.equal(soft.resolved_by, 'Horizon')
  assert.ok(soft.resolved_at)
  for (const key of ['blocking', 'split']) assert.equal(askRow(seeded[key]).status, 'open', `${key} stays open`)
  for (const key of ['ownerDismissed', 'filed']) assert.deepEqual(pick(askRow(seeded[key])), pick(before[key]), `${key} unchanged`)
  // Nothing deleted: the draft, the why and the review are as they were.
  assert.equal(soft.draft_json, before.soft.draft_json)
  assert.equal(soft.why, before.soft.why)
  assert.ok(reviewRow(seeded.soft), 'the review row is kept')
  assert.equal(askCount(itemId), Object.keys(seeded).length)
  // No GitHub call for the ask: nothing on its repo, no issue filed.
  const calls = stub.calls.slice(callsBefore)
  assert.deepEqual(calls.filter((c) => c.path.startsWith(`/repos/${LIB}/`)), [])
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && /\/issues$/.test(c.path)), [])
  // The snapshot: gone from the open list, listed as closed with the item.
  const view = store.itemViewById(itemId)
  assert.ok(!view.asks.some((a) => a.id === seeded.soft))
  const shown = view.parentClosedAsks.find((a) => a.id === seeded.soft)
  assert.equal(shown.dismiss_reason, reason)
  assert.equal(shown.review.verdict, 'accept')
  assert.ok(!view.parentClosedAsks.some((a) => a.id === seeded.ownerDismissed), 'an owner-dismissed ask is not listed')
}

test('metric 1: approving Review & close dismisses the open soft ask as Horizon, "Parent item closed"; nothing else changes', async () => {
  const { id } = newItem(TASK_FINAL, 'task')
  const seeded = seedAsks(id)
  const before = snapshotOf(seeded)
  assert.equal(store.itemViewById(id).parentClosedAsks, undefined, 'absent while there are none')
  const calls = stub.calls.length
  const res = await move(id, { stepKey: 'closed', from: stepKeyAt(TASK_FINAL) })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorOf(id), endIndex('task'))
  assertResolved(id, seeded, before, asks.PARENT_CLOSED_REASON, calls)
})

test('metric 1: the owner’s /move approve at Review & close does the same, and a /move reopen leaves the ask dismissed', async () => {
  const { id } = newItem(TASK_FINAL, 'task', { withIssue: false })
  const seeded = seedAsks(id)
  const before = snapshotOf(seeded)
  const calls = stub.calls.length
  const res = await move(id, { action: 'approve', from: stepKeyAt(TASK_FINAL) })
  assert.equal(res.statusCode, 200, res.body)
  assertResolved(id, seeded, before, asks.PARENT_CLOSED_REASON, calls)
  const closed = pick(askRow(seeded.soft))

  const reopen = await move(id, { action: 'reopen', from: 'closed' })
  assert.equal(reopen.statusCode, 200, reopen.body)
  assert.ok(cursorOf(id) < endIndex('task'))
  assert.deepEqual(pick(askRow(seeded.soft)), closed)
  assert.equal(askRow(seeded.blocking).status, 'open')
})

test('metric 2: a GitHub issue closed outside Horizon dismisses the soft ask the same way; a reopened webhook leaves it dismissed', async () => {
  const { id, issue } = newItem(ARCH)
  const seeded = seedAsks(id)
  const before = snapshotOf(seeded)
  const calls = stub.calls.length
  const res = await issuesWebhook(issue, 'closed')
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(cursorOf(id), endIndex('change'))
  assertResolved(id, seeded, before, asks.PARENT_CLOSED_REASON, calls)
  const closed = pick(askRow(seeded.soft))

  const reopened = await issuesWebhook(issue, 'open')
  assert.equal(reopened.statusCode, 204, reopened.body)
  assert.ok(cursorOf(id) < endIndex('change'), 'the item reopened')
  assert.deepEqual(pick(askRow(seeded.soft)), closed)
  for (const key of ['blocking', 'split']) assert.equal(askRow(seeded[key]).status, 'open')
})

test('metric 3: abandoning through the route the UI calls dismisses the soft ask with "Parent item abandoned"', async () => {
  const { id } = newItem(ARCH)
  const seeded = seedAsks(id)
  const before = snapshotOf(seeded)
  const calls = stub.calls.length
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/abandon`, headers, payload: { reason: 'Superseded by a rewrite.' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(db.prepare('SELECT abandoned_at FROM work_item WHERE id = ?').get(id).abandoned_at)
  assertResolved(id, seeded, before, asks.PARENT_ABANDONED_REASON, calls)
})

test('a refused close resolves nothing', async () => {
  const { id } = newItem(TASK_FINAL, 'task')
  const soft = seedAsk(id)
  const res = await move(id, { stepKey: 'closed', from: stepKeyAt(ARCH) })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(askRow(soft).status, 'open')
})

test('metric 5: File it files a soft ask Horizon dismissed; a second File it files nothing; the other closed asks are refused', async () => {
  const { id } = newItem(TASK_FINAL, 'task')
  const soft = seedAsk(id)
  const unreviewed = seedAsk(id, { reviewed: false })
  const blocking = seedAsk(id, { kind: 'blocking' })
  assert.equal((await move(id, { stepKey: 'closed', from: stepKeyAt(TASK_FINAL) })).statusCode, 200)
  assert.equal(askRow(soft).status, 'dismissed')
  assert.equal(askRow(unreviewed).status, 'dismissed')
  // A blocking ask is never dismissed by the close; were one dismissed by
  // Horizon with the parent reason, it is still not re-fileable.
  assert.equal(askRow(blocking).status, 'open')
  db.prepare("UPDATE ask SET status = 'dismissed', resolved_by = 'Horizon', dismiss_reason = ? WHERE id = ?").run(asks.PARENT_CLOSED_REASON, blocking)

  const creates = stub.creates().length
  const first = await fileIt(id, soft)
  assert.equal(first.statusCode, 200, first.body)
  const body = first.json()
  assert.equal(body.alreadyFiled, false)
  assert.equal(body.dependencyAdded, false)
  const row = askRow(soft)
  assert.equal(row.status, 'filed')
  assert.equal(row.filed_item_id, body.itemId)
  assert.ok(row.resolved_by.includes('Owner Example'))
  assert.equal(row.dismiss_reason, asks.PARENT_CLOSED_REASON, 'the reason stays as history')
  assert.equal(stub.creates().length, creates + 1)
  assert.equal(stub.creates().at(-1).path, `/repos/${LIB}/issues`)
  assert.ok(!(store.itemViewById(id).parentClosedAsks ?? []).some((a) => a.id === soft), 'a filed ask leaves the closed list')

  const second = await fileIt(id, soft)
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(second.json(), { ok: true, itemId: body.itemId, alreadyFiled: true, dependencyAdded: false })
  assert.equal(stub.creates().length, creates + 1)

  const notReviewed = await fileIt(id, unreviewed)
  assert.equal(notReviewed.statusCode, 409)
  assert.equal(notReviewed.json().error, 'ask_not_reviewed')

  const blocked = await fileIt(id, blocking)
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.json().error, 'ask_closed')
  assert.equal(stub.creates().length, creates + 1)
})

test('metric 5: an ask the owner dismissed stays closed, even with dismissAsk’s default actor of Horizon', async () => {
  const { id } = newItem(ARCH)
  const soft = seedAsk(id)
  const dismissed = asks.dismissAsk(store.getItem(id), soft, { reason: 'Not needed now', queueFeedbackOnce: () => ({ ok: true }) })
  assert.equal(dismissed.ok, true)
  assert.equal(askRow(soft).resolved_by, 'Horizon')
  const res = await fileIt(id, soft)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'ask_closed')
  assert.equal(askRow(soft).status, 'dismissed')
})

// The hook lives in moveItem only. A step completion (writeStepCompletion) is
// the one other cursor writer; it must never close an item, or a soft ask
// could outlive it. Completions run from agent steps, so: from every non-gate
// row, in every lane, every place a completion may go is short of the end.
test('a step completion never closes an item: every kind ends on a gate and no completion target reaches the end', () => {
  for (const kind of ['change', 'task', 'plan']) {
    const rows = stepsFor(kind)
    assert.equal(rows.at(-1).kind, 'gate', `${kind}'s last row is a gate`)
    for (const lane of [null, ...LANES]) {
      for (const row of rows.filter((r) => STEPS[r.index].kind !== 'gate')) {
        const item = { kind, lane, cursor: row.index }
        const checked = laneCheckIndexes(item)
        const targets = [nextCursor(item)]
        if (checked.has(row.index)) targets.push(nextCursor({ ...item, cursor: Math.max(...checked) }))
        for (const t of targets) assert.ok(t < endIndex(kind), `${row.key} (${lane ?? 'full'}) completes to ${t}`)
      }
    }
  }
})
