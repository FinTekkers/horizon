// HZ-256, the operator's journey: a deploy lands while an item is mid-resolve.
// The drain marks the run interrupted and cancels it in farmd; farmd then
// answers the still-open /conflicts/resolve with 409 cancelled. The item must
// not be sent back (no requestChanges, no "could not run" event), the row
// stays `interrupted`, and Resolve conflicts can simply be run again. A real
// HTTP stub stands in for farmd, so the long-call transport is the real one.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pendingResolve = null
let resolveSeen = null
let nextResolve = null
const farm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const send = (r, status, obj) => {
      r.writeHead(status, { 'content-type': 'application/json' })
      r.end(JSON.stringify(obj))
    }
    if (req.url === '/conflicts/resolve') {
      if (nextResolve) return send(res, 200, nextResolve)
      // Held open, like a resolver still running.
      pendingResolve = res
      resolveSeen?.()
      return
    }
    if (req.url === '/conflicts/cancel') {
      // farmd's resolver unwinds: its own request answers 409 cancelled first.
      send(pendingResolve, 409, { error: 'cancelled' })
      pendingResolve = null
      return send(res, 200, { ok: true, cancelled: true, killed: 2, lock_released: true })
    }
    send(res, 404, {})
  })
})
await new Promise((resolve) => farm.listen(0, '127.0.0.1', resolve))
after(() => new Promise((resolve) => farm.close(resolve)))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-resolve-cancelled-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${farm.address().port}`

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const deployDrain = await import('../src/deployDrain.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

test('a resolve cancelled by a deploy is interrupted, not sent back, and can be run again', async () => {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES ('RX-1', 'Mid-resolve', 'Medium', ?, 'acme/demo', 77, 0)`,
  ).run(ACCEPT_GATE_INDEX)
  const seen = new Promise((resolve) => (resolveSeen = resolve))
  const run = orchestrator.resolveConflicts('RX-1', 'Alice')
  await seen
  assert.equal(store.getGateAction('RX-1', 'resolve').state, 'running')

  deployDrain.beginDrain({ ttlS: 60 })
  const { interrupted } = await deployDrain.interruptForDeploy([{ itemId: 'RX-1', kind: 'resolve' }])
  assert.deepEqual(interrupted, [{ itemId: 'RX-1', kind: 'resolve', killed: true }])

  assert.deepEqual(await run, { error: 'cancelled' })
  const item = store.getItem('RX-1')
  assert.equal(item.cursor, ACCEPT_GATE_INDEX, 'not sent back to implement')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE item_id = 'RX-1'").get().n, 0, 'no requestChanges feedback')
  const events = JSON.stringify(db.prepare("SELECT * FROM event WHERE item_id = 'RX-1'").all())
  assert.ok(!/could not run|Request changes/i.test(events), events)
  const row = store.getGateAction('RX-1', 'resolve')
  assert.equal(row.state, 'interrupted')
  assert.equal(row.reason, 'server restarted for deploy')

  // After the restart (the block is gone with the old process), Resolve conflicts runs again.
  deployDrain.endDrain()
  nextResolve = { ok: true, resolved: true, summary: 'merged' }
  assert.deepEqual(await orchestrator.resolveConflicts('RX-1', 'Alice'), { ok: true, resolved: true })
  assert.equal(store.getGateAction('RX-1', 'resolve').state, 'resolved')
})
