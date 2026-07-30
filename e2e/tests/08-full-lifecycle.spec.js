import { test, expect } from '../fixtures/test-base.js'

const GATES = [
  'Approve & prioritize this work',
  'Approve the high-level design',
  'Review before execution',
  'Accept the code',
  'Review the work & close',
]

test('one item travels the full lifecycle from creation to closed', async ({ request, page }) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E full lifecycle',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  const { id } = await res.json()

  await page.goto(`/${id.toLowerCase()}`)

  for (const label of GATES) {
    await expect(page.locator('.step-card--awaiting')).toContainText(label, { timeout: 15_000 })
    await page.locator('.btn-gate-approve').click()
  }

  await expect(page.locator('.tracker__status')).toContainText('Closed', { timeout: 10_000 })
})
