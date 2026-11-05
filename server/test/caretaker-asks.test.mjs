// HZ-731: Autopilot treats asks like gates.
//
// caretaker.init, caretakerActor.init and caretakerAsks.init are wired as
// server.js wires them, to the real app's gateActions and spawn.js's filing
// calls. Items have no repo, so File it files a local item (spawn.js's demo
// path) and no case reaches GitHub; fetch fails every call to prove it.
// Asks and their reviews are seeded as HZ-728 and HZ-729 write them.
//
// Fake clock: `now` is a variable the tests move, and the 60s intervals run
// on node:test's mocked setInterval.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('caretaker-asks test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-asks-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '600000'
process.env.WA_APPROVER_JIDS = '15550001111'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET', 'WA_NOTIFY_ENABLED']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const caretakerAsks = await import('../src/caretakerAsks.js')
const accept = await import('../src/caretakerAccept.js')
const { spawnItems, linkSpawned } = await import('../src/spawn.js')
const { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

store.purgeDemoItems()
const silent = { info() {}, warn() {}, error() {} }
const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
await app.ready()

const T0 = Date.parse('2026-11-05T00:00:00Z')
let clock = T0
mock.timers.enable({ apis: ['setInterval'] })
caretaker.init(silent)
actor.init(silent, { gateActions: app.gateActions, now: () => clock, send: async () => {} })
caretakerAsks.init(silent, { spawnItems, linkSpawned, now: () => clock })

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}
const advance = async (ms) => {
  clock += ms
  mock.timers.tick(ms)
  await settle()
}

const ARCH = requiredStepIndex('Architecture review')
const REVIEW_BEFORE = requiredStepIndex('Review before execution')
const REPO = 'Acme/asks'

let projectSeq = 0
const project = (autopilot) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(`Asks project ${++projectSeq}`).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  db.prepare('INSERT INTO project_repo (repo, prefix, project_id) VALUES (?, ?, ?)').run(`${REPO}${projectSeq}`, `AQ${projectSeq}`, id)
  return { id, repo: `${REPO}${projectSeq}` }
}
const newItem = (id, p, cursor, { autopilotOff = 0 } = {}) => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, autopilot_off) VALUES (?, ?, 'High', ?, ?, ?)").run(
    id,
    `fixture ${id}`,
    cursor,
    p.id,
    autopilotOff,
  )
  return id
}
const draft = (p, over = {}) => ({
  title: 'Release bot signs publish commits',
  repo: p.repo,
  outcome: 'Publish commits are authored by the bot.',
  metric: '1. The bot authors each commit.\n2. A dry run names the bot.\n3. CI fails on any other author.',
  guardrails: '1. No new secrets.',
  ...over,
})
// One open ask raised at Architecture review, with a review when `verdict`
// (or a review `status` other than done) is given.
function seedAsk(itemId, p, { kind = 'blocking', d = draft(p), verdict = null, status = 'done', amended = null } = {}) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES (?, ?, 1, 'Architect', 'done', 'x', 'x')")
    .run(itemId, ARCH).lastInsertRowid
  const askId = Number(
    db
      .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, ?, 'open', ?, 'Architecture review: needed.')")
      .run(itemId, runId, ARCH, kind, JSON.stringify(d)).lastInsertRowid,
  )
  if (verdict) review(askId, verdict, { status, amended })
  return askId
}
const review = (askId, verdict, { status = 'done', amended = null } = {}) =>
  db
    .prepare("INSERT INTO ask_review (ask_id, provider, status, verdict, reasons_json, amended_draft_json) VALUES (?, 'muse', ?, ?, '[]', ?)")
    .run(askId, status, verdict, amended ? JSON.stringify(amended) : null)
// What the orchestrator does when a step finishes: the done run, the cursor
// onto the gate, then a store change.
const arrive = (itemId, gate, artifact) => {
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', 'x', ?)").run(itemId, gate - 1, artifact)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  store.notifyChange()
}
const PROCEED = '## Recommendation\n**PROCEED** — the plan is fine.\n'

