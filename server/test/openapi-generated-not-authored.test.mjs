// HZ-178 success metric 2: "The spec is generated at server start from the
// registered routes, never hand-written or checked in. A test registers a
// throwaway route and asserts it appears in the generated spec without any other
// edit."
//
// That throwaway route is the whole point of this file. It is registered here,
// in the test, on an app built by the same buildApp() production uses — no entry
// is added to app.js, to openapi.js, or to any document. If it turns up in the
// generated spec complete with its parameters, body and response, then the spec
// is being read off the route table rather than off an authored list.
//
// The converse leg scans the repo for a checked-in OpenAPI document, because
// "generated" is only half the metric: a build step that wrote one to disk would
// satisfy the throwaway-route leg and still break the item.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoFiles, relative, MIN_EXPECTED_FILES } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-openapi-generated-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')

// A second app, so the probe route cannot leak into any other test's spec.
const app = buildApp({ logger: false })

const PROBE_PATH = '/api/hz178-probe/:probeId'
app.post(
  PROBE_PATH,
  {
    schema: {
      params: { type: 'object', required: ['probeId'], properties: { probeId: { type: 'string' } } },
      querystring: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
      body: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 10 } } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  },
  () => ({ ok: true }),
)

await app.ready()
const spec = app.swagger()
const probe = spec.paths['/api/hz178-probe/{probeId}']?.post

test('a route registered only by this test appears in the generated spec', () => {
  assert.ok(
    probe,
    `the probe route is absent from the generated document. Paths present: ${Object.keys(spec.paths).join(', ')}`,
  )
})

test('the probe arrives with its path parameter, query parameter, body and response', () => {
  const where = Object.fromEntries((probe.parameters || []).map((p) => [p.name, p.in]))
  assert.deepEqual(where, { probeId: 'path', dryRun: 'query' })
  assert.equal(probe.parameters.find((p) => p.name === 'probeId').required, true)
  assert.equal(probe.requestBody.content['application/json'].schema.properties.note.maxLength, 10)
  assert.ok(probe.responses['200'].content['application/json'].schema)
})

test('the probe also picked up the session cookie, from the same hook the real routes use', () => {
  // The probe is a /api/ route outside SESSION_EXEMPT, so the onRoute hook in
  // buildApp() should have declared the cookie on it without the test asking —
  // as an alternative to a bearer token since HZ-179.
  assert.deepEqual(probe.security, [{ sessionCookie: [] }, { bearerToken: [] }])
})

test('the probe is absent from the spec of an app that never registered it', () => {
  // Control for the assertion above: it must be this app's route table that put
  // the probe in this app's document, not something global or cached.
  const other = buildApp({ logger: false })
  // buildApp() returns pre-ready; swagger() needs ready(), so assert on the
  // route table instead — same question, no second boot.
  assert.equal(other.hasRoute({ method: 'POST', url: PROBE_PATH }), false)
  assert.equal(app.hasRoute({ method: 'POST', url: PROBE_PATH }), true)
})

// The one openapi-shaped file in the tree: the vendored OAS 3.1 META-schema the
// validity test checks the real document against. Named here rather than
// pattern-excluded, and the test below proves it is a meta-schema (it describes
// OpenAPI documents) rather than an OpenAPI document of Horizon's own.
const VENDORED_META_SCHEMA = 'server/test/fixtures/openapi-3.1-schema.json'

test('no OpenAPI document is checked into the repo', () => {
  const files = repoFiles()
  assert.ok(files.length >= MIN_EXPECTED_FILES, `the repo walk found only ${files.length} files — it is scoped wrong`)
  const candidates = files
    .map((f) => relative(f))
    .filter((rel) => /(^|\/)(openapi|swagger)[-.]?[^/]*\.(json|ya?ml)$/i.test(rel))
  // Non-vacuous: the walk and the pattern do find the one file that exists.
  assert.ok(candidates.includes(VENDORED_META_SCHEMA), `the scan missed ${VENDORED_META_SCHEMA} — the pattern is wrong`)
  const offenders = candidates.filter((rel) => rel !== VENDORED_META_SCHEMA)
  assert.deepEqual(
    offenders,
    [],
    `these look like checked-in API documents: ${offenders.join(', ')}. The spec is served from memory, never written.`,
  )
})

test('the one file the scan allows is a meta-schema, not a Horizon spec', async () => {
  const { readFileSync } = await import('node:fs')
  const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, VENDORED_META_SCHEMA), 'utf8'))
  assert.equal(doc.$id, 'https://spec.openapis.org/oas/3.1/schema/2022-10-07', 'provenance: see fixtures/README.md')
  assert.equal(doc.openapi, undefined, 'it declares an `openapi` version — that makes it a document, not a schema')
  assert.equal(doc.paths, undefined, 'it has `paths` — that makes it a document, not a schema')
  assert.ok(doc.$defs?.schema, 'a 3.1 meta-schema defines $defs.schema')
})
