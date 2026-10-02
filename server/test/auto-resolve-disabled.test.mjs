// HZ-235 metric line 5: one setting turns the trigger off. With
// auto_resolve_on_main = '0', neither a signed merge into main nor a main
// move the poll notices starts a resolver call or logs any item line.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve, MAIN_SHA_2, MAIN_SHA_3, REPO } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-disabled')
const { settings, autoResolve, gh } = h

beforeEach(async () => {
  await h.reset()
  settings.setSetting('auto_resolve_on_main', '0')
})

test('setting off: a signed merge into main starts nothing', async () => {
  assert.equal(settings.isAutoResolveOnMain(), false)
  h.conflictedAtGate('DS-Y', 1001)
  const res = await h.mergeWebhook(1100)
  assert.equal(res.statusCode, 204)
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.gateAction('DS-Y'), undefined)
  assert.deepEqual(h.itemLines('DS-Y'), [])
  assert.ok(h.lines.includes(`auto-resolve off — ignored main move on ${REPO}`))
})

test('setting off: a main move seen by the poll starts nothing', async () => {
  h.conflictedAtGate('DS-P', 1002)
  await h.pollTick() // seed
  gh.mainSha = MAIN_SHA_2
  gh.commitPrs.set(MAIN_SHA_2, [1101])
  await h.pollTick()
  gh.mainSha = MAIN_SHA_3
  await h.pollTick()
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('DS-P'), [])
})
