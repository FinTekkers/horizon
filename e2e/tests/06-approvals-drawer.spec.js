import { test, expect } from '../fixtures/test-base.js'

test('pending approvals drawer lists and approves a gated item', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Pending approvals' }).click()

  await expect(page.locator('.drawer__title')).toHaveText('Pending approvals')
  const approval = page.locator('.approval').filter({ has: page.locator('.approval__id', { hasText: 'E2E-4' }) })
  await expect(approval).toBeVisible()
  await expect(approval).toContainText('E2E fixture — final review gate')

  // E2E-4 sits at the final gate — approving it closes the item for good,
  // so it can only ever leave the pending list once, no gate-to-gate races.
  await approval.locator('.btn-approve').click()
  await expect(approval).toHaveCount(0, { timeout: 10_000 })
})
