// HZ-730: POST /api/items/:id/asks/:askId/file. File it files the ask's draft
// (the reviewer's amended one when the verdict is amend) as one item on the
// repo the ask names, and a blocking ask's item becomes a dependency of the
// asking item. A second File it files nothing and links nothing. Only a
// browser session with the gate PIN may file; the issue body holds the draft's
// plan text and nothing else; a repo outside the item's project is refused.
//
// GitHub is helpers/splitGithubStub.mjs; review data is seeded as ask_review
// rows, as HZ-729's sweep writes them.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-asks-file-')), 'test.db')
process.env.GITHUB_TOKEN = 'ghp_TEST_ASKS_FILE'
for (const key of ['FARM_URL', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const stub = splitGithubStub()
const realFetch = globalThis.fetch
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { askRequestKey } = await import('../src/asks.js')
const { composeIssueBody } = await import('../src/github.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const FOREIGN = 'Acme/elsewhere'
const project = store.createProject('Asks file').id
for (const repo of [SRC, LIB]) store.addRepoToProject(project, repo)
store.addRepoToProject(store.createProject('Acme').id, FOREIGN)

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
const token = loginFixtureToken(auth, owner.user)
await app.ready()
after(async () => {
  await app.close()
  globalThis.fetch = realFetch
})

const ARCH = requiredStepIndex('Architecture review')
const QA_PLAN = requiredStepIndex('QA reviews the test plan')
const SENTINEL = 'SENTINEL-transcript-7f3a'

const draft = (over = {}) => ({
  title: 'Publish script must use the bot identity',
  repo: LIB,
  outcome: 'The publish script commits as the bot.',
  metric: '1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints the identity.',
  guardrails: '1. No new secrets.',
  ...over,
})

function newItem(title) {
  const issue = stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: 'Fix it.', metric: 'Works.', guardrails: '' }) })
  const id = `LS-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?)",
  ).run(id, title, issue.number, SRC, project, QA_PLAN)
  return id
}

// One open ask from an Architecture review run whose output and why carry the
// sentinel, with a finished review (or none, when `verdict` is null).
function seedAsk(itemId, { kind = 'blocking', d = draft(), verdict = 'accept', amended = null } = {}) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES (?, ?, 1, 'Architect', 'done', ?, ?)")
    .run(itemId, ARCH, `run output ${SENTINEL}`, `## Verdict\n${SENTINEL}`).lastInsertRowid
  const askId = Number(
    db
      .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, ?, 'open', ?, ?)")
      .run(itemId, runId, ARCH, kind, JSON.stringify(d), `Architecture review: '${SENTINEL}'`).lastInsertRowid,
  )
  if (verdict) {
    db.prepare("INSERT INTO ask_review (ask_id, provider, status, verdict, reasons_json, amended_draft_json) VALUES (?, 'muse', 'done', ?, ?, ?)").run(
      askId,
      verdict,
      JSON.stringify(['Fits the project.']),
      amended ? JSON.stringify(amended) : null,
    )
  }
  return askId
}

const fileIt = (itemId, askId, headers = { cookie: owner.cookie, 'x-human-key': owner.pin }) =>
  app.inject({ method: 'POST', url: `/api/items/${itemId}/asks/${askId}/file`, headers, payload: {} })
const askRow = (askId) => db.prepare('SELECT * FROM ask WHERE id = ?').get(askId)
const spawnRows = (itemId) => db.prepare('SELECT * FROM item_spawn WHERE parent_id = ?').all(itemId)
const createsSince = (n) => stub.creates().slice(n)

