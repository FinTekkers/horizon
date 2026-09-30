import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('board renders phase columns and seeded work items', async ({ page }) => {
  await page.goto('/')

  for (const name of ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']) {
    await expect(page.locator('.col__name', { hasText: new RegExp(`^${name}$`) })).toBeVisible()
  }

  await expect(page.getByText('E2E fixture — awaiting intake gate')).toBeVisible()
  await expect(page.getByText('E2E fixture — mid technical plan')).toBeVisible()

  // Closed items are hidden by default (HZ-143) — the header states the count
  // and the chip reveals them, same contract as stale and abandoned.
  await expect(page.getByText('E2E fixture — already closed')).toHaveCount(0)
  await expect(page.locator('.board__hidden-note')).toContainText('closed')

  await page.locator('.board__filter-chip', { hasText: 'Closed' }).click()
  await expect(page.getByText('E2E fixture — already closed')).toBeVisible()

  // Captured after the reveal so the journey shot still shows a populated
  // Review column.
  await captureScreenshot(page, 'board')
})
