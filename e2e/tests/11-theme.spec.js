import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

// HZ-25: dark mode toggle, top-right user menu. One consolidated journey
// (not one test per assertion) — this suite runs under a fixed 90s global
// budget (see playwright.config.js) shared with every other spec file.
test('dark mode toggles from the user menu, applies everywhere, and survives a reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  await page.locator('.topbar__avatar').click()
  const toggle = page.getByRole('switch', { name: 'Dark mode' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // The board, not just the attribute, actually repainted.
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bodyBg).toBe('rgb(21, 19, 27)')
  await captureScreenshot(page, 'dark-mode-board')

  // Persists across a fresh navigation, applied before first paint by the
  // inline <head> script (not React) — no light-mode flash to catch here,
  // but a stale attribute after reload would mean that script is missing.
  await page.goto('/hz-102')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.tracker__id')).toHaveText('HZ-102')

  await page.goto('/admin')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.admin__title')).toHaveText('Admin')

  // Leave the shared browser context as found — other spec files in this
  // run reuse the same storageState and assume light mode.
  await page.goto('/')
  await page.locator('.topbar__avatar').click()
  await page.getByRole('switch', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
})
