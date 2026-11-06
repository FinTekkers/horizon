// HZ-731: Autopilot treats asks like gates. HZ-793: it never files one —
// every ask waits for the owner's File it or Dismiss.
//
// caretaker.init, caretakerActor.init and caretakerAsks.init are wired as
// server.js wires them, to the real app's gateActions and spies around
// spawn.js's filing calls, which caretakerAsks must never call. Items have no
// repo, so the owner's File it files a local item (spawn.js's demo path) and
// no case reaches GitHub; fetch fails every call to prove it.
// Asks and their reviews are seeded as HZ-728 and HZ-729 write them.
//
// Fake clock: `now` is a variable the tests move, and the 60s intervals run
// on node:test's mocked setInterval.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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
const spawnSpy = mock.fn(spawnItems)
const linkSpy = mock.fn(linkSpawned)
caretakerAsks.init(silent, { spawnItems: spawnSpy, linkSpawned: linkSpy, now: () => clock })

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
const itemCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
const STEP_NUMBER = /\bstep \d+\b/i
const ticks = async (n) => {
  for (let i = 0; i < n; i++) {
    store.notifyChange()
    await advance(60 * 1000)
  }
}
const fileIt = (itemId, askId) =>
  app.inject({ method: 'POST', url: `/api/items/${itemId}/asks/${askId}/file`, headers: { cookie: owner.cookie, 'x-human-key': owner.pin }, payload: {} })
const VERDICT_TEXT = {
  accept: 'The reviewer accepted it.',
  amend: 'The reviewer amended it.',
  escalate: 'The reviewer escalated it.',
  failed: 'Its review failed.',
  interrupted: 'Its review was cut short.',
}

