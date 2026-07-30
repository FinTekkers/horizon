import { test, expect } from '../fixtures/test-base.js'

test('shows the merge-conflict banner when the PR cannot be merged', async ({ page }) => {
  await page.goto('/cfl-1')
  await expect(page.locator('.step-card__conflict')).toBeVisible()
  await expect(page.locator('.step-card__conflict')).toContainText('PR #501 has merge conflicts')
})

test('hides the merge-conflict banner for a normal mergeable PR', async ({ page }) => {
  await page.goto('/cln-1')
  await expect(page.locator('.tracker__id')).toHaveText('CLN-1')
  await expect(page.locator('.step-card__conflict')).toHaveCount(0)
})
