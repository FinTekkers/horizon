// HZ-563 metric 1, end to end: the suite's user is ADMIN_EMAIL, so /api/auth/me
// says isAdmin and the account menu offers Farm health. This server has no
// FARM_URL, so the page is deterministically red — "Farm is not running" is
// checked before the services and disk, whatever this host's real load is.
// Box and service figures come from the real host, so only labels and
// structure are asserted, never values.

import { test, expect } from '../fixtures/test-base.js'

// HZ-595: the rows come from the seeded deploy targets (horizon and its
// horizon-farm extra service, ui-service; market-data-inputs has no service),
// then the box units. Each unit appears once.
const SERVICES = [
  'horizon-server',
  'horizon-farm',
  'fintekkers-ui',
  'nginx',
  'postgresql',
  'whatsapp-bridge',
  'earlyoom',
]

async function expectRedPage(page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Farm health' })).toBeVisible()
  // The first reading may still be warming up: wait on the state, not a sleep.
  const overall = page.getByRole('region', { name: 'Overall' })
  await expect(overall).toHaveAttribute('data-state', 'red', { timeout: 20_000 })
  await expect(overall).toContainText('Farm is not running')
  const services = page.getByRole('region', { name: 'Services' })
  for (const name of SERVICES) await expect(services.getByText(name, { exact: true })).toBeVisible()
  await expect(services.getByRole('listitem')).toHaveCount(SERVICES.length)
}

test('an admin opens Farm health from the account menu; it reads red, and a reload keeps the page', async ({ page }) => {
  await page.goto('/')
  await page.locator('.topbar__avatar').click()
  const entry = page.getByRole('button', { name: /farm health/i })
  await expect(entry).toBeVisible()
  // The dot appears once the first reading lands, and it matches the page.
  await expect(entry.getByRole('img', { name: 'Unhealthy' })).toHaveAttribute('data-state', 'red', { timeout: 20_000 })
  await entry.click()

  await expect(page).toHaveURL(/\/farm-health$/)
  await expectRedPage(page)

  await page.reload()
  await expect(page).toHaveURL(/\/farm-health$/)
  await expectRedPage(page)

  await page.locator('.topbar__avatar').click()
  await expect(page.getByRole('button', { name: /farm health/i }).getByRole('img')).toHaveAttribute('data-state', 'red')
})

test('on a phone the page keeps every section, one card a row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1700 })
  await page.goto('/farm-health')
  await expectRedPage(page)
  for (const name of ['Capacity', 'Running now', 'Box', 'Capacity slots', 'Services', 'Recent']) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }
  // HZ-574: with no farm to ask, the Capacity slots card says so rather than
  // showing an empty table.
  const checkSlots = page.getByRole('region', { name: 'Capacity slots' })
  await expect(checkSlots.getByText('Farm not reachable — no capacity slot readings')).toBeVisible()
  await expect(checkSlots.getByText('Nothing waiting')).toBeVisible()
})
