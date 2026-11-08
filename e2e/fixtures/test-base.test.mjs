// Plain node:test unit tests for test-base.js's helpers, separate from
// the Playwright spec suite in e2e/tests/ — this file lives outside
// playwright.config.js's testDir so Playwright never tries to load it, and
// it's run explicitly via e2e/package.json's "test" script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeKey, startCoverage, writeCoverage } from './test-base.js'

// HZ-328: the inventory's per-spec routes, and the guardrail that coverage is
// never recorded in a gating run.
test('routeKey names an API request by method and path, with id-like segments as :id', () => {
  assert.equal(routeKey('get', 'http://localhost:4351/api/items/HZ-12'), 'route:GET /api/items/:id')
  assert.equal(routeKey('GET', 'http://localhost:4351/api/items/42?x=1'), 'route:GET /api/items/:id')
  assert.equal(
    routeKey('POST', 'http://localhost:4351/api/items/HZ-12/gates/13/approve-via-whatsapp'),
    'route:POST /api/items/:id/gates/:id/approve-via-whatsapp',
  )
  assert.equal(routeKey('GET', 'http://localhost:4351/assets/index-abc123.js'), null)
  assert.equal(routeKey('GET', 'http://localhost:4351/'), null)
  assert.equal(routeKey('GET', 'not a url'), null)
})

// HZ-709: the gate routes name a step by key; every step maps to one route key.
// (HZ-712 retired the plain approve route; its WhatsApp leg keeps :step.)
test('routeKey names a step key after /gates/ as :step, and nothing else', () => {
  assert.equal(
    routeKey('POST', 'http://localhost:4351/api/items/HZ-12/gates/change.accept-code/approve-via-whatsapp'),
    'route:POST /api/items/:id/gates/:step/approve-via-whatsapp',
  )
  assert.equal(
    routeKey('POST', 'http://localhost:4351/api/items/HZ-12/gates/task.approve-run/note-via-whatsapp'),
    'route:POST /api/items/:id/gates/:step/note-via-whatsapp',
  )
  assert.equal(routeKey('GET', 'http://localhost:4351/api/openapi.json'), 'route:GET /api/openapi.json')
})

test('without HORIZON_E2E_COVERAGE_DIR the fixture touches nothing on the page and writes nothing', async () => {
  const page = new Proxy({}, { get: (_, prop) => { throw new Error(`page.${String(prop)} used`) } })
  const recording = await startCoverage(page, {})
  assert.equal(recording, null)
  await writeCoverage(page, recording, { file: 'x.spec.js', testId: 't' })
})
