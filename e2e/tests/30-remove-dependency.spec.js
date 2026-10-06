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
  // The compact board badge stays display-only.
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(0)

  await card.click()
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
  await expect(page.getByRole('button', REMOVE_X)).toHaveCount(0)
  expect(await page.evaluate(() => window.__noReload)).toBe(1)
})

test('removing the only blocker starts the item’s next agent step with no restart', async ({ page }) => {
  await page.goto('/')
  await page.locator('.card', { hasText: 'E2E fixture — waiting on its only blocker' }).click()
  await expect(page.locator('.dep-detail')).toContainText('DEP-RM-4')
  // Inert while blocked: no step has run.
  await expect(page.locator('.step__icon--done')).toHaveCount(0)

  await page.getByRole('button', { name: 'Remove dependency on DEP-RM-4' }).click()

  await expect(page.locator('.dep-detail')).toHaveCount(0)
  // The mock agents run the three PM/Architect steps up to the first gate.
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  await expect(page.locator('.step__icon--done')).toHaveCount(3)
})
