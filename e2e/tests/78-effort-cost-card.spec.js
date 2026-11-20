// HZ-921 metric lines 3 and 4: the item page's Effort & cost card shows at
// "Review the work & close" and on a closed item, and not at an earlier step.
// The closed item's runs have no recorded turns and it needed no
// clarification, so its card reads "not recorded" and "No clarification
// needed" — never 0. Each card is shot at desktop and phone, light and dark,
// attached to the report; the same screens are `effort-cost-*` in
// .horizon/screenshots.json, which the farm captures into the PR.
//
// The fixture is written straight to the DB (fixtures/effort-cost-seed.js):
// the open items are paused and the closed one never moves, so no gate is
// approved and no PIN is needed.

import { test, expect } from '../fixtures/test-base.js'
import { openDb } from '../fixtures/seed.js'
import {
  seedEffortCost,
  EC_EARLY_ID,
  EC_FINAL_ID,
  EC_CLOSED_ID,
  EC_FINAL_COST,
  EC_FINAL_IMPLEMENT_COST,
  EC_FINAL_IMPLEMENT_TURNS,
  EC_CLOSED_COST,
} from '../fixtures/effort-cost-seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const VIEWPORTS = { desktop: { width: 1024, height: 640 }, phone: { width: 375, height: 667 } }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    seedEffortCost(db)
  } finally {
    db.close()
  }
})

const card = (page) => page.getByRole('region', { name: 'Effort & cost' })
const section = (page, name) => card(page).getByRole('region', { name })

// Opens the item page and waits for its Lifecycle panel, so a missing card is
// really missing and not still to come.
async function openItem(page, id) {
  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(id, { timeout: 10_000 })
  await expect(page.locator('.tracker__stepper')).toBeVisible()
}

// The theme follows prefers-color-scheme as the page loads, so each theme
// reloads. A full-page shot, so the sticky header never covers the card.
async function shoot(page, testInfo, name) {
  for (const [viewport, size] of Object.entries(VIEWPORTS)) {
    for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize(size)
      await page.emulateMedia({ colorScheme })
      await page.reload()
      // Light is the stylesheet's default, with no attribute.
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
      await expect(card(page).getByRole('region', { name: 'Clarification' })).toBeVisible()
      const file = testInfo.outputPath(`${name}-${viewport}-${colorScheme}.png`)
      await page.screenshot({ path: file, fullPage: true })
      await testInfo.attach(`${name}-${viewport}-${colorScheme}`, { path: file, contentType: 'image/png' })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('no Effort & cost card at an earlier step', async ({ page, request }) => {
  const res = await request.get(`/api/items/${EC_EARLY_ID}/stats`)
  expect(res.ok()).toBeTruthy()
  expect(await res.json()).toEqual({ visible: false, stats: null })

  await openItem(page, EC_EARLY_ID)
  // The card mounts with the page (statsVisible), so with the Lifecycle panel
  // drawn its absence is final.
  await expect(card(page)).toHaveCount(0)
})

test('the card shows at "Review the work & close" with the implementation’s cost and turns', async ({ page }, testInfo) => {
  await openItem(page, EC_FINAL_ID)
  await expect(card(page)).toBeVisible()
  const impl = section(page, 'Implementation')
  await expect(impl).toContainText(EC_FINAL_IMPLEMENT_COST)
  await expect(impl).toContainText(EC_FINAL_IMPLEMENT_TURNS)
  await expect(section(page, 'Whole item')).toContainText(EC_FINAL_COST)
  const clarification = section(page, 'Clarification')
  await expect(clarification).toContainText('1 clarification')
  await expect(clarification).not.toContainText('No clarification needed')
  await shoot(page, testInfo, 'effort-cost-final')
})

test('a closed item shows the card after a reload, with turns "not recorded" and "No clarification needed"', async ({ page }, testInfo) => {
  await openItem(page, EC_CLOSED_ID)
  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(EC_CLOSED_ID, { timeout: 10_000 })
  await expect(card(page)).toBeVisible()
  const impl = section(page, 'Implementation')
  await expect(impl.getByRole('definition').filter({ hasText: 'not recorded' }).first()).toBeVisible()
  await expect(impl).not.toContainText(/\b0 turns\b/)
  await expect(section(page, 'Whole item')).toContainText(EC_CLOSED_COST)
  await expect(section(page, 'Clarification').getByText('No clarification needed')).toBeVisible()
  await shoot(page, testInfo, 'effort-cost-closed')
})
