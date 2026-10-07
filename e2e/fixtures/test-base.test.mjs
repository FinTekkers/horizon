// Plain node:test unit tests for captureScreenshot (HZ-18), separate from
// the Playwright spec suite in e2e/tests/ — this file lives outside
// playwright.config.js's testDir so Playwright never tries to load it, and
// it's run explicitly via e2e/package.json's "test" script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureScreenshot, routeKey, startCoverage, writeCoverage } from './test-base.js'

test('captureScreenshot writes to the fixed path relative to the e2e/ cwd (no e2e/ prefix)', async () => {
  let capturedPath
  const page = { screenshot: async ({ path }) => { capturedPath = path } }
  await captureScreenshot(page, 'my-journey')
  assert.equal(capturedPath, '__screenshots__/my-journey.png')
})

test('captureScreenshot warns and does not throw when page.screenshot rejects', async (t) => {
  const warnCalls = []
  t.mock.method(console, 'warn', (...args) => warnCalls.push(args.join(' ')))

  const page = { screenshot: async () => { throw new Error('boom') } }
  await assert.doesNotReject(() => captureScreenshot(page, 'test-journey'))

  assert.equal(warnCalls.length, 1)
  assert.match(warnCalls[0], /test-journey/)
  assert.match(warnCalls[0], /boom/)
})

// HZ-328: the inventory's per-spec routes, and the guardrail that coverage is
// never recorded in a gating run.
test('routeKey names an API request by method and path, with id-like segments as :id', () => {
  assert.equal(routeKey('get', 'http://localhost:4351/api/items/HZ-12'), 'route:GET /api/items/:id')
  assert.equal(routeKey('GET', 'http://localhost:4351/api/items/42?x=1'), 'route:GET /api/items/:id')
  assert.equal(routeKey('POST', 'http://localhost:4351/api/items/HZ-12/gates/13/approve'), 'route:POST /api/items/:id/gates/:id/approve')
  assert.equal(routeKey('GET', 'http://localhost:4351/assets/index-abc123.js'), null)
  assert.equal(routeKey('GET', 'http://localhost:4351/'), null)
  assert.equal(routeKey('GET', 'not a url'), null)
})

test('without HORIZON_E2E_COVERAGE_DIR the fixture touches nothing on the page and writes nothing', async () => {
  const page = new Proxy({}, { get: (_, prop) => { throw new Error(`page.${String(prop)} used`) } })
  const recording = await startCoverage(page, {})
  assert.equal(recording, null)
  await writeCoverage(page, recording, { file: 'x.spec.js', testId: 't' })
})
