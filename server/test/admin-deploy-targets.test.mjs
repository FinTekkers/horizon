// HTTP-contract test for GET /api/admin/deploy-targets (HZ-41): the
// read-only Admin panel's data source. No auth beyond the existing
// Admin-page gating — same shape as GET /api/sync/status and
// GET /api/definitions, both also ungated at the route level.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-admin-deploy-targets-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const fixtureHome = mkdtempSync(join(tmpdir(), 'horizon-admin-deploy-targets-home-'))
process.env.HOME = fixtureHome

const registryFile = join(mkdtempSync(join(tmpdir(), 'horizon-admin-deploy-targets-registry-')), 'deploy-targets.json')
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
    {
      key: 'ui-service',
      repo: 'FinTekkers/ui-service',
      script: 'stub-ui.sh',
      service: 'fintekkers-ui-test',
      repoDir: '/tmp/fixture-ui-service',
      stateKey: 'ui-service',
      healthUrl: 'http://stub.invalid/ui-service',
      healthCheckType: 'ssr-asset-check',
    },
  ]),
)
process.env.HORIZON_DEPLOY_TARGETS_FILE = registryFile

// horizon has a recorded successful deploy; ui-service has never deployed —
// the response must reflect each target's own state independently.
const horizonStateDir = join(fixtureHome, '.horizon', 'horizon')
mkdirSync(horizonStateDir, { recursive: true })
writeFileSync(join(horizonStateDir, 'self-deploy.log'), '2026-09-14T03:22:10Z DEPLOY OK tag=refs/tags/v42 commit=abc1234\n')
writeFileSync(join(horizonStateDir, 'last-good-tag'), 'refs/tags/v42:abc1234\n')

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)

test('GET /api/admin/deploy-targets returns repo, service, and per-target deploy state', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/deploy-targets', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.targets.length, 2)

  const horizon = body.targets.find((t) => t.key === 'horizon')
  assert.deepEqual(horizon, {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    service: 'horizon-server-test',
    lastTag: 'refs/tags/v42',
    lastCommit: 'abc1234',
    lastResult: 'ok',
    lastAt: '2026-09-14T03:22:10Z',
  })

  const uiService = body.targets.find((t) => t.key === 'ui-service')
  assert.deepEqual(uiService, {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    service: 'fintekkers-ui-test',
    lastTag: null,
    lastCommit: null,
    lastResult: 'never',
    lastAt: null,
  })
})
