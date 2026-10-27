// HZ-585 metric 2, live: an Accept that queued for a capacity slot gets its full
// PREMERGE_CHECK_TIMEOUT_MS, counted from when it holds the slot. Queue time
// counts toward none of its three clocks — farm/premerge.py's check budget,
// premerge.js's kill timer, or the gate action's lease. The cap still binds
// once the slot is held, and that kill frees the slot for the next run
// (metric 4).
//
// This reverses HZ-227 guardrail 3 ("queue time counts toward
// PREMERGE_CHECK_TIMEOUT_MS"), which this file used to assert: on 24 Oct
// that rule timed out four queued Accepts in a row.
//
// Its own file because the timeouts are read once, at config.js import. Same
// live setup as premerge-slot-wait-live.test.mjs.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { holdSlot, slotPython, waitFor, writeShim } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-slot-wait-timeout-'))
const farmHome = join(tmp, 'farm-home')
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = writeShim(tmp)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '3000'
process.env.PREMERGE_QUEUE_TIMEOUT_MS = '30000'
// A lease sized from the click would be 3.2 s: any queue longer than that
// would let the sweep time the action out.
process.env.GATE_ACTION_MARGIN_MS = '200'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
after(() => rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => rmSync(join(farmHome, 'hold-checks'), { force: true }))

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
let merges = 0
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  const method = options.method || 'GET'
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
    return json(200, { head: { sha: HEAD, ref: 'horizon/t-slot' }, base: { ref: 'main' } })
  }
  if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
  if (method === 'PUT' && u.pathname.endsWith('/merge')) {
    merges++
    return json(200, { merged: true })
  }
  return json(404, {})
}

let seq = 0
function acceptItem() {
  const id = `T-SWT-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    100 + seq,
    200 + seq,
  )
  return id
}
const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const queued = (id) =>
  waitFor(() => store.getGateAction(id, 'premerge')?.detail?.startsWith('waiting for a capacity slot'), { what: `${id} to queue` })
const checkSeconds = (id, s) => writeFileSync(join(farmHome, `check-seconds-${id}`), String(s))

test('the gate lease covers the queue: a sweep while queued leaves the action running, and it merges', async () => {
  const id = acceptItem()
  const mergesBefore = merges
  const holder = await holdSlot(farmHome)
  let pending
  try {
    const clicked = Date.now()
    pending = approve(id)
    await queued(id)
    // Past the 3.2 s a lease counted from the click would have had.
    await sleep(Math.max(0, 4000 - (Date.now() - clicked)))
    store.sweepGateActions()
    assert.equal(store.getGateAction(id, 'premerge').state, 'running', 'the queue ran the lease out')
    assert.equal(existsSync(join(farmHome, `ran-${id}`)), false)
  } finally {
    await holder.release()
  }
  const res = await pending
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getGateAction(id, 'premerge').state, 'merged')
  assert.equal(merges, mergesBefore + 1)
})

test('after a 5 s queue, a 2.5 s check still merges under a 3000 ms PREMERGE_CHECK_TIMEOUT_MS', async () => {
  const id = acceptItem()
  checkSeconds(id, 2.5)
  const mergesBefore = merges
  const holder = await holdSlot(farmHome)
  const clicked = Date.now()
  const pending = approve(id)
  try {
    await queued(id)
    await sleep(Math.max(0, 5000 - (Date.now() - clicked)))
  } finally {
    await holder.release()
  }
  const res = await pending
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(Date.now() - clicked > config.PREMERGE_CHECK_TIMEOUT_MS + 2500, 'queue plus checks outlasted the cap')
  assert.equal(store.getGateAction(id, 'premerge').state, 'merged')
  assert.equal(merges, mergesBefore + 1)
})

test('the cap still binds once the slot is held, and its kill frees the slot for the queued run', async () => {
  const hung = acceptItem()
  const next = acceptItem()
  checkSeconds(hung, 60)
  const mergesBefore = merges
  const holder = await holdSlot(farmHome)
  const hungPending = approve(hung)
  await queued(hung)
  await holder.release()
  await waitFor(() => existsSync(join(farmHome, `ran-${hung}`)), { what: 'the hung run to hold the slot' })
  const heldAt = Date.now()
  const nextPending = approve(next)
  await queued(next)

  const res = await hungPending
  assert.equal(res.statusCode, 502)
  const action = store.getGateAction(hung, 'premerge')
  assert.equal(action.state, 'timed_out')
  assert.match(action.reason, /no result within/)
  // Killed by the 3 s checks cap, not left to the 30 s queue cap.
  assert.ok(Date.now() - heldAt < 15000, `ended ${Date.now() - heldAt} ms after the grant`)

  const nextRes = await nextPending
  assert.equal(nextRes.statusCode, 200, nextRes.body)
  assert.equal(existsSync(join(farmHome, `ran-${next}`)), true)
  assert.equal(store.getGateAction(next, 'premerge').state, 'merged')
  assert.equal(merges, mergesBefore + 1)
  assert.equal(slotPython(farmHome, 'print(json.dumps(check_slots.busy_slots()))'), 0)
})
