// HZ-730: POST /api/items/:id/asks/:askId/dismiss. Dismiss needs a reason: an
// empty or blank one is refused and nothing changes. With a reason, the ask
// closes as 'dismissed' and the reason is queued as one feedback row for the
// asking item's next agent step, addressed to the agent of the step that
// asked and naming that step by its label, never its number.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-asks-dismiss-')), 'test.db')
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const REPO = 'FinTekkers/ledger-service'
const project = store.createProject('Asks dismiss').id
store.addRepoToProject(project, REPO)

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
await app.ready()
after(() => app.close())

const ARCH = requiredStepIndex('Architecture review')
const QA_PLAN = requiredStepIndex('QA reviews the test plan')
const TITLE = 'Publish script must use the bot identity'

let n = 0
function seed() {
  const id = `AD-${++n}`
  db.prepare("INSERT INTO work_item (id, title, priority, desc, metric, guardrails, project_id, cursor) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?)").run(
    id,
    `dismiss asker ${n}`,
    project,
    QA_PLAN,
  )
  const runId = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Architect', 'done')").run(id, ARCH).lastInsertRowid
  const draft = { title: TITLE, repo: REPO, outcome: 'Commits as the bot.', metric: '1. a\n2. b\n3. c', guardrails: '1. None.' }
  const askId = db
    .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, 'blocking', 'open', ?, ?)")
    .run(id, runId, ARCH, JSON.stringify(draft), "Architecture review: 'owner identity'").lastInsertRowid
  return { id, askId }
}

const dismiss = (id, askId, payload) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/asks/${askId}/dismiss`, headers: { cookie: owner.cookie, 'x-human-key': owner.pin }, payload })
const askRow = (askId) => db.prepare('SELECT * FROM ask WHERE id = ?').get(askId)
const feedbackOf = (id) => db.prepare('SELECT * FROM feedback WHERE item_id = ?').all(id)

test('metric 3: Dismiss with an empty or blank reason is 400 reason_required; the ask stays open and nothing is queued', async () => {
  const { id, askId } = seed()
  for (const reason of ['', '   ']) {
    const res = await dismiss(id, askId, { reason })
    assert.equal(res.statusCode, 400, `${JSON.stringify(reason)}: ${res.body}`)
    assert.equal(res.json().error, 'reason_required')
  }
  const missing = await dismiss(id, askId, {})
  assert.equal(missing.statusCode, 400, missing.body)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(askRow(askId).dismiss_reason, null)
  assert.deepEqual(feedbackOf(id), [])
})

test('metric 3: Dismiss with a reason closes the ask and queues one feedback row for the asking step’s agent, naming the step', async () => {
  const { id, askId } = seed()
  const reason = 'Already covered by HZ-640'
  const res = await dismiss(id, askId, { reason })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true })

  const row = askRow(askId)
  assert.equal(row.status, 'dismissed')
  assert.equal(row.dismiss_reason, reason)
  assert.ok(row.resolved_by.includes('Owner Example'))
  assert.ok(row.resolved_at)

  const rows = feedbackOf(id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'ask')
  assert.equal(rows[0].target, STEPS[ARCH].agent)
  assert.notEqual(rows[0].target, 'Eng')
  assert.equal(rows[0].delivered_at, null)
  assert.ok(rows[0].message.includes(reason))
  assert.ok(rows[0].message.includes('“Architecture review”'))
  assert.ok(rows[0].message.includes(TITLE))
  assert.doesNotMatch(rows[0].message, /\bstep \d+\b/i)
  assert.equal(store.itemViewById(id).asks.length, 0, 'a dismissed ask leaves the open list')

  // A dismissed ask cannot be filed.
  const file = await app.inject({ method: 'POST', url: `/api/items/${id}/asks/${askId}/file`, headers: { cookie: owner.cookie, 'x-human-key': owner.pin }, payload: {} })
  assert.equal(file.statusCode, 409, file.body)
  assert.equal(file.json().error, 'ask_closed')
})
