// HZ-134 success metric 2: "the API's JSON schema maxLength values are derived
// from domain/fields.json; a test asserts equality."
//
// Two legs, because either alone is weak:
//
//   BEHAVIOURAL — for every intake field, POST /api/items with that field at
//     exactly maxLength (expect NOT 400) and at maxLength + 1 (expect 400), and
//     the same either side of minLength where one is declared. This is the leg a
//     stale literal in app.js cannot satisfy. QA flagged that POST /api/items had
//     no test at all before this, so the session + demo-mode scaffolding below is
//     new ground rather than an extension.
//   STRUCTURAL — diff the exported ITEM_BODY_PROPERTIES fragment against what
//     domain/fields.json implies, read with JSON.parse rather than through the
//     binding, so the comparison is against the document and not against the
//     code that produced the fragment.
//
// Plus the split neither leg would catch on its own: `required` stays a literal
// in app.js while `properties` is derived, so a field dropped from
// domain/fields.json would leave the route requiring a property it no longer
// defines. Asserted directly.
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

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-field-limits-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp, ITEM_BODY_PROPERTIES } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const post = (payload) => app.inject({ method: 'POST', url: '/api/items', payload, headers: { cookie } })

const source = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fields.json'), 'utf8'))
const intake = source.fields.filter((f) => f.settableAtIntake)

// A valid body, built from the declared minimums so it satisfies the route
// whatever the authored limits are. `repeat` keeps every value comfortably
// inside its own maxLength.
function validBody(overrides = {}) {
  const body = {}
  for (const field of intake) {
    if (field.name === 'repo') continue // naming a repo with none connected is a 400 by design
    body[field.name] = 'x'.repeat(Math.max(field.minLength ?? 1, 12))
  }
  return { ...body, ...overrides }
}

test('sanity: the scaffolding works — a valid body is accepted and creates a local item', async () => {
  const res = await post(validBody())
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`)
  assert.equal(res.json().ok, true)
  assert.ok(res.json().id, 'no item id came back')
})

test('sanity: there are intake fields to check, and at least one declares a minLength', () => {
  assert.ok(intake.length >= 4, `only ${intake.length} intake field(s) — the loops below would be near-vacuous`)
  assert.ok(intake.some((f) => f.minLength !== undefined))
  assert.ok(intake.some((f) => f.minLength === undefined), 'minLength is not optional — a case below is vacuous')
})

// ---- behavioural: the route enforces the DECLARED numbers, not a literal ----

for (const field of intake) {
  test(`POST /api/items accepts ${field.name} at exactly its declared maxLength (${field.maxLength})`, async () => {
    // "x" with no spaces: length is the only thing under test here.
    const res = await post(validBody({ [field.name]: 'x'.repeat(field.maxLength) }))
    assert.notEqual(res.statusCode, 400, `a ${field.maxLength}-char ${field.name} was rejected: ${res.body}`)
  })

  test(`POST /api/items rejects ${field.name} one char over its declared maxLength`, async () => {
    const res = await post(validBody({ [field.name]: 'x'.repeat(field.maxLength + 1) }))
    assert.equal(res.statusCode, 400, `a ${field.maxLength + 1}-char ${field.name} was accepted`)
    assert.match(
      res.json().message,
      new RegExp(`body/${field.name} must NOT have more than ${field.maxLength} characters`),
      `the 400 does not come from ${field.name}'s own maxLength: ${res.body}`,
    )
  })

  if (field.minLength !== undefined) {
    test(`POST /api/items accepts ${field.name} at exactly its declared minLength (${field.minLength})`, async () => {
      const res = await post(validBody({ [field.name]: 'x'.repeat(field.minLength) }))
      assert.notEqual(res.statusCode, 400, `a ${field.minLength}-char ${field.name} was rejected: ${res.body}`)
    })

    test(`POST /api/items rejects ${field.name} one char under its declared minLength`, async () => {
      const res = await post(validBody({ [field.name]: 'x'.repeat(field.minLength - 1) }))
      assert.equal(res.statusCode, 400, `a ${field.minLength - 1}-char ${field.name} was accepted`)
      assert.match(
        res.json().message,
        new RegExp(`body/${field.name} must NOT have fewer than ${field.minLength} characters`),
        `the 400 does not come from ${field.name}'s own minLength: ${res.body}`,
      )
    })
  } else {
    test(`POST /api/items accepts a single-character ${field.name} — no minLength is declared for it`, async () => {
      const res = await post(validBody({ [field.name]: 'x' }))
      assert.notEqual(res.statusCode, 400, `a 1-char ${field.name} was rejected: ${res.body}`)
    })
  }
}

// ---- structural: the fragment IS the document ----

test('the route body properties equal what domain/fields.json declares, field for field', () => {
  const expected = Object.fromEntries(
    intake.map((f) => [
      f.name,
      { type: 'string', ...(f.minLength === undefined ? {} : { minLength: f.minLength }), maxLength: f.maxLength },
    ]),
  )
  assert.deepEqual(ITEM_BODY_PROPERTIES, expected)
})

// The create route's body schema, located by its `required` line rather than by
// its URL: `/api/items` is a prefix of several other route paths.
function itemBodySchemaSource() {
  const appSource = readFileSync(join(REPO_ROOT, 'server/src/app.js'), 'utf8')
  const at = appSource.indexOf("required: ['title', 'outcome', 'metric']")
  assert.notEqual(at, -1, 'could not find the POST /api/items body schema in server/src/app.js')
  return appSource.slice(at, at + 400)
}

test('no work-item length literal survives in the POST /api/items body schema', () => {
  const routeSchema = itemBodySchemaSource()
  assert.ok(routeSchema.includes('...ITEM_BODY_PROPERTIES'), 'the route no longer spreads the derived fragment')
  for (const field of intake) {
    assert.ok(
      !new RegExp(`${field.name}:\\s*\\{[^}]*maxLength`).test(routeSchema),
      `${field.name} declares its own maxLength in the route schema again`,
    )
  }
})

// ---- the split app.js keeps: `required` is a literal, `properties` is derived ----

test('every name in the route body `required` list is a property the derived fragment defines', () => {
  assert.match(itemBodySchemaSource(), /^required: \['title', 'outcome', 'metric'\]/)
  const required = ['title', 'outcome', 'metric']
  for (const name of required) {
    assert.ok(
      name in ITEM_BODY_PROPERTIES,
      `POST /api/items requires "${name}" but the derived properties do not define it — it was dropped from domain/fields.json`,
    )
  }
  // And the route really does reject a body missing one of them, so the list
  // above is not just prose.
  const { title: _dropped, ...withoutTitle } = validBody()
  return app
    .inject({ method: 'POST', url: '/api/items', payload: withoutTitle, headers: { cookie } })
    .then((res) => assert.equal(res.statusCode, 400))
})

// ---- the `priority` enum stays a literal, on purpose ----

test('priority is still validated as an enum and is NOT a length-limited field', () => {
  assert.ok(!('priority' in ITEM_BODY_PROPERTIES), 'priority leaked into the field-limit table — it is an enum, not a length')
  assert.ok(!source.fields.some((f) => f.name === 'priority'), 'domain/fields.json declares priority — it carries no length')
})

test('a bad priority is still a 400 — deriving the lengths did not loosen the rest of the schema', async () => {
  const res = await post(validBody({ priority: 'Urgent' }))
  assert.equal(res.statusCode, 400)
})
