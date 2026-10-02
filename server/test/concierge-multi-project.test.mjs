// HZ-209: one WhatsApp concierge across every enabled project — the server
// half. The farm half (routing, the ask reply, the one session) is
// farm/tests/test_multi_project_concierge.py, which loads the snapshot this
// file pins as farm/tests/fixtures/snapshot_multi_project.json.
//
// Three projects: Horizon (HZ) and FinTekkers (US) enabled, Ledger (LS)
// disabled. Each has item 12 at the first gate.
//
// Its own file because config.js reads the environment at import time.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-concierge-multi-')), 'test.db')
process.env.WA_NOTIFY_ENABLED = '1'
delete process.env.WA_POLL_ENABLED
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-tests'
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const votes = await import('../src/waPollVotes.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
await app.ready()
after(() => app.close())

const FIXTURE = join(import.meta.dirname, '../../farm/tests/fixtures/snapshot_multi_project.json')
const GATE = gateStepIndexes()[0]
const DAVID = '15550001111@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'
const FARM = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const WA = { 'x-wa-approval-secret': 'wa-approval-secret-for-tests' }

// GitHub is the only network the app reaches here (POST /api/items). Issue
// numbers count up so every created item has its own id.
const githubCalls = []
let issueNumber = 500
globalThis.fetch = async (url, opts) => {
  githubCalls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  const body = String(url).endsWith('/labels')
    ? {}
    : { number: ++issueNumber, title: JSON.parse(opts.body).title, body: '', html_url: `https://github.com/x/issues/${issueNumber}`, labels: [], state: 'open' }
  return { ok: true, status: 200, json: async () => body }
}

function project(name, prefix, repo) {
  const { id } = store.createProject(name)
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(id, repo, prefix)
  return id
}
const HORIZON = project('Horizon', 'HZ', 'FinTekkers/horizon')
const FINTEKKERS = project('FinTekkers', 'US', 'FinTekkers/ui-service')
const LEDGER = project('Ledger', 'LS', 'FinTekkers/ledger-service')
store.setProjectEnabled(FINTEKKERS, true)
store.setProjectEnabled(LEDGER, false)

function item(id, projectId, title, repo) {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, desc, metric, cursor, project_id, repo, issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, title, 'High', `${title} outcome`, `${title} metric`, GATE, projectId, repo, Number(id.split('-')[1]))
}
item('HZ-12', HORIZON, 'Horizon dashboard refresh', 'FinTekkers/horizon')
item('US-12', FINTEKKERS, 'Portfolio export button', 'FinTekkers/ui-service')
item('LS-12', LEDGER, 'Ledger reconciliation job', 'FinTekkers/ledger-service')

const snapshotOf = (query = '') => app.inject({ method: 'GET', url: `/api/farm/snapshot${query}`, headers: FARM })
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const notices = (id) => db.prepare('SELECT * FROM gate_notice WHERE item_id = ?').all(id)
const polls = (id) => db.prepare('SELECT * FROM gate_poll WHERE item_id = ?').all(id)
const voteRows = (id) =>
  db.prepare('SELECT v.* FROM gate_poll_vote v JOIN gate_poll p ON p.id = v.poll_id WHERE p.item_id = ?').all(id)
const stateOf = (id) => ({ cursor: row(id).cursor, rejected: row(id).rejected, notified: row(id).notified_step, votes: voteRows(id) })

// The fields farm/concierge_routing.py and build_prompt read, nothing else —
// so the fixture is the real reply's shape without volatile timestamps.
function forPython(snapshot) {
  return {
    activeProjectId: snapshot.activeProjectId,
    projects: snapshot.projects.map(({ id, name, enabled, repos }) => ({ id, name, enabled, repos })),
    items: snapshot.items.map((it) => ({
      id: it.id,
      project_id: it.project_id,
      title: it.title,
      priority: it.priority,
      desc: it.desc,
      metric: it.metric,
      paused: it.paused,
      activeRun: it.activeRun,
      abandoned_at: it.abandoned_at,
      currentStep: it.currentStep,
      pr: it.pr,
      stepOutputs: it.stepOutputs,
    })),
  }
}

