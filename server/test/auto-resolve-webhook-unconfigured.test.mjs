// HZ-235 webhook guardrail: with no $GITHUB_WEBHOOK_SECRET configured the
// webhook answers 503 and a merge into main starts nothing. Its own file
// because config.js reads the secret once, at import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-webhook-unconfigured', { webhookSecret: null })

test('no webhook secret: 503 and no scan', async () => {
  h.insertItem('WU-C', { pr: 1201 })
  h.conflictedAtGate('WU-Y', 1202)
  const res = await h.mergeWebhook(1300)
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error, 'webhooks_not_configured')
  await h.autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('WU-C'), [])
})
