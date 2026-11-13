// HZ-713: Resume clears a rule block (HZ-346), so on a rule-blocked item it now
// needs a browser session and the gate PIN. No PIN, a wrong PIN, a session
// without the PIN and an API token with the right PIN are each refused and the
// block stays; a session with the right PIN clears it. Pausing, and resuming
// an item with no block, take the login alone as before. The PIN never reaches
// an event, a ping, a response body, an outbound request or the server log.
//
// Farm mode with a stubbed fetch, like rule-block.test.mjs, so a resume's kick
// inserts a real farm step_run row and nothing runs a mock step.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-rule-block-pin-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.WA_APPROVER_JIDS = '15550001111'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const gateNotifier = await import('../src/gateNotifier.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, pause: orchestrator.pause })

// Every outbound request body (farm dispatch, GitHub), kept for the PIN scan.
const outbound = []
globalThis.fetch = async (url, opts = {}) => {
  outbound.push(`${url} ${JSON.stringify(opts.headers ?? {})} ${typeof opts.body === 'string' ? opts.body : ''}`)
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, json: async () => ({}) }
}

const logLines = []
const app = buildApp({
  logger: {
    level: 'trace',
    stream: new Writable({
      write(chunk, _enc, done) {
        logLines.push(chunk.toString())
        done()
      },
    }),
  },
})
await app.ready()

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

// A PIN no timestamp, id or hash could contain by chance.
const PIN = 'qv8-PIN-hz713-rk'
const WRONG_PIN = 'qv8-WRONG-hz713-rk'
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, owner.user.id)
}
const token = loginFixtureToken(auth, owner.user)

// A fresh browser session each time: a correct PIN verifies a session for 12
// hours (HZ-704) and a wrong one locks it, so no call rides on another.
function browser(extra = {}) {
  return { cookie: `${config.SESSION_COOKIE_NAME}=${auth.createSession(owner.user.id)}`, 'x-horizon-csrf': '1', ...extra }
}

const responses = []
async function call(opts) {
  const res = await app.inject(opts)
  responses.push(res.body)
  return res
}
const pause = (id, paused, headers) => call({ method: 'POST', url: `/api/items/${id}/pause`, headers, payload: { paused } })

const BLOCK = { rule: 'guardrail 6: models first: no local workaround', needs: 'a ledger-models release with the fix' }
const rawBlock = (id) => db.prepare('SELECT rule_block_json FROM work_item WHERE id = ?').get(id).rule_block_json
const pausedCol = (id) => db.prepare('SELECT paused FROM work_item WHERE id = ?').get(id).paused

function blockedItem(id, { paused = false } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'Rule-blocked item', 'Medium', ?)").run(id, IMPLEMENT_STEP_INDEX)
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, auto_retry_count) VALUES (?, ?, 1, ?, 'active', 0)")
    .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid
  assert.deepEqual(orchestrator.blockFarmRun(runId, BLOCK), { ok: true })
  if (paused) db.prepare(`UPDATE work_item SET ${store.PAUSE_SET} WHERE id = ?`).run(id)
  assert.ok(rawBlock(id), `${id} is rule-blocked`)
}

function assertRefused(res, id, paused) {
  assert.equal(res.statusCode, 401, res.body)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.ok(rawBlock(id), `${id}: the block stays after a refused resume`)
  assert.equal(pausedCol(id), paused ? 1 : 0, `${id}: the paused flag is unchanged`)
}

for (const [label, paused] of [
  ['rule-blocked, not paused', false],
  ['paused and rule-blocked', true],
]) {
  test(`metric 1 (${label}): no PIN, a wrong PIN, a session without the PIN and a token with the right PIN are refused; a session with the PIN clears the block`, async () => {
    const id = paused ? 'PIN-PAUSED' : 'PIN-LIVE'
    blockedItem(id, { paused })

    assertRefused(await pause(id, false, { cookie: owner.cookie }), id, paused)
    assertRefused(await pause(id, false, browser()), id, paused)
    assertRefused(await pause(id, false, browser({ 'x-human-key': WRONG_PIN })), id, paused)
    assertRefused(await pause(id, false, { ...token.headers, 'x-human-key': PIN }), id, paused)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND text = 'resumed work'").get(id).n, 0)

    const ok = await pause(id, false, browser({ 'x-human-key': PIN }))
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().ok, true)
    assert.equal(ok.json().paused, false)
    assert.equal(rawBlock(id), null, 'the block is cleared')
    assert.equal(pausedCol(id), 0)
    assert.equal(ok.json().item.ruleBlock, null)
  })
}

test('guardrail 2: pausing a rule-blocked item needs no PIN and keeps the block', async () => {
  blockedItem('PIN-PAUSE')
  const res = await pause('PIN-PAUSE', true, { cookie: owner.cookie })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().paused, true)
  assert.equal(pausedCol('PIN-PAUSE'), 1)
  assert.ok(rawBlock('PIN-PAUSE'), 'Pause leaves the block')
})

test('guardrail 2: pause then resume an item with no block needs no PIN, with today’s body shape', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('PIN-FREE', 'Unblocked', 'Medium', ?)").run(IMPLEMENT_STEP_INDEX)
  const paused = await pause('PIN-FREE', true, { cookie: owner.cookie })
  assert.equal(paused.statusCode, 200, paused.body)
  assert.deepEqual(Object.keys(paused.json()).sort(), ['item', 'ok', 'paused'])
  assert.equal(paused.json().paused, true)

  const resumed = await pause('PIN-FREE', false, { cookie: owner.cookie })
  assert.equal(resumed.statusCode, 200, resumed.body)
  assert.deepEqual(Object.keys(resumed.json()).sort(), ['item', 'ok', 'paused'])
  assert.equal(resumed.json().paused, false)
  assert.equal(pausedCol('PIN-FREE'), 0)

  // A token resumes an unblocked item as before.
  await pause('PIN-FREE', true, token.headers)
  const byToken = await pause('PIN-FREE', false, token.headers)
  assert.equal(byToken.statusCode, 200, byToken.body)
})

test('guardrail 3: the PIN is in no event, move-log row, ping, response, outbound request or log line', async () => {
  // The pings the blocks queued, sent through a stub.
  const pings = []
  await gateNotifier.drainOutbox({ send: async (to, body) => pings.push(`${to} ${body}`) })
  responses.push((await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: owner.cookie } })).body)
  responses.push((await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie: owner.cookie } })).body)

  const sinks = {
    events: db.prepare('SELECT * FROM event').all().map((r) => JSON.stringify(r)),
    notices: db.prepare('SELECT * FROM gate_notice').all().map((r) => JSON.stringify(r)),
    moveLog: db.prepare('SELECT * FROM item_move').all().map((r) => JSON.stringify(r)),
    pings,
    responses,
    outbound,
    log: logLines,
  }
  assert.ok(sinks.events.length > 0 && sinks.pings.length > 0 && responses.length > 10 && logLines.length > 0, 'the scan read real sinks')
  for (const [name, lines] of Object.entries(sinks)) {
    for (const secret of [PIN, WRONG_PIN]) {
      const hit = lines.find((line) => line.includes(secret))
      assert.equal(hit, undefined, `the PIN appears in ${name}: ${hit}`)
    }
  }
})
