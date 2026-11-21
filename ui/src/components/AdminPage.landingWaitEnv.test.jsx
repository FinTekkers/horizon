// HZ-925 metric 2: bare /admin waits 3 s for its reads unless the build sets
// VITE_ADMIN_LANDING_WAIT_MS (the e2e build sets 500). Vite reads the value
// when the module is built, so each case stubs the env and imports afresh.

import { expect, test, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function landingWaitWith(value) {
  if (value !== undefined) vi.stubEnv('VITE_ADMIN_LANDING_WAIT_MS', value)
  vi.resetModules()
  return (await import('./AdminPage')).LANDING_WAIT_MS
}

test('unset, the wait is the production 3000 ms', async () => {
  expect(await landingWaitWith(undefined)).toBe(3000)
})

test('a short build value is used', async () => {
  expect(await landingWaitWith('200')).toBe(200)
})

test('a tiny value is held at the 50 ms floor', async () => {
  expect(await landingWaitWith('1')).toBe(50)
})

test('junk keeps the production 3000 ms', async () => {
  expect(await landingWaitWith('abc')).toBe(3000)
})
