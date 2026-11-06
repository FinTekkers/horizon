// HZ-791: the fail-closed half of wa-credential-ladder.test.mjs. With no
// WA_APPROVAL_SECRET on this host, approve-via-whatsapp, poll-vote and
// autopilot-off-via-whatsapp all answer 503 wa_approval_not_configured through
// the shared waCallerOk ladder — whatever header the caller sends, and before
// any lookup, so an unknown target is 503 too and nothing is written.
//
// Its own file because config.js reads the environment at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('wa-credential-ladder-unconfigured test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-ladder-unset-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) {
  delete process.env[key]
}
delete process.env.WA_APPROVAL_SECRET
// Approvers are configured, so only the missing secret can explain the 503.
process.env.WA_APPROVER_JIDS = '15550001111'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })

const GATE = gateStepIndexes()[0]
const OWNER = '15550001111@s.whatsapp.net'

db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run('U-GATE', 'Unconfigured ladder', 'Medium', GATE)
const pollId = votes.registerPoll({ itemId: 'U-GATE', stepIndex: GATE, recipient: OWNER, question: `U-GATE — ${STEPS[GATE].label}` })
votes.attachPollMessageId(pollId, 'U-MSG-1')
const PROJECT_ID = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Unset Project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(PROJECT_ID)

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const state = () => ({
  items: count('work_item'),
  cursor: db.prepare("SELECT cursor FROM work_item WHERE id = 'U-GATE'").get().cursor,
  decisions: count('gate_decision'),
  votes: count('gate_poll_vote'),
  events: count('event'),
  projectEvents: count('project_event'),
  autopilot: db.prepare('SELECT autopilot FROM project WHERE id = ?').get(PROJECT_ID).autopilot,
})

const REQUESTS = [
  ['approve', (t) => [`/api/items/${t}/gates/${GATE}/approve-via-whatsapp`, { senderJid: OWNER, sender: 'Owner' }], ['U-GATE', 'U-NO-SUCH']],
  ['poll-vote', (t) => ['/api/wa/poll-vote', { voteId: `U-V-${t}`, pollMessageId: t, voterJid: OWNER, selectedOption: POLL_APPROVE }], ['U-MSG-1', 'U-MSG-NEVER']],
  ['autopilot-off', (t) => ['/api/projects/autopilot-off-via-whatsapp', { project: t, senderJid: OWNER }], ['Unset Project', 'No Such Project']],
]

for (const [name, build, targets] of REQUESTS) {
  test(`${name}: every request is 503 wa_approval_not_configured and writes nothing`, async () => {
    const before = state()
    for (const target of targets) {
      for (const headers of [{}, { 'x-wa-approval-secret': 'anything' }, { 'x-farm-secret': 'dev-secret' }]) {
        const [url, payload] = build(target)
        const res = await app.inject({ method: 'POST', url, payload, headers })
        assert.equal(res.statusCode, 503, `${url} ${JSON.stringify(headers)}: ${res.body}`)
        assert.deepEqual(res.json(), { error: 'wa_approval_not_configured' })
      }
    }
    assert.deepEqual(state(), before)
  })
}
