// A farm the server has lost contact with must recover on its own.
//
// startRealFarm() pins farm status to 'error' when it cannot reach farmd, and
// runnable() refuses to dispatch anything while that holds. ensureFarm() knows
// how to retry — but it was only ever called at boot and when the first project
// was created, so the error latched until somebody restarted the process, with
// nothing in the UI explaining why the board had gone quiet.
//
// That is not hypothetical. A deploy restarts horizon-server and then
// horizon-farm; the server reaches for the farm mid-restart, gets
// "fetch failed", and latches. Observed in production twice on 2026-09-24,
// each time halting every item until a manual restart.
//
// A short recovery interval is used here so the retry is observable in a fast
// test run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-recovery-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RECOVERY_POLL_MS = '120'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// The farm is unreachable to begin with, then comes back — exactly what a
// deploy's restart looks like from this process.
let farmReachable = false
globalThis.fetch = async () => {
  if (!farmReachable) throw new Error('fetch failed')
  return { ok: true, json: async () => ({ ok: true, status: 'running' }) }
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

test('a farm that becomes unreachable does not stay errored once it returns', async () => {
  db.prepare("INSERT OR IGNORE INTO project (id, name) VALUES (1, 'test')").run()
  db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', '1')").run()

  // init() while the farm is unreachable: first contact fails (the latch) and,
  // with the fix, installs the recovery interval. init() is called ONCE, here
  // — calling it again after the farm returns would recover via its own
  // ensureFarm() call and prove nothing about the interval.
  orchestrator.init(silentLog)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(orchestrator.getFarmState().status, 'error', 'an unreachable farm should report error')

  // The farm comes back on its own. Only the periodic probe can notice.
  farmReachable = true

  const deadline = Date.now() + 3000
  while (Date.now() < deadline && orchestrator.getFarmState().status !== 'running') {
    await new Promise((r) => setTimeout(r, 60))
  }

  assert.equal(
    orchestrator.getFarmState().status,
    'running',
    'the farm should recover without a process restart',
  )
})
