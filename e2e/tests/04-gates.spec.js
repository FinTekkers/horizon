import { test, expect } from '../fixtures/test-base.js'

test('approve, approve-with-comments and send-back drive an item through consecutive gates', async ({
  request,
  page,
}) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E gates journey',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  const { id } = await res.json()

  // Plain approve, exercised from the board card.
  await page.goto('/')
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.locator('.btn-approve')).toBeVisible({ timeout: 10_000 })
  await card.locator('.btn-approve').click()

  // Approve with comments, exercised from the tracker.
  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
  await page.locator('.btn-gate-feedback').click()
  await page.locator('.composer__input').fill('Go with the recommended option.')
  await page.locator('.composer__submit').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Review before execution', { timeout: 10_000 })

  // Send back with feedback rolls the item back to the prior agent step,
  // which re-runs and returns it to the same gate.
  await page.locator('.btn-gate-reject').click()
  await page.locator('.composer__input').fill('Please double-check the test plan.')
  await page.locator('.composer__submit').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Review before execution', { timeout: 10_000 })
})
