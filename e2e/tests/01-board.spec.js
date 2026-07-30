import { test, expect } from '../fixtures/test-base.js'

test('board renders phase columns and seeded work items', async ({ page }) => {
  await page.goto('/')

  for (const name of ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']) {
    await expect(page.locator('.col__name', { hasText: new RegExp(`^${name}$`) })).toBeVisible()
  }

  await expect(page.getByText('E2E fixture — awaiting intake gate')).toBeVisible()
  await expect(page.getByText('E2E fixture — mid technical plan')).toBeVisible()
  await expect(page.getByText('E2E fixture — already closed')).toBeVisible()
})
