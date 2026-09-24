import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

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

  // Plain approve, exercised from the board card — now pauses on the
  // explicit confirm dialog (HZ-38) before anything reaches the server.
  await page.goto('/')
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.locator('.btn-approve')).toBeVisible({ timeout: 10_000 })
  await card.locator('.btn-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()

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

  // HZ-51: a human can name a specific earlier agent step instead of the
  // nearest-preceding one — here, an explicit target that sits behind
  // another gate (Approve the high-level design). Every gate between the
  // chosen step and here must be crossed again on the way back, so picking
  // it must re-present that gate before Review before execution reappears.
  await page.locator('.btn-gate-reject').click()
  await expect(page.locator('#composer-target-step')).toBeVisible()
  await page.locator('#composer-target-step').selectOption({ label: 'Plan options & trade-offs (pros / cons)' })
  await page.locator('.composer__input').fill('Reconsider the design options entirely.')
  await page.locator('.composer__submit').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
  await page.locator('.btn-gate-approve').click()
  await page.locator('.composer__submit').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Review before execution', { timeout: 10_000 })

  await captureScreenshot(page, 'gates')
})
