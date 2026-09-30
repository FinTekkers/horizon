// HZ-140: the fail-closed half. WA_APPROVAL_SECRET and WA_APPROVER_JIDS have
// no dev fallback (unlike FARM_SHARED_SECRET's 'dev-secret'), so a host that
// hasn't set them must refuse every WhatsApp approval rather than quietly
// accept one.
//
// Its own file because config.js reads the environment at import time: the
// "configured" matrix in wa-approval-auth.test.mjs cannot also observe the
// unset case inside one process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-unset-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
delete process.env.WA_APPROVAL_SECRET
delete process.env.WA_APPROVER_JIDS

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')
const { approvalSecretConfigured, isAllowedApprover } = await import('../src/waApprovers.js')
const store = await import('../src/store.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })

const GATE_INDEX = STEPS.findIndex((s) => s.kind === 'gate')
const DAVID = '15550001111@s.whatsapp.net'

db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
  'W-UNSET',
  'No approval config on this host',
  'Medium',
  GATE_INDEX,
)

const post = (headers) =>
  app.inject({
    method: 'POST',
    url: `/api/items/W-UNSET/gates/${GATE_INDEX}/approve-via-whatsapp`,
    payload: { senderJid: DAVID, sender: 'David' },
    headers,
  })

const cursor = () => db.prepare("SELECT cursor FROM work_item WHERE id = 'W-UNSET'").get().cursor
const decisions = () => db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get().n
const events = () => db.prepare('SELECT COUNT(*) AS n FROM event').get().n

test('an unset WA_APPROVAL_SECRET means no credential is configured', () => {
  assert.equal(approvalSecretConfigured(), false)
})

test('an unset WA_APPROVER_JIDS denies every sender, never allows all', () => {
  for (const jid of [DAVID, '15550002222@s.whatsapp.net', '19998887777@s.whatsapp.net']) {
    assert.equal(isAllowedApprover(jid), false)
  }
})

test('every approval is 503, even from a plausible sender with a plausible header', async () => {
  const before = { cursor: cursor(), decisions: decisions(), events: events() }
  for (const headers of [{}, { 'x-wa-approval-secret': 'anything' }, { 'x-farm-secret': 'dev-secret' }]) {
    const res = await post(headers)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { error: 'wa_approval_not_configured' })
  }
  assert.equal(cursor(), before.cursor)
  assert.equal(decisions(), before.decisions)
  assert.equal(events(), before.events)
})
