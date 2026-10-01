// Companion to config-wa-notify.test.mjs: the clamps actually kicking in.
// A separate file per env permutation because config.js reads process.env once,
// at import time — the same reason config-reconcile-sweep-override.test.mjs is
// its own file.
//
// Both floors exist for the same reason: this sweep runs on EVERY store.onChange
// as well as on its timer, and the outbox drains inside it. An operator setting
// WA_NOTIFY_SWEEP_MS to 100 would hammer the database from a timer for no gain,
// and a non-positive WA_NOTIFY_MAX_ATTEMPTS would mean a queued notification is
// failed before it is ever tried — silently never delivering anything while
// looking configured.
//
// The two floors are reached differently, and the third test below pins which
// is which rather than leaving it to be rediscovered. `Math.max(Number(x) || d, floor)`
// — the idiom every numeric var in config.js uses — sends a NEGATIVE value to
// the clamp but sends '0', '' and 'abc' to the DEFAULT, because all three are
// falsy after Number(). So `WA_NOTIFY_MAX_ATTEMPTS=0` means 8, not 1. Either way
// the property that matters holds: a queued notification is always tried at
// least once. Anyone wanting "queue it but never send" wants WA_NOTIFY_ENABLED=0.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WA_NOTIFY_ENABLED = 'true' // NOT "1"
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:8080///'
process.env.WA_NOTIFY_SWEEP_MS = '100' // an operator asking for a 100ms sweep
process.env.WA_NOTIFY_MAX_ATTEMPTS = '-1' // …and for a negative attempt budget

const { WA_NOTIFY_ENABLED, WA_BRIDGE_URL, WA_NOTIFY_SWEEP_MS, WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')

test('only the exact string "1" enables the notifier — "true" does not', () => {
  assert.equal(WA_NOTIFY_ENABLED, false)
})

test('WA_NOTIFY_SWEEP_MS is clamped up to the 10s floor', () => {
  assert.equal(WA_NOTIFY_SWEEP_MS, 10_000, 'the requested 100ms sweep was not clamped')
})

test('a negative WA_NOTIFY_MAX_ATTEMPTS is clamped up to 1 — every queued notification is tried at least once', () => {
  assert.equal(WA_NOTIFY_MAX_ATTEMPTS, 1)
})

test('every trailing slash is stripped from WA_BRIDGE_URL, not just the last one', () => {
  assert.equal(WA_BRIDGE_URL, 'http://127.0.0.1:8080')
  assert.equal(`${WA_BRIDGE_URL}/api/send`, 'http://127.0.0.1:8080/api/send')
})
