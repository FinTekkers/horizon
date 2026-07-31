// Plain node:test unit tests for captureScreenshot (HZ-18), separate from
// the Playwright spec suite in e2e/tests/ — this file lives outside
// playwright.config.js's testDir so Playwright never tries to load it, and
// it's run explicitly via e2e/package.json's "test" script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureScreenshot } from './test-base.js'

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
