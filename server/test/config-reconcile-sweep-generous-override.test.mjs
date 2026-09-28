// Companion to config-reconcile-sweep.test.mjs / -override.test.mjs: a
// separate process (own env, own import) for the third case — an override
// generous enough that the clamp is a no-op.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // 10 minutes
process.env.RECONCILE_SWEEP_MS = String(90 * 60 * 1000) // well above the floor
const { RECONCILE_SWEEP_MS } = await import('../src/config.js')

test('a RECONCILE_SWEEP_MS override above the floor passes through unchanged', () => {
  assert.equal(RECONCILE_SWEEP_MS, 90 * 60 * 1000)
})
