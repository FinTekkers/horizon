// HZ-488: the item page's Activity column minimizes to a narrow strip with an
// expand button, giving the Lifecycle column the freed width, and the choice
// is remembered in this browser across reloads and items. On phone widths the
// same toggle collapses the panel in place to one horizontal row.
//
// The jsdom suite (Tracker.activityToggle.test.jsx) covers the toggle logic;
// this spec is the real-layout proof: measured widths, reload persistence,
// and the phone viewport.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FIRST_ID = 'ACT-E2E-1'
const SECOND_ID = 'ACT-E2E-2'
const MIN_KEY = 'horizon_activity_minimized'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(FIRST_ID)) return
    // Paused at the intake gate, so the mock farm never kicks them.
    for (const id of [FIRST_ID, SECOND_ID]) {
      insertItem(db, { id, title: `E2E fixture — activity minimize ${id}`, cursor: 3, paused: 1 })
    }
    for (let n = 1; n <= 3; n++) {
      insertEvent(db, { itemId: FIRST_ID, who: 'QA', text: `activity fixture event ${n}`, color: '#2E7D5B', initials: 'QA' })
    }
    for (let n = 1; n <= 2; n++) {
      insertEvent(db, { itemId: SECOND_ID, who: 'Eng', text: `second-item fixture event ${n}`, color: '#2E6CB2', initials: 'EN' })
    }
  } finally {
    db.close()
  }
})

const minimize = (page) => page.getByRole('button', { name: 'Minimize Activity' })
const expand = (page) => page.getByRole('button', { name: 'Expand Activity' })
const storedChoice = (page) => page.evaluate((key) => localStorage.getItem(key), MIN_KEY)

test('minimizing hides the rows, widens Lifecycle, and survives a reload and another item; expanding restores both', async ({
  page,
}) => {
  await page.goto(`/${FIRST_ID.toLowerCase()}`)
  const activity = page.locator('.tracker__activity')
  const stepper = page.locator('.tracker__stepper')
  await expect(page.locator('.tracker__id')).toHaveText(FIRST_ID)
  await expect(activity.locator('.activity-row').first()).toBeVisible()
  await expect(minimize(page)).toHaveAttribute('aria-expanded', 'true')

  const expandedStepper = (await stepper.boundingBox()).width
  const expandedActivity = (await activity.boundingBox()).width

  await minimize(page).click()

  await expect(activity.locator('.activity-row')).toHaveCount(0)
  await expect(activity.locator('.activity-empty')).toHaveCount(0)
  await expect(expand(page)).toBeVisible()
  await expect(expand(page)).toContainText('Activity')
  await expect(expand(page)).toHaveAttribute('aria-expanded', 'false')
  expect(await storedChoice(page)).toBe('1')

  // Real layout proof, not just the modifier class: the strip narrows and
  // Lifecycle takes the freed width.
  const minActivity = (await activity.boundingBox()).width
  const minStepper = (await stepper.boundingBox()).width
  expect(expandedActivity - minActivity).toBeGreaterThan(50)
  expect(minStepper - expandedStepper).toBeGreaterThan(50)
  await captureScreenshot(page, 'activity-minimized')

  // A reload reads the stored choice back.
  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(FIRST_ID)
  await expect(expand(page)).toBeVisible()
  await expect(activity.locator('.activity-row')).toHaveCount(0)

  // So does another item: the choice is per browser, not per item.
  await page.goto(`/${SECOND_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(SECOND_ID)
  await expect(expand(page)).toBeVisible()
  await expect(activity.locator('.activity-row')).toHaveCount(0)

  await expand(page).click()
  await expect(minimize(page)).toBeVisible()
  await expect(activity.getByText('second-item fixture event 1')).toBeVisible()
  const restoredStepper = (await stepper.boundingBox()).width
  expect(Math.abs(restoredStepper - expandedStepper)).toBeLessThanOrEqual(2)
  expect(await storedChoice(page)).toBe('0')

  // The expanded choice carries back to the first item too.
  await page.goto(`/${FIRST_ID.toLowerCase()}`)
  await expect(minimize(page)).toBeVisible()
  await expect(activity.locator('.activity-row').first()).toBeVisible()
})

test('on a phone the toggle collapses the panel in place to one horizontal row', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/${FIRST_ID.toLowerCase()}`)
  const activity = page.locator('.tracker__activity')
  await expect(activity.locator('.activity-row').first()).toBeVisible()

  await minimize(page).click()

  await expect(expand(page)).toBeVisible()
  await expect(activity.locator('.activity-row')).toHaveCount(0)
  // In place: still full width, and the label runs horizontally instead of
  // a tall vertical strip.
  const box = await activity.boundingBox()
  expect(box.width).toBeGreaterThan(300)
  const labelHeight = (await expand(page).locator('.tracker__activity-expand-label').boundingBox()).height
  expect(labelHeight).toBeLessThanOrEqual(30)
  const collapsed = await page.evaluate(() => {
    const button = document.querySelector('.tracker__activity-expand')
    const label = document.querySelector('.tracker__activity-expand-label')
    return {
      direction: getComputedStyle(button).flexDirection,
      writingMode: getComputedStyle(label).writingMode,
    }
  })
  expect(collapsed).toEqual({ direction: 'row', writingMode: 'horizontal-tb' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)

  await expand(page).click()
  await expect(activity.locator('.activity-row').first()).toBeVisible()
})
