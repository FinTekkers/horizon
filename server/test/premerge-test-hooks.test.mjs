// HZ-924: the e2e-only premerge hold routes, with HORIZON_TEST_HOOKS=1, as the
// owner. 21-gate-in-flight.spec.js holds an item's pre-merge result through
// them instead of sleeping; the hold itself is in premerge.test.mjs.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-premerge-test-hooks-')), 'test.db')
process.env.HORIZON_TEST_HOOKS = '1'
delete process.env.FARM_URL

const store = await import('../src/store.js')
const premerge = await import('../src/premerge.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

assert.equal(config.TEST_HOOKS_ENABLED, true)

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers: { 'x-human-key': pin, cookie } })
await app.ready()
after(async () => {
  premerge.releaseForTest('X-1')
  await app.close()
})

test('premerge-hold sets a hold; premerge-release frees it once, then says there was none', async () => {
  const held = await post('/api/test/premerge-hold', { itemId: 'X-1' })
  assert.equal(held.statusCode, 200, held.body)
  assert.deepEqual(held.json(), { ok: true })
  assert.equal(premerge.testHolds.has('X-1'), true)

  const first = await post('/api/test/premerge-release', { itemId: 'X-1' })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(first.json(), { ok: true, released: true })
  assert.equal(premerge.testHolds.has('X-1'), false)

  const second = await post('/api/test/premerge-release', { itemId: 'X-1' })
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(second.json(), { ok: true, released: false })
})

test('both routes refuse a missing, empty or non-string itemId with 400', async () => {
  for (const url of ['/api/test/premerge-hold', '/api/test/premerge-release']) {
    for (const payload of [{}, { itemId: '' }, { itemId: 7 }, { itemId: ['X-1'] }]) {
      const res = await post(url, payload)
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}: ${res.body}`)
      assert.deepEqual(res.json(), { error: 'itemId must be a string' })
    }
  }
  assert.equal(premerge.testHolds.size, 0)
})
