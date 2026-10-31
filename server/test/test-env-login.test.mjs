// HZ-511: screenshot capture logs in with the repo's test_env_file key, sent
// as X-Horizon-Test-Env-SCREENSHOT-LOGIN-KEY, never through /api/auth/login.
// Hooks on here; test-env-login-hooks-off.test.mjs covers a production server.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'hz511-screenshot-k3y'
const scratch = mkdtempSync(join(tmpdir(), 'horizon-test-env-login-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
process.env.HORIZON_TEST_HOOKS = '1'
process.env.SCREENSHOT_LOGIN_KEY = KEY
delete process.env.FARM_URL

const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { TEST_ENV_LOGIN_HEADER, testEnvUser } = await import('../src/testEnvLogin.js')

store.purgeDemoItems()
// The admin account up front, so the test knows its gate PIN.
const { user: admin, pin: adminPin } = auth.createUser({ email: config.ADMIN_EMAIL, name: 'Admin', authMethod: 'password', role: 'owner' })

const logLines = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logLines.push(line) } } })
// Echoes the credential label the login gate set, so tests can observe it.
app.get('/api/test/whoami', { config: { scope: 'test' } }, (request) => ({ via: request.auth.via, userId: request.user.id }))
await app.ready()
after(() => app.close())

const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers })

test('the header name is the one the farm runner sends for SCREENSHOT_LOGIN_KEY', () => {
  assert.equal(TEST_ENV_LOGIN_HEADER, 'x-horizon-test-env-screenshot-login-key')
})

test('the correct header is logged in on /api/auth/me and a gated route', async () => {
  const me = await get('/api/auth/me', { [TEST_ENV_LOGIN_HEADER]: KEY })
  assert.equal(me.statusCode, 200, me.body)
  assert.equal(me.json().user.id, admin.id)
  assert.equal(me.json().user.email, config.ADMIN_EMAIL)

  const items = await get('/api/items', { [TEST_ENV_LOGIN_HEADER]: KEY })
  assert.equal(items.statusCode, 200, items.body)
  assert.ok(Array.isArray(items.json().items))
})

test('a wrong or missing header gets 401 login_required', async () => {
  for (const headers of [{ [TEST_ENV_LOGIN_HEADER]: 'not-the-key' }, { [TEST_ENV_LOGIN_HEADER]: `${KEY} ` }, {}]) {
    for (const url of ['/api/auth/me', '/api/items']) {
      const res = await get(url, headers)
      assert.equal(res.statusCode, 401, `${url} ${JSON.stringify(Object.keys(headers))}`)
      assert.deepEqual(res.json(), { error: 'login_required' })
    }
  }
})

test('an empty key never matches, not even an empty header', async () => {
  assert.equal(testEnvUser({ [TEST_ENV_LOGIN_HEADER]: '' }, { enabled: true, key: '' }), null)
  assert.equal(testEnvUser({ [TEST_ENV_LOGIN_HEADER]: 'x' }, { enabled: true, key: '' }), null)
  // Through the app: the configured key is set, an empty header is still refused.
  const res = await get('/api/items', { [TEST_ENV_LOGIN_HEADER]: '' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('the header is labelled test-env and cannot pass a gate, even with a valid PIN', async () => {
  const who = await get('/api/test/whoami', { [TEST_ENV_LOGIN_HEADER]: KEY })
  assert.equal(who.statusCode, 200, who.body)
  assert.deepEqual(who.json(), { via: 'test-env', userId: admin.id })

  assert.ok(auth.verifyGatePin(admin.id, adminPin), 'the PIN itself is valid')
  const res = await app.inject({
    method: 'PUT',
    url: '/api/projects/1/repos/test-env',
    headers: { [TEST_ENV_LOGIN_HEADER]: KEY, 'x-human-key': adminPin },
    payload: { repo: 'acme/ui', path: '/etc/never-stored.env' },
  })
  assert.equal(res.statusCode, 401, res.body)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('the key never reaches the server log, for a good or a bad header', async () => {
  await get('/api/items', { [TEST_ENV_LOGIN_HEADER]: KEY })
  await get('/api/items', { [TEST_ENV_LOGIN_HEADER]: `${KEY}-wrong` })
  assert.ok(logLines.length > 0, 'the capturing logger saw the requests')
  assert.ok(logLines.every((line) => !line.includes(KEY)), 'no log line holds the key')
})
