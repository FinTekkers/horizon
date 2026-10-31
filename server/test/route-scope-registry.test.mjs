// HZ-655: every route declares config.scope. A route without one, with an
// unknown one, or with one of the wrong class for its URL makes the
// fastify.get() that registers it throw — so buildApp(), and with it the
// server's boot, fails naming the route. Built with HORIZON_TEST_HOOKS=1, as
// the e2e server is, so the /api/test/* routes are checked too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-route-scopes-')), 'test.db')
process.env.HORIZON_TEST_HOOKS = '1'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp, SESSION_EXEMPT } = await import('../src/app.js')
const { USER_SCOPES, EXEMPT_SCOPES } = await import('../src/access.js')

test('a route registered with no config.scope throws at registration, naming the route', async () => {
  const app = buildApp({ logger: false })
  assert.throws(() => app.get('/api/zz-unscoped', () => ({ ok: true })), /route scope missing: GET \/api\/zz-unscoped/)
  await app.close()
})

test('a user route labelled with an exempt scope, or an unknown scope, throws naming the route', async () => {
  const app = buildApp({ logger: false })
  assert.throws(
    () => app.get('/api/zz-public', { config: { scope: 'public' } }, () => ({ ok: true })),
    /route scope mismatch: public on GET \/api\/zz-public/,
  )
  assert.throws(
    () => app.post('/api/farm/zz-owner', { config: { scope: 'owner' } }, () => ({ ok: true })),
    /route scope mismatch: owner on POST \/api\/farm\/zz-owner/,
  )
  assert.throws(
    () => app.get('/api/zz-admin', { config: { scope: 'admin' } }, () => ({ ok: true })),
    /route scope invalid: 'admin' on GET \/api\/zz-admin/,
  )
  await app.close()
})

test('with test hooks on, the app boots and every route, /api/test/* and HEAD included, has a legal scope', async () => {
  const app = buildApp({ logger: false })
  await app.ready()
  const routes = app.routeScopes()
  const legal = new Set([...USER_SCOPES, ...EXEMPT_SCOPES])
  for (const route of routes) assert.ok(legal.has(route.scope), `${route.method} ${route.url}: ${route.scope}`)

  for (const url of ['/api/test/run-state', '/api/test/conflict-reply', '/api/test/github-pr', '/api/test/screenshot-snapshot']) {
    assert.deepEqual(
      routes.filter((r) => r.url === url),
      [{ method: 'POST', url, scope: 'test' }],
    )
  }

  // Fastify's automatic HEAD routes carry their GET route's scope.
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.url}`, r.scope]))
  const heads = routes.filter((r) => r.method === 'HEAD')
  assert.ok(heads.length > 0)
  for (const head of heads) assert.equal(head.scope, byKey.get(`GET ${head.url}`), head.url)

  // The session-exempt credential routes keep exempt scopes; the rest are user scopes.
  const exempt = (url) => SESSION_EXEMPT.some((re) => re.test(url.replace(/:[^/]+/g, '0')))
  for (const route of routes) assert.equal(EXEMPT_SCOPES.includes(route.scope), exempt(route.url), route.url)
  assert.equal(byKey.get('GET /api/health'), 'public')
  assert.equal(byKey.get('POST /api/webhooks/github'), 'hmac')
  assert.equal(byKey.get('POST /api/billing/stripe-webhook'), 'hmac')
  assert.equal(byKey.get('POST /api/wa/poll-vote'), 'wa')
  assert.equal(byKey.get('GET /api/farm/snapshot'), 'farm')
  // HZ-656: the board and its feeds are per user.
  assert.equal(byKey.get('GET /api/items'), 'filtered')
  assert.equal(byKey.get('GET /api/stream'), 'filtered')
  assert.equal(byKey.get('GET /api/items/:id/stream'), 'member:item')

  // HZ-657: the item and run reads are member-scoped; the writes beside them are not.
  for (const url of [
    '/api/items/:id/artifacts/:stepIndex',
    '/api/items/:id/artifacts/:stepIndex/:attempt',
    '/api/items/:id/steps/:stepIndex/output',
    '/api/items/:id/job',
    '/api/items/:id/job/log',
    '/api/items/:id/plan-draft',
    '/api/items/:id/screenshots',
    '/api/items/:id/screenshots/:screen/:kind',
  ]) {
    assert.equal(byKey.get(`GET ${url}`), 'member:item', url)
  }
  assert.equal(byKey.get('GET /api/runs/:runId/log'), 'member:run')
  assert.equal(byKey.get('GET /api/runs/:runId/log/view'), 'member:run')
  assert.equal(byKey.get('PUT /api/items/:id/plan-draft'), 'owner')
  assert.equal(byKey.get('POST /api/items/:id/screenshots/approve'), 'owner')
  assert.equal(byKey.get('POST /api/items/:id/job/stop'), 'owner')
  assert.equal(byKey.get('POST /api/items/:id/job/resume'), 'owner')
  await app.close()
})
