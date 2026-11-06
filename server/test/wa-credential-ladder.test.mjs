// HZ-791: approve-via-whatsapp, poll-vote and autopilot-off-via-whatsapp all
// prove the WhatsApp caller through the one shared waCallerOk ladder that the
// gate-note routes use (HZ-786/HZ-790), and a WhatsApp client sees exactly the
// codes it saw when each route carried its own copy:
//
//   route                        503                         401                   403
//   approve-via-whatsapp         wa_approval_not_configured  bad_approval_secret   sender_not_allowed
//   poll-vote                    "                           "                     voter_not_allowed
//   autopilot-off-via-whatsapp   "                           "                     refused
//
// Every refusal runs before any lookup or write. The 503 half lives in
// wa-credential-ladder-unconfigured.test.mjs, because config.js reads the
// environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

globalThis.fetch = async () => {
  throw new Error('wa-credential-ladder test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-ladder-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) {
  delete process.env[key]
}
const WA_SECRET = 'wa-approval-secret-for-ladder-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
// The first entry is the owner; the second is an approver who is not.
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
// Every log line the app writes, at every level, for the no-echo check.
const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
await app.ready()
after(() => app.close())

const GATE = gateStepIndexes()[0]
const OWNER = '15550001111@s.whatsapp.net'
const APPROVER = '15550002222@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'
const BODIES = []

const item = (id) => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, `Ladder ${id}`, 'Medium', GATE)
}
let seq = 0
const poll = (id) => {
  item(id)
  const msgId = `LADDER-MSG-${++seq}`
  const pollId = votes.registerPoll({ itemId: id, stepIndex: GATE, recipient: OWNER, question: `${id} — ${STEPS[GATE].label}` })
  votes.attachPollMessageId(pollId, msgId)
  return msgId
}
const project = (name) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(id)
  return id
}

const inject = async (url, payload, secret) => {
  const res = await app.inject({
    method: 'POST',
    url,
    payload,
    headers: secret === null ? {} : { 'x-wa-approval-secret': secret },
  })
  BODIES.push(res.body)
  return res
}

// One request builder per route; each sends a schema-valid body only.
const ROUTES = {
  approve: {
    send: (target, jid, secret = WA_SECRET) =>
      inject(`/api/items/${target}/gates/${GATE}/approve-via-whatsapp`, { senderJid: jid, sender: 'Ladder' }, secret),
    refused: STRANGER,
    refusal: 'sender_not_allowed',
  },
  'poll-vote': {
    send: (target, jid, secret = WA_SECRET) =>
      inject('/api/wa/poll-vote', { voteId: `LADDER-V-${++seq}`, pollMessageId: target, voterJid: jid, selectedOption: POLL_APPROVE }, secret),
    refused: STRANGER,
    refusal: 'voter_not_allowed',
  },
  'autopilot-off': {
    send: (target, jid, secret = WA_SECRET) =>
      inject('/api/projects/autopilot-off-via-whatsapp', { project: target, senderJid: jid }, secret),
    // An allowed approver who is not the owner: proves isOwner is the 403 step.
    refused: APPROVER,
    refusal: 'refused',
  },
}

// Real targets the refusals aim at: a gated item, an open poll on a gated
// item, and an autopilot-on project.
item('L-APPROVE')
const REAL = {
  approve: 'L-APPROVE',
  'poll-vote': poll('L-POLL'),
  'autopilot-off': 'Ladder Project',
}
const PROJECT_ID = project(REAL['autopilot-off'])
const MISSING = { approve: 'L-NO-SUCH', 'poll-vote': 'LADDER-MSG-NEVER', 'autopilot-off': 'No Such Project' }

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const state = () => ({
  items: count('work_item'),
  cursors: db.prepare('SELECT id, cursor FROM work_item ORDER BY id').all(),
  decisions: count('gate_decision'),
  votes: count('gate_poll_vote'),
  events: count('event'),
  projectEvents: count('project_event'),
  autopilot: db.prepare('SELECT autopilot FROM project WHERE id = ?').get(PROJECT_ID).autopilot,
})

async function refusedUnchanged(run, status, error) {
  const before = state()
  const res = await run()
  assert.equal(res.statusCode, status, res.body)
  assert.deepEqual(res.json(), { error })
  assert.deepEqual(state(), before, `${status} ${error} was not side-effect free`)
}

