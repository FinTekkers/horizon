// HZ-925: domain/js/envMs.js, the one parser behind the timers the e2e run
// shortens (RUN_LOG_POLL_MS, DEPLOY_TICK_MS, VITE_ADMIN_LANDING_WAIT_MS).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { envMs } from '../../domain/js/envMs.js'

test('unset gives the fallback', () => {
  assert.equal(envMs(undefined, 2000), 2000)
  assert.equal(envMs(null, 2000), 2000)
})

test('a number gives that number', () => {
  assert.equal(envMs('200', 2000), 200)
})

test('junk or empty text gives the fallback', () => {
  assert.equal(envMs('abc', 2000), 2000)
  assert.equal(envMs('', 2000), 2000)
  assert.equal(envMs('  ', 2000), 2000)
})

test('zero, negative or tiny values are held at the 50 ms floor, never off', () => {
  assert.equal(envMs('0', 2000), 50)
  assert.equal(envMs('-5', 2000), 50)
  assert.equal(envMs('1', 2000), 50)
})
