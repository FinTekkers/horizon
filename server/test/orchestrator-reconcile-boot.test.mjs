// HZ-100's outcome text: "On boot, any step_run left active that the farm
// does not claim and that has no live agent session is failed within one
// sweep interval". RECONCILE_SWEEP_MS defaults to 15 minutes (clamped above
// FARM_QUEUE_TIMEOUT_MS) — this proves a stranded row left over from before
// a restart is resolved almost immediately at startup, not after waiting for
// that first interval tick.
//
// init() awaits reconcileActiveRuns() BEFORE rearmFarmRuns() runs — the
// other order was tried first and found to make the boot-time sweep dead
// code: rearmFarmRuns() arms a timer for every active row unconditionally
// (even one the farm never picked up gets HZ-57's generous fallback timer),
// so a reconcile call placed after it always finds `!timers[run.id]` filters
// out everything. Running reconcile first means THIS test's row — no timer,
// no farm claim, no session — is actually resolved via the never_picked_up
// path proven below, not via rearm's fallback timer happening to also fire
// fast for a row this stale.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-reconcile-boot-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
// Defaults left in place deliberately: FARM_QUEUE_TIMEOUT_MS (10min) and the
// resulting RECONCILE_SWEEP_MS clamp (15min) are both far longer than this
// test's wait window, so only boot-time behavior (not the interval) can
// explain a fast resolution.

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

globalThis.fetch = async (url) => {
  if (String(url).includes('/runs/alive')) return { ok: true, json: async () => ({ alive: {} }) } // nothing the farm knows about
  return { ok: true, json: async () => ({}) }
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

test('a step_run left active before a restart is resolved almost immediately at boot, not after waiting the full sweep interval', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'BOOT-1',
    'Stranded before boot',
    'Medium',
    IMPLEMENT_STEP_INDEX,
  )
  const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() // an hour ago — budget long exceeded
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at) VALUES (?, ?, 1, ?, 'active', ?)`,
  ).run('BOOT-1', IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, staleStartedAt)

  orchestrator.init(silentLog)

  const deadline = Date.now() + 2000
  let stillActive = 1
  while (Date.now() < deadline) {
    stillActive = db
      .prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'BOOT-1' AND started_at = ? AND status = 'active'")
      .get(staleStartedAt).n
    if (stillActive === 0) break
    await new Promise((r) => setTimeout(r, 30))
  }

  assert.equal(stillActive, 0, 'the stranded row must be resolved within a couple seconds of boot, nowhere near the 15-minute sweep interval')
  assert.equal(store.getItem('BOOT-1').paused, false, 'timeout/never_picked_up are both auto-retryable — recovers with no human action')
  const retried = db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'BOOT-1' AND status = 'active'").get().n
  assert.equal(retried, 1, 'a fresh run must have been auto-dispatched')

  const events = db.prepare("SELECT text FROM event WHERE item_id = 'BOOT-1' ORDER BY id").all().map((r) => r.text)
  assert.ok(
    events.some((t) => /never_picked_up/.test(t)),
    'must resolve via reconcileActiveRuns\' never_picked_up path, proving the boot-time sweep call actually ran and did the work — not via rearmFarmRuns\' unrelated timeout fallback',
  )

  orchestrator.cancel('BOOT-1')
})
