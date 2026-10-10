// HZ-178 guardrails: "No behaviour change. Adding response schemas must not
// change any response body: Fastify strips fields not in a response schema, so
// every new response schema must allow every field the route returns today" and
// "The spec must never contain secrets, tokens, default credentials or example
// values taken from real data."
//
// The existing suite covers the first guardrail for every route it already
// touches, and it does — api-field-limits-derived.test.mjs caught the one real
// stripping bug this item introduced (Fastify answers a validation failure with
// an Error INSTANCE, whose fields are non-enumerable, so `additionalProperties:
// true` alone serialized a 400 as `{}`; see ERROR_OBJECT in src/openapi.js).
//
// What it cannot cover is a route no test calls. These ten public routes gained a
// response schema with no server test hitting them beforehand:
//
//   GET  /api/stream                           POST /api/items/:id/pause
//   GET  /api/sync/status                      POST /api/items/:id/reject
//   POST /api/projects                         POST /api/items/:id/phases/:phase/restart
//   POST /api/projects/:id/activate            POST /api/projects/:id/repos
//   POST /api/projects/:id/repos/disconnect    POST /api/sync/token
//
// "Every existing server test must pass unchanged" proves nothing where no test
// exists, so each distinct payload shape among them is asserted here against the
// same value the handler's own source of truth returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-openapi-behaviour-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const github = await import('../src/github.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { user, pin, cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })
const gated = (opts) => inject({ ...opts, headers: { ...opts.headers, 'x-human-key': pin } })

await app.ready()

// ---- the stylesheet, byte for byte ----

test('GET /api/agent-pages.css still serves pages.css unchanged', async () => {
  // Load-bearing: the existing CSS assertion is a regex match for /\.page/,
  // which a JSON-quoted body would still satisfy. This compares the whole body
  // to the file on disk.
  const expected = readFileSync(new URL('../src/pages.css', import.meta.url), 'utf8')
  const res = await app.inject({ method: 'GET', url: '/api/agent-pages.css' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/css')
  assert.equal(res.body, expected, 'the stylesheet body changed — a content-keyed schema is serializing it')
  assert.ok(!res.body.startsWith('"'), 'the body is JSON-quoted')
})

// ---- /api/stream: documented as SSE, and still an SSE stream ----

test('GET /api/stream still streams a snapshot frame as text/event-stream', async () => {
  // reply.hijack() means inject() cannot see this route's body, so this runs over
  // a real socket on an ephemeral port. On its OWN app, because closing a
  // listening server would take every later test in this file with it.
  const streamApp = buildApp({ logger: false })
  await streamApp.listen({ port: 0, host: '127.0.0.1' })
  try {
    const { port } = streamApp.server.address()
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    assert.equal(res.headers.get('cache-control'), 'no-cache')

    const reader = res.body.getReader()
    const { value } = await reader.read()
    const frame = new TextDecoder().decode(value)
    // HZ-318: the unversioned stream (tabs built before it) leads with a
    // `retry:` line ahead of its one data frame.
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    assert.ok(dataLine, `first frame is not an SSE data frame: ${frame.slice(0, 80)}`)
    const payload = JSON.parse(dataLine.slice('data: '.length))
    // The same keys snapshot() builds — a hijacked reply runs no serializer, so
    // this is really a check that documenting the route changed nothing.
    assert.deepEqual(Object.keys(payload).sort(), ['activeProjectId', 'deployBlock', 'durationEstimates', 'farm', 'items', 'projects', 'repoUrl', 'sync'])
    await reader.cancel()
  } finally {
    await streamApp.close()
  }
})

// ---- the three untested payload shapes ----

test('GET /api/sync/status returns getSyncState() with every key intact', async () => {
  const expected = github.getSyncState()
  assert.ok(Object.keys(expected).length >= 2, `getSyncState() returned ${JSON.stringify(expected)} — nothing to strip`)
  const res = await inject({ method: 'GET', url: '/api/sync/status' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), expected, 'the sync status body lost or gained a field')
})

test('POST /api/projects returns the created project with every key intact', async () => {
  // The expectation comes from store.createProject itself, called directly for a
  // differently-named project, so it is the handler's own source of truth rather
  // than a literal in this file.
  const direct = store.createProject('HZ-178 via the store')
  assert.ok(Object.keys(direct).length >= 2, `createProject returned ${JSON.stringify(direct)} — nothing to strip`)

  const res = await inject({ method: 'POST', url: '/api/projects', payload: { name: 'HZ-178 behaviour' } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(Object.keys(body).sort(), Object.keys(direct).sort(), 'the created-project body lost a field')
  assert.ok(store.listProjects().some((p) => p.id === body.id), 'the id in the body does not name a real project')

  const clash = await inject({ method: 'POST', url: '/api/projects', payload: { name: 'HZ-178 behaviour' } })
  assert.equal(clash.statusCode, 409)
  assert.match(clash.json().error, /already exists/, `the 409 body was stripped: ${clash.body}`)
})

test('POST /api/projects/:id/activate returns its flags, not an empty object', async () => {
  const project = store.listProjects().find((p) => p.name === 'HZ-178 behaviour')
  // Whether this project is already the active one depends on how many exist, so
  // both branches are accepted — what matters is that two keys survive, not one.
  const first = await inject({ method: 'POST', url: `/api/projects/${project.id}/activate` })
  assert.equal(first.statusCode, 200)
  const body = first.json()
  assert.equal(body.ok, true)
  assert.deepEqual(
    Object.keys(body).sort().filter((k) => k !== 'ok'),
    [body.alreadyActive ? 'alreadyActive' : 'restarting'],
    `the activate body lost its second key: ${first.body}`,
  )
  // Now it is definitely active, which pins the other branch.
  const second = await inject({ method: 'POST', url: `/api/projects/${project.id}/activate` })
  assert.deepEqual(second.json(), { ok: true, alreadyActive: true })

  const missing = await inject({ method: 'POST', url: '/api/projects/999999/activate' })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'Project not found' })
})

test('POST /api/items/:id/pause returns the store result unchanged through send()', async () => {
  const { db } = await import('../src/db.js')
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-178', 'Pausable', 'Medium', 3)").run()
  const expected = store.setPaused('T-178', true)
  store.setPaused('T-178', false)
  assert.ok(Object.keys(expected).length >= 1, 'setPaused returned nothing — this test would be vacuous')

  const res = await inject({ method: 'POST', url: '/api/items/T-178/pause', payload: { paused: true } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), expected, 'the pause body lost a field on its way through the serializer')

  const missing = await inject({ method: 'POST', url: '/api/items/NOPE-1/pause', payload: { paused: true } })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })
})

