import { test, expect } from '../fixtures/test-base.js'

test('approve, approve-with-comments and return-to drive an item through consecutive gates', async ({
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
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 10_000 })
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
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

  // HZ-711: Return to… (was Send back with feedback) opens the Move dialog
  // with the gate's default target chosen; confirming rolls the item back to
  // that agent step, which re-runs and returns it to the same gate.
  const awaiting = page.locator('.step-card--awaiting')
  const moveDialog = page.getByRole('dialog', { name: `Return to an earlier step · ${id}` })
  await awaiting.getByRole('button', { name: 'Return to…' }).click()
  await expect(moveDialog).toBeVisible()
  await expect(moveDialog.getByRole('radio', { checked: true })).toHaveCount(1)
  await moveDialog.getByLabel('Note for the step (optional)').fill('Please double-check the test plan.')
  await moveDialog.getByRole('button', { name: 'Return here' }).click()
  await expect(moveDialog).toHaveCount(0)

  await expect(awaiting).toContainText('Review before execution', { timeout: 10_000 })

  // HZ-51: a human can name a specific earlier agent step instead of the
  // default — here, an explicit target that sits behind another gate
  // (Approve the high-level design). Every gate between the chosen step and
  // here must be crossed again on the way back, so picking it must re-present
  // that gate before Review before execution reappears — and the dialog says
  // so before anything is sent.
  await awaiting.getByRole('button', { name: 'Return to…' }).click()
  await expect(moveDialog).toBeVisible()
  await moveDialog.getByRole('radio', { name: /^Plan options & trade-offs \(pros \/ cons\)/ }).check()
  await expect(moveDialog.getByRole('list', { name: 'Approvals given again' }).getByRole('listitem')).toHaveText([
    'Approve the high-level design',
  ])
  await moveDialog.getByLabel('Note for the step (optional)').fill('Reconsider the design options entirely.')
  await moveDialog.getByRole('button', { name: 'Return here' }).click()
  await expect(moveDialog).toHaveCount(0)

  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
  await page.locator('.btn-gate-approve').click()
  await page.locator('.composer__submit').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Review before execution', { timeout: 10_000 })
})
