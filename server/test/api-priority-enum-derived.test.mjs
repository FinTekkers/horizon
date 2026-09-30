// HZ-135 success metric 2, the API leg: "the API enum ... derives from it."
//
// There are TWO priority enums on the API and only one of them had any coverage.
// server/test/app.test.mjs:136 onwards exercises POST /api/items/:id/priority
// (accept, reject a lower-case value, reject a missing one) — those cases stay
// byte-identical, since behaviour must not move. But POST /api/items' enum, the
// one a human hits from the intake form, had NO test at all: nothing posted a
// priority through that route, and nothing checked what an omitted priority
// becomes.
//
// That is the enum this change rewires, and the default too. So it gets the same
// two-leg treatment api-field-limits-derived.test.mjs gives the length limits:
//
//   BEHAVIOURAL — POST every declared value through the real route and read the
//     STORED priority back out of the database; post values that are not declared
//     and assert 400. A stale literal in app.js cannot satisfy this.
//   STRUCTURAL — diff the route's own body schema, pulled off the built Fastify
//     instance, against domain/priorities.json read with JSON.parse — the
//     document, not the binding that produced the schema.
//
// Demo mode: no repo is connected in this DB, so POST /api/items takes the
// store.createLocalItem branch and answers 200 without touching GitHub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-priority-enum-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp, PRIORITY_PROPERTY } = await import('../src/app.js')
const config = await import('../src/config.js')
const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const post = (payload) => app.inject({ method: 'POST', url: '/api/items', payload, headers: { cookie } })

const source = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/priorities.json'), 'utf8'))

function validBody(overrides = {}) {
  return {
    title: 'A priority intake fixture',
    outcome: 'Prove the intake route reads its enum from domain/priorities.json.',
    metric: 'Every declared value is accepted and stored verbatim.',
    ...overrides,
  }
}

function storedPriorityOf(id) {
  return db.prepare('SELECT priority FROM work_item WHERE id = ?').get(id).priority
}

test('sanity: the scaffolding works, and there is a vocabulary to check', async () => {
  const res = await post(validBody())
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`)
  assert.ok(res.json().id, 'no item id came back')
  assert.ok(source.priorities.length >= 3, 'the vocabulary is implausibly small')
})

// ---- behavioural: every declared value, read back out of the database ----

for (const value of source.priorities) {
  test(`POST /api/items with priority "${value}" is accepted and stored verbatim`, async () => {
    const res = await post(validBody({ priority: value }))
    assert.equal(res.statusCode, 200, `expected 200 for ${value}, got ${res.statusCode}: ${res.body}`)
    assert.equal(storedPriorityOf(res.json().id), value, `${value} was not stored as posted`)
  })
}

test('POST /api/items with no priority stores the declared default', async () => {
  const res = await post(validBody())
  assert.equal(res.statusCode, 200)
  assert.equal(storedPriorityOf(res.json().id), source.default)
})

test('POST /api/items rejects a value outside the vocabulary at the schema layer (400)', async () => {
  for (const bad of ['urgent', 'Urgent', 'Blocker', 'none', '']) {
    const res = await post(validBody({ priority: bad }))
    assert.equal(res.statusCode, 400, `"${bad}" was accepted; body: ${res.body}`)
  }
})

test('POST /api/items rejects a case-mismatched value — the enum is exact, unchanged', async () => {
  // The same strictness POST /api/items/:id/priority already had. Asserted for
  // every declared value rather than one, so a vocabulary that gained a
  // lower-case member would fail here rather than at the CHECK constraint.
  for (const value of source.priorities) {
    const res = await post(validBody({ priority: value.toLowerCase() }))
    if (value.toLowerCase() === value) continue
    assert.equal(res.statusCode, 400, `"${value.toLowerCase()}" was accepted; body: ${res.body}`)
  }
})

test('POST /api/items rejects a non-string priority', async () => {
  for (const bad of [1, null, [], {}, true]) {
    const res = await post(validBody({ priority: bad }))
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} was accepted; body: ${res.body}`)
  }
})

// ---- structural: the route's schema fragment IS the document ----
// Compared against domain/priorities.json read with JSON.parse, not against the
// binding that produced the fragment — otherwise this would be the code checked
// against itself.

test("the intake route's priority fragment is exactly the authored vocabulary, in order", () => {
  assert.deepEqual(PRIORITY_PROPERTY.enum, source.priorities, 'the enum is not the authored vocabulary')
  assert.equal(PRIORITY_PROPERTY.type, 'string')
  assert.equal(PRIORITY_PROPERTY.default, source.default)
  assert.deepEqual(Object.keys(PRIORITY_PROPERTY).sort(), ['default', 'enum', 'type'])
})

test('the route really uses that fragment — the structural leg is not checking a dead export', () => {
  const appSource = readFileSync(join(REPO_ROOT, 'server/src/app.js'), 'utf8')
  assert.match(appSource, /priority: PRIORITY_PROPERTY,/, 'POST /api/items does not use the exported fragment')
})

test('POST /api/items/:id/priority shares the enum and declares NO default — unchanged asymmetry', () => {
  // Creating an item without naming a priority is normal; changing an item's
  // priority to nothing is a 400. That difference predates HZ-135 and app.test.mjs
  // covers it behaviourally — this asserts the change route still derives its enum
  // from the same binding rather than re-typing it.
  const appSource = readFileSync(join(REPO_ROOT, 'server/src/app.js'), 'utf8')
  assert.match(appSource, /properties: \{ priority: \{ type: 'string', enum: PRIORITIES \} \}/)
})

test('no priority value is hand-typed in server/src/app.js any more', () => {
  const appSource = readFileSync(join(REPO_ROOT, 'server/src/app.js'), 'utf8')
  for (const value of source.priorities) {
    assert.ok(
      !new RegExp(`['"\`]${value}['"\`]`).test(appSource),
      `app.js still hand-types the priority "${value}"`,
    )
  }
  assert.match(appSource, /enum: PRIORITIES/, 'app.js does not build an enum from the binding')
})
