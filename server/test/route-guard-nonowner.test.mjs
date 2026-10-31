// HZ-655: the route guard, through the real app. A signed-in non-owner gets
// 404 — never 403 — on an `owner` route and on a member:item route whose id is
// unknown or belongs to a project they are not in. The owner check reads
// user.role, not the ADMIN_EMAILS allowlist. A resolver that throws fails
// closed: 404, never the handler's output.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-route-guard-')), 'test.db')
process.env.ADMIN_EMAILS = 'listed-admin@example.com'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')

const otherProject = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Other Guarded', 1)").run().lastInsertRowid)
db.prepare(
  `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, project_id)
   VALUES ('OTH-1', 'Another project''s item', 'Medium', '', '', '', 0, ?)`,
).run(otherProject)

const member = loginFixtureUser(auth, config, { email: 'no-memberships@example.com', role: 'member' })
// On ADMIN_EMAILS, yet role 'member': the allowlist does not make an owner.
const listedMember = loginFixtureUser(auth, config, { email: 'listed-admin@example.com', role: 'member' })
// Not on any allowlist, yet role 'owner'.
const unlistedOwner = loginFixtureUser(auth, config, { email: 'unlisted-owner@example.com', role: 'owner' })
assert.equal(auth.isAdmin(listedMember.user), true)
assert.equal(auth.isAdmin(unlistedOwner.user), false)

function withProbe(app) {
  app.get('/api/zz-probe/:id', { config: { scope: 'member:item' } }, () => ({ handler: 'ran' }))
  return app
}
const app = withProbe(buildApp({ logger: false }))
const throwingApp = withProbe(
  buildApp({
    logger: false,
    resolveProject() {
      throw new Error('resolver exploded')
    },
  }),
)
const statuses = []
async function call(target, method, url, who) {
  const res = await target.inject({ method, url, headers: { cookie: who.cookie } })
  statuses.push(res.statusCode)
  return res
}
after(async () => {
  await app.close()
  await throwingApp.close()
})

test('a non-owner with no memberships gets 404 on an owner route, GET and HEAD', async () => {
  const res = await call(app, 'GET', '/api/admin/deploy-targets', member)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
  assert.equal((await call(app, 'HEAD', '/api/admin/deploy-targets', member)).statusCode, 404)
})

test('a non-owner gets 404 on a member:item route for an unknown id and for another project’s real id', async () => {
  for (const id of ['NOPE-999', 'OTH-1']) {
    const res = await call(app, 'GET', `/api/zz-probe/${id}`, member)
    assert.equal(res.statusCode, 404, id)
    assert.deepEqual(res.json(), { error: 'not_found' }, id)
  }
})

test('the owner check reads user.role: an unlisted owner gets 200, an ADMIN_EMAILS member gets 404', async () => {
  assert.equal((await call(app, 'GET', '/api/admin/deploy-targets', unlistedOwner)).statusCode, 200)
  assert.equal((await call(app, 'GET', '/api/zz-probe/OTH-1', unlistedOwner)).statusCode, 200)
  assert.equal((await call(app, 'GET', '/api/admin/deploy-targets', listedMember)).statusCode, 404)
})

test('a resolver that throws fails closed with 404 and the handler never runs', async () => {
  const res = await call(throwingApp, 'GET', '/api/zz-probe/OTH-1', member)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('no response in this file is a 403', () => {
  assert.ok(statuses.length >= 8)
  assert.ok(!statuses.includes(403), `statuses: ${statuses.join(',')}`)
})