// HZ-385: the page sends the action it shows and applies the answer, so the
// body names the state written. That one field is the only change: the event
// text and the error codes stay as they were.
test('POST /api/items/:id/pause adds only `paused`, with the same events and error codes', async () => {
  const { db } = await import('../src/db.js')
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-385', 'Pausable', 'Medium', 3)").run()
  const lastEvent = () => db.prepare("SELECT text FROM event WHERE item_id = 'T-385' ORDER BY id DESC LIMIT 1").get()?.text

  const paused = await inject({ method: 'POST', url: '/api/items/T-385/pause', payload: { paused: true } })
  assert.equal(paused.statusCode, 200)
  assert.deepEqual(paused.json(), { ok: true, paused: true })
  assert.equal(lastEvent(), 'paused agent work on this item')

  // Sent twice, as a stale tab would: each answers with what it wrote.
  for (let i = 0; i < 2; i++) {
    const resumed = await inject({ method: 'POST', url: '/api/items/T-385/pause', payload: { paused: false } })
    assert.equal(resumed.statusCode, 200)
    assert.deepEqual(resumed.json(), { ok: true, paused: false })
    assert.equal(lastEvent(), 'resumed work')
  }

  const missing = await inject({ method: 'POST', url: '/api/items/NOPE-1/pause', payload: { paused: true } })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })

  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-385C', 'Closed', 'Medium', 99)").run()
  const closed = await inject({ method: 'POST', url: '/api/items/T-385C/pause', payload: { paused: true } })
  assert.equal(closed.statusCode, 409)
  assert.deepEqual(closed.json(), { error: 'closed' })

  const invalid = await inject({ method: 'POST', url: '/api/items/T-385/pause', payload: { paused: 'yes' } })
  assert.equal(invalid.statusCode, 400)
})

test('POST /api/items/:id/reject carries the 401 body when the PIN is missing', async () => {
  // The human-gate 401 is a handler-sent plain object, unlike Fastify's own
  // validation 400 — both go through ERROR_OBJECT, so both are checked.
  const res = await inject({ method: 'POST', url: '/api/items/T-178/reject', payload: { feedback: 'no' } })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('POST /api/items/:id/phases/:phase/restart returns the store result unchanged', async () => {
  const res = await gated({ method: 'POST', url: '/api/items/T-178/phases/0/restart', payload: { reason: 'retry' } })
  assert.ok([200, 404, 409].includes(res.statusCode), `unexpected ${res.statusCode}: ${res.body}`)
  const body = res.json()
  assert.ok(Object.keys(body).length >= 1, `the restart body came back empty: ${res.body}`)
  if (res.statusCode === 200) assert.equal(body.ok, true)
  else assert.ok(body.error, 'a non-200 must still carry its error key')
})

test('Fastify’s own validation 400 keeps all four of its fields', async () => {
  // The regression that actually happened. Named explicitly so a future change to
  // ERROR_OBJECT cannot quietly reintroduce it.
  const res = await inject({ method: 'POST', url: '/api/items/T-178/pause', payload: { paused: 'not-a-boolean' } })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.statusCode, 400)
  assert.equal(body.code, 'FST_ERR_VALIDATION')
  assert.equal(body.error, 'Bad Request')
  assert.match(body.message, /paused/, `the validation message was stripped: ${res.body}`)
})

test('the two /api/auth/google redirects still send an empty body', async () => {
  for (const url of ['/api/auth/google/start', '/api/auth/google/callback']) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 302, `${url} no longer redirects`)
    assert.equal(res.body, '', `${url} grew a body — its documented 302 is serializing something`)
    assert.ok(res.headers.location, `${url} lost its Location header`)
  }
})

