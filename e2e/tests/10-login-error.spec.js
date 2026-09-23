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
