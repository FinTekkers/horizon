// HZ-540 metric 3: a gate notice, its WhatsApp poll question and the
// WhatsApp send-back name the sub-step the item is at when its snapshot puts
// one at that step (domain/js/substeps.js stepLabel), and the step's own
// label otherwise — byte-equal to the text before sub-steps.
//
// HZ-538's loader only anchors sub-steps on agent steps, so a sub-step at a
// gate is snapshot data written here directly: the notifier names whatever
// the snapshot says, with no rule of its own about which steps have them.
//
// Its own file because config.js reads the environment at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gate-notifier-substep-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const WA_SECRET = 'wa-approval-secret-for-substep-tests'
const APPROVER = '15550001111@s.whatsapp.net'
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = APPROVER

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_SEND_BACK } = await import('../src/waSend.js')
const { renderNotice, renderPollQuestion } = await import('../src/gateNotifier.js')
const { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })

const GATE = ACCEPT_GATE_INDEX
const AT_GATE = { id: 'gate-check', label: 'Check the change', kind: 'audit', anchor: GATE, persona: null }
const AUDIT = { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: null }

// A work_item row as the sweep reads it (SELECT *).
function seed(id, { substeps = null, substepCursor = null } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, substeps_json, substep_cursor) VALUES (?, ?, 'Medium', ?, ?, ?)").run(
    id,
    `Item ${id}`,
    GATE,
    substeps && JSON.stringify(substeps),
    substepCursor,
  )
  return db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
}

const gateLine = (notice) => notice.split('\n').find((l) => l.startsWith('Gate: '))

test('at a sub-step of the gate, the notice and poll question name the sub-step', () => {
  const row = seed('G-1', { substeps: [AUDIT, AT_GATE], substepCursor: 'gate-check' })
  assert.equal(gateLine(renderNotice(row)), 'Gate: Check the change')
  assert.equal(renderPollQuestion(row), 'G-1 — Check the change')
})

test('at no sub-step, they name the gate exactly as before', () => {
  for (const [id, opts] of [
    ['G-2', {}],
    ['G-3', { substeps: [AUDIT, AT_GATE] }],
  ]) {
    const row = seed(id, opts)
    assert.equal(gateLine(renderNotice(row)), `Gate: ${STEPS[GATE].label}`, id)
    assert.equal(renderPollQuestion(row), `${id} — ${STEPS[GATE].label}`, id)
  }
})

test('a substep_cursor naming another step’s sub-step leaves the gate its own label', () => {
  const row = seed('G-4', { substeps: [AUDIT, AT_GATE], substepCursor: 'impl-audit' })
  assert.equal(gateLine(renderNotice(row)), `Gate: ${STEPS[GATE].label}`)
  assert.equal(renderPollQuestion(row), `G-4 — ${STEPS[GATE].label}`)
})

let seq = 0
async function sendBackByPoll(id) {
  const pollId = votes.registerPoll({ itemId: id, stepIndex: GATE, recipient: APPROVER, question: renderPollQuestion(store.getItem(id)) })
  const msgId = `MSG-${++seq}`
  votes.attachPollMessageId(pollId, msgId)
  const res = await app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers: { 'x-wa-approval-secret': WA_SECRET },
    payload: { voteId: `V-${seq}`, pollMessageId: msgId, voterJid: APPROVER, selectedOption: POLL_SEND_BACK },
  })
  assert.equal(res.statusCode, 200, res.body)
  return db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE 'requested changes on %' ORDER BY id DESC LIMIT 1").get(id).text
}

test('a WhatsApp send-back names the sub-step at a sub-step, and the gate as before otherwise', async () => {
  seed('W-1', { substeps: [AUDIT, AT_GATE], substepCursor: 'gate-check' })
  assert.match(await sendBackByPoll('W-1'), /^requested changes on Check the change[: ]/)

  seed('W-2')
  const before = await sendBackByPoll('W-2')
  assert.ok(before.startsWith(`requested changes on ${STEPS[GATE].label}`), before)
  assert.ok(before.endsWith(` — sent back to the ${STEPS[IMPLEMENT_STEP_INDEX].label.toLowerCase()} step`), before)
})
