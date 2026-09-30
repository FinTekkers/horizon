// HZ-143: completed work is hidden from the board by default so it stops
// crowding the Review column. This is the one path filters.test.js and
// Board.filters.test.jsx can't reach: hiding is a *render-time view* concern
// only, so a closed item must still come back from the API and still open by
// its own URL while the board is not showing it.
//
// One test, not four — the suite runs under an 85s globalTimeout
// (playwright.config.js) and every extra test pays for a fresh browser
// context plus a board load.
//
// Measured on the HZ-143 branch rather than estimated, since the budget is a
// hard suite-wide ceiling: 29 tests / 43.2s before this item, 30 tests /
// 47.2-49.6s after (two runs, so ~2.4s of that spread is run-to-run noise).
// This file is ~1.5s of the delta; the rest is the three chip clicks added to
// 01-board and 08-full-lifecycle. That leaves ~35s of headroom — a host would
// have to be ~1.7x slower than this one to breach the ceiling, down from
// ~2.0x before. Re-measure before adding a fourth board-filter spec.

import { test, expect } from '../fixtures/test-base.js'

test('a closed item is hidden from the board, still reachable by URL and API, and revealed by its own chip', async ({
  page,
  request,
}) => {
  // Nothing is filtered server-side — hiding never reaches the data layer.
  const res = await request.get('/api/items')
  expect(res.ok()).toBe(true)
  const ids = (await res.json()).items.map((i) => i.id)
  expect(ids).toContain('E2E-3')

  await page.goto('/')
  await expect(page.getByText('E2E fixture — awaiting intake gate')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('E2E fixture — already closed')).toHaveCount(0)
  await expect(page.locator('.board__hidden-note')).toContainText('closed')

  const review = page.locator('.col').filter({ has: page.locator('.col__name', { hasText: /^Review$/ }) })
  // A delta, not a literal: earlier specs close items of their own, so the
  // baseline moves with the suite. What's pinned is that revealing puts the
  // closed items back in the column they belong to.
  const before = parseInt(await review.locator('.col__count').textContent(), 10)

  await page.locator('.board__filter-chip', { hasText: 'Closed' }).click()
  await expect(page.getByText('E2E fixture — already closed')).toBeVisible()
  await expect(review.locator('.card__id', { hasText: 'E2E-3' })).toBeVisible()
  expect(parseInt(await review.locator('.col__count').textContent(), 10)).toBeGreaterThan(before)

  // Deep link works the same whether the board is hiding it or not.
  await page.goto('/e2e-3')
  await expect(page.locator('.tracker__id')).toHaveText('E2E-3')
  await expect(page.locator('.tracker__status')).toContainText('Closed')
})
