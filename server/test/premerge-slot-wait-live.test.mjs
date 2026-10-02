// HZ-227: an Accept whose pre-merge checks queue for a check slot shows
// 'Waiting for a check slot', then 'Running checks' once a slot is granted.
//
// Live across the seam: the real premerge.runner.spawn streams the real
// stderr of a PREMERGE_PYTHON shim (helpers/slotWait.mjs) that queues through
// the real farm/check_slots.py and reports through the real
// farm/premerge.py stderr_event — so the HORIZON_EVENT prefix drifting
// between Python and Node fails here. The slot is held by a real flock in a
// temp FARM_HOME. Only GitHub is stubbed.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { holdSlot, recordDetailWrites, slotPython, waitFor, writeShim } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-slot-wait-live-'))
const farmHome = join(tmp, 'farm-home')
process.env.HORIZON_DB = join(tmp, 'test.db')
// Never the inherited farm: the shim's slot must be the test's own.
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = writeShim(tmp)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '60000'

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
const detailWrites = recordDetailWrites(db)

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const WAITING = 'Waiting for a check slot'
const RUNNING = 'Running checks'

let merges = 0
before(() => {
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
})
after(() => rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => rmSync(join(farmHome, 'hold-checks'), { force: true }))

let seq = 0
function acceptItem() {
  const id = `T-SW-${++seq}`
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
const gateActionOf = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id).gateAction
}

test('every slot held: the card reads Waiting for a check slot, then Running checks once a slot frees, then merged', async () => {
  const id = acceptItem()
  const holder = await holdSlot(farmHome)
  writeFileSync(join(farmHome, 'hold-checks'), '')
  const mergesBefore = merges
  let pending
  try {
    pending = approve(id)
    const queued = await waitFor(async () => {
      const action = await gateActionOf(id)
      return action?.detail === WAITING && action
    }, { what: 'the waiting detail' })
    // Guardrail 4: only `detail` differs from a no-queue running row — same
    // keys, same state, no new status value.
    const plainId = acceptItem()
    store.claimGateAction(plainId, 'premerge', { detail: 'running checks on main + PR #1', timeoutMs: 60000 })
    const plain = await gateActionOf(plainId)
    assert.deepEqual(Object.keys(queued).sort(), Object.keys(plain).sort())
    assert.equal(queued.state, 'running')
    assert.equal(queued.kind, 'premerge')
    assert.equal(merges, mergesBefore, 'nothing merges while queued')
  } finally {
    await holder.release()
  }

  await waitFor(async () => (await gateActionOf(id))?.detail === RUNNING, { what: 'the running detail' })
  rmSync(join(farmHome, 'hold-checks'), { force: true })
  const res = await pending
  assert.equal(res.statusCode, 200)
  assert.equal((await gateActionOf(id)).state, 'merged')
  assert.equal(merges, mergesBefore + 1)

  const details = detailWrites(id).map((w) => w.detail)
  const waitAt = details.indexOf(WAITING)
  const runAt = details.indexOf(RUNNING)
  assert.ok(waitAt >= 0 && runAt > waitAt, `waiting before running: ${JSON.stringify(details)}`)
  assert.equal(details.filter((d) => d === WAITING).length, 1)
  assert.equal(details.filter((d) => d === RUNNING).length, 1)
  // Nothing after the grant claims it is waiting again.
  assert.ok(!details.slice(runAt).includes(WAITING))
})

test('a free slot: the detail is never Waiting for a check slot, at any write', async () => {
  const id = acceptItem()
  assert.equal(slotPython(farmHome, 'print(json.dumps(check_slots.busy_slots()))'), 0)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal((await gateActionOf(id)).state, 'merged')
  const writes = detailWrites(id)
  assert.ok(writes.length >= 2, `every write recorded: ${JSON.stringify(writes)}`)
  assert.ok(!writes.some((w) => w.detail === WAITING), JSON.stringify(writes))
  assert.ok(!writes.some((w) => w.detail === RUNNING), 'no grant without a queue')
  assert.ok(writes.some((w) => w.detail.startsWith('running checks on main + PR #')))
})