for (const [name, route] of Object.entries(ROUTES)) {
  test(`${name}: a missing or wrong x-wa-approval-secret is 401 bad_approval_secret and nothing changes`, async () => {
    for (const target of [REAL[name], MISSING[name]]) {
      for (const secret of [null, 'wrong-secret']) {
        await refusedUnchanged(() => route.send(target, OWNER, secret), 401, 'bad_approval_secret')
      }
    }
  })

  test(`${name}: a refused sender is 403 ${route.refusal} and nothing changes`, async () => {
    await refusedUnchanged(() => route.send(REAL[name], route.refused), 403, route.refusal)
  })

  test(`${name}: a refusal for a nonexistent target is 401/403, never 404`, async () => {
    await refusedUnchanged(() => route.send(MISSING[name], route.refused), 403, route.refusal)
    await refusedUnchanged(() => route.send(MISSING[name], route.refused, 'wrong-secret'), 401, 'bad_approval_secret')
  })

  test(`${name}: a wrong secret AND a refused sender is 401, not 403`, async () => {
    await refusedUnchanged(() => route.send(REAL[name], route.refused, 'wrong-secret'), 401, 'bad_approval_secret')
  })
}

// Happy paths last: they move the real targets the refusals above aim at.
test('each route still proceeds past the ladder for a valid secret and an allowed sender', async () => {
  const approve = await ROUTES.approve.send(REAL.approve, APPROVER)
  assert.equal(approve.statusCode, 200, approve.body)
  assert.equal(approve.json().ok, true)

  const vote = await ROUTES['poll-vote'].send(REAL['poll-vote'], OWNER)
  assert.equal(vote.statusCode, 200, vote.body)
  assert.equal(vote.json().outcome, 'applied')

  const off = await ROUTES['autopilot-off'].send(REAL['autopilot-off'], OWNER)
  assert.equal(off.statusCode, 200, off.body)
  assert.equal(off.json().new, 'off')
})

test('no log line and no response body ever contains the secret value', () => {
  assert.ok(BODIES.length > 0)
  for (const text of [...BODIES, ...logs]) assert.ok(!text.includes(WA_SECRET), text)
})

// ---- metric 4: the source keeps one copy of the ladder ----

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/app.js'), 'utf8')

// The text of the function or route registration that starts at `marker`,
// up to the next top-level function or route registration.
function blockAt(marker) {
  const start = SOURCE.indexOf(marker)
  assert.ok(start >= 0, `${marker} not found in app.js`)
  const rest = SOURCE.slice(start + marker.length)
  const ends = [rest.search(/\n {2}fastify\.(get|post|put|patch|delete)\(/), rest.search(/\n(export )?(async )?function /)]
  const end = Math.min(...ends.filter((i) => i >= 0))
  return SOURCE.slice(start, start + marker.length + end)
}

test('approvalSecretOk( appears only inside the shared waCallerOk helper', () => {
  const helper = blockAt('function waCallerOk(')
  const hits = SOURCE.split('approvalSecretOk(').length - 1
  const inHelper = helper.split('approvalSecretOk(').length - 1
  assert.ok(hits <= 1, `approvalSecretOk( appears ${hits} times in app.js`)
  assert.equal(hits, inHelper, 'approvalSecretOk( is called outside waCallerOk')
})

test('all three routes call waCallerOk before any lookup, with no ladder copy of their own', () => {
  for (const [path, lookup] of [
    ["'/api/items/:id/gates/:step/approve-via-whatsapp'", 'gateStepOf('],
    ["'/api/wa/poll-vote'", 'applyVote('],
    ["'/api/projects/autopilot-off-via-whatsapp'", 'findProjectByName('],
  ]) {
    const block = blockAt(path)
    const guard = block.indexOf('waCallerOk(')
    assert.ok(guard >= 0, `${path} does not call waCallerOk`)
    assert.ok(block.indexOf(lookup) > guard, `${path}: ${lookup} must come after waCallerOk`)
    assert.ok(!block.includes('approvalSecretConfigured('), `${path} still carries its own 503 check`)
    assert.ok(!block.includes('approvalSecretOk('), `${path} still carries its own 401 check`)
  }
})
