import { test, expect } from '@playwright/test'

test('passes', () => {
  expect(1).toBe(1)
})

test('fails', () => {
  expect(1).toBe(2)
})

test.skip('skipped', () => {})

test.describe('retried', () => {
  test.describe.configure({ retries: 1 })

  test('flaky', ({}, testInfo) => {
    expect(testInfo.retry).toBe(1)
  })
})
