// HZ-598, live (reverses HZ-227 guardrail 3): the time an Accept spends
// queued for a check slot no longer counts toward PREMERGE_CHECK_TIMEOUT_MS.
// The cap is re-armed when the slot is granted, so a run queued for longer
// than the whole cap still runs its checks and the PR merges.
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

test('a queue longer than the cap still runs the checks and merges: the cap counts from the grant', async () => {
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
  let released = false
  try {
    const approve = app.inject({
      method: 'POST',
      url: `/api/items/T-SWT-1/gates/${ACCEPT_GATE_INDEX}/approve`,
      payload: {},
      headers: { cookie, 'x-human-key': pin },
    })
    await waitFor(() => detailWrites('T-SWT-1').some((w) => w.detail === 'Waiting for a check slot'), {
      what: 'the run to queue',
    })
    // Queued past the whole 3 s cap: before HZ-598 this run was killed here.
    await new Promise((r) => setTimeout(r, config.PREMERGE_CHECK_TIMEOUT_MS + 1000))
    assert.notEqual(store.getGateAction('T-SWT-1', 'premerge')?.state, 'timed_out')
    assert.equal(detailWrites('T-SWT-1').at(-1).detail, 'Waiting for a check slot')
    await holder.release()
    released = true

    const res = await approve
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(merges, 1)

    // The cap itself is unchanged: the same timeoutMs and --timeout-s.
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].opts.timeoutMs, config.PREMERGE_CHECK_TIMEOUT_MS)
    assert.equal(spawns[0].args[spawns[0].args.indexOf('--timeout-s') + 1], '3')
    assert.ok(detailWrites('T-SWT-1').some((w) => w.detail === 'Running checks'))
    assert.notEqual(store.getGateAction('T-SWT-1', 'premerge').state, 'timed_out')
  } finally {
    premerge.runner.spawn = realSpawn
    if (!released) await holder.release()
  }

  // The run left the slot and the queue.
  await waitFor(() => slotPython(farmHome, 'print(json.dumps(len(check_slots.waiting_runs())))') === 0, {
    what: 'the waiting marker to be cleared',
  })
  assert.equal(slotPython(farmHome, 'print(json.dumps(check_slots.busy_slots()))'), 0)
})
