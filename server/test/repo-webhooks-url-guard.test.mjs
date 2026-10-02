// HZ-244: with HORIZON_UI_URL left at its localhost default, the webhook URL is
// one GitHub could never reach — so neither connect nor Fix may create or
// repair a hook. Both refuse before any GitHub call, with
// reason "webhook_url_not_public".
//
// Its own file because config.js reads HORIZON_UI_URL at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-webhooks-url-guard-')), 'test.db')
delete process.env.HORIZON_UI_URL
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret-url-guard'

const calls = []
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push(`${method} ${url}`)
  if (method === 'GET' && url === 'https://api.github.com/repos/FinTekkers/local') {
    return new Response(JSON.stringify({ full_name: 'FinTekkers/local' }), { status: 200 })
  }
  if (method === 'GET' && url.startsWith('https://api.github.com/repos/FinTekkers/local/issues?')) {
    return new Response('[]', { status: 200 })
  }
  throw new Error(`unexpected GitHub call: ${method} ${url}`)
}

const config = await import('../src/config.js')
const webhooks = await import('../src/webhooks.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

const hookCalls = () => calls.filter((c) => c.includes('/hooks'))

test('the default webhook URL is localhost', () => {
  assert.equal(webhooks.webhookUrl(), 'http://localhost:5173/api/webhooks/github')
  assert.equal(config.WEBHOOK_URL, webhooks.webhookUrl())
})

test('ensure and fix refuse a non-public webhook URL without calling GitHub', async () => {
  const expected = { status: 'error', lastResponseCode: null, reason: 'webhook_url_not_public' }
  assert.deepEqual(await webhooks.ensure('FinTekkers/local'), expected)
  assert.deepEqual(await webhooks.fix('FinTekkers/local'), { action: 'none', ...expected })
  assert.deepEqual(hookCalls(), [])
})

test('connect still succeeds, reports the refusal and sends no hooks call; Fix answers 503', async () => {
  store.purgeDemoItems()
  const user = loginFixtureUser(auth, config)
  const app = buildApp({ logger: false })
  const { id } = store.createProject('HZ-244 url guard')
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/repos`,
    headers: { cookie: user.cookie },
    payload: { repo: 'FinTekkers/local' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().webhook, { status: 'error', lastResponseCode: null, reason: 'webhook_url_not_public' })

  const fix = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/repos/webhook/fix`,
    headers: { cookie: user.cookie, 'x-human-key': user.pin },
    payload: { repo: 'FinTekkers/local' },
  })
  assert.equal(fix.statusCode, 503)
  assert.deepEqual(fix.json(), { error: 'webhook_url_not_public' })
  assert.deepEqual(hookCalls(), [])
  assert.ok(!calls.some((c) => !c.startsWith('GET ')), `a write was sent: ${calls.join(', ')}`)
})
