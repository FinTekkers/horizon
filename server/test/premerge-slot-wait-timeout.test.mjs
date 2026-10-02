// HZ-227 metric 3 + guardrail 3, live: the time an Accept spends queued for a
// check slot counts toward the existing PREMERGE_CHECK_TIMEOUT_MS deadline —
// no new timeout. A run whose deadline expires while it is still queued ends
// timed_out, leaves the queue, and never holds or later receives a slot.
//
// Its own file because PREMERGE_CHECK_TIMEOUT_MS is read once, at config.js
// import. Same live setup as premerge-slot-wait-live.test.mjs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { holdSlot, recordDetailWrites, slotPython, waitFor, writeShim } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-slot-wait-timeout-'))
const farmHome = join(tmp, 'farm-home')
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = writeShim(tmp)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '3000'

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
    return json(200, { head: { sha: HEAD, ref: 'horizon/t-slot' }, base: { ref: 'main' } })
  }
  if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
  if (method === 'PUT' && u.pathname.endsWith('/merge')) {
    merges++
    return json(200, { merged: true })
  }
  return json(404, {})
}

test('the deadline expires while queued: timed_out, no new timeout, the queue place is left and no slot leaks', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'T-SWT-1',
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    101,
    201,
  )
  const spawns = []
  const realSpawn = premerge.runner.spawn
  premerge.runner.spawn = (args, opts) => {
    spawns.push({ args, opts })
    return realSpawn(args, opts)
  }
  const holder = await holdSlot(farmHome)
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/T-SWT-1/gates/${ACCEPT_GATE_INDEX}/approve`,
      payload: {},
      headers: { cookie, 'x-human-key': pin },
    })
    assert.equal(res.statusCode, 502)
    assert.equal(merges, 0)

    // The one deadline is today's: the same timeoutMs and --timeout-s.
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].opts.timeoutMs, config.PREMERGE_CHECK_TIMEOUT_MS)
    assert.equal(spawns[0].args[spawns[0].args.indexOf('--timeout-s') + 1], '3')

    const action = store.getGateAction('T-SWT-1', 'premerge')
    assert.equal(action.state, 'timed_out')
    const writes = detailWrites('T-SWT-1')
    assert.equal(writes.at(-1).detail, 'Waiting for a check slot', `still queued at the kill: ${JSON.stringify(writes)}`)
    assert.ok(!writes.some((w) => w.detail === 'Running checks'))

    // The killed waiter left the queue and holds nothing; only the holder's slot is busy.
    await waitFor(() => slotPython(farmHome, 'print(json.dumps(len(check_slots.waiting_runs())))') === 0, {
      what: 'the waiting marker to be pruned',
    })
    assert.equal(slotPython(farmHome, 'print(json.dumps(check_slots.busy_slots()))'), 1)
  } finally {
    premerge.runner.spawn = realSpawn
    await holder.release()
  }

  // A late stderr flush after the finish writes nothing (token guard).
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(detailWrites('T-SWT-1').at(-1).detail, 'Waiting for a check slot')
  assert.equal(store.getGateAction('T-SWT-1', 'premerge').state, 'timed_out')

  // The next caller gets the freed slot, exactly once.
  const next = slotPython(
    farmHome,
    'events = []\nwith check_slots.check_slot(on_event=events.append) as s:\n    out = [s.mode, check_slots.busy_slots()]\nprint(json.dumps([out, events, check_slots.busy_slots()]))',
  )
  assert.deepEqual(next, [['held', 1], [], 0])
})
