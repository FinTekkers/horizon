// HZ-244: with $GITHUB_WEBHOOK_SECRET unset Horizon will not create an
// unsigned webhook — connect still succeeds, reports
// reason "secret_not_configured", and makes no hooks call at all; status reads
// and Fix make none either.
//
// Its own file because config.js reads GITHUB_WEBHOOK_SECRET at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-webhooks-no-secret-')), 'test.db')
process.env.HORIZON_UI_URL = 'https://horizon.test/horizon'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO
delete process.env.FARM_URL

const calls = []
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push(`${method} ${url}`)
  if (method === 'GET' && url === 'https://api.github.com/repos/FinTekkers/unsigned') {
    return new Response(JSON.stringify({ full_name: 'FinTekkers/unsigned' }), { status: 200 })
  }
  if (method === 'GET' && url.startsWith('https://api.github.com/repos/FinTekkers/unsigned/issues?')) {
    return new Response('[]', { status: 200 })
  }
  throw new Error(`unexpected GitHub call: ${method} ${url}`)
}

const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

test('connect, status and Fix make no hooks call when the webhook secret is unset', async () => {
  store.purgeDemoItems()
  const user = loginFixtureUser(auth, config)
  const app = buildApp({ logger: false })
  const { id } = store.createProject('HZ-244 no secret')
  const expected = { status: 'error', lastResponseCode: null, reason: 'secret_not_configured' }

  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/repos`,
    headers: { cookie: user.cookie },
    payload: { repo: 'FinTekkers/unsigned' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().webhook, expected)

  const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/repos/webhooks`, headers: { cookie: user.cookie } })
  assert.deepEqual(list.json(), { webhooks: [{ repo: 'FinTekkers/unsigned', ...expected }] })

  const fix = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/repos/webhook/fix`,
    headers: { cookie: user.cookie, 'x-human-key': user.pin },
    payload: { repo: 'FinTekkers/unsigned' },
  })
  assert.equal(fix.statusCode, 503)
  assert.deepEqual(fix.json(), { error: 'webhook_secret_not_configured' })

  assert.deepEqual(calls.filter((c) => c.includes('/hooks')), [])
  assert.ok(calls.length >= 1, 'the connect never reached the stub')
})

// HZ-425 guardrail 4: with no secret nothing can be verified, so a
// `repository` event never changes the cached default branch.
test('a repository event is refused with 503 and leaves the cached default branch alone when the secret is unset', async () => {
  const app = buildApp({ logger: false })
  const { id } = store.createProject('HZ-425 no secret')
  assert.ok(store.addRepoToProject(id, 'FinTekkers/unsigned-branch').ok)
  assert.ok(store.setDefaultBranch('FinTekkers/unsigned-branch', 'master'))
  const before = store.getDefaultBranch('FinTekkers/unsigned-branch')
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': 'repository', 'x-hub-signature-256': 'sha256=whatever' },
    payload: JSON.stringify({
      action: 'edited',
      changes: { default_branch: { from: 'master' } },
      repository: { full_name: 'FinTekkers/unsigned-branch', default_branch: 'main' },
    }),
  })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(store.getDefaultBranch('FinTekkers/unsigned-branch'), before)
})
