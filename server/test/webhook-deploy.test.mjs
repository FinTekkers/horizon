// HTTP-level self-deploy tests (HZ-19): the /api/webhooks/github route with a
// real secret configured, driven through the real Fastify app via inject().
// Kept in its own file (rather than app.test.mjs) because it needs
// GITHUB_WEBHOOK_SECRET set before config.js/app.js are imported, whereas
// app.test.mjs deliberately unsets it to test the "webhooks not configured"
// path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-webhook-deploy-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { setSetting } = await import('../src/settings.js')
const deploy = await import('../src/deploy.js')

setSetting('github_repo', 'FinTekkers/horizon')

const app = buildApp({ logger: false })

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')
}

function releaseWebhook({ repo = 'FinTekkers/horizon', tag = 'v1', action = 'published', draft = false, prerelease = false, badSignature = false } = {}) {
  const body = JSON.stringify({
    action,
    repository: { full_name: repo },
    release: { tag_name: tag, draft, prerelease, html_url: `https://github.com/${repo}/releases/tag/${tag}` },
  })
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'release',
      'x-hub-signature-256': badSignature ? 'sha256=' + '0'.repeat(64) : sign(body),
    },
    payload: body,
  })
}

function stubSpawn() {
  const calls = []
  const original = deploy.runner.spawn
  deploy.runner.spawn = (tag) => calls.push(tag)
  return { calls, restore: () => { deploy.runner.spawn = original } }
}

test('valid release published on the connected repo triggers a deploy and replies 204', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook({ tag: 'v1' })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, ['v1'])
  } finally {
    stub.restore()
  }
})

test('release published on a different repo does not trigger a deploy, still replies 204', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook({ repo: 'FinTekkers/shoreward', tag: 'v-evil' })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('an invalid signature on a release event is rejected with 401 before any deploy logic runs', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook({ tag: 'v-bad-sig', badSignature: true })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('a draft release does not trigger a deploy', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook({ tag: 'v-draft', draft: true })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('two back-to-back valid release webhooks both trigger, each with its own tag', async () => {
  const stub = stubSpawn()
  try {
    const first = await releaseWebhook({ tag: 'v10' })
    const second = await releaseWebhook({ tag: 'v11' })
    assert.equal(first.statusCode, 204)
    assert.equal(second.statusCode, 204)
    assert.deepEqual(stub.calls, ['v10', 'v11'])
  } finally {
    stub.restore()
  }
})
