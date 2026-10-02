// HZ-250 metric line 5: while a self-deploy drains, auto-resolve
// (server/src/autoResolve.js) starts no resolve run — it logs why and creates
// no gate_action row — and the item is re-checked once the block lifts.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve, REPO } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('deploy-drain-auto-resolve')
const { autoResolve } = h
const deployDrain = await import('../src/deployDrain.js')

beforeEach(async () => {
  deployDrain.endDrain()
  await h.reset()
})

async function mergeAndSettle(pr) {
  assert.equal((await h.mergeWebhook(pr)).statusCode, 204)
  await autoResolve.whenIdleForTest()
}

test('M5: a conflicted item is skipped with a logged reason and no gate_action row while a deploy drains', async () => {
  h.conflictedAtGate('DR-AUTO', 701)
  deployDrain.beginDrain({ ttlS: 600 })
  await mergeAndSettle(800)
  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.gateAction('DR-AUTO'), undefined)
  assert.deepEqual(h.itemLines('DR-AUTO'), [`auto-resolve ${REPO} [main moved: merged PR #800] DR-AUTO PR #701: skipped (deploy in progress)`])

  // Once the deploy is over, the next poll tick re-checks it and starts the run.
  deployDrain.endDrain()
  h.farmReplyNext(h.resolved)
  await h.pollTick()
  await h.untilFarmCalls(1)
  await autoResolve.whenIdleForTest()
  assert.equal(h.gateAction('DR-AUTO').state, 'resolved')
})

test('M5: a deploy that starts draining while the scan waits on GitHub still gets no run', async () => {
  h.conflictedAtGate('DR-LATE', 702)
  h.gh.onPrRead = (n) => n === 702 && deployDrain.beginDrain({ ttlS: 600 })
  await mergeAndSettle(801)
  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.gateAction('DR-LATE'), undefined)
  assert.match(h.itemLines('DR-LATE').at(-1), /: skipped \(deploy in progress\)$/)
})
