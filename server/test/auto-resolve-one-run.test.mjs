// HZ-235 metric line 3 and the bounded-load guardrail: at most one resolve
// run per item, through the HZ-188 lock, and one item at a time. The fake
// farmd holds each /conflicts/resolve call open until the test replies, so
// merges and clicks genuinely arrive while a run is queued or running.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve, MAIN_SHA_2, MAIN_SHA_3 } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-one-run')
const { autoResolve, gh } = h

beforeEach(() => h.reset())

const SHA_4 = 'e'.repeat(40)
const SHA_5 = 'f'.repeat(40)

test('two conflicted items are resolved one at a time: the second farm call waits for the first reply', async () => {
  h.conflictedAtGate('OT-A', 701)
  h.conflictedAtGate('OT-B', 702)
  await h.mergeWebhook(800)
  await h.untilFarmCalls(1)
  assert.equal(h.farmCalls[0].body.item.id, 'OT-A')

  // Hold A open across another merge's whole debounce window: B never starts.
  await h.mergeWebhook(801, { sha: MAIN_SHA_3 })
  await h.untilLine(/auto-resolve: scan queued behind OT-A/)
  assert.equal(h.farmCalls.length, 1)

  gh.mergeable.set(701, true)
  h.farmCalls[0].resolve(h.replyOk(h.resolved))
  await h.untilFarmCalls(2)
  assert.equal(h.farmCalls[1].body.item.id, 'OT-B')
  gh.mergeable.set(702, true)
  h.farmCalls[1].resolve(h.replyOk(h.resolved))
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 2)
})

test('a second and third merge while Y is still queued behind Z: Y gets one farm call in total', async () => {
  h.conflictedAtGate('OQ-A-Z', 711)
  h.conflictedAtGate('OQ-B-Y', 712)
  gh.mainSha = MAIN_SHA_2
  await h.mergeWebhook(810, { sha: MAIN_SHA_2 })
  await h.untilFarmCalls(1)
  assert.equal(h.farmCalls[0].body.item.id, 'OQ-A-Z', 'Z runs; Y is queued behind it')

  gh.mainSha = SHA_5
  await h.mergeWebhook(811, { sha: SHA_4 })
  await h.mergeWebhook(812, { sha: SHA_5 })
  await h.untilLine(/scan queued behind OQ-A-Z/)
  assert.equal(h.resolveCallsFor('OQ-B-Y').length, 0)

  gh.mergeable.set(711, true)
  h.farmCalls[0].resolve(h.replyOk(h.resolved))
  await h.untilFarmCalls(2)
  assert.equal(h.farmCalls[1].body.item.id, 'OQ-B-Y')
  gh.mergeable.set(712, true)
  h.farmCalls[1].resolve(h.replyOk(h.resolved))
  await autoResolve.whenIdleForTest()

  assert.equal(h.resolveCallsFor('OQ-B-Y').length, 1, 'one run in total for Y')
  // The follow-up scan for #811 and #812 ran once and found Y clean.
  assert.match(h.itemLines('OQ-B-Y').at(-1), /\[main moved: merged PR #811, #812\] OQ-B-Y PR #712: clean$/)
})

test('a human click while the auto run is held is refused by the HZ-188 lock; more merges add nothing', async () => {
  h.conflictedAtGate('OH-Y', 721)
  await h.mergeWebhook(820)
  await h.untilFarmCalls(1)
  assert.equal(h.gateAction('OH-Y').started_by, 'main_moved')

  await h.mergeWebhook(821, { sha: MAIN_SHA_3 })
  await h.mergeWebhook(822, { sha: SHA_4 })
  await h.untilLine(/scan queued behind OH-Y/)
  const click = await h.resolvePost('OH-Y')
  assert.equal(click.statusCode, 409)
  assert.deepEqual(click.json(), { error: 'resolve_in_progress' })
  assert.equal(h.farmCalls.length, 1)
  assert.equal(h.gateAction('OH-Y').started_by, 'main_moved', 'the click did not take over the lock row')

  gh.mergeable.set(721, true)
  h.farmCalls[0].resolve(h.replyOk(h.resolved))
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 1)
})
