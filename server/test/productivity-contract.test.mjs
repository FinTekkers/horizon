// HZ-549 success metric: the mock fixture validates against the checked-in
// response JSON Schema and carries the design's figures (319 closed, the
// 13-row model matrix, null costs), and the published OpenAPI spec lists
// GET /api/admin/productivity with its range and project params and that
// schema as its 200 response.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { validate } from '../../domain/validate.mjs'
import { STEPS } from '../../domain/js/lifecycle.js'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-productivity-contract-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
const schema = readJson('domain/productivity.schema.json')
const fixture = readJson('domain/fixtures/productivity.json')

const COST_KEYS = new Set(['cost', 'costPerItem', 'tokens', 'inputTokens', 'outputTokens'])

// Every [key, value] pair at any depth, so a cost field added later is covered.
function entriesDeep(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => entriesDeep(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push([k, v])
      entriesDeep(v, out)
    }
  }
  return out
}

test('the fixture validates against the checked-in response schema', () => {
  assert.deepEqual(validate(schema, fixture), [])
})

test('the schema check is not a rubber stamp: three broken fixtures each fail', () => {
  const copy = () => structuredClone(fixture)

  const noSummary = copy()
  delete noSummary.summary
  assert.notDeepEqual(validate(schema, noSummary), [], 'missing summary passed')

  const stringClosed = copy()
  stringClosed.summary.closed = '319'
  assert.notDeepEqual(validate(schema, stringClosed), [], 'summary.closed as a string passed')

  const strayKey = copy()
  strayKey.summary.extra = 1
  assert.notDeepEqual(validate(schema, strayKey), [], 'a stray key under summary passed')
})

test('the fixture uses the design figures: 319 closed, summed per day too', () => {
  assert.equal(fixture.summary.closed, 319)
  const perDay = fixture.closedPerDay.flatMap((d) => d.byProject.map((p) => p.count)).reduce((a, b) => a + b, 0)
  assert.equal(perDay, 319)
})

test('the fixture carries the 13-row model matrix, with a not-recorded count per row', () => {
  assert.deepEqual(fixture.models.columns, ['claude-opus-5-5', 'muse-spark-1.3'])
  assert.equal(fixture.models.rows.length, 13)
  assert.deepEqual(fixture.models.rows[0], {
    // The first step's label, read off STEPS rather than typed here (domain-one-declaration).
    step: STEPS[0].label,
    runs: [{ model: 'claude-opus-5-5', count: 220 }, { model: 'muse-spark-1.3', count: 1 }],
    notRecorded: 58,
  })
  for (const row of fixture.models.rows) assert.ok(Number.isInteger(row.notRecorded), row.step)
})

test('every cost and token field in the fixture is null, meaning not captured', () => {
  const costs = entriesDeep(fixture).filter(([k]) => COST_KEYS.has(k))
  assert.ok(costs.length > 0, 'found no cost fields at all')
  for (const [k, v] of costs) assert.equal(v, null, `${k} is ${v}`)
})

test('the published spec lists GET /api/admin/productivity with range, project and the schema as its 200', async () => {
  const { buildApp } = await import('../src/app.js')
  const app = buildApp({ logger: false })
  await app.ready()
  try {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    assert.equal(res.statusCode, 200, res.body)
    const op = res.json().paths['/api/admin/productivity']?.get
    assert.ok(op, 'GET /api/admin/productivity is not in the published spec')

    const params = Object.fromEntries(op.parameters.map((p) => [p.name, p]))
    assert.deepEqual(Object.keys(params).sort(), ['project', 'range'])
    assert.equal(params.range.in, 'query')
    assert.deepEqual(params.range.schema.enum, ['7d', '14d', '30d'])
    assert.equal(params.project.in, 'query')

    // @fastify/swagger adds no keys to this schema, so the comparison is exact.
    assert.deepEqual(op.responses['200'].content['application/json'].schema, schema)
  } finally {
    await app.close()
  }
})
