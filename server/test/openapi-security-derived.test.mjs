// HZ-178 success metric 4: "The spec declares the cookie session
// (securitySchemes) on every route that needs it, and documents the x-human-key
// header on gate routes (approve, reject, resolve-conflicts)."
//
// DERIVED from the two things that decide the answer in the running server:
//
//   the cookie — from app.js's own exported SESSION_EXEMPT, the very list the
//     onRequest login gate tests each request against. A hand-copied second list
//     here is exactly the drift this item exists to remove.
//   the PIN    — from the humanAuthorized() CALL SITES in app.js's source. The
//     metric names three routes; the code has six. Counting the call sites means
//     a seventh gate added without documenting its header fails this file.
//
// Both legs run in both directions. Asserting the cookie is declared where it is
// needed is half a test; the other half is asserting it is ABSENT from the routes
// that genuinely take no session, because a hook that declared it unconditionally
// would pass the first half and publish a lie.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-openapi-security-')), 'test.db')
process.env.HORIZON_TEST_HOOKS = '1'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp, SESSION_EXEMPT } = await import('../src/app.js')
const { isInternal } = await import('../src/openapi.js')

const registered = []
const app = buildApp({ logger: false, onRoute: (routeOptions) => registered.push(routeOptions) })
await app.ready()
const spec = app.swagger()

const PUBLIC_ROUTES = registered
  .filter(({ url, method }) => url.startsWith('/api/') && method !== 'HEAD' && !isInternal(url))
  .map(({ method, url }) => ({ method, url, label: `${method} ${url}` }))

function operationFor({ method, url }) {
  return spec.paths[url.replace(/:([^/]+)/g, '{$1}')]?.[method.toLowerCase()]
}

function schemesOn(route) {
  // One flat set of scheme names across every requirement object in `security`.
  return new Set((operationFor(route)?.security || []).flatMap((requirement) => Object.keys(requirement)))
}

// A registered route url is exempt if the login gate would let it through. The
// gate matches request paths, and SESSION_EXEMPT's gate-approval entry uses
// \d+ for the step index, so the route form (:stepIndex) is substituted with a
// digit before testing — same path the server sees at request time.
function gateWouldExempt(url) {
  const asRequested = url.replace(/:stepIndex/g, '0').replace(/:([^/]+)/g, 'x')
  return SESSION_EXEMPT.some((re) => re.test(asRequested))
}

const EXEMPT = PUBLIC_ROUTES.filter((r) => gateWouldExempt(r.url))
const GATED = PUBLIC_ROUTES.filter((r) => !gateWouldExempt(r.url))

test('the derivation produced two non-empty groups to check', () => {
  assert.ok(SESSION_EXEMPT.length >= 8, `SESSION_EXEMPT has only ${SESSION_EXEMPT.length} entries`)
  assert.ok(GATED.length >= 25, `only ${GATED.length} session-gated public routes — the exempt filter is too wide`)
  assert.ok(EXEMPT.length >= 6, `only ${EXEMPT.length} exempt public routes — the filter is too narrow`)
})

test('every session-gated public route declares the cookie scheme', () => {
  const missing = GATED.filter((r) => !schemesOn(r).has('sessionCookie')).map((r) => r.label)
  assert.deepEqual(missing, [], `these routes need a session but do not declare sessionCookie: ${missing.join(', ')}`)
})

test('the cookie scheme is absent from the routes that really take no session', async () => {
  // /api/auth/me and the gate-PIN regeneration route are exempt from the gate but
  // check the session themselves and 401 without one, so they do declare the
  // cookie. Every other exempt route must not — and each is checked here by
  // actually calling it with no cookie and seeing a non-401.
  const SELF_CHECKING = new Set(['GET /api/auth/me', 'POST /api/auth/gate-pin/regenerate'])
  const wrong = []
  for (const route of EXEMPT) {
    const declares = schemesOn(route).has('sessionCookie')
    if (SELF_CHECKING.has(route.label)) {
      if (!declares) wrong.push(`${route.label}: 401s without a session but declares no sessionCookie`)
      const res = await app.inject({ method: route.method, url: route.url.replace(/:([^/]+)/g, '1') })
      assert.equal(res.statusCode, 401, `${route.label} no longer 401s without a session — move it out of SELF_CHECKING`)
      continue
    }
    if (declares) wrong.push(`${route.label}: takes no session but the document says it needs the cookie`)
  }
  assert.deepEqual(wrong, [], wrong.join('\n'))
})

