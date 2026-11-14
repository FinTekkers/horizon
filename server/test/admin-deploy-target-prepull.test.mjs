// HO-839: creating a deploy target with a container image, or editing one so
// its image changes, asks farmd to pre-pull that image (POST /images/pull) —
// the route wiring, not just prePullOnImageChange(). An edit that leaves the
// image unchanged asks for nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-target-prepull-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-prepull-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const calls = []
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body })
  return { ok: true, status: 202, json: async () => ({ queued: true }) }
}
const pulls = () => calls.filter((call) => call.url === 'http://farm.test/images/pull').map((call) => JSON.parse(call.body).image)
// The pull is fired off the request; let it reach fetch.
const settle = () => new Promise((resolve) => setImmediate(resolve))

await useDeployTargetRows([
  { key: 'horizon', repo: 'FinTekkers/horizon', script: 'stub-horizon.sh', service: 'horizon-server-test', stateKey: 'horizon' },
  { key: 'docs', repo: 'FinTekkers/docs', script: 'stub-docs.sh', service: 'docs-svc', stateKey: 'docs' },
])

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const IMAGE_1 = `ghcr.io/acme/job@sha256:${'1'.repeat(64)}`
const IMAGE_2 = `ghcr.io/acme/job@sha256:${'2'.repeat(64)}`
const FIELDS = {
  repo: 'FinTekkers/notes',
  script: 'stub-docs.sh',
  service: 'docs-svc',
  repoDir: '/opt/fintekkers/notes',
  stateKey: 'notes',
  healthUrl: 'https://notes.example.invalid/',
  healthCheckType: 'http-200',
}

const send = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie, 'x-human-key': pin } })

test('POST with a containerImage pre-pulls it once; POST without one pulls nothing', async () => {
  calls.length = 0
  const plain = await send('POST', '/api/admin/deploy-targets', { key: 'plain', ...FIELDS, repo: 'FinTekkers/plain', repoDir: '/opt/fintekkers/plain', stateKey: 'plain' })
  assert.equal(plain.statusCode, 201, plain.body)
  await settle()
  assert.deepEqual(pulls(), [])

  const created = await send('POST', '/api/admin/deploy-targets', { key: 'notes', ...FIELDS, containerImage: IMAGE_1 })
  assert.equal(created.statusCode, 201, created.body)
  await settle()
  assert.deepEqual(pulls(), [IMAGE_1])
})

test('PUT that changes containerImage pre-pulls the new image once; an unchanged image pulls nothing', async () => {
  calls.length = 0
  const same = await send('PUT', '/api/admin/deploy-targets/notes', { ...FIELDS, containerImage: IMAGE_1, cpuLimit: '1.5' })
  assert.equal(same.statusCode, 200, same.body)
  await settle()
  assert.deepEqual(pulls(), [])

  const changed = await send('PUT', '/api/admin/deploy-targets/notes', { ...FIELDS, containerImage: IMAGE_2 })
  assert.equal(changed.statusCode, 200, changed.body)
  await settle()
  assert.deepEqual(pulls(), [IMAGE_2])
})

test('a refused write (no PIN) pulls nothing', async () => {
  calls.length = 0
  const refused = await app.inject({
    method: 'PUT',
    url: '/api/admin/deploy-targets/notes',
    payload: { ...FIELDS, containerImage: `ghcr.io/acme/job@sha256:${'3'.repeat(64)}` },
    headers: { cookie },
  })
  assert.notEqual(refused.statusCode, 200)
  await settle()
  assert.deepEqual(pulls(), [])
})
