// HZ-37: a failed /api/auth/google/* callback redirects to the login page
// with ?error=<code> instead of rendering raw JSON. This spec drives that
// through a real, unauthenticated browser — every other spec inherits the
// logged-in storageState (see playwright.config.js), so this file opts out
// of it to actually see LoginPage render.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test.use({ storageState: { cookies: [], origins: [] } })

test('an ?error= redirect lands on the login page with a readable message, and the param is stripped', async ({ page }) => {
  await page.goto('/?error=google_link_blocked')

  await expect(page.locator('.gh-error')).toBeVisible()
  await expect(page.locator('.gh-error')).not.toContainText('google_link_blocked')
  await expect(page.locator('.gh-error')).toContainText(/verified/i)

  // The code must not linger in the URL past the first render.
  await expect.poll(() => new URL(page.url()).search).toBe('')

  await captureScreenshot(page, 'login-error')
})

test('with no ?error= param, the login page renders with no error banner', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.login__submit')).toBeVisible()
  await expect(page.locator('.gh-error')).toHaveCount(0)
})

// HZ-36: unauthenticated access must only ever reach the login page — even a
// deep link to a specific item, which every OTHER spec in this suite (all
// logged in via storageState) can open directly.
test('an unauthenticated deep link to a specific item lands on the login page, not the board', async ({ page }) => {
  await page.goto('/hz-102')
  await expect(page.locator('.login__submit')).toBeVisible()
  await expect(page.locator('.tracker__id')).toHaveCount(0)
})
