// HZ-924: a server without HORIZON_TEST_HOOKS=1 (production) has no premerge
// hold routes at all — 404 even for the owner, so the session gate can't be
// what refuses them. Its own file because config.js reads the flag at import.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-premerge-test-hooks-off-')), 'test.db')
delete process.env.HORIZON_TEST_HOOKS
delete process.env.FARM_URL

const store = await import('../src/store.js')
const premerge = await import('../src/premerge.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

assert.equal(config.TEST_HOOKS_ENABLED, false)

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()
after(() => app.close())

test('hooks off: premerge-hold and premerge-release do not exist, even for the owner', async () => {
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200, `the owner session works: ${me.body}`)
  for (const url of ['/api/test/premerge-hold', '/api/test/premerge-release']) {
    const res = await app.inject({ method: 'POST', url, payload: { itemId: 'X-1' }, headers: { 'x-human-key': pin, cookie } })
    assert.equal(res.statusCode, 404, `${url}: ${res.body}`)
    assert.equal(app.routeScopes().some((r) => r.url === url), false, url)
  }
  assert.equal(premerge.testHolds.size, 0)
})
