// HZ-178 success metric 3, and the item's "CI fails if a public route is
// undocumented" gate:
//
//   "Every public route (all /api/* except /api/farm/*, /api/test/*,
//    /api/webhooks/* and /api/wa/*) appears in the spec with its path and query
//    parameters, its request body schema, and a response schema for its success
//    status. A test enumerates the registered routes and fails, naming the
//    route, for any public route missing a response schema."
//
// DERIVED, in the house style of api-field-limits-derived.test.mjs: the route
// list comes from an onRoute collector on a real buildApp(), not from a list
// anyone maintains here, so a route added to app.js tomorrow is checked tomorrow
// with no edit to this file. The internal/public split comes from
// openapi.js's INTERNAL_PREFIXES — the same list the `hide` transform uses, so
// this gate and the published document can never disagree about what is private.
//
// There is no CI workflow in this repo (.github/workflows/ holds only the deploy
// hook). "CI fails" means this file: it runs under `npm --prefix server test`,
// which root `npm test` runs, which farm/checks.py runs at the guardrail gate.
//
// Every assertion here has a non-vacuity guard. A filter bug that empties the
// public-route list would otherwise make this gate green forever, which is worse
// than not having it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-openapi-coverage-')), 'test.db')
process.env.HORIZON_TEST_HOOKS = '1' // so the /api/test/* routes exist to be excluded
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { isInternal, INTERNAL_PREFIXES } = await import('../src/openapi.js')

// Every registration app.js makes, with the schema it authored, collected
// through buildApp's onRoute seam — see the comment on buildApp for why a hook
// added from out here would fire for nothing.
const registered = []
const app = buildApp({ logger: false, onRoute: (routeOptions) => registered.push(routeOptions) })
await app.ready()

const ROUTES = registered
  .filter(({ url }) => url.startsWith('/api/'))
  // HEAD is auto-registered alongside every GET and is not part of the published
  // surface; @fastify/swagger skips it for the same reason.
  .filter(({ method }) => method !== 'HEAD')
  .map(({ method, url, schema }) => ({ method, url, schema }))

const PUBLIC_ROUTES = ROUTES.filter(({ url }) => !isInternal(url))
const INTERNAL_ROUTES = ROUTES.filter(({ url }) => isInternal(url))

const spec = app.swagger()

// A Fastify route url (/api/items/:id) as the spec writes it (/api/items/{id}).
function specPath(url) {
  return url.replace(/:([^/]+)/g, '{$1}')
}

function operationFor({ method, url }) {
  return spec.paths[specPath(url)]?.[method.toLowerCase()]
}

test('the route collector found a real route table — nothing below is vacuous', () => {
  assert.ok(ROUTES.length >= 40, `only ${ROUTES.length} /api/ routes collected; app.js registers far more`)
  assert.ok(PUBLIC_ROUTES.length >= 30, `only ${PUBLIC_ROUTES.length} public routes — the isInternal filter is too wide`)
  assert.ok(INTERNAL_ROUTES.length >= 4, `only ${INTERNAL_ROUTES.length} internal routes — the filter is too narrow`)
  assert.ok(INTERNAL_PREFIXES.length >= 4, 'INTERNAL_PREFIXES lost entries')
})

test('every public route appears in the spec under its own path and method', () => {
  const missing = PUBLIC_ROUTES.filter((r) => !operationFor(r)).map((r) => `${r.method} ${r.url}`)
  assert.deepEqual(missing, [], `these public routes are absent from the generated document: ${missing.join(', ')}`)
})

test('the document holds exactly as many operations as there are public routes', () => {
  // The two directions above, stated once as an equality: nothing public is
  // missing AND nothing extra is published. 39 of each today, but asserted
  // against the derived count rather than that number.
  const operations = Object.values(spec.paths).reduce((n, pathItem) => n + Object.keys(pathItem).length, 0)
  assert.equal(
    operations,
    PUBLIC_ROUTES.length,
    `the document publishes ${operations} operations for ${PUBLIC_ROUTES.length} public routes`,
  )
})

test('every public route documents a success response with a schema', () => {
  // "Success status" is read off the document rather than guessed: an operation
  // passes if it declares a 2xx or 3xx response. Any declared 2xx must carry a
  // content schema; a 3xx may legitimately have no body (see the redirects
  // below), which is why those two are named rather than pattern-excluded.
  const BODYLESS_REDIRECTS = new Set(['GET /api/auth/google/start', 'GET /api/auth/google/callback'])
  const failures = []
  for (const route of PUBLIC_ROUTES) {
    const label = `${route.method} ${route.url}`
    const responses = operationFor(route)?.responses || {}
    const successes = Object.keys(responses).filter((code) => /^[23]\d\d$/.test(code))
    if (successes.length === 0) {
      failures.push(`${label}: declares no 2xx or 3xx response at all`)
      continue
    }
    for (const code of successes) {
      const hasSchema = Object.values(responses[code].content || {}).some((media) => media.schema)
      if (hasSchema) continue
      if (code.startsWith('3') && BODYLESS_REDIRECTS.has(label)) continue
      failures.push(`${label}: response ${code} has no content schema`)
    }
  }
  assert.deepEqual(failures, [], `undocumented success responses:\n  ${failures.join('\n  ')}`)
})

test('the two bodyless-redirect exceptions are real routes that really send no body', async () => {
  // Otherwise the allowance above could outlive the routes it was written for.
  for (const url of ['/api/auth/google/start', '/api/auth/google/callback']) {
    assert.ok(PUBLIC_ROUTES.some((r) => r.url === url), `${url} is gone — drop it from BODYLESS_REDIRECTS`)
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 302, `${url} no longer redirects`)
    assert.equal(res.body, '', `${url} now sends a body, so its 302 needs a documented schema`)
  }
})

