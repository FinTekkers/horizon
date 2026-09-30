// Fourth process in the config-wa-notify.* set, for the one input an operator
// is most likely to try and most likely to misread: WA_NOTIFY_MAX_ATTEMPTS=0.
//
// It does NOT mean "queue it but never send", and it does not hit the floor of
// 1 either — `Math.max(Number(x) || 8, 1)`, the idiom every numeric var in
// config.js uses, treats 0 as falsy and falls back to the default. So a host
// with this set retries eight times like any other. That is surprising enough
// to pin: the alternative reading ("never send") would make a configured,
// enabled notifier silently deliver nothing, and nothing in the outbox would
// say why. The way to stop sending is WA_NOTIFY_ENABLED=0, which is loud about
// it in the boot log.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WA_NOTIFY_MAX_ATTEMPTS = '0'
const { WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')

test('WA_NOTIFY_MAX_ATTEMPTS=0 falls back to the default budget, never to zero attempts', () => {
  assert.equal(WA_NOTIFY_MAX_ATTEMPTS, 8)
  assert.ok(WA_NOTIFY_MAX_ATTEMPTS >= 1, 'a queued notification must always be tried at least once')
})
