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

// HZ-564: each Admin section has its own URL. A cold load of a nested path is
// served and renders; a click pushes the section's URL, a reload keeps it,
// back returns to the section before, and an unknown path falls back to
// /admin rather than the item tracker.
test('Admin sections deep-link: cold load, click, reload, back, and an unknown path', async ({ page }) => {
  await page.goto('/admin/deploys')
  await expect(page.getByRole('heading', { name: 'Deploy targets' })).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: /^Flaky tests/ }).click()
  await expect(page).toHaveURL(/\/admin\/flaky$/)
  await expect(page.getByRole('heading', { name: 'Flaky tests' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Flaky tests' })).toBeVisible({ timeout: 10_000 })

  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/deploys$/)
  await expect(page.getByRole('heading', { name: 'Deploy targets' })).toBeVisible()

  await page.goto('/admin/nope')
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.locator('.tracker__id')).toHaveCount(0)
})