const askRow = (askId) => db.prepare('SELECT * FROM ask WHERE id = ?').get(askId)
const actionsOf = (itemId) => db.prepare('SELECT * FROM caretaker_ask_action WHERE item_id = ? ORDER BY id').all(itemId)
const pingsOf = (itemId) => db.prepare('SELECT * FROM caretaker_ping WHERE item_id = ? ORDER BY id').all(itemId)
const eventsOf = (itemId) => db.prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Caretaker' ORDER BY id").all(itemId).map((e) => e.text)
const spawnedBy = (itemId) => db.prepare("SELECT child_id FROM item_spawn WHERE parent_id = ? AND status = 'filed' ORDER BY id").all(itemId).map((r) => r.child_id)
const decisionsOf = (itemId) => db.prepare('SELECT * FROM gate_decision WHERE item_id = ?').all(itemId)
const cursorOf = (itemId) => store.getItem(itemId).cursor
const STEP_NUMBER = /\bstep \d+\b/i

test('metric 1: Autopilot on files an accepted ask with its draft and an amended one with the amended draft; an escalated one is not filed and the owner is pinged', async () => {
  const p = project('on')
  const id = newItem('CA-ON', p, ARCH)
  const accepted = seedAsk(id, p, { verdict: 'accept', d: draft(p, { title: 'Accepted follow-up' }) })
  const amended = draft(p, { title: 'Amended follow-up, reviewer wording', outcome: 'The reviewer’s outcome.' })
  const amendedAsk = seedAsk(id, p, { kind: 'soft', verdict: 'amend', d: draft(p, { title: 'Original wording' }), amended })
  const escalated = seedAsk(id, p, { verdict: 'escalate', d: draft(p, { title: 'Escalated follow-up' }) })
  store.notifyChange()
  await settle()

  const acceptedRow = askRow(accepted)
  assert.equal(acceptedRow.status, 'filed')
  assert.equal(acceptedRow.resolved_by, 'Caretaker')
  assert.equal(store.getItem(acceptedRow.filed_item_id).title, 'Accepted follow-up')
  const amendedRow = askRow(amendedAsk)
  assert.equal(amendedRow.status, 'filed')
  const amendedChild = store.getItem(amendedRow.filed_item_id)
  assert.equal(amendedChild.title, amended.title, 'filed with the reviewer’s amended draft')
  assert.equal(amendedChild.desc, amended.outcome)
  assert.deepEqual(spawnedBy(id), [acceptedRow.filed_item_id, amendedRow.filed_item_id], 'exactly two items filed')
  // A blocking ask's item became a dependency; the soft one's did not.
  assert.deepEqual(store.blockersOf(id).map((b) => b.id), [acceptedRow.filed_item_id])

  assert.equal(askRow(escalated).status, 'open', 'an escalated ask is not filed')
  assert.equal(askRow(escalated).filed_item_id, null)
  const pings = pingsOf(id)
  assert.deepEqual(pings.map((g) => [g.reason, g.dedupe_key]), [['ask_escalated', `ask_escalated:${escalated}`]])
  assert.equal(pings[0].recipient, '15550001111@s.whatsapp.net')
  assert.match(pings[0].body, /Escalated follow-up/)
  assert.ok(pings[0].body.includes(`"${STEPS[ARCH].label}"`), 'the ping names the step by its label')
  assert.doesNotMatch(pings[0].body, STEP_NUMBER)

  // A second tick and a re-sweep add nothing.
  store.notifyChange()
  await advance(60 * 1000)
  assert.equal(spawnedBy(id).length, 2)
  assert.equal(pingsOf(id).length, 1)
  assert.equal(askRow(escalated).status, 'open')
})

test('metric 2: Autopilot off files nothing and records nothing; the accepted ask stays open for the owner', async () => {
  const p = project('off')
  const id = newItem('CA-OFF', p, ARCH)
  const askId = seedAsk(id, p, { verdict: 'accept' })
  store.notifyChange()
  await advance(60 * 1000)
  assert.equal(askRow(askId).status, 'open')
  assert.deepEqual(spawnedBy(id), [])
  assert.deepEqual(actionsOf(id), [])
  assert.deepEqual(pingsOf(id), [])
})

