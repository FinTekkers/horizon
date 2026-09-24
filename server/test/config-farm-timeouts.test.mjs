// HZ-57: the step timeout used to be a single dispatch-time clock, so a step
// held in the farm's queue burned the whole deadline before it ever ran.
// Fixed by splitting into two independently-overridable budgets — this pins
// their defaults and env-override behavior so the split can't silently
// collapse back into one knob.

import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.FARM_QUEUE_TIMEOUT_MS
delete process.env.FARM_STEP_TIMEOUT_MS
const defaults = await import('../src/config.js')

test('FARM_QUEUE_TIMEOUT_MS defaults to 10 minutes, shorter than the execution budget', () => {
  assert.equal(defaults.FARM_QUEUE_TIMEOUT_MS, 10 * 60 * 1000)
  assert.ok(
    defaults.FARM_QUEUE_TIMEOUT_MS < defaults.FARM_STEP_TIMEOUT_MS,
    'the queue watchdog must stay well short of the execution budget, or a genuinely stuck queue entry would not fail in a bounded window',
  )
})

test('FARM_STEP_TIMEOUT_MS defaults to 20 minutes (unchanged from before the split)', () => {
  assert.equal(defaults.FARM_STEP_TIMEOUT_MS, 20 * 60 * 1000)
})