test('/api/openapi.json and /api/health are documented as needing nothing', () => {
  for (const path of ['/api/openapi.json', '/api/health']) {
    assert.deepEqual(
      schemesOn({ method: 'GET', url: path }),
      new Set(),
      `${path} is the unauthenticated probe pair — the document must not claim it needs a credential`,
    )
  }
})

// ---- the human gate PIN ----

const APP_SOURCE = readFileSync(join(REPO_ROOT, 'server/src/app.js'), 'utf8')

// Anchored on the CALL form. A bare count of "humanAuthorized(request, reply)"
// returns one more than the number of gates, because the function's own
// declaration matches the same text. HZ-384: the approve route keeps the
// proof it returns, then makes the same check on it.
const HUMAN_GATE_CALL_SITES =
  APP_SOURCE.match(
    /if \(!humanAuthorized\(request, reply\)\) return|const proof = humanAuthorized\(request, reply\)\n\s*if \(!proof\) return/g,
  ) || []

test('the call-site count is a real count, and excludes the declaration', () => {
  assert.ok(HUMAN_GATE_CALL_SITES.length >= 3, `found ${HUMAN_GATE_CALL_SITES.length} humanAuthorized call sites`)
  assert.match(APP_SOURCE, /function humanAuthorized\(request, reply\) \{/, 'the declaration moved — re-anchor this scan')
  assert.equal(
    (APP_SOURCE.match(/humanAuthorized\(request, reply\)/g) || []).length,
    HUMAN_GATE_CALL_SITES.length + 1,
    'the call form and the bare form should differ by exactly the one declaration',
  )
})

test('exactly as many operations declare the PIN header as there are gates in the code', () => {
  const declaring = PUBLIC_ROUTES.filter((r) => schemesOn(r).has('humanGateKey')).map((r) => r.label)
  assert.equal(
    declaring.length,
    HUMAN_GATE_CALL_SITES.length,
    `app.js calls humanAuthorized at ${HUMAN_GATE_CALL_SITES.length} routes but ${declaring.length} operations ` +
      `declare humanGateKey:\n  ${declaring.join('\n  ')}\n` +
      'A new human-gated route must document the x-human-key header it enforces.',
  )
})

test('the three routes the metric names by hand are among them', () => {
  // The metric lists approve, reject and resolve-conflicts. The count above is
  // the real gate; this pins the named three so a refactor cannot satisfy the
  // count while losing one of them.
  for (const url of [
    '/api/items/:id/gates/:stepIndex/approve',
    '/api/items/:id/reject',
    '/api/items/:id/resolve-conflicts',
  ]) {
    const schemes = schemesOn({ method: 'POST', url })
    assert.ok(schemes.has('humanGateKey'), `${url} does not document the x-human-key header`)
    assert.ok(schemes.has('sessionCookie'), `${url} needs a session as well as the PIN`)
  }
})

test('the PIN header is declared alongside the cookie, never instead of it', () => {
  // One requirement object listing both schemes means "send both". Two objects
  // would mean "either one will do", which is not what humanAuthorized does — it
  // runs after the session gate has already passed.
  for (const route of PUBLIC_ROUTES.filter((r) => schemesOn(r).has('humanGateKey'))) {
    const security = operationFor(route).security
    assert.equal(security.length, 1, `${route.label} offers alternative credentials; the PIN is an additional one`)
    assert.deepEqual(Object.keys(security[0]).sort(), ['humanGateKey', 'sessionCookie'])
  }
})

test('every scheme a route names is actually defined in components', () => {
  const defined = new Set(Object.keys(spec.components?.securitySchemes || {}))
  const dangling = new Set()
  for (const route of PUBLIC_ROUTES) {
    for (const scheme of schemesOn(route)) if (!defined.has(scheme)) dangling.add(`${route.label}: ${scheme}`)
  }
  assert.deepEqual([...dangling], [], 'a route references a security scheme the document never defines')
  assert.ok(defined.size >= 2, `only ${defined.size} schemes defined`)
})

// ---- the bearer token (HZ-179) ----
// "The OpenAPI spec declares the bearer scheme alongside the cookie scheme, and
// documents the token management routes." A token is an ALTERNATIVE to the
// cookie on ordinary routes, and absent from the two kinds of route that refuse
// it: gates (humanAuthorized) and token management (requireSession). The latter
// is derived from requireSession() call sites the same way the PIN leg above is.

const SESSION_ONLY_CALL_SITES = APP_SOURCE.match(/if \(!requireSession\(request, reply\)\) return/g) || []

test('the bearer scheme is defined as an http bearer scheme', () => {
  const scheme = spec.components.securitySchemes.bearerToken
  assert.ok(scheme, 'components.securitySchemes has no bearerToken')
  assert.equal(scheme.type, 'http')
  assert.equal(scheme.scheme, 'bearer')
})

test('an ordinary route accepts the cookie OR a bearer token', () => {
  assert.deepEqual(operationFor({ method: 'GET', url: '/api/items' }).security, [{ sessionCookie: [] }, { bearerToken: [] }])
})

test('the token management routes are documented, cookie only', () => {
  for (const route of [
    { method: 'GET', url: '/api/tokens' },
    { method: 'POST', url: '/api/tokens' },
    { method: 'DELETE', url: '/api/tokens/:id' },
  ]) {
    assert.ok(operationFor(route), `${route.method} ${route.url} is missing from the spec`)
    assert.deepEqual(operationFor(route).security, [{ sessionCookie: [] }], `${route.method} ${route.url} must not offer bearerToken`)
  }
})

test('no gate route offers the bearer token', () => {
  const offending = PUBLIC_ROUTES.filter((r) => schemesOn(r).has('humanGateKey') && schemesOn(r).has('bearerToken'))
  assert.deepEqual(offending.map((r) => r.label), [])
  for (const url of ['/api/items/:id/gates/:stepIndex/approve', '/api/items/:id/reject', '/api/items/:id/resolve-conflicts']) {
    assert.equal(schemesOn({ method: 'POST', url }).has('bearerToken'), false, `${url} documents bearerToken`)
  }
})

test('every gated route offers bearer except exactly the requireSession and gate routes', () => {
  assert.match(APP_SOURCE, /function requireSession\(request, reply\) \{/, 'the declaration moved — re-anchor this scan')
  assert.ok(SESSION_ONLY_CALL_SITES.length >= 3, `found ${SESSION_ONLY_CALL_SITES.length} requireSession call sites`)
  const cookieOnly = GATED.filter((r) => !schemesOn(r).has('bearerToken'))
  const pinRoutes = cookieOnly.filter((r) => schemesOn(r).has('humanGateKey'))
  const sessionOnly = cookieOnly.filter((r) => !schemesOn(r).has('humanGateKey'))
  assert.equal(pinRoutes.length, HUMAN_GATE_CALL_SITES.length)
  assert.equal(
    sessionOnly.length,
    SESSION_ONLY_CALL_SITES.length,
    `app.js calls requireSession at ${SESSION_ONLY_CALL_SITES.length} routes but ${sessionOnly.length} gated ` +
      `operations refuse bearer without a PIN:\n  ${sessionOnly.map((r) => r.label).join('\n  ')}`,
  )
})
