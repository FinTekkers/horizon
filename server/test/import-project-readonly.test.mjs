// HO-880 metric 2: after an import, edits and gate actions on the source
// items are rejected and leave them unchanged — on every write path, not just
// the item routes.
//
//   - /priority, /feedback and /move answer 409 item_imported; a direct
//     moveItem call and store.approveGate are refused.
//   - R2: a WhatsApp poll-vote approve and one caretaker pass leave the
//     source's event, gate_decision and feedback rows and its cursor as they
//     were, with no retry and nothing logged above warn.
//   - R4 / guardrail 1: issues.edited and issues.closed webhooks for a source
//     issue leave the source and its copy byte-identical, answered 2xx.
//   - guardrail 4: a project that was never imported moves, edits and syncs
//     exactly as before.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'
import { FARM_SECRET, SOURCE_REPO, postImport, seedImport, sourceSnapshot } from './helpers/importFixture.mjs'

const WA_SECRET = 'import-wa-secret'
const APPROVER = '15550001111'
const HOOK_SECRET = 'import-hook-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-import-readonly-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = FARM_SECRET
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = APPROVER
process.env.GITHUB_WEBHOOK_SECRET = HOOK_SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_TOKEN', 'HORIZON_TEST_HOOKS', 'WA_NOTIFY_ENABLED']) delete process.env[key]

