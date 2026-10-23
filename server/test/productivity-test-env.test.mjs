// HZ-549: requireHumanSession() lets the screenshot capture's test-env login
// (HZ-511) read GET /api/admin/productivity on a hooks-on server, while
// requireSession() still refuses it on the token routes. Hooks off is in
// productivity-route.test.mjs; its own file because config.js reads the flag at
// import.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'hz549-screenshot-k3y'
const scratch = mkdtempSync(join(tmpdir(), 'horizon-productivity-test-env-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
process.env.HORIZON_TEST_HOOKS = '1'
process.env.SCREENSHOT_LOGIN_KEY = KEY
delete process.env.FARM_URL

const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { TEST_ENV_LOGIN_HEADER } = await import('../src/testEnvLogin.js')

store.purgeDemoItems()
auth.createUser({ email: config.ADMIN_EMAIL, name: 'Admin', authMethod: 'password' })
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const testEnv = { [TEST_ENV_LOGIN_HEADER]: KEY }

test('hooks on: the screenshot login header gets 200 on the productivity report', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/productivity?range=30d', headers: testEnv })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().range, '30d')
  assert.equal(res.json().summary.closed, 319)
})

test('hooks on: the same header still gets 403 session_required on /api/tokens', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/tokens', headers: testEnv })
  assert.equal(res.statusCode, 403, res.body)
  assert.deepEqual(res.json(), { error: 'session_required' })
})
