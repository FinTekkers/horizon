// Companion to config-reconcile-sweep.test.mjs: env overrides in the same
// file would just re-test whichever import ran first (config.js reads
// process.env once, at import time) — a separate process per test file
// (node --test's default) is what lets each set its own env before that
// first import.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // 10 minutes
process.env.RECONCILE_SWEEP_MS = '60000' // an operator setting it BELOW the queue watchdog
const { RECONCILE_SWEEP_MS, FARM_QUEUE_TIMEOUT_MS } = await import('../src/config.js')

test('RECONCILE_SWEEP_MS is clamped to stay above FARM_QUEUE_TIMEOUT_MS even when configured below it', () => {
  assert.equal(FARM_QUEUE_TIMEOUT_MS, 600000)
  assert.equal(RECONCILE_SWEEP_MS, 660000, 'clamped to FARM_QUEUE_TIMEOUT_MS + 60s, not the requested 60s')
  assert.ok(RECONCILE_SWEEP_MS > FARM_QUEUE_TIMEOUT_MS)
})
