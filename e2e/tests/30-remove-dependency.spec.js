// HZ-310: removing a dependency from the item view, end to end against the
// real server. global-setup.js seeds DEP-RM-3 depending on DEP-RM-1 and
// DEP-RM-2, and DEP-RM-5 depending only on DEP-RM-4 (at an agent step).

import { test, expect } from '../fixtures/test-base.js'

const REMOVE_X = { name: /^Remove dependency on / }

function countRemoveRequests(page) {
  const seen = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/dependencies/remove')) seen.push(req)
  })
  return seen
}

test('X removes one edge: one request, the badge, the event log and the board card all drop it, no reload', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.card', { hasText: 'E2E fixture — two removable blockers' })
  await expect(card.locator('.dep-pill--blocked')).toContainText('Blocked by DEP-RM-1')
  // HZ-335: blocked at a gate still reads Blocked.
  await expect(card.locator('.status-pill')).toHaveText('Blocked')
  // The compact board badge stays display-only.
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(0)

  // The title, not the card centre: the centre can land on a blocker link.
  await card.locator('.card__title').click()
  const detail = page.locator('.dep-detail')
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(2)

  await page.evaluate(() => {
    window.__noReload = 1
  })
  const requests = countRemoveRequests(page)
  const firstRequest = page.waitForRequest((req) => req.url().includes('/dependencies/remove'))
  await page.getByRole('button', { name: 'Remove dependency on DEP-RM-1' }).click()
  const req = await firstRequest
  expect(req.url()).toContain('/items/DEP-RM-3/dependencies/remove')
  expect(req.postDataJSON()).toEqual({ dependsOnId: 'DEP-RM-1' })

  await expect(detail).not.toContainText('DEP-RM-1')
  await expect(detail).toContainText('DEP-RM-2')
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(1)
  await expect(page.locator('.activity-row__text', { hasText: 'removed the dependency on DEP-RM-1' })).toBeVisible()
  expect(requests).toHaveLength(1)

  await page.getByRole('button', { name: 'Back to board' }).click()
  await expect(card.locator('.dep-pill--blocked')).toContainText('Blocked by DEP-RM-2')
  await expect(card.locator('.dep-pill--blocked')).not.toContainText('DEP-RM-1')
  // Still held up by DEP-RM-2: a partial removal does not clear Blocked.
  await expect(card.locator('.status-pill')).toHaveText('Blocked')
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(0)
  expect(await page.evaluate(() => window.__noReload)).toBe(1)
})

test('removing the only blocker starts the item’s next agent step with no restart', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.card', { hasText: 'E2E fixture — waiting on its only blocker' })
  // HZ-335: blocked at an agent step reads Blocked, never an agent working,
  // and offers no Pause work. The blocker is named as a link.
  await expect(card.locator('.status-pill')).toHaveText('Blocked')
  await expect(card.getByRole('button', { name: 'Pause work' })).toHaveCount(0)
  const blockerLink = card.getByRole('link', { name: 'DEP-RM-4' })
  await expect(blockerLink).toBeVisible()
  await expect(blockerLink).toHaveAttribute('href', /\/dep-rm-4$/)

  // The title, not the card centre: the centre can land on a blocker link.
  await card.locator('.card__title').click()
  await expect(page.locator('.dep-detail')).toContainText('DEP-RM-4')
  await expect(page.locator('.tracker__status')).toHaveText('Blocked')
  await expect(page.getByRole('button', { name: 'Pause work' })).toHaveCount(0)
  // Inert while blocked: no step has run.
  await expect(page.locator('.step__icon--done')).toHaveCount(0)

  await page.evaluate(() => {
    window.__noReload = 1
  })
  await page.getByRole('button', { name: 'Remove dependency on DEP-RM-4' }).click()

  await expect(page.locator('.dep-detail')).toHaveCount(0)
  // The live snapshot clears Blocked with no reload.
  await expect(page.locator('.tracker__status')).not.toHaveText('Blocked')
  // The mock agents run the three PM/Architect steps up to the first gate.
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  await expect(page.locator('.step__icon--done')).toHaveCount(3)

  await page.getByRole('button', { name: 'Back to board' }).click()
  await expect(card.locator('.status-pill')).toBeVisible()
  await expect(card.locator('.status-pill')).not.toHaveText('Blocked')
  expect(await page.evaluate(() => window.__noReload)).toBe(1)
})
