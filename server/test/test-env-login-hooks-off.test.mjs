// HZ-511: a server without HORIZON_TEST_HOOKS=1 (production) ignores the
// screenshot login header, even with SCREENSHOT_LOGIN_KEY in its env. Its own
// file because config.js reads the flag at import.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'hz511-screenshot-k3y'
const scratch = mkdtempSync(join(tmpdir(), 'horizon-test-env-login-off-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.HORIZON_TEST_HOOKS
process.env.SCREENSHOT_LOGIN_KEY = KEY
delete process.env.FARM_URL

const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const { TEST_ENV_LOGIN_HEADER } = await import('../src/testEnvLogin.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

test('hooks off: the correct header is ignored on /api/auth/me and a gated route', async () => {
  for (const url of ['/api/auth/me', '/api/items']) {
    const res = await app.inject({ method: 'GET', url, headers: { [TEST_ENV_LOGIN_HEADER]: KEY } })
    assert.equal(res.statusCode, 401, `${url}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'login_required' })
  }
})