const stub = createFarmTasksStub({ secret: FARM_SECRET })
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const { moveItem } = await import('../src/moveItem.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const fx = seedImport({ db, store, auth, config, lifecycle, tag: 'ro' })
const { owner, source, target, ids, firstGate, sourcePrefix } = fx
const headers = { cookie: owner.cookie, 'x-human-key': owner.pin }

// One more source item, parked at a gate the caretaker acts on, with an 'on'
// decision on record — what the caretaker would approve next pass.
const ACT_GATE = actor.ACT_GATES[0]
const AT_ACT_GATE = `${sourcePrefix}-4`
db.prepare(
  "INSERT INTO work_item (id, title, priority, desc, metric, issue, repo, project_id, cursor, backend) VALUES (?, 'At an acted gate', 'High', 'o', '1. m', 4, ?, ?, ?, 'github')",
).run(AT_ACT_GATE, SOURCE_REPO, source, ACT_GATE)
db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run('on', source)
db.prepare(
  "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason, comment) VALUES (?, ?, 0, 'on', 'approve', NULL, 'fixture decision', NULL)",
).run(AT_ACT_GATE, ACT_GATE)

const imported = await postImport(app, owner, { sourceProjectId: source, targetProjectId: target })
assert.equal(imported.statusCode, 200, imported.body)
const [first, second] = ids.open
const copies = () => db.prepare('SELECT * FROM work_item WHERE project_id = ? ORDER BY id').all(target)

test('metric 2: /priority, /feedback and /move answer 409 item_imported, and the source rows stay byte-identical', async () => {
  const before = sourceSnapshot(db, source)
  const calls = [
    { url: `/api/items/${first}/priority`, payload: { priority: 'Low' } },
    { url: `/api/items/${first}/feedback`, payload: { message: 'please change this' } },
    { url: `/api/items/${second}/move`, payload: { from: lifecycle.stepKeyAt(firstGate), action: 'approve' } },
    { url: `/api/items/${first}/pause`, payload: { paused: true } },
  ]
  for (const { url, payload } of calls) {
    const res = await app.inject({ method: 'POST', url, headers, payload })
    assert.equal(res.statusCode, 409, `${url}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'item_imported' }, url)
  }
  // Reads still work, and the item says why it is frozen.
  const read = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: owner.cookie } })
  assert.equal(read.statusCode, 200, read.body)
  const view = read.json().items.find((item) => item.id === first)
  assert.equal(view.imported, true)
  assert.deepEqual([view.moves.targets, view.moves.approveKey], [[], null], 'no move is offered on a frozen item')
  assert.deepEqual(sourceSnapshot(db, source), before)
})

test('metric 2: a direct moveItem call and store.approveGate are refused with item_imported, changing nothing', () => {
  const before = sourceSnapshot(db, source)
  assert.deepEqual(moveItem(first, { action: 'retry', who: 'test' }), { error: 'item_imported' })
  assert.deepEqual(store.approveGate(second, firstGate, 'ok', 'Owner'), { error: 'item_imported' })
  assert.deepEqual(store.requestChanges(second, 'x', 'feedback'), { error: 'item_imported' })
  assert.deepEqual(store.approveGateFromGithub(second), { error: 'item_imported' })
  assert.deepEqual(sourceSnapshot(db, source), before)
})

test('R2: a WhatsApp poll-vote approve and one caretaker pass leave the source unchanged, with no retry and no log above warn', async () => {
  const before = sourceSnapshot(db, source)
  const pollId = votes.registerPoll({ itemId: second, stepIndex: firstGate, recipient: APPROVER, question: `${second} — gate` })
  votes.attachPollMessageId(pollId, `MSG-${second}`)
  const vote = await app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers: { 'x-wa-approval-secret': WA_SECRET },
    payload: { voteId: `V-${second}`, pollMessageId: `MSG-${second}`, voterJid: APPROVER, selectedOption: POLL_APPROVE },
  })
  assert.equal(vote.statusCode, 409, vote.body)
  assert.equal(vote.json().error, 'ignored_item_imported')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_poll_vote WHERE vote_id = ?').get(`V-${second}`).n, 0, 'refused before the claim writes a row')

  const logged = []
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, (msg) => logged.push({ level, msg })]))
  const gateCalls = []
  const gateActions = {
    approve: (...args) => (gateCalls.push(args), app.gateActions.approve(...args)),
    sendBack: (...args) => (gateCalls.push(args), app.gateActions.sendBack(...args)),
  }
  const acted = await actor.actOnDecisions({ gateActions, log, send: async () => {} })
  assert.equal(acted.acted, 0)
  assert.deepEqual(gateCalls, [], 'the caretaker never tried to act on a frozen item')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caretaker_action WHERE item_id = ?').get(AT_ACT_GATE).n, 0)
  const swept = caretaker.sweepCaretaker({ log, policy: () => ({ rules: [] }) })
  assert.equal(swept.recorded, 0, 'no frozen item is judged')
  assert.deepEqual(logged.filter((l) => l.level === 'error' || l.level === 'fatal'), [])
  assert.deepEqual(sourceSnapshot(db, source), before)
})

const sign = (raw) => `sha256=${crypto.createHmac('sha256', HOOK_SECRET).update(raw).digest('hex')}`
const webhook = (event, payload) => {
  const raw = JSON.stringify(payload)
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(raw) },
    payload: raw,
  })
}

test('R4 / guardrail 1: issues.edited and issues.closed webhooks for a source issue leave the source and its copy byte-identical', async () => {
  const before = sourceSnapshot(db, source)
  const copiesBefore = copies()
  const copyEvents = () => db.prepare('SELECT COUNT(*) AS n FROM event e JOIN work_item w ON w.id = e.item_id WHERE w.project_id = ?').get(target).n
  const eventsBefore = copyEvents()
  const issue = (state) => ({ number: 1, title: 'Renamed on GitHub', body: '## Outcome\nChanged.', state, labels: [{ name: 'priority: low' }] })
  for (const [action, state] of [['edited', 'open'], ['closed', 'closed']]) {
    const res = await webhook('issues', { action, issue: issue(state), repository: { full_name: SOURCE_REPO } })
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${action}: ${res.statusCode} ${res.body}`)
  }
  const comment = await webhook('issue_comment', {
    action: 'created',
    issue: { number: 1 },
    comment: { id: 77, body: 'a comment on GitHub', user: { login: 'someone', type: 'User' } },
    repository: { full_name: SOURCE_REPO },
  })
  assert.equal(comment.statusCode, 204, comment.body)
  assert.deepEqual(sourceSnapshot(db, source), before)
  assert.deepEqual(copies(), copiesBefore)
  assert.equal(copyEvents(), eventsBefore)
  assert.deepEqual(stub.strays, [], 'nothing was written to GitHub')
})

test('guardrail 4: a project that was never imported moves, edits and syncs as before', async () => {
  const plain = store.createProject('Never imported').id
  store.setProjectEnabled(plain, true)
  const repo = 'acme/plain-app'
  assert.equal(store.addRepoToProject(plain, repo).ok, true)
  assert.equal(store.upsertFromGithub({ number: 5, title: 'Plain', body: '## Outcome\nPlain.', state: 'open', labels: [] }, repo), true)
  const id = store.findItemByIssue(repo, 5).id
  assert.equal(Object.hasOwn(store.itemViewById(id), 'imported'), false)
  assert.equal(Object.hasOwn(store.itemViewById(id), 'sourceItemId'), false)

  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/feedback`, headers, payload: { message: 'a note' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.upsertFromGithub({ number: 5, title: 'Plain, renamed', body: '## Outcome\nPlain.', state: 'open', labels: [] }, repo), true)
  assert.equal(store.getItem(id).title, 'Plain, renamed')
  assert.equal(moveItem(id, { action: 'retry', who: 'test' }).ok, true)
})
