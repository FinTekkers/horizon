// HZ-141 — the notifier's four config values with nothing set, i.e. what a host
// that has never been told about this feature gets.
//
// The one that matters most is WA_NOTIFY_ENABLED: this feature messages a real
// human, so "unset means off" is a safety property, not a default. The clamps on
// the other two are exercised in config-wa-notify-override.test.mjs (below the
// floor) and config-wa-notify-generous-override.test.mjs (above it) — separate
// files because config.js reads process.env once, at import.

import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.WA_NOTIFY_ENABLED
delete process.env.WA_BRIDGE_URL
delete process.env.WA_NOTIFY_SWEEP_MS
delete process.env.WA_NOTIFY_MAX_ATTEMPTS

const { WA_NOTIFY_ENABLED, WA_BRIDGE_URL, WA_NOTIFY_SWEEP_MS, WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')

test('an unconfigured host has the notifier OFF — it is opt-in because it texts a human', () => {
  assert.equal(WA_NOTIFY_ENABLED, false)
})

test('WA_BRIDGE_URL defaults to the localhost bridge, with no trailing slash', () => {
  assert.equal(WA_BRIDGE_URL, 'http://localhost:8080')
  // waSend.js appends '/api/send', so a trailing slash here would double up.
  assert.ok(!WA_BRIDGE_URL.endsWith('/'))
})

test('the backstop sweep defaults to 60s, comfortably above its own 10s floor', () => {
  assert.equal(WA_NOTIFY_SWEEP_MS, 60_000)
  assert.ok(WA_NOTIFY_SWEEP_MS >= 10_000)
})

test('the give-up count defaults to 8 — roughly two hours of 60s doubling backoff', () => {
  assert.equal(WA_NOTIFY_MAX_ATTEMPTS, 8)
  // The drain's backoff is min(60 * 2^(n-1), 3600) seconds per attempt; pin the
  // default's real-world meaning so changing it is a deliberate act.
  const total = Array.from({ length: WA_NOTIFY_MAX_ATTEMPTS }, (_, i) => Math.min(60 * 2 ** i, 3600)).reduce(
    (a, b) => a + b,
    0,
  )
  assert.ok(total > 60 * 60 && total < 4 * 60 * 60, `${total}s of retry is not the intended ~2 hours`)
})
