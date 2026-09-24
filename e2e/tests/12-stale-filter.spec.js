// HZ-80: the board hides items with no progress for 30+ days by default —
// end to end, using a real backdated last_activity_at (last_activity_at is
// sourced from work_item.updated_at; see store.js's listItems()). This is
// the one path filters.test.js/Board.filters.test.jsx can't reach: the
// default-hide-on-load behavior against a real server response, not a
// hand-built item object.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'STALE-1', title: 'E2E fixture — stale for 45 days', cursor: 1, updatedAt: daysAgo(45) })
    insertItem(db, { id: 'FRESH-1', title: 'E2E fixture — freshly touched' })
  } finally {
    db.close()
  }
})

test('a 30+ day inactive item is hidden by default, with a visible count and a one-click reveal', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('E2E fixture — freshly touched')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('E2E fixture — stale for 45 days')).toHaveCount(0)

  // The hidden count is stated in the header, not tucked behind a menu.
  await expect(page.locator('.board__hidden-note')).toContainText('stale')

  await captureScreenshot(page, 'stale-filter-hidden')

  await page.locator('.board__show-all').click()
  await expect(page.getByText('E2E fixture — stale for 45 days')).toBeVisible()

  await captureScreenshot(page, 'stale-filter-revealed')
})
