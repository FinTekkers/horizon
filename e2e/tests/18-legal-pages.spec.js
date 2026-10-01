// The Privacy Policy and Terms of Service are public. This drives them
// through a real, signed-out browser (opting out of the suite's logged-in
// storageState, like 10-login-error.spec.js), from the login page's links.

import { test, expect } from '../fixtures/test-base.js'

test.use({ storageState: { cookies: [], origins: [] } })

test('a signed-out visitor can open both legal pages directly', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.locator('h1.legal__title')).toHaveText('Privacy Policy')
  await expect(page.locator('a[href="mailto:help@fintekkers.org"]')).toBeVisible()
  await expect(page.locator('.login__submit')).toHaveCount(0)

  await page.goto('/terms')
  await expect(page.locator('h1.legal__title')).toHaveText('Terms of Service')
  await expect(page.locator('.legal__body')).toContainText('laws of the State of New York')
})

test('the login page links to the legal pages, and they link back to each other', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.login__submit')).toBeVisible()

  await page.locator('.login__legal a', { hasText: 'Terms of Service' }).click()
  await expect(page.locator('h1.legal__title')).toHaveText('Terms of Service')

  await page.locator('.legal__footer a', { hasText: 'Privacy Policy' }).click()
  await expect(page.locator('h1.legal__title')).toHaveText('Privacy Policy')
})