// ---- metric 1: the snapshot the one concierge reads ----

test('?scope=enabled returns every enabled project\'s items, never a disabled one\'s, in the shape Python reads', async () => {
  const res = await snapshotOf('?scope=enabled')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.items.map((it) => it.id).sort(), ['HZ-12', 'US-12'])

  for (const p of body.projects) {
    assert.equal(typeof p.id, 'number')
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.enabled, 'boolean')
    for (const r of p.repos) assert.equal(typeof r.prefix, 'string')
  }
  for (const it of body.items) {
    assert.equal(typeof it.id, 'string')
    assert.ok(it.project_id === null || Number.isInteger(it.project_id))
  }
  assert.deepEqual(
    body.projects.map((p) => [p.name, p.enabled, p.repos.map((r) => r.prefix)]),
    [['FinTekkers', true, ['US']], ['Horizon', true, ['HZ']], ['Ledger', false, ['LS']]],
  )

  // The checked-in fixture IS this reply, so the Python tests can't drift
  // from it. UPDATE_FIXTURES=1 rewrites it after a deliberate shape change.
  const actual = forPython(body)
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`)
  assert.deepEqual(actual, JSON.parse(readFileSync(FIXTURE, 'utf8')))
})

test('with no scope the snapshot is unchanged: the active project\'s items only', async () => {
  const body = (await snapshotOf()).json()
  assert.deepEqual(body.items.map((it) => it.id), ['HZ-12'])
  assert.deepEqual((await snapshotOf('?scope=active')).json().items, body.items)
  assert.equal(body.activeProjectId, HORIZON)
})

test('a scope outside active|enabled is a 400, and the secret is still required', async () => {
  assert.equal((await snapshotOf('?scope=all')).statusCode, 400)
  const bare = await app.inject({ method: 'GET', url: '/api/farm/snapshot?scope=enabled' })
  assert.equal(bare.statusCode, 401)
})

// ---- metric 2 and 4: notifications ----

test('a gate arrival in each enabled project is notified once, naming its key; the disabled project\'s gets nothing', () => {
  notifier.sweepGates()

  for (const id of ['HZ-12', 'US-12']) {
    const sent = notices(id)
    assert.equal(sent.length, 1, `${id}: ${sent.length} notices`)
    assert.match(sent[0].body, new RegExp(id))
    assert.equal(polls(id).length, 1, `${id}: one poll`)
    assert.equal(row(id).notified_step, GATE)
  }
  assert.deepEqual(notices('LS-12'), [])
  assert.deepEqual(polls('LS-12'), [])
  assert.equal(row('LS-12').notified_step, null)

  // A second sweep notifies nobody twice.
  notifier.sweepGates()
  assert.equal(notices('HZ-12').length + notices('US-12').length, 2)
})

test('re-enabling a disabled project notifies its waiting item on the next sweep, once', () => {
  store.setProjectEnabled(LEDGER, true)
  try {
    notifier.sweepGates()
    notifier.sweepGates()
    assert.equal(notices('LS-12').length, 1)
    assert.match(notices('LS-12')[0].body, /LS-12/)
    assert.equal(row('LS-12').notified_step, GATE)
  } finally {
    store.setProjectEnabled(LEDGER, false)
  }
})

// ---- metric 2 and guardrails 2, 7: votes ----

function pollMsg(id) {
  const poll = polls(id).at(-1)
  const msgId = `MSG-${id}-${poll.id}`
  votes.attachPollMessageId(poll.id, msgId)
  return msgId
}
const vote = (msgId, { voter = DAVID, voteId = `V-${msgId}-${voter}`, headers = WA } = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers,
    payload: { voteId, pollMessageId: msgId, voterJid: voter, selectedOption: POLL_APPROVE },
  })

test('a disabled project\'s vote is refused before anything is written; the allowlist and the secret still win', async () => {
  // Ledger was enabled, its item notified and polled, then disabled again.
  const msgId = pollMsg('LS-12')
  const before = stateOf('LS-12')

  const stranger = await vote(msgId, { voter: STRANGER })
  assert.equal(stranger.statusCode, 403)
  assert.deepEqual(stranger.json(), { error: 'voter_not_allowed' })

  const forged = await vote(msgId, { headers: { 'x-wa-approval-secret': 'wrong' } })
  assert.equal(forged.statusCode, 401)

  const res = await vote(msgId)
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'ignored_project_disabled' })
  assert.deepEqual(stateOf('LS-12'), before)
  assert.deepEqual(voteRows('LS-12'), [])

  const direct = await votes.applyVote(
    { voteId: 'V-direct-ls', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    { approve: () => assert.fail('approve reached'), sendBack: () => assert.fail('sendBack reached') },
  )
  assert.equal(direct.outcome, 'ignored_project_disabled')
  assert.equal(direct.status, 409)
  assert.equal(direct.itemId, 'LS-12')
  assert.equal(direct.stepIndex, GATE)
  assert.deepEqual(voteRows('LS-12'), [])
})

test('a valid vote on each enabled project\'s item moves that item only', async () => {
  const hz = pollMsg('HZ-12')
  const us = pollMsg('US-12')

  const usBefore = stateOf('US-12')
  const first = await vote(hz)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().itemId, 'HZ-12')
  assert.equal(row('HZ-12').cursor, GATE + 1)
  assert.deepEqual(stateOf('US-12'), usBefore, 'a Horizon vote touched FinTekkers')

  const hzAfter = stateOf('HZ-12')
  const second = await vote(us)
  assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json().itemId, 'US-12')
  assert.equal(row('US-12').cursor, GATE + 1)
  assert.deepEqual(stateOf('HZ-12'), hzAfter, 'a FinTekkers vote touched Horizon')
})

// ---- guardrail 7 on the numbered-choice path: the real store refusal ----

test('approve-via-whatsapp on a disabled project\'s item is refused project_not_active and changes nothing', async () => {
  const before = stateOf('LS-12')
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/LS-12/gates/${GATE}/approve-via-whatsapp`,
    headers: WA,
    payload: { sender: 'David', senderJid: DAVID },
  })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error, 'project_not_active')
  assert.deepEqual(stateOf('LS-12'), before)
})

