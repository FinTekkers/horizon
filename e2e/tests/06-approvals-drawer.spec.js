import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('pending approvals drawer lists and approves a gated item', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Pending approvals' }).click()

  await expect(page.locator('.drawer__title')).toHaveText('Pending approvals')
  const approval = page.locator('.approval').filter({ has: page.locator('.approval__id', { hasText: 'E2E-4' }) })
  await expect(approval).toBeVisible()
  await expect(approval).toContainText('E2E fixture — final review gate')

  await captureScreenshot(page, 'approvals-drawer')

  // E2E-4 sits at the final gate — approving it closes the item for good,
  // so it can only ever leave the pending list once, no gate-to-gate races.
  // Approve now pauses on the explicit confirm dialog first (HZ-38).
  await approval.locator('.btn-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await expect(page.locator('.composer__sub')).toContainText('E2E-4')
  await expect(page.locator('.composer__sub')).toContainText('Review the work & close')
  await page.locator('.composer__submit').click()
  await expect(approval).toHaveCount(0, { timeout: 10_000 })
})
