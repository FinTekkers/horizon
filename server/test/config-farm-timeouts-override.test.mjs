// Companion to config-farm-timeouts.test.mjs: env overrides for both HZ-57
// budgets in the same file would just re-test whichever import ran first
// (config.js reads process.env once, at import time) — a separate process
// per test file (node --test's default) is what lets each set its own env
// before that first import.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FARM_QUEUE_TIMEOUT_MS = '45000'
process.env.FARM_STEP_TIMEOUT_MS = '99000'
const { FARM_QUEUE_TIMEOUT_MS, FARM_STEP_TIMEOUT_MS } = await import('../src/config.js')

test('FARM_QUEUE_TIMEOUT_MS and FARM_STEP_TIMEOUT_MS are independently env-overridable', () => {
  assert.equal(FARM_QUEUE_TIMEOUT_MS, 45000)
  assert.equal(FARM_STEP_TIMEOUT_MS, 99000)
})