test('metric 2: File it on a blocking ask files the amended draft once and adds one dependency; a second File it files and links nothing', async () => {
  const id = newItem('blocking asker')
  const amended = draft({
    title: 'Release bot signs every publish commit',
    outcome: 'Every publish commit is authored by the release bot.',
    metric: '1. The bot authors each publish commit.\n2. A dry run names the bot.\n3. CI fails on any other author.',
    guardrails: '1. Tag format unchanged.',
  })
  const askId = seedAsk(id, { verdict: 'amend', amended })
  const before = stub.creates().length

  const first = await fileIt(id, askId)
  assert.equal(first.statusCode, 200, first.body)
  const body = first.json()
  assert.equal(body.alreadyFiled, false)
  assert.equal(body.dependencyAdded, true)

  const creates = createsSince(before)
  assert.equal(creates.length, 1)
  assert.ok(creates[0].path.startsWith(`/repos/${LIB}/`), 'filed on the repo the ask names')
  assert.equal(creates[0].body.title, amended.title)
  for (const text of [amended.outcome, 'A dry run names the bot.', 'Tag format unchanged.']) assert.ok(creates[0].body.body.includes(text), text)
  for (const text of [draft().title, draft().outcome, 'Commits name the bot.', 'No new secrets.']) {
    assert.ok(!creates[0].body.title.includes(text) && !creates[0].body.body.includes(text), `the original's “${text}” stays out`)
  }
  assert.deepEqual(store.blockersOf(id).map((b) => b.id), [body.itemId])
  assert.equal(spawnRows(id).length, 1)
  assert.equal(spawnRows(id)[0].request_key, askRequestKey(askId))
  const row = askRow(askId)
  assert.equal(row.status, 'filed')
  assert.equal(row.filed_item_id, body.itemId)
  assert.ok(row.resolved_by.includes('Owner Example'))
  assert.equal(store.itemViewById(id).asks.length, 0, 'a filed ask leaves the open list')

  const second = await fileIt(id, askId)
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(second.json(), { ok: true, itemId: body.itemId, alreadyFiled: true, dependencyAdded: false })
  assert.equal(createsSince(before).length, 1)
  assert.equal(store.blockersOf(id).length, 1)
  assert.equal(spawnRows(id).length, 1)
})

test('metric 2: File it on a soft ask files once and adds no dependency, twice over', async () => {
  const id = newItem('soft asker')
  const askId = seedAsk(id, { kind: 'soft', d: draft({ title: 'Document the publish identity', repo: SRC }) })
  const before = stub.creates().length

  const first = await fileIt(id, askId)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().dependencyAdded, false)
  assert.equal(createsSince(before).length, 1)
  assert.equal(createsSince(before)[0].body.title, 'Document the publish identity')
  assert.equal(store.blockersOf(id).length, 0)

  const second = await fileIt(id, askId)
  assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json().alreadyFiled, true)
  assert.equal(createsSince(before).length, 1)
  assert.equal(store.blockersOf(id).length, 0)
  assert.equal(askRow(askId).status, 'filed')
})

test('metric 2: when the status update throws after the issue is filed, a retry files no second issue and ends filed', async () => {
  const id = newItem('half-filed asker')
  const askId = seedAsk(id)
  const before = stub.creates().length
  db.exec(`CREATE TEMP TRIGGER fail_ask_filed BEFORE UPDATE OF status ON ask WHEN NEW.status = 'filed' BEGIN SELECT RAISE(ABORT, 'status update failed'); END`)
  try {
    const broken = await fileIt(id, askId)
    assert.equal(broken.statusCode, 500, broken.body)
  } finally {
    db.exec('DROP TRIGGER fail_ask_filed')
  }
  assert.equal(createsSince(before).length, 1, 'the issue was filed before the status update')
  assert.equal(askRow(askId).status, 'open')

  const retry = await fileIt(id, askId)
  assert.equal(retry.statusCode, 200, retry.body)
  assert.equal(retry.json().alreadyFiled, false)
  assert.equal(createsSince(before).length, 1)
  assert.equal(spawnRows(id).length, 1)
  assert.equal(store.blockersOf(id).length, 1)
  const row = askRow(askId)
  assert.equal(row.status, 'filed')
  assert.equal(row.filed_item_id, retry.json().itemId)
})

