// HZ-100: the durable reconciliation sweep must never fire faster than
// FARM_QUEUE_TIMEOUT_MS — otherwise the sweep could race and fail a step
// that the server's own queue watchdog would have caught anyway, before that
// watchdog gets a chance to win. RECONCILE_SWEEP_MS is clamped to enforce
// this regardless of how it's configured; see config-reconcile-sweep-
// override.test.mjs for the clamp actually kicking in.

import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.RECONCILE_SWEEP_MS
delete process.env.FARM_QUEUE_TIMEOUT_MS
const { RECONCILE_SWEEP_MS, FARM_QUEUE_TIMEOUT_MS } = await import('../src/config.js')

test('RECONCILE_SWEEP_MS defaults to 15 minutes, comfortably above the default queue watchdog', () => {
  assert.equal(RECONCILE_SWEEP_MS, 15 * 60 * 1000)
  assert.ok(RECONCILE_SWEEP_MS > FARM_QUEUE_TIMEOUT_MS, 'an armed queue watchdog must always win the race against the sweep')
})
