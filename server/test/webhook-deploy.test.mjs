// HTTP-level self-deploy tests (HZ-19, extended for HZ-41's versioned
// deploy-target registry): the /api/webhooks/github route with a real secret
// configured, driven through the real Fastify app via inject(). Kept in its
// own file (rather than app.test.mjs) because it needs
// GITHUB_WEBHOOK_SECRET set before config.js/app.js are imported, whereas
// app.test.mjs deliberately unsets it to test the "webhooks not configured"
// path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-webhook-deploy-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-webhook-deploy-home-'))
delete process.env.FARM_URL

const registryFile = join(mkdtempSync(join(tmpdir(), 'horizon-webhook-deploy-registry-')), 'deploy-targets.json')
writeFileSync(
  registryFile,
  JSON.stringify([
    {
      key: 'horizon',
      repo: 'FinTekkers/horizon',
      script: 'stub-horizon.sh',
      service: 'horizon-server-test',
      repoDir: '/tmp/fixture-horizon',
      stateKey: 'horizon',
      healthUrl: 'http://stub.invalid/horizon',
      healthCheckType: 'json-items',
    },
  ]),
)
process.env.HORIZON_DEPLOY_TARGETS_FILE = registryFile

const { buildApp } = await import('../src/app.js')
const deploy = await import('../src/deploy.js')

const app = buildApp({ logger: false })

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')
}

function releaseWebhook(appInstance, { repo = 'FinTekkers/horizon', tag = 'v1', action = 'published', draft = false, prerelease = false, badSignature = false } = {}) {
  const body = JSON.stringify({
    action,
    repository: { full_name: repo },
    release: { tag_name: tag, draft, prerelease, html_url: `https://github.com/${repo}/releases/tag/${tag}` },
  })
  return appInstance.inject({
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
  deploy.runner.spawn = (target, tag) => calls.push(tag)
  return { calls, restore: () => { deploy.runner.spawn = original } }
}

test('valid release published on a registered repo triggers a deploy and replies 204', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook(app, { tag: 'v1' })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, ['v1'])
  } finally {
    stub.restore()
  }
})

test('release published on a repo absent from the registry does not trigger a deploy, still replies 204', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook(app, { repo: 'FinTekkers/some-other-repo', tag: 'v-evil' })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('a release published on a repo absent from the registry is logged as ignored', async () => {
  const stub = stubSpawn()
  const lines = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  const loggingApp = buildApp({ logger: { level: 'warn', stream } })
  try {
    const res = await releaseWebhook(loggingApp, { repo: 'FinTekkers/some-other-repo', tag: 'v-evil' })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, [])
    const warned = lines.some((line) => line.includes('self-deploy: ignored release event from FinTekkers/some-other-repo'))
    assert.equal(warned, true, `expected a warn log for the ignored release; got: ${lines.join('')}`)
  } finally {
    stub.restore()
  }
})

test('an invalid signature on a release event is rejected with 401 before any deploy logic runs', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook(app, { tag: 'v-bad-sig', badSignature: true })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('a draft release does not trigger a deploy', async () => {
  const stub = stubSpawn()
  try {
    const res = await releaseWebhook(app, { tag: 'v-draft', draft: true })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

test('two back-to-back valid release webhooks both trigger, each with its own tag', async () => {
  const stub = stubSpawn()
  try {
    const first = await releaseWebhook(app, { tag: 'v10' })
    const second = await releaseWebhook(app, { tag: 'v11' })
    assert.equal(first.statusCode, 204)
    assert.equal(second.statusCode, 204)
    assert.deepEqual(stub.calls, ['v10', 'v11'])
  } finally {
    stub.restore()
  }
})
