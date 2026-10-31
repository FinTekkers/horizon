// HZ-656: the owner's board and the concierge's /api/farm/snapshot are pinned
// to payloads captured before per-user feeds existed (on main at 445c194), so
// filtering for members can never change what the owner or the farm gets.
// The clock- and host-dependent keys are pinned (memberBoardSeed.mjs); every
// other byte comes from the fixed seed.
//
// UPDATE_FIXTURE=1 rewrites the fixtures. Only do that on a commit that is
// already known to be right, never to turn this test green.
//
// Its own file because config.js reads the environment at import time.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'
import { pinVolatile, seedMemberBoard } from './helpers/memberBoardSeed.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-owner-fixture-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { setSetting } = await import('../src/settings.js')
const { unlinkedProjectId } = await import('../src/membership.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
seedMemberBoard(db, { setSetting, unlinkedProjectId })
const app = appModule.buildApp({ logger: false })
after(() => app.close())
const { cookie } = loginFixtureUser(auth, config)

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ITEMS_FIXTURE = join(FIXTURES, 'owner-items-snapshot.json')
const FARM_FIXTURE = join(FIXTURES, 'farm-snapshot-enabled.json')

function matchesFixture(path, payload) {
  const pinned = pinVolatile(payload)
  if (process.env.UPDATE_FIXTURE === '1') writeFileSync(path, `${JSON.stringify(pinned, null, 2)}\n`)
  assert.deepEqual(pinned, JSON.parse(readFileSync(path, 'utf8')))
}

// Twice in one process: a key that moves between calls fails the second run.
for (const run of [1, 2]) {
  test(`run ${run}: the owner's GET /api/items?v=2 deep-equals the pre-change fixture`, async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })
    assert.equal(res.statusCode, 200)
    matchesFixture(ITEMS_FIXTURE, res.json())
  })

  test(`run ${run}: /api/farm/snapshot?scope=enabled deep-equals the pre-change fixture`, async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/farm/snapshot?scope=enabled',
      headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    })
    assert.equal(res.statusCode, 200)
    matchesFixture(FARM_FIXTURE, res.json())
  })
}

test('in process, snapshot() deep-equals snapshot({ viewer: null })', () => {
  for (const opts of [{ scope: 'enabled', stepOutputs: false }, { scope: 'enabled' }, { scope: 'active' }]) {
    assert.deepEqual(pinVolatile(appModule.snapshot({ ...opts, viewer: null })), pinVolatile(appModule.snapshot(opts)))
  }
})
