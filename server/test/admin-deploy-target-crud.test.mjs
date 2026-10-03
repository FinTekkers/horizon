// HZ-259: Admin create / edit / delete of deploy targets
// (POST/PUT/DELETE /api/admin/deploy-targets[/:key]) and the stored-row read
// (GET /api/admin/deploy-targets/config). Every write is gate-grade: session +
// PIN in x-human-key only. Rules are checkRunnable's: the stub scripts dir's
// horizon-deploy.sudoers decides which services a row may name.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

const SECRET_TOKEN = 'SENTINEL-GITHUB-TOKEN-crud-1a2b'
const SECRET_WEBHOOK = 'SENTINEL-WEBHOOK-SECRET-crud-3c4d'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-target-crud-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-crud-home-'))
process.env.GITHUB_TOKEN = SECRET_TOKEN
process.env.GITHUB_WEBHOOK_SECRET = SECRET_WEBHOOK
delete process.env.FARM_URL

// The seeded pair, plus a sudoers line for the services the new rows use.
const scriptsDir = await useDeployTargetRows([
  { key: 'horizon', repo: 'FinTekkers/horizon', script: 'stub-horizon.sh', service: 'horizon-server-test', stateKey: 'horizon' },
  { key: 'ui-service', repo: 'FinTekkers/ui-service', script: 'stub-ui.sh', service: 'fintekkers-ui-test', stateKey: 'ui-service' },
])
writeFileSync(join(scriptsDir, 'stub-docs.sh'), '#!/bin/sh\n', { mode: 0o755 })
writeFileSync(
  join(scriptsDir, 'horizon-deploy.sudoers'),
  ['horizon-server-test', 'fintekkers-ui-test', 'docs-svc', 'docs-svc-2', 'docs-extra']
    .map((service) => `ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart ${service}\n`)
    .join(''),
)

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { listTargets, findTargetByKey } = await import('../src/deployTargets.js')

const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const DOCS = {
  key: 'docs',
  repo: 'FinTekkers/docs',
  script: 'stub-docs.sh',
  service: 'docs-svc',
  repoDir: '/opt/fintekkers/docs',
  stateKey: 'docs',
  healthUrl: 'https://docs.example.invalid/',
  healthCheckType: 'http-200',
}
const { key: _docsKey, ...DOCS_FIELDS } = DOCS

function request(method, url, { payload, pin: key, headers = {} } = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: { cookie, ...(key !== undefined ? { 'x-human-key': key } : {}), ...headers },
  })
}

const keys = () => listTargets().map((t) => t.key)

test('POST, PUT, DELETE with the PIN return 201, 200, 200 and change the stored rows', async () => {
  const created = await request('POST', '/api/admin/deploy-targets', { payload: { ...DOCS, extraServices: ['docs-extra'] }, pin })
  assert.equal(created.statusCode, 201, created.body)
  assert.deepEqual(created.json(), { ok: true, target: { ...DOCS, extraServices: ['docs-extra'] } })
  assert.deepEqual(findTargetByKey('docs'), { ...DOCS, extraServices: ['docs-extra'] })

  const updated = await request('PUT', '/api/admin/deploy-targets/docs', {
    payload: { ...DOCS_FIELDS, service: 'docs-svc-2' },
    pin,
  })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().target.service, 'docs-svc-2')
  assert.deepEqual(findTargetByKey('docs'), { ...DOCS, service: 'docs-svc-2' })

  const deleted = await request('DELETE', '/api/admin/deploy-targets/docs', { pin })
  assert.equal(deleted.statusCode, 200, deleted.body)
  assert.deepEqual(deleted.json(), { ok: true })
  assert.equal(findTargetByKey('docs'), null)
  assert.deepEqual(keys(), ['horizon', 'ui-service'])
})

test('a missing field or a wrong type is a schema 400, with a valid PIN sent', async () => {
  const { service: _omit, ...missing } = DOCS
  for (const [label, payload] of [
    ['missing service', missing],
    ['wrong type', { ...DOCS, service: { name: 'docs-svc' } }],
    ['extraServices not an array', { ...DOCS, extraServices: { first: 'docs-extra' } }],
  ]) {
    const res = await request('POST', '/api/admin/deploy-targets', { payload, pin })
    assert.equal(res.statusCode, 400, label)
    assert.equal(res.json().code, 'FST_ERR_VALIDATION', label)
  }
  const res = await request('PUT', '/api/admin/deploy-targets/horizon', { payload: { ...DOCS_FIELDS, repo: { name: 'FinTekkers/docs' } }, pin })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(keys(), ['horizon', 'ui-service'])
  assert.equal(findTargetByKey('horizon').repo, 'FinTekkers/horizon')
})