test('guardrail 1: no session, a session without the PIN, and an API token with the right PIN are each 401 on both routes; nothing changes', async () => {
  const id = newItem('guarded asker')
  const askId = seedAsk(id)
  const before = stub.creates().length
  const feedback = () => db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE item_id = ?').get(id).n
  const callers = {
    'no session': { 'x-human-key': owner.pin },
    'session, no PIN': { cookie: owner.cookie },
    'token with PIN': { ...token.headers, 'x-human-key': owner.pin },
  }
  for (const [who, headers] of Object.entries(callers)) {
    const file = await fileIt(id, askId, headers)
    assert.equal(file.statusCode, 401, `${who} file: ${file.body}`)
    const dismiss = await app.inject({ method: 'POST', url: `/api/items/${id}/asks/${askId}/dismiss`, headers, payload: { reason: 'not needed' } })
    assert.equal(dismiss.statusCode, 401, `${who} dismiss: ${dismiss.body}`)
  }
  assert.equal(createsSince(before).length, 0)
  assert.equal(feedback(), 0)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(spawnRows(id).length, 0)
})

test('guardrail 2: an amended draft holding a host path or a token is 422 draft_invalid and never reaches GitHub', async () => {
  const id = newItem('dirty asker')
  const before = stub.creates().length
  for (const [label, amended, field] of [
    ['host path', draft({ outcome: 'Read the config from /home/ubuntu/.horizon/state.json first.' }), 'outcome'],
    ['token', draft({ guardrails: `1. Use ghp_${'a'.repeat(36)} for the push.` }), 'guardrails'],
  ]) {
    const askId = seedAsk(id, { verdict: 'amend', amended })
    const res = await fileIt(id, askId)
    assert.equal(res.statusCode, 422, `${label}: ${res.body}`)
    assert.equal(res.json().error, 'draft_invalid')
    assert.equal(res.json().field, field)
    assert.equal(askRow(askId).status, 'open')
  }
  assert.equal(createsSince(before).length, 0)
})

test('guardrail 2: the issue body carries the plan text only — never the why or the step run output', async () => {
  const id = newItem('sentinel asker')
  const askId = seedAsk(id, { kind: 'soft' })
  const before = stub.creates().length
  const res = await fileIt(id, askId)
  assert.equal(res.statusCode, 200, res.body)
  const [create] = createsSince(before)
  assert.ok(create.body.body.includes(draft().outcome))
  assert.ok(!JSON.stringify(create.body).includes(SENTINEL), 'no why, output or artifact text in the issue')
})

test('guardrail 3: a repo connected to another project, or unknown to Horizon, is 409 repo_not_in_project with no GitHub call', async () => {
  const id = newItem('wrong-repo asker')
  const before = stub.creates().length
  for (const repo of [FOREIGN, 'Nobody/unknown']) {
    const askId = seedAsk(id, { verdict: 'amend', amended: draft({ repo }) })
    const res = await fileIt(id, askId)
    assert.equal(res.statusCode, 409, `${repo}: ${res.body}`)
    assert.equal(res.json().error, 'repo_not_in_project')
    assert.equal(askRow(askId).status, 'open')
  }
  assert.equal(createsSince(before).length, 0)
})

test('an ask with no finished review is 409 ask_not_reviewed; an escalated one is the owner’s call and files', async () => {
  const id = newItem('unreviewed asker')
  const before = stub.creates().length
  const unreviewed = seedAsk(id, { kind: 'soft', verdict: null })
  const res = await fileIt(id, unreviewed)
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error, 'ask_not_reviewed')
  assert.equal(createsSince(before).length, 0)

  const escalated = seedAsk(id, { kind: 'soft', verdict: 'escalate', d: draft({ title: 'An escalated follow-up' }) })
  const ok = await fileIt(id, escalated)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(createsSince(before).length, 1)
})
