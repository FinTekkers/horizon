import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('deep link opens the right item by id, case-insensitively', async ({ page }) => {
  await page.goto('/hz-102')
  await expect(page.locator('.tracker__id')).toHaveText('HZ-102')
  await expect(page.getByText('E2E fixture — deep link target')).toBeVisible()

  await captureScreenshot(page, 'deep-links')
})

test('deep link opens the admin page', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.locator('.admin__title')).toHaveText('Admin')
})
