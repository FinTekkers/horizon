// HZ-95: both dependency directions rendered end to end against the real
// server. global-setup.js seeds DEP-2 depending on DEP-1 (DEP-1 blocks
// DEP-2) — one edge, both directions must show up on the board.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('one dependency edge renders as "Blocked by" on the dependent and "Blocks" on the blocker', async ({ page }) => {
  await page.goto('/')

  const blockerCard = page.locator('.card', { hasText: 'E2E fixture — dependency blocker' })
  const dependentCard = page.locator('.card', { hasText: 'E2E fixture — dependency dependent' })

  await expect(blockerCard.locator('.dep-pill--dependents')).toHaveText('Blocks 1')
  await expect(dependentCard.locator('.dep-pill--blocked')).toContainText('Blocked by E2E fixture — dependency blocker')

  await captureScreenshot(page, 'dependencies-board')

  await dependentCard.click()
  await expect(page.locator('.dep-detail__label--blocked')).toHaveText('Blocked by')
  await expect(page.locator('.dep-detail')).toContainText('E2E fixture — dependency blocker')

  await captureScreenshot(page, 'dependencies-tracker')
})