test('every path and query parameter a public route declares appears in the spec', () => {
  const failures = []
  let pathChecked = 0
  let queryChecked = 0
  for (const route of PUBLIC_ROUTES) {
    const declared = Object.fromEntries((operationFor(route)?.parameters || []).map((p) => [p.name, p.in]))
    const schema = registeredSchemaFor(route)
    for (const [source, where] of [
      ['params', 'path'],
      ['querystring', 'query'],
    ]) {
      for (const name of Object.keys(schema?.[source]?.properties || {})) {
        if (where === 'query') queryChecked += 1
        if (declared[name] === where) continue
        failures.push(`${route.method} ${route.url}: ${where} parameter "${name}" is ${declared[name] ?? 'absent'} in the spec`)
      }
    }
    // Every :param in the url must be documented too, whether or not the route
    // declared a `params` schema for it. This leg needs no authored schema at
    // all, so it still holds if the collector above ever comes back empty.
    for (const name of (route.url.match(/:([^/]+)/g) || []).map((m) => m.slice(1))) {
      pathChecked += 1
      if (declared[name] === 'path') continue
      failures.push(`${route.method} ${route.url}: path parameter "${name}" is ${declared[name] ?? 'absent'} in the spec`)
    }
  }
  assert.ok(pathChecked >= 10, `only ${pathChecked} path parameters checked — the url scan is broken`)
  assert.ok(queryChecked >= 5, `only ${queryChecked} query parameters checked — the schema collector is empty`)
  assert.deepEqual(failures, [], `parameters missing from the document:\n  ${failures.join('\n  ')}`)
})

test('every public route that declares a request body publishes a requestBody', () => {
  const failures = []
  let checked = 0
  for (const route of PUBLIC_ROUTES) {
    if (!registeredSchemaFor(route)?.body) continue
    checked += 1
    const body = operationFor(route)?.requestBody
    if (!body?.content?.['application/json']?.schema) failures.push(`${route.method} ${route.url}`)
  }
  assert.ok(checked >= 10, `only ${checked} routes declare a body schema — the lookup is broken`)
  assert.deepEqual(failures, [], `these routes declare a body but publish no requestBody: ${failures.join(', ')}`)
})

test('the spec uses OpenAPI {param} paths, never Fastify :param paths', () => {
  // The other way both derived gates above go silently vacuous: if the
  // :param → {param} mapping were wrong, every lookup would miss and the
  // "missing" lists would be... not empty, so this is really a guard on the
  // document itself being well-formed for its readers.
  const colons = Object.keys(spec.paths).filter((p) => p.includes(':'))
  assert.deepEqual(colons, [], `these spec paths carry Fastify parameter syntax: ${colons.join(', ')}`)
  assert.ok(
    Object.keys(spec.paths).some((p) => p.includes('{')),
    'no spec path has a {param} at all — the mapping produced nothing',
  )
})

test('no internal route appears in the spec', () => {
  const leaked = INTERNAL_ROUTES.filter((r) => operationFor(r)).map((r) => `${r.method} ${r.url}`)
  assert.deepEqual(leaked, [], `these internal routes leaked into the public document: ${leaked.join(', ')}`)
  // And each of the four named prefixes is actually represented in the route
  // table, so "no leak" is a statement about routes that exist.
  for (const prefix of ['/api/farm/', '/api/test/', '/api/webhooks/', '/api/wa/']) {
    assert.ok(
      INTERNAL_ROUTES.some((r) => r.url.startsWith(prefix)),
      `no registered route under ${prefix} — this test is not exercising that exclusion`,
    )
  }
  // The WhatsApp approval bridge is excluded by its own INTERNAL_PREFIXES entry
  // rather than by one of the four prefixes above (it matches none of them).
  const waApproval = ROUTES.find((r) => r.url.endsWith('/approve-via-whatsapp'))
  assert.ok(waApproval, 'the approve-via-whatsapp route is gone — drop its INTERNAL_PREFIXES entry')
  assert.equal(operationFor(waApproval), undefined, 'the credential-gated WhatsApp bridge leg is published')
})

test('the spec documents /api/stream as a text/event-stream', () => {
  // Success metric 5. The behavioural half — that it still streams — is in
  // openapi-no-behaviour-change.test.mjs.
  const stream = spec.paths['/api/stream']?.get
  assert.ok(stream, '/api/stream is missing from the document')
  assert.ok(
    stream.responses['200'].content['text/event-stream']?.schema,
    `/api/stream's 200 is documented as ${Object.keys(stream.responses['200'].content || {}).join(', ')}`,
  )
})

test('the standalone HTML pages and the stylesheet are documented with their real media types', () => {
  const expected = {
    'GET /api/agent-pages.css': 'text/css',
    'GET /api/items/{id}/artifacts/{stepIndex}': 'text/html',
    'GET /api/items/{id}/artifacts/{stepIndex}/{attempt}': 'text/html',
    'GET /api/items/{id}/steps/{stepIndex}/output': 'text/html',
    'GET /api/runs/{runId}/log/view': 'text/html',
  }
  for (const [label, mime] of Object.entries(expected)) {
    const [method, path] = label.split(' ')
    const responses = spec.paths[path]?.[method.toLowerCase()]?.responses
    assert.ok(responses, `${label} is missing from the document`)
    assert.ok(responses['200'].content[mime]?.schema, `${label} does not document ${mime}`)
    assert.equal(
      responses['200'].content['application/json'],
      undefined,
      `${label} is documented as JSON as well as ${mime}`,
    )
  }
})

// The authored schema for a route, as app.js declared it.
function registeredSchemaFor({ method, url }) {
  return ROUTES.find((r) => r.method === method && r.url === url)?.schema
}