test('a checkRunnable refusal is a 400 carrying its plain reason, and writes nothing', async () => {
  const res = await request('POST', '/api/admin/deploy-targets', { payload: { ...DOCS, service: 'not-a-service' }, pin })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'deploy_target_invalid', reason: 'service not-a-service not in horizon-deploy.sudoers' })
  assert.equal(findTargetByKey('docs'), null)

  const script = await request('PUT', '/api/admin/deploy-targets/horizon', {
    payload: { ...DOCS_FIELDS, repo: 'FinTekkers/horizon', script: '../../etc/passwd' },
    pin,
  })
  assert.equal(script.statusCode, 400)
  assert.equal(script.json().reason, 'script outside infra/host')
  assert.equal(findTargetByKey('horizon').script, 'stub-horizon.sh')
})

test('no PIN or a wrong PIN is 401 human_gate_key_required on every write, and nothing is written', async () => {
  for (const key of [undefined, 'not-the-pin']) {
    const attempts = [
      request('POST', '/api/admin/deploy-targets', { payload: DOCS, pin: key }),
      request('PUT', '/api/admin/deploy-targets/horizon', { payload: { ...DOCS_FIELDS, repo: 'FinTekkers/horizon' }, pin: key }),
      request('DELETE', '/api/admin/deploy-targets/horizon', { pin: key }),
    ]
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.statusCode, 401)
      assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    }
  }
  assert.deepEqual(keys(), ['horizon', 'ui-service'])
  assert.equal(findTargetByKey('horizon').service, 'horizon-server-test')
})

test('a token caller gets 401 on POST, PUT and DELETE even with a valid x-human-key', async () => {
  const minted = await request('POST', '/api/tokens', { payload: { name: 'deploy-target-bot' } })
  assert.equal(minted.statusCode, 201, minted.body)
  const tokenHeaders = { authorization: `Bearer ${minted.json().token}`, 'x-human-key': pin }
  const asToken = (method, url, payload) => app.inject({ method, url, payload, headers: tokenHeaders })
  for (const res of [
    await asToken('POST', '/api/admin/deploy-targets', DOCS),
    await asToken('PUT', '/api/admin/deploy-targets/horizon', { ...DOCS_FIELDS, repo: 'FinTekkers/horizon' }),
    await asToken('DELETE', '/api/admin/deploy-targets/horizon'),
  ]) {
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error, 'human_gate_key_required')
  }
  assert.deepEqual(keys(), ['horizon', 'ui-service'])
  assert.equal(findTargetByKey('horizon').service, 'horizon-server-test')
})

test('a PIN in the body or query is not read: exactly 401, nothing written; extra fields are not stored', async () => {
  const inBody = await request('POST', '/api/admin/deploy-targets', { payload: { ...DOCS, pin, 'x-human-key': pin } })
  assert.equal(inBody.statusCode, 401)
  const inQuery = await request('DELETE', `/api/admin/deploy-targets/horizon?pin=${pin}&x-human-key=${pin}`)
  assert.equal(inQuery.statusCode, 401)
  assert.deepEqual(keys(), ['horizon', 'ui-service'])

  const extra = await request('POST', '/api/admin/deploy-targets', { payload: { ...DOCS, sneaky: 'x', deployNow: true }, pin })
  assert.equal(extra.statusCode, 201, extra.body)
  assert.deepEqual(findTargetByKey('docs'), DOCS)
  assert.equal(extra.body.includes('sneaky'), false)
  assert.equal((await request('DELETE', '/api/admin/deploy-targets/docs', { pin })).statusCode, 200)
})

test('unknown keys are 404 and a duplicate key or repo is 409', async () => {
  const put = await request('PUT', '/api/admin/deploy-targets/nope', { payload: DOCS_FIELDS, pin })
  assert.equal(put.statusCode, 404)
  assert.equal(put.json().error, 'deploy_target_not_found')
  const del = await request('DELETE', '/api/admin/deploy-targets/nope', { pin })
  assert.equal(del.statusCode, 404)

  const dupKey = await request('POST', '/api/admin/deploy-targets', { payload: { ...DOCS, key: 'horizon' }, pin })
  assert.equal(dupKey.statusCode, 409)
  assert.equal(dupKey.json().error, 'deploy_target_conflict')
  const dupRepo = await request('PUT', '/api/admin/deploy-targets/ui-service', {
    payload: { ...DOCS_FIELDS, repo: 'FinTekkers/horizon' },
    pin,
  })
  assert.equal(dupRepo.statusCode, 409)
  assert.equal(findTargetByKey('ui-service').repo, 'FinTekkers/ui-service')
})

test('GET /api/admin/deploy-targets/config returns the stored rows and no secrets', async () => {
  const res = await request('GET', '/api/admin/deploy-targets/config')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.targets.map((t) => t.key), ['horizon', 'ui-service'])
  assert.equal(body.targets[0].script, 'stub-horizon.sh')
  assert.equal(body.targets[0].healthCheckType, 'json-health')
  for (const secret of [SECRET_TOKEN, SECRET_WEBHOOK, pin]) assert.equal(res.body.includes(secret), false)
})