test('metric 2: an item with the autopilot-off label in an on project files nothing, writes no action row, and its ask stays open', async () => {
  const p = project('on')
  const id = newItem('CA-ITEM-OFF', p, ARCH, { autopilotOff: 1 })
  const askId = seedAsk(id, p, { verdict: 'accept' })
  const escalated = seedAsk(id, p, { verdict: 'escalate', d: draft(p, { title: 'Escalated, item off' }) })
  store.notifyChange()
  await advance(60 * 1000)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(askRow(escalated).status, 'open')
  assert.deepEqual(spawnedBy(id), [])
  assert.deepEqual(actionsOf(id), [])
  assert.deepEqual(pingsOf(id), [])
})

test('metric 3: at Review before execution an open blocking ask holds the gate and pings once; Autopilot filing it releases the gate', async () => {
  const p = project('on')
  const id = newItem('CA-GATE-FILE', p, REVIEW_BEFORE - 1)
  // No review yet, so nothing files it: it stays open.
  const askId = seedAsk(id, p, { d: draft(p, { title: 'Prerequisite fix' }) })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()

  assert.equal(cursorOf(id), REVIEW_BEFORE, 'the gate is not approved')
  assert.deepEqual(decisionsOf(id), [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caretaker_eval WHERE item_id = ?').get(id).n, 0, 'no decision is locked in')
  const pings = pingsOf(id)
  assert.equal(pings.length, 1)
  assert.equal(pings[0].reason, 'blocking_ask')
  assert.ok(pings[0].body.includes('"Review before execution"'))
  assert.ok(pings[0].body.includes('Prerequisite fix'))
  assert.doesNotMatch(pings[0].body, STEP_NUMBER)
  assert.ok(eventsOf(id).some((t) => t.includes('did not approve “Review before execution”')))

  // Re-sweeps and change signals ping no second time.
  store.notifyChange()
  await advance(60 * 1000)
  await advance(60 * 1000)
  assert.equal(pingsOf(id).length, 1)
  assert.equal(cursorOf(id), REVIEW_BEFORE)

  // The reviewer accepts it; Autopilot files it, and the gate is approved.
  review(askId, 'accept')
  store.notifyChange()
  await settle()
  await settle()
  assert.equal(askRow(askId).status, 'filed')
  assert.equal(decisionsOf(id).length, 1)
  assert.equal(decisionsOf(id)[0].decided_by, 'Caretaker')
  assert.equal(cursorOf(id), IMPLEMENT_STEP_INDEX, 'the gate advanced')
  assert.equal(pingsOf(id).length, 1)
})

test('metric 3: the gate is approved once the owner dismisses the blocking ask', async () => {
  const p = project('on')
  const id = newItem('CA-GATE-DISMISS', p, REVIEW_BEFORE - 1)
  const askId = seedAsk(id, p, { verdict: 'escalate', d: draft(p, { title: 'Owner’s call' }) })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()
  assert.equal(cursorOf(id), REVIEW_BEFORE)
  assert.deepEqual(pingsOf(id).map((g) => g.reason).sort(), ['ask_escalated', 'blocking_ask'])

  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/asks/${askId}/dismiss`,
    headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
    payload: { reason: 'Already covered elsewhere.' },
  })
  assert.equal(res.statusCode, 200, res.body)
  await settle()
  await settle()
  assert.equal(askRow(askId).status, 'dismissed')
  assert.equal(decisionsOf(id).length, 1)
  assert.equal(cursorOf(id), IMPLEMENT_STEP_INDEX)
})

test('metric 3: Accept the code waits while a blocking ask is open and proceeds after it is filed or dismissed', () => {
  const p = project('on')
  for (const resolution of ['filed', 'dismissed']) {
    const id = newItem(`CA-ACCEPT-${resolution}`, p, ACCEPT_GATE_INDEX)
    db.prepare('UPDATE work_item SET pr = 7, pr_mergeable = 1 WHERE id = ?').run(id)
    const reviewRun = Number(
      db
        .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'x', 'done', 'review passed')")
        .run(id, ACCEPT_GATE_INDEX - 1).lastInsertRowid,
    )
    const askId = seedAsk(id, p)
    const row = { item_id: id, arrival_run_id: reviewRun, forwarded_review_run_id: null, pr_mergeable: 1 }
    assert.deepEqual(accept.decideAcceptGate(accept.gatherAcceptFacts(row)), { kind: 'wait', reason: accept.BLOCKING_ASK_WAIT })
    db.prepare('UPDATE ask SET status = ? WHERE id = ?').run(resolution, askId)
    assert.equal(accept.decideAcceptGate(accept.gatherAcceptFacts(row)).kind, 'accept', `proceeds once ${resolution}`)
  }
})

test('guardrail 2: an open soft ask never holds the gate', async () => {
  const p = project('on')
  const id = newItem('CA-SOFT', p, REVIEW_BEFORE - 1)
  seedAsk(id, p, { kind: 'soft' })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()
  assert.equal(cursorOf(id), IMPLEMENT_STEP_INDEX)
  assert.deepEqual(pingsOf(id), [])
})

test('guardrail 3: an open split ask is never filed and never holds the gate', async () => {
  const p = project('on')
  const id = newItem('CA-SPLIT', p, REVIEW_BEFORE - 1)
  const askId = seedAsk(id, p, { kind: 'split', verdict: 'accept' })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()
  assert.equal(askRow(askId).status, 'open')
  assert.deepEqual(spawnedBy(id), [])
  assert.deepEqual(actionsOf(id), [])
  assert.equal(cursorOf(id), IMPLEMENT_STEP_INDEX)
})

test('shadow records what Autopilot would do — file, hold — and files, pings and approves nothing', async () => {
  const p = project('shadow')
  const id = newItem('CA-SHADOW', p, REVIEW_BEFORE - 1)
  const askId = seedAsk(id, p, { verdict: 'accept', d: draft(p, { title: 'Shadow follow-up' }) })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()
  assert.equal(askRow(askId).status, 'open')
  assert.deepEqual(spawnedBy(id), [])
  assert.deepEqual(pingsOf(id), [])
  const events = eventsOf(id)
  assert.ok(events.includes('caretaker would file the ask “Shadow follow-up”'), events.join('\n'))
  assert.ok(events.includes('caretaker would hold “Review before execution” for the blocking ask “Shadow follow-up” and ping the owner'), events.join('\n'))
  await advance(60 * 1000)
  assert.equal(eventsOf(id).length, events.length, 'once each')
})

test('a filing that fails is recorded once, pings once and is never retried', async () => {
  const p = project('on')
  const id = newItem('CA-FAIL', p, ARCH)
  const askId = seedAsk(id, p, { verdict: 'amend', amended: draft(p, { repo: 'Nobody/unknown' }) })
  store.notifyChange()
  await settle()
  await advance(60 * 1000)
  assert.equal(askRow(askId).status, 'open')
  assert.deepEqual(actionsOf(id).map((a) => [a.action, a.outcome]), [['file', 'failed']])
  assert.deepEqual(pingsOf(id).map((g) => g.dedupe_key), [`ask_file_failed:${askId}`])
  assert.deepEqual(spawnedBy(id), [])
})

test('guardrail 1: Autopilot never dismisses — no ask was dismissed except by the owner, and the module cannot', () => {
  // The Accept the code case sets one by hand (resolved_by NULL); the other is
  // the owner's Dismiss.
  const dismissed = db.prepare("SELECT resolved_by FROM ask WHERE status = 'dismissed' AND resolved_by IS NOT NULL").all()
  assert.equal(dismissed.length, 1, 'only the owner’s one Dismiss above')
  assert.ok(dismissed[0].resolved_by.includes('Owner Example'))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ask WHERE resolved_by = 'Caretaker' AND status <> 'filed'").get().n, 0)
  const source = readFileSync(join(REPO_ROOT, 'server/src/caretakerAsks.js'), 'utf8')
  assert.doesNotMatch(source, /import\s*\{[^}]*\bdismissAsk\b/)
  assert.doesNotMatch(source, /'dismissed'|\/dismiss\b/)
})
