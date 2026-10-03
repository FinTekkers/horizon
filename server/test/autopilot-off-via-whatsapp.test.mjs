// HZ-274 metric 1: the WhatsApp kill switch, driven through the real Fastify
// app. The concierge (farm/autopilot_command.py) posts the body below; its
// pytest asserts it sends this same literal shape, so the two cannot drift.
//
// Only the owner — the first WA_APPROVER_JIDS entry — may turn a project's
// Autopilot off this way. Every other sender gets one identical refusal,
// whether or not the project exists. The route can only write 'off', and
// nothing else (PIN, rules, other projects) moves. Numbers are fake; nothing
// is sent anywhere.
//
// Its own file because config.js reads the environment at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('autopilot-off-via-whatsapp test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-autopilot-off-wa-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED', 'CARETAKER_HOURLY_LIMIT']) {
  delete process.env[key]
}
const WA_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
// A bare number in env, the form DEPLOY.md documents; the second is another
// approver, not the owner.
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
process.env.RULES_HMAC_SECRET = 'rules-hmac-secret-for-tests'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const rulesStore = await import('../src/rulesStore.js')
const actor = await import('../src/caretakerActor.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const OWNER = '15550001111@s.whatsapp.net'
const OTHER_APPROVER = '15550002222@s.whatsapp.net'
const LID_NON_OWNER = '15550003333@lid'
const ROUTE = '/api/projects/autopilot-off-via-whatsapp'

const project = (name, autopilot = 'on') => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const modeOf = (id) => db.prepare('SELECT autopilot FROM project WHERE id = ?').get(id).autopilot
const eventsOf = (id) => db.prepare("SELECT * FROM project_event WHERE project_id = ? AND kind = 'autopilot' ORDER BY id").all(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
// The literal body farm/autopilot_command.py posts.
const post = (projectName, senderJid, { secret = WA_SECRET, extra = {} } = {}) =>
  app.inject({
    method: 'POST',
    url: ROUTE,
    payload: { project: projectName, senderJid, ...extra },
    headers: secret === null ? {} : { 'x-wa-approval-secret': secret },
  })

// An 'on'-mode approve decision on record for an item parked at gate 5.
const approveOnRecord = (itemId, projectId) => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', 4, ?)").run(itemId, `fixture ${itemId}`, projectId)
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, 4, 'x', 'done', 'fixture')")
    .run(itemId).lastInsertRowid
  db.prepare('UPDATE work_item SET cursor = 5 WHERE id = ?').run(itemId)
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, 5, ?, 'on', 'approve', 'fixture')",
  ).run(itemId, runId)
}
const silent = { info() {}, warn() {}, error() {} }
const tick = () => actor.actOnDecisions({ gateActions: app.gateActions, log: silent, send: async () => {} })

test('owner: off is set, audited with its source and no jid, and the next caretaker poll acts on nothing (with a control)', async () => {
  const pid = project('Horizon')
  // Control: while 'on', the caretaker acts on a seeded decision.
  approveOnRecord('KS-1', pid)
  const before = await tick()
  assert.equal(before.acted, 1)
  assert.equal(cursorOf('KS-1'), 6)

  // Reseed, then the owner turns it off from WhatsApp.
  approveOnRecord('KS-2', pid)
  const res = await post('Horizon', OWNER)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, project: 'Horizon', old: 'on', new: 'off' })
  assert.equal(modeOf(pid), 'off')

  const after = await tick()
  assert.equal(after.acted, 0)
  assert.equal(cursorOf('KS-2'), 5, 'the caretaker moved an item after the kill switch')

  const [event] = eventsOf(pid)
  assert.equal(event.who, 'Owner via WhatsApp')
  assert.equal(event.old_value, 'on')
  assert.equal(event.new_value, 'off')
  assert.ok(!JSON.stringify(eventsOf(pid)).includes('15550001111'), 'the owner number reached the audit row')
})

test('the owner sending off twice changes nothing the second time and writes no second event', async () => {
  const pid = project('Twice')
  assert.equal((await post('Twice', OWNER)).statusCode, 200)
  const again = await post('  twice ', OWNER)
  assert.equal(again.statusCode, 200)
  assert.deepEqual(again.json(), { ok: true, project: 'Twice', old: 'off', new: 'off', unchanged: true })
  assert.equal(eventsOf(pid).length, 1)
})

test('a bare owner number in env matches the @s.whatsapp.net sender; an @lid non-owner is refused', async () => {
  const pid = project('Jid Shapes')
  const lid = await post('Jid Shapes', LID_NON_OWNER)
  assert.equal(lid.statusCode, 403)
  assert.equal(modeOf(pid), 'on')
  const owner = await post('Jid Shapes', OWNER)
  assert.equal(owner.statusCode, 200)
  assert.equal(modeOf(pid), 'off')
})

test('a non-owner is refused, the setting is unchanged, and a missing project gets the byte-identical refusal', async () => {
  const pid = project('Refused')
  const existing = await post('Refused', OTHER_APPROVER)
  const missing = await post('No Such Project', OTHER_APPROVER)
  const stranger = await post('Refused', '19998887777@s.whatsapp.net')
  for (const res of [existing, missing, stranger]) {
    assert.equal(res.statusCode, 403)
    assert.equal(res.body, existing.body)
  }
  assert.deepEqual(existing.json(), { error: 'refused' })
  assert.ok(!existing.body.includes('Refused') && !existing.body.includes('on'), existing.body)
  assert.equal(modeOf(pid), 'on')
  assert.equal(eventsOf(pid).length, 0)
})

test('the owner naming an unknown project gets 404; a bad or missing secret is 401 and changes nothing', async () => {
  const pid = project('Secret')
  assert.equal((await post('Nope', OWNER)).statusCode, 404)
  assert.equal((await post('Secret', OWNER, { secret: 'wrong' })).statusCode, 401)
  assert.equal((await post('Secret', OWNER, { secret: null })).statusCode, 401)
  assert.equal(modeOf(pid), 'on')
})

test('WhatsApp can only move a project to off: mode, pin or rules in the body are 400, and nothing else moves', async () => {
  const target = project('Only Off')
  const bystander = project('Bystander')
  rulesStore.saveRule('project', 'only-off', 'Keep PRs small.\n', 'Alice Example')
  const snapshot = () => ({
    users: db.prepare('SELECT * FROM user ORDER BY id').all(),
    rules: db.prepare('SELECT * FROM rule_version ORDER BY id').all(),
    settings: db.prepare('SELECT * FROM setting ORDER BY key').all(),
  })
  const before = snapshot()
  for (const extra of [{ mode: 'on' }, { mode: 'off' }, { pin: '1234' }, { rules: 'anything' }]) {
    const res = await post('Only Off', OWNER, { extra })
    assert.equal(res.statusCode, 400, JSON.stringify(extra))
  }
  assert.equal(modeOf(target), 'on')
  assert.equal((await post('Only Off', OWNER)).statusCode, 200)
  assert.equal(modeOf(target), 'off')
  assert.equal(modeOf(bystander), 'on')
  assert.deepEqual(snapshot(), before)
})

test('the Admin PIN route is unchanged: it can still turn the project back on', async () => {
  const pid = project('Back On', 'off')
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${pid}/autopilot`,
    payload: { mode: 'on' },
    headers: { cookie: alice.cookie, 'x-human-key': alice.pin },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(modeOf(pid), 'on')
})

test('the route needs no session and is absent from the published API reference', async () => {
  // No cookie on any request above: the session gate let them through.
  const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json()
  assert.ok(!Object.keys(spec.paths).some((p) => p.includes('autopilot-off-via-whatsapp')))
})
