// HZ-717 metric 3, end to end: while the server can't reach the farm, the item
// page says so and links to Farm health. The e2e server has no farm and no
// FARM_URL, so nothing marks it unreachable on its own — the default is no
// banner. POST /api/test/farm-reachable flips the server's flag; the banner
// must follow over the live snapshot, with no reload and no new polling.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'HZ-E2E-FARM-DOWN'
const BANNER = "The farm isn't reachable, so agent steps can't start or report back."

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT id FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — an item while the farm is unreachable', cursor: IMPLEMENT_STEP_INDEX })
    }
  } finally {
    db.close()
  }
})

// The flag is process-wide on a server every spec shares (workers: 1): never
// leave it down for the specs after this one.
test.afterAll(async ({ request }) => {
  await request.post('/api/test/farm-reachable', { data: { reachable: true } })
})

async function setReachable(request, reachable) {
  const res = await request.post('/api/test/farm-reachable', { data: { reachable } })
  expect(res.ok()).toBeTruthy()
}

test('the item page shows and clears the farm banner live, adds no polling, and links to Farm health', async ({ page, request }, testInfo) => {
  const paths = []
  page.on('request', (req) => paths.push(new URL(req.url()).pathname))
  const banner = page.getByRole('status').filter({ hasText: BANNER })

  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expect(banner).toHaveCount(0)
  const before = new Set(paths)
  const outageStart = paths.length

  await setReachable(request, false)
  await expect(banner).toBeVisible({ timeout: 10_000 })
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    await page.reload()
    await expect(banner).toBeVisible()
    await testInfo.attach(`item-page-farm-banner-${colorScheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })

  // No new polling: only API calls the page already made before the outage
  // (static assets such as a lazily loaded font aside), and never the farm.
  const during = paths.slice(outageStart)
  expect(during.filter((p) => p.startsWith('/api/') && !before.has(p))).toEqual([])
  expect(during.filter((p) => p.includes('/farm/'))).toEqual([])

  await setReachable(request, true)
  await expect(banner).toHaveCount(0, { timeout: 10_000 })

  await setReachable(request, false)
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Farm health' }).click()
  await expect(page).toHaveURL(/\/farm-health$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Farm health' })).toBeVisible()
  await setReachable(request, true)
})
