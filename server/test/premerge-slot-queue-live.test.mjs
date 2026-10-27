// HZ-585 metrics 4 and 5, live: a queued Accept reads "queued for a check
// slot (n ahead)" through the real item API, and n counts down as the runs
// ahead of it get their slots; a run stopped while still queued leaves the
// queue without running anything, and the next run still starts.
//
// Same live setup as premerge-slot-wait-live.test.mjs: real premerge.runner,
// a PREMERGE_PYTHON shim waiting in the real farm/check_slots.py with
// farm/premerge.py's own slot_policy(), real flocks in a temp FARM_HOME.
//
// Polling flock is not FIFO, so the order of grants is fixed by slot, not by
// luck: the two older runs use a limit-2 shim and the newest a limit-1 shim.
// With both slots held, freeing slot 1 can only grant an older run; slot 0 is
// freed last, for the newest.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { holdSlot, recordDetailWrites, slotPython, waitFor, writeShim } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-slot-queue-live-'))
const farmHome = join(tmp, 'farm-home')
mkdirSync(farmHome, { recursive: true })
const shimOne = writeShim(tmp, { slots: 1, name: 'shim-one' })
const shimTwo = writeShim(tmp, { slots: 2, name: 'shim-two' })
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = shimOne
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '60000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const detailWrites = recordDetailWrites(db)
after(() => rmSync(tmp, { recursive: true, force: true }))

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
let merges = 0
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  const method = options.method || 'GET'
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
    return json(200, { head: { sha: HEAD, ref: 'horizon/t-queue' }, base: { ref: 'main' } })
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
  const id = `T-SQ-${++seq}`
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
// premerge.js reads PREMERGE_PYTHON at each spawn.
function approve(id, shim = shimOne) {
  process.env.PREMERGE_PYTHON = shim
  return app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
}
const detailOf = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id).gateAction?.detail
}
const showsDetail = (id, text) => waitFor(async () => (await detailOf(id)) === text, { what: `${id} to read "${text}"` })
const ran = (id) => existsSync(join(farmHome, `ran-${id}`))
const holdFile = (id) => join(farmHome, `hold-${id}`)

test('the newest queued Accept counts down 2 ahead, 1 ahead, 0 ahead, then Running checks', async () => {
  const [older1, older2, newest] = [acceptItem(), acceptItem(), acceptItem()]
  for (const id of [older1, older2]) writeFileSync(holdFile(id), '')
  const slot0 = await holdSlot(farmHome, 0)
  const slot1 = await holdSlot(farmHome, 1)
  const mergesBefore = merges
  try {
    const p1 = approve(older1, shimTwo)
    await showsDetail(older1, 'waiting for a capacity slot to run pre-merge checks (main + PR), 0 ahead')
    const p2 = approve(older2, shimTwo)
    await showsDetail(older2, 'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead')
    const p3 = approve(newest, shimOne)
    await showsDetail(newest, 'waiting for a capacity slot to run pre-merge checks (main + PR), 2 ahead')
    assert.equal(merges, mergesBefore)

    await slot1.release()
    await showsDetail(newest, 'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead')
    const first = await waitFor(() => [older1, older2].find(ran), { what: 'an older run to get slot 1' })
    const second = first === older1 ? older2 : older1
    rmSync(holdFile(first))
    await showsDetail(newest, 'waiting for a capacity slot to run pre-merge checks (main + PR), 0 ahead')
    await waitFor(() => ran(second), { what: 'the other older run to get slot 1' })
    assert.equal(ran(newest), false)
    rmSync(holdFile(second))

    await slot0.release()
    for (const res of await Promise.all([p1, p2, p3])) assert.equal(res.statusCode, 200, res.body)
    assert.equal(merges, mergesBefore + 3)
  } finally {
    await slot0.release()
    await slot1.release()
  }
  const details = detailWrites(newest)
    .map((w) => w.detail)
    .filter((d) => d.startsWith('waiting for a capacity slot') || d === 'Running checks')
  assert.deepEqual(details, [
    'waiting for a capacity slot to run pre-merge checks (main + PR), 2 ahead',
    'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead',
    'waiting for a capacity slot to run pre-merge checks (main + PR), 0 ahead',
    'Running checks',
  ])
})

test('a run stopped while queued leaves the queue, never runs its checks, and the next run starts', async () => {
  const stopped = acceptItem()
  const next = acceptItem()
  const holder = await holdSlot(farmHome, 0)
  const mergesBefore = merges
  let nextPending
  try {
    const stoppedPending = approve(stopped)
    await showsDetail(stopped, 'waiting for a capacity slot to run pre-merge checks (main + PR), 0 ahead')
    nextPending = approve(next)
    await showsDetail(next, 'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead')

    assert.equal(await premerge.interruptRun(stopped), true)
    const res = await stoppedPending
    assert.equal(res.statusCode, 502)
    await waitFor(
      () => !slotPython(farmHome, 'print(json.dumps([w["item_id"] for w in check_slots.waiting_runs()]))').includes(stopped),
      { what: "the stopped run's marker to leave waiting_runs()" },
    )
    await showsDetail(next, 'waiting for a capacity slot to run pre-merge checks (main + PR), 0 ahead')
  } finally {
    await holder.release()
  }
  const res = await nextPending
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(ran(stopped), false, 'the stopped run never ran its checks')
  assert.equal(ran(next), true)
  assert.equal(merges, mergesBefore + 1)
  assert.equal(slotPython(farmHome, 'print(json.dumps(check_slots.busy_slots()))'), 0)
})