// ---- guardrail 4: the wizard names the project, never a fallback ----

const createItem = (payload) =>
  app.inject({
    method: 'POST',
    url: '/api/items',
    headers: { cookie },
    payload: { title: 'From WhatsApp', outcome: 'An outcome long enough', metric: 'A metric long enough', ...payload },
  })

test('POST /api/items with an enabled projectId creates the item in that project, not the active one', async () => {
  const res = await createItem({ projectId: FINTEKKERS })
  assert.equal(res.statusCode, 200, res.body)
  assert.match(res.json().id, /^US-\d+$/)
  assert.equal(row(res.json().id).project_id, FINTEKKERS)
  assert.ok(githubCalls.some((c) => c.url.includes('/repos/FinTekkers/ui-service/issues')))
})

test('POST /api/items with a disabled or unknown projectId is refused and creates nothing', async () => {
  const calls = githubCalls.length
  for (const projectId of [LEDGER, 999]) {
    const res = await createItem({ projectId })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'project_not_enabled' })
  }
  assert.equal((await createItem({ projectId: 'abc' })).statusCode, 400)
  assert.equal(githubCalls.length, calls, 'a refused create reached GitHub')
})

test('POST /api/items with no projectId still goes to the active project', async () => {
  const res = await createItem({})
  assert.equal(res.statusCode, 200, res.body)
  assert.match(res.json().id, /^HZ-\d+$/)
})