test('metric 1: Autopilot on files no ask, whatever the verdict: each stays open and the owner is pinged once with its verdict', async () => {
  const p = project('on')
  const id = newItem('CA-ON', p, ARCH)
  const itemsBefore = itemCount()
  const asks = {
    accept: seedAsk(id, p, { verdict: 'accept', d: draft(p, { title: 'Accepted follow-up' }) }),
    amend: seedAsk(id, p, { kind: 'soft', verdict: 'amend', d: draft(p, { title: 'Amended follow-up' }), amended: draft(p, { title: 'Reviewer wording' }) }),
    escalate: seedAsk(id, p, { verdict: 'escalate', d: draft(p, { title: 'Escalated follow-up' }) }),
    failed: seedAsk(id, p, { verdict: 'escalate', status: 'failed', d: draft(p, { title: 'Failed-review follow-up' }) }),
    interrupted: seedAsk(id, p, { verdict: 'escalate', status: 'interrupted', d: draft(p, { title: 'Interrupted-review follow-up' }) }),
  }
  const titles = {
    accept: 'Accepted follow-up',
    amend: 'Amended follow-up',
    escalate: 'Escalated follow-up',
    failed: 'Failed-review follow-up',
    interrupted: 'Interrupted-review follow-up',
  }
  await ticks(3)

  for (const askId of Object.values(asks)) {
    assert.equal(askRow(askId).status, 'open')
    assert.equal(askRow(askId).filed_item_id, null)
  }
  assert.equal(itemCount(), itemsBefore, 'no item was created')
  assert.deepEqual(spawnedBy(id), [])
  assert.equal(spawnSpy.mock.callCount(), 0)
  assert.equal(linkSpy.mock.callCount(), 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM caretaker_ask_action WHERE action = 'file'").get().n, 0)

  const pings = pingsOf(id)
  assert.deepEqual(
    pings.map((g) => [g.reason, g.dedupe_key]),
    Object.values(asks).map((askId) => ['ask_escalated', `ask_escalated:${askId}`]),
    'exactly one ping per ask',
  )
  for (const [verdict, askId] of Object.entries(asks)) {
    const ping = pings.find((g) => g.dedupe_key === `ask_escalated:${askId}`)
    assert.equal(ping.recipient, '15550001111@s.whatsapp.net')
    assert.ok(ping.body.includes(`“${titles[verdict]}”`), ping.body)
    assert.ok(ping.body.includes(VERDICT_TEXT[verdict]), ping.body)
    assert.ok(ping.body.includes(`"${STEPS[ARCH].label}"`), 'the ping names the step by its label')
    assert.doesNotMatch(ping.body, STEP_NUMBER)
    assert.match(ping.body, /File it or dismiss it\.$/)
  }
  assert.doesNotMatch(pings.find((g) => g.dedupe_key === `ask_escalated:${asks.accept}`).body, /escalated/)
  assert.ok(eventsOf(id).includes('caretaker pinged the owner about the ask “Accepted follow-up” (the reviewer accepted it)'))
  assert.ok(!eventsOf(id).some((t) => /filed|would file|did not file/.test(t)))
})

test('metric 1: an ask already pinged as escalated is not pinged again; a contradiction the reviewer found is in the ping', async () => {
  const p = project('on')
  const id = newItem('CA-PINGED', p, ARCH)
  const askId = seedAsk(id, p, { d: draft(p, { title: 'Pinged before' }) })
  db.prepare("INSERT INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms) VALUES (?, ?, 'ask_escalated', ?, '', 'earlier ping', ?)").run(
    p.id,
    id,
    `ask_escalated:${askId}`,
    clock,
  )
  review(askId, 'accept')
  const contradicting = seedAsk(id, p, { d: draft(p, { title: 'Delete the ledger row' }) })
  review(contradicting, 'accept')
  db.prepare('UPDATE ask_review SET contradiction_json = ? WHERE ask_id = ?').run(JSON.stringify({ contradicts: true, detail: 'the design keeps the ledger row.' }), contradicting)
  await ticks(3)
  assert.deepEqual(pingsOf(id).map((g) => [g.dedupe_key, g.body === 'earlier ping']), [
    [`ask_escalated:${askId}`, true],
    [`ask_escalated:${contradicting}`, false],
  ])
  assert.ok(pingsOf(id)[1].body.includes("It may contradict CA-PINGED's description: the design keeps the ledger row. File it or dismiss it."), pingsOf(id)[1].body)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(askRow(contradicting).status, 'open')
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

test('metric 3: an accepted blocking ask holds the gate under on across ticks; the owner’s File it releases it', async () => {
  const p = project('on')
  const id = newItem('CA-GATE-FILE', p, REVIEW_BEFORE - 1)
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

  // The reviewer accepts it: Autopilot pings once about the verdict and files
  // nothing, so the gate stays held however many ticks pass.
  review(askId, 'accept')
  await ticks(3)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(cursorOf(id), REVIEW_BEFORE)
  assert.deepEqual(decisionsOf(id), [])
  assert.deepEqual(pingsOf(id).map((g) => g.reason), ['blocking_ask', 'ask_escalated'])
  assert.deepEqual(spawnedBy(id), [])

  // The owner files it; the next tick approves the gate.
  const res = await fileIt(id, askId)
  assert.equal(res.statusCode, 200, res.body)
  await ticks(1)
  await settle()
  assert.equal(askRow(askId).status, 'filed')
  assert.ok(askRow(askId).resolved_by.includes('Owner Example'))
  assert.equal(decisionsOf(id).length, 1)
  assert.equal(decisionsOf(id)[0].decided_by, 'Caretaker')
  assert.equal(cursorOf(id), IMPLEMENT_STEP_INDEX, 'the gate advanced')
  assert.equal(pingsOf(id).length, 2)
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

test('shadow records one "would ping" per ask and never "would file"; switched to on, the owner gets exactly one real ping', async () => {
  const p = project('shadow')
  const id = newItem('CA-SHADOW', p, REVIEW_BEFORE - 1)
  const askId = seedAsk(id, p, { verdict: 'accept', d: draft(p, { title: 'Shadow follow-up' }) })
  const soft = seedAsk(id, p, { kind: 'soft', verdict: 'amend', d: draft(p, { title: 'Shadow soft follow-up' }), amended: draft(p) })
  arrive(id, REVIEW_BEFORE, PROCEED)
  await settle()
  await ticks(3)
  assert.equal(askRow(askId).status, 'open')
  assert.equal(askRow(soft).status, 'open')
  assert.deepEqual(spawnedBy(id), [])
  assert.deepEqual(pingsOf(id), [])
  const events = eventsOf(id)
  assert.ok(!events.some((t) => t.includes('would file')), events.join('\n'))
  assert.deepEqual(
    events.filter((t) => t.startsWith('caretaker would ping the owner about the ask')),
    [
      'caretaker would ping the owner about the ask “Shadow follow-up” (the reviewer accepted it)',
      'caretaker would ping the owner about the ask “Shadow soft follow-up” (the reviewer amended it)',
    ],
  )
  assert.ok(events.includes('caretaker would hold “Review before execution” for the blocking ask “Shadow follow-up” and ping the owner'), events.join('\n'))

  // The project goes 'on': each ask's one real ping follows, once.
  db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(p.id)
  await ticks(2)
  const verdictPings = pingsOf(id).filter((g) => g.reason === 'ask_escalated')
  assert.deepEqual(verdictPings.map((g) => g.dedupe_key), [`ask_escalated:${askId}`, `ask_escalated:${soft}`])
  assert.equal(askRow(askId).status, 'open')
  assert.equal(askRow(soft).status, 'open')
})

test('metric 2: nothing in caretakerAsks.js calls fileAsk; the owner’s File it route is its only caller', () => {
  const caretakerSource = readFileSync(join(REPO_ROOT, 'server/src/caretakerAsks.js'), 'utf8')
  assert.doesNotMatch(caretakerSource, /\bfileAsk\b/)
  assert.doesNotMatch(caretakerSource, /\/file\b/)
  const srcDir = join(REPO_ROOT, 'server/src')
  const hits = []
  for (const name of readdirSync(srcDir, { recursive: true })) {
    if (!/\.(m?js)$/.test(name)) continue
    const lines = readFileSync(join(srcDir, name), 'utf8').split('\n')
    lines.forEach((text, i) => {
      if (/\bfileAsk\b/.test(text) && !text.trim().startsWith('//')) hits.push({ file: name, line: i, text: text.trim() })
    })
  }
  assert.deepEqual(
    hits.map((h) => h.file).sort(),
    ['app.js', 'app.js', 'asks.js'],
    hits.map((h) => `${h.file}: ${h.text}`).join('\n'),
  )
  assert.match(hits.find((h) => h.file === 'asks.js').text, /^export async function fileAsk\(/)
  const appHits = hits.filter((h) => h.file === 'app.js')
  assert.match(appHits[0].text, /^import \{[^}]*\bfileAsk\b[^}]*\} from '\.\/asks\.js'$/)
  // The call sits inside the /asks/:askId/file handler.
  const appLines = readFileSync(join(srcDir, 'app.js'), 'utf8').split('\n')
  const route = appLines.slice(0, appHits[1].line).findLast((text) => /^\s*'\/api\//.test(text))
  assert.equal(route.trim(), "'/api/items/:id/asks/:askId/file',")
  assert.match(appHits[1].text, /await fileAsk\(/)
})

test('guardrail 1: Autopilot never dismisses — no ask was dismissed except by the owner, and the module cannot', () => {
  // The Accept the code case sets one by hand (resolved_by NULL); the other is
  // the owner's Dismiss.
  const dismissed = db.prepare("SELECT resolved_by FROM ask WHERE status = 'dismissed' AND resolved_by IS NOT NULL").all()
  assert.equal(dismissed.length, 1, 'only the owner’s one Dismiss above')
  assert.ok(dismissed[0].resolved_by.includes('Owner Example'))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ask WHERE resolved_by = 'Caretaker'").get().n, 0)
  const source = readFileSync(join(REPO_ROOT, 'server/src/caretakerAsks.js'), 'utf8')
  assert.doesNotMatch(source, /import\s*\{[^}]*\bdismissAsk\b/)
  assert.doesNotMatch(source, /'dismissed'|\/dismiss\b/)
})