test('POST /api/sync/token still answers 400 with the validation error from GitHub', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({ message: 'Bad credentials' }) })
  try {
    const res = await inject({ method: 'POST', url: '/api/sync/token', payload: { token: 'x'.repeat(20) } })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error, `the 400 body lost its error key: ${res.body}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/projects/:id/repos and /repos/disconnect keep their error bodies', async () => {
  const project = store.listProjects().find((p) => p.name === 'HZ-178 behaviour')
  const bad = await inject({ method: 'POST', url: `/api/projects/${project.id}/repos`, payload: { repo: 'not a repo!!' } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /owner\/name/, `the parse error was stripped: ${bad.body}`)

  const gone = await inject({
    method: 'POST',
    url: `/api/projects/${project.id}/repos/disconnect`,
    payload: { repo: 'FinTekkers/nothing-here' },
  })
  assert.equal(gone.statusCode, 404)
  assert.deepEqual(gone.json(), { error: 'That repository is not connected to this project' })
})

// ---- the no-secrets guardrail, swept over the live document ----

function walk(node, path = '$', out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, out))
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, out)
  else out.push([path, node])
  return out
}

const spec = JSON.parse((await app.inject({ method: 'GET', url: '/api/openapi.json' })).body)
const leaves = walk(spec)

test('the document carries no examples at all', () => {
  // The cheapest way a real token or a real work item’s contents could reach a
  // published document is an `example` copied off a live response.
  const examples = leaves.filter(([path]) => /\.examples?(\.|\[|$)/.test(path)).map(([path]) => path)
  assert.deepEqual(examples, [], `the document grew example values: ${examples.join(', ')}`)
  assert.ok(leaves.length >= 200, `only ${leaves.length} leaves walked — the sweep is not reaching the document`)
})

test('the security schemes carry no value, default or example', () => {
  // An apiKey scheme names where the credential goes; an http scheme (the
  // HZ-179 bearer token) names its auth scheme. Neither may carry anything else.
  const SHAPE = { apiKey: ['description', 'in', 'name', 'type'], http: ['description', 'scheme', 'type'] }
  for (const [name, scheme] of Object.entries(spec.components.securitySchemes)) {
    assert.deepEqual(
      Object.keys(scheme).sort(),
      SHAPE[scheme.type],
      `${name} declares more than the scheme's shape — a credential value may have come with it`,
    )
  }
})

test('no string value in the document looks like a credential', () => {
  // PROPERTY NAMES are fine — `tokenConfigured`, `humanGateKey` and
  // `x-human-key` are all legitimate and must not trip this. Only VALUES are
  // swept, and only string ones: `default: 0` on offset and
  // `default: 'Medium'` on priority come from request schemas and are part of
  // the contract.
  const suspicious = leaves.filter(([path, value]) => {
    if (typeof value !== 'string') return false
    if (path.endsWith('.description') || path.endsWith('.title')) return false
    return (
      /gh[pousr]_[A-Za-z0-9]{16,}/.test(value) ||
      /\bghp_|\bgithub_pat_/.test(value) ||
      /[A-Za-z0-9+/]{40,}={0,2}$/.test(value) ||
      /^\d{4,}$/.test(value) ||
      /(secret|password|passwd|credential|api[_-]?key|bearer)\s*[:=]/i.test(value)
    )
  })
  assert.deepEqual(
    suspicious.map(([p, v]) => `${p} = ${v}`),
    [],
    'these values look like credentials',
  )
})

test('the sweep would catch a planted credential — it is not a rubber stamp', () => {
  const planted = walk({ paths: { '/x': { get: { responses: { 200: { description: 'ok' } }, operationId: 'ghp_0123456789abcdefghij' } } } })
  const hits = planted.filter(([, value]) => typeof value === 'string' && /gh[pousr]_[A-Za-z0-9]{16,}/.test(value))
  assert.equal(hits.length, 1, 'the credential pattern does not match a planted GitHub token')
})

test('no internal credential header is named anywhere in the document', () => {
  // The internal routes are excluded wholesale, so their credentials should not
  // appear even as header names.
  const text = JSON.stringify(spec)
  for (const name of ['x-wa-approval-secret', 'x-farm-secret', 'x-hub-signature-256', 'WA_APPROVAL_SECRET', 'FARM_SHARED_SECRET']) {
    assert.ok(!text.includes(name), `the document names ${name} — an internal route leaked`)
  }
})

test('the document is small enough that no internal surface slipped in', () => {
  // A smell test, not a budget: the public surface is ~39 operations of
  // deliberately shallow schemas. A large jump means routes or payload detail
  // arrived that nobody decided to publish.
  const bytes = Buffer.byteLength(JSON.stringify(spec))
  assert.ok(bytes > 5_000, `the document is only ${bytes} bytes — it is probably empty`)
  assert.ok(bytes < 120_000, `the document is ${bytes} bytes; check what was added`)
})
