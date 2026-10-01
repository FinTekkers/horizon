// HZ-178 success metric 1: "GET /api/openapi.json returns a valid OpenAPI 3.x
// document (validated in a test with a schema validator). It is reachable
// without a session, like /api/health."
//
// Both halves are asserted here, and the no-session half is the one that needs
// saying twice: every other test in this directory drives the app with a session
// cookie from loginFixtureUser, so a route accidentally left behind the login
// gate would look fine to all of them. The requests below send NO cookie at all.
//
// On the validator: it is the ajv that fastify itself depends on, through
// @fastify/ajv-compiler and fast-json-stringify, and it is imported here WITHOUT
// being declared in server/package.json. That is deliberate. HZ-128's guardrail
// 3 — pinned byte-for-byte in domain-no-drift-scaffolding.test.mjs, which names
// "just add ajv" as the thing it exists to stop — forbids adding a dependency,
// and HZ-178's own guardrail allows exactly one, which went to
// @fastify/swagger. Importing the copy fastify already installs adds no package
// to the tree. The first assertion below fails loudly, naming the fix, if a
// future fastify ever stops bringing it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-openapi-valid-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')

const app = buildApp({ logger: false })
await app.ready()

const require = createRequire(import.meta.url)

test('ajv is still part of the fastify install this test borrows it from', () => {
  const version = require('ajv/package.json').version
  assert.match(
    version,
    /^8\./,
    `ajv is ${version}, not 8.x — this test imports ajv/dist/2020 (2020-12 support, added in ajv 8) from ` +
      'fastify\'s own install. If fastify has dropped or moved past it, either pin the validator here or ' +
      'revisit HZ-128 guardrail 3 in domain-no-drift-scaffolding.test.mjs before declaring a dependency.',
  )
})

// The official OAS 3.1 meta-schema, vendored so this test never touches the
// network. See test/fixtures/README.md for provenance and for why the
// $dynamicRef substitution below is a no-op for what the document is checked
// against.
const META_SCHEMA = JSON.parse(
  readFileSync(new URL('./fixtures/openapi-3.1-schema.json', import.meta.url), 'utf8').replaceAll(
    '"$dynamicRef": "#meta"',
    '"$ref": "#/$defs/schema"',
  ),
)

const { default: Ajv2020 } = await import('ajv/dist/2020.js')
const { default: addFormats } = await import('ajv-formats')

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
const validateOpenapi = ajv.compile(META_SCHEMA)

// No cookie, on purpose — see the header.
const fetchSpec = () => app.inject({ method: 'GET', url: '/api/openapi.json' })

test('GET /api/openapi.json answers 200 with JSON and no session cookie', async () => {
  const res = await fetchSpec()
  assert.equal(res.statusCode, 200, `expected 200 without a session, got ${res.statusCode}: ${res.body.slice(0, 200)}`)
  assert.match(res.headers['content-type'], /application\/json/)
})

test('the session gate really is what the request above skipped', async () => {
  // Positive control: the same app, same absence of a cookie, a route that is
  // NOT exempt. Without this, a broken onRequest hook would make the test above
  // pass for the wrong reason.
  const res = await app.inject({ method: 'GET', url: '/api/items' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('the document validates against the official OpenAPI 3.1 meta-schema', async () => {
  const spec = (await fetchSpec()).json()
  const ok = validateOpenapi(spec)
  assert.ok(
    ok,
    `the generated document is not valid OpenAPI 3.1:\n${JSON.stringify(validateOpenapi.errors?.slice(0, 10), null, 2)}`,
  )
})

test('the meta-schema is actually rejecting things — it is not a rubber stamp', () => {
  // Three ways a document can be wrong, each of which the assertion above would
  // miss if the compiled validator were vacuous.
  assert.equal(validateOpenapi({ info: { title: 'x', version: '1' }, paths: {} }), false, 'no `openapi` version')
  assert.equal(validateOpenapi({ openapi: '2.0', info: { title: 'x', version: '1' }, paths: {} }), false, 'Swagger 2.0')
  assert.equal(validateOpenapi({ openapi: '3.1.0', info: { title: 'x' }, paths: {} }), false, 'info with no version')
})

test('the document declares 3.1.x and names itself', async () => {
  const spec = (await fetchSpec()).json()
  assert.match(spec.openapi, /^3\.\d+\.\d+$/)
  assert.equal(spec.openapi, '3.1.0', 'openapi.js pins this version and fixtures/ holds the matching meta-schema')
  assert.equal(spec.info.title, 'Horizon API')
  assert.ok(spec.info.version, 'the document must carry a version')
})

test('both security schemes are declared, naming the cookie the server actually reads', async () => {
  const spec = (await fetchSpec()).json()
  const schemes = spec.components?.securitySchemes
  assert.ok(schemes, 'components.securitySchemes is missing')
  const config = await import('../src/config.js')
  assert.deepEqual(
    { type: schemes.sessionCookie?.type, in: schemes.sessionCookie?.in, name: schemes.sessionCookie?.name },
    { type: 'apiKey', in: 'cookie', name: config.SESSION_COOKIE_NAME },
    'the cookie scheme must name the cookie config.js defines, not a literal that could drift from it',
  )
  assert.deepEqual(
    { type: schemes.humanGateKey?.type, in: schemes.humanGateKey?.in, name: schemes.humanGateKey?.name },
    { type: 'apiKey', in: 'header', name: 'x-human-key' },
  )
})

test('the document is stable across requests — nothing in the pipeline mutates it', async () => {
  const first = (await fetchSpec()).body
  const second = (await fetchSpec()).body
  assert.equal(first, second, 'two consecutive reads differ, so the transform or the cache is mutating the document')
})

test('the shared response shapes survive being reused across every route', async () => {
  // OK_OBJECT and ERROR_OBJECT are single module-level objects handed to ~39
  // route schemas. Fastify compiles them into serializers and @fastify/swagger
  // resolves them into the document; if either mutated them in place, one route's
  // schema would start leaking into another's. Checked by value, before and after
  // a build, and by two independently-built apps agreeing on the whole document.
  const openapi = await import('../src/openapi.js')
  const shapes = JSON.stringify([openapi.OK_OBJECT, openapi.ERROR_OBJECT])

  const first = buildApp({ logger: false })
  await first.ready()
  const second = buildApp({ logger: false })
  await second.ready()

  assert.equal(JSON.stringify([openapi.OK_OBJECT, openapi.ERROR_OBJECT]), shapes, 'a shared response shape was mutated')
  assert.deepEqual(first.swagger(), second.swagger(), 'two apps built from the same code disagree on the document')
  assert.equal(openapi.OK_OBJECT.additionalProperties, true, 'OK_OBJECT must stay permissive or it starts stripping fields')
  assert.equal(openapi.ERROR_OBJECT.additionalProperties, true)
})

test('no Swagger UI route came along with the plugin', async () => {
  // HZ-178 scopes the UI page out. These are @fastify/swagger-ui's default
  // mount points. hasRoute() rather than inject(), because the login gate
  // answers 401 for anything under /api/ before routing even happens, which
  // would make an injected request look like a miss whether the route exists or
  // not.
  for (const url of ['/documentation', '/documentation/json', '/api/documentation', '/api/docs']) {
    assert.equal(app.hasRoute({ method: 'GET', url }), false, `a route is registered at ${url} — a UI page shipped`)
  }
  // Positive control: hasRoute does find a route that genuinely exists.
  assert.equal(app.hasRoute({ method: 'GET', url: '/api/openapi.json' }), true)
})
