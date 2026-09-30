// Third process for the third case (see config-wa-notify.test.mjs and
// -override.test.mjs): overrides comfortably above both floors must pass
// through untouched. Without this, a clamp that ignored its input entirely —
// returning the floor, or the default, whatever was asked for — would still
// pass the other two files.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WA_NOTIFY_ENABLED = '1'
process.env.WA_NOTIFY_SWEEP_MS = String(5 * 60 * 1000)
process.env.WA_NOTIFY_MAX_ATTEMPTS = '20'

const { WA_NOTIFY_ENABLED, WA_NOTIFY_SWEEP_MS, WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')

test('WA_NOTIFY_ENABLED="1" is the one value that turns it on', () => {
  assert.equal(WA_NOTIFY_ENABLED, true)
})

test('a sweep cadence above the floor passes through unchanged', () => {
  assert.equal(WA_NOTIFY_SWEEP_MS, 5 * 60 * 1000)
})

test('an attempt budget above the floor passes through unchanged', () => {
  assert.equal(WA_NOTIFY_MAX_ATTEMPTS, 20)
})
