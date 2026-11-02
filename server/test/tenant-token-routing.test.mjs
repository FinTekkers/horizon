// HZ-697: which token each server GitHub call for a repo carries. A tenant
// project's repo uses that project's own token — its 0600 file — and with no
// resolvable token of its own, no call is made at all: never one with the
// owner's GITHUB_TOKEN. An internal repo keeps the global token. farmd's
// /farm/start for a tenant project carries no token.
//
// GitHub and the farm are a stubbed globalThis.fetch that records each call's
// Authorization header.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GLOBAL_TOKEN = 'ghp_OWNERGLOBALROUTINGhz697ABCDEFGHIJKL'
const TENANT_TOKEN = `github_pat_ROUTING_${'r'.repeat(50)}`
const TOKEN_ROOT = mkdtempSync(join(tmpdir(), 'horizon-tenant-routing-'))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tenant-routing-db-')), 'test.db')
process.env.HORIZON_TENANT_TOKEN_ROOT = TOKEN_ROOT
process.env.HORIZON_UI_URL = 'https://horizon.test/horizon'
process.env.GITHUB_WEBHOOK_SECRET = 'routing-secret'
process.env.GITHUB_TOKEN = GLOBAL_TOKEN
process.env.FARM_URL = 'http://farm.test'
for (const key of ['FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

let calls = []
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  calls.push({ url, method: opts.method || 'GET', authz: opts.headers?.Authorization ?? null, body: opts.body ?? null })
  if (url === 'http://farm.test/farm/status') return Response.json({ status: 'running' })
  if (url.startsWith('http://farm.test/')) return Response.json({ ok: true })
  return Response.json([], { status: 200, headers: { etag: '"e"' } })
}

const store = await import('../src/store.js')
const github = await import('../src/github.js')
const webhooks = await import('../src/webhooks.js')
const orchestrator = await import('../src/orchestrator.js')
const { setSetting } = await import('../src/settings.js')
const { tokenForRepo } = await import('../src/tenantTokens.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const INTERNAL = store.createProject('Internal').id
store.addRepoToProject(INTERNAL, 'owner/app')
const TENANT = store.createProject('Tenant', { isolation: 'tenant', memberId: null }).id
assert.equal(store.setTenantConnection(TENANT, 'acme/widgets', 'test').ok, true)
const tokenFile = join(TOKEN_ROOT, String(TENANT))

const writeToken = (mode = 0o600) => {
  writeFileSync(tokenFile, TENANT_TOKEN)
  chmodSync(tokenFile, mode)
}

test('tokenForRepo: a tenant repo reads its own 0600 file — in any letter case — and an internal or unknown repo keeps the global token', () => {
  writeToken()
  assert.equal(tokenForRepo('acme/widgets'), TENANT_TOKEN)
  assert.equal(tokenForRepo('ACME/Widgets'), TENANT_TOKEN)
  assert.equal(tokenForRepo('owner/app'), GLOBAL_TOKEN)
  assert.equal(tokenForRepo('someone/unconnected'), GLOBAL_TOKEN)
})

test('tokenForRepo: a tenant repo whose file is missing or not 0600 gets null, never the global token', () => {
  writeToken(0o644)
  assert.equal(tokenForRepo('acme/widgets'), null)
  rmSync(tokenFile)
  assert.equal(tokenForRepo('acme/widgets'), null)
})

test('github.js and webhooks.js: tenant calls carry the tenant token; with none, no call is made', async () => {
  writeToken()
  calls = []
  await github.pollRepo('acme/widgets')
  await webhooks.inspect('acme/widgets')
  await github.pollRepo('owner/app')
  assert.deepEqual(
    calls.map((c) => [c.url.split('?')[0], c.authz]),
    [
      ['https://api.github.com/repos/acme/widgets/issues', `Bearer ${TENANT_TOKEN}`],
      ['https://api.github.com/repos/acme/widgets/hooks', `Bearer ${TENANT_TOKEN}`],
      ['https://api.github.com/repos/owner/app/issues', `Bearer ${GLOBAL_TOKEN}`],
    ],
  )

  rmSync(tokenFile)
  calls = []
  const poll = await github.pollRepo('acme/widgets')
  assert.equal(poll.error, 'no GitHub token for this repo')
  assert.equal((await webhooks.inspect('acme/widgets')).reason, 'token_unavailable')
  assert.equal((await webhooks.ensure('acme/widgets')).reason, 'token_unavailable')
  await assert.rejects(github.createIssue('acme/widgets', { title: 't', outcome: 'o', metric: 'm', priority: 'Medium' }), /no GitHub token/)
  assert.equal(await github.fetchScreenshotSnapshot('acme/widgets', { id: 'AW-1' }), null)
  assert.deepEqual(calls, [], 'a call was made without the tenant’s own token')
})

test('orchestrator: /farm/start for a tenant project carries no token; for an internal one, the global token as before', async () => {
  for (const [projectId, token] of [
    [TENANT, null],
    [INTERNAL, GLOBAL_TOKEN],
  ]) {
    calls = []
    setSetting('farm_project_id', String(projectId))
    orchestrator.ensureFarm()
    const deadline = Date.now() + 5000
    while (!calls.some((c) => c.url.endsWith('/farm/start')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const start = calls.find((c) => c.url.endsWith('/farm/start'))
    assert.ok(start, 'farm start was sent')
    const body = JSON.parse(start.body)
    assert.equal(body.project.id, projectId)
    assert.equal(body.token, token)
    assert.ok(!start.body.includes(GLOBAL_TOKEN) || token === GLOBAL_TOKEN)
    while (orchestrator.getFarmState().status !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  }
})
