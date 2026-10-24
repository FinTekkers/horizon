// HZ-547 metric lines 1, 3 and 4: a closed Plan's filed items through the real
// server. The item page's "From Plan" pill opens the board filtered to that
// Plan (its open items, with the chip). The filter survives a reload. Clearing
// the chip drops `plan=` from the URL, and a reload does not bring it back.
// At 390px the board with the chip, a card with the From Plan chip and the
// item page with the pill all fit with no sideways scroll.
//
// Its own fixtures, seeded straight into the DB: a closed Plan that filed two
// open items (paused, so no mock agent moves them) and one closed item.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertSpawn } from '../fixtures/seed.js'
import { endIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PLAN = 'PF-PLAN'
const PLAN_TITLE = 'E2E fixture — adjusted cost basis'
const OPEN = ['PF-1', 'PF-2']
const CLOSED = 'PF-3'
const PHONE = { width: 390, height: 844 }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(PLAN)) return
    insertItem(db, { id: PLAN, title: PLAN_TITLE, cursor: endIndex('plan'), kind: 'plan' })
    const intake = requiredStepIndex('Approve & prioritize this work')
    for (const id of OPEN) insertItem(db, { id, title: `E2E fixture — filed item ${id}`, cursor: intake, paused: 1 })
    insertItem(db, { id: CLOSED, title: 'E2E fixture — filed item already shipped', cursor: endIndex('change') })
    ;[...OPEN, CLOSED].forEach((childId, seq) => insertSpawn(db, { parentId: PLAN, childId, requestKey: 'plan:pf', seq }))
  } finally {
    db.close()
  }
})

const planChip = (page) => page.locator('.board__plan-chip')
const cardIds = async (page) => (await page.locator('.card .card__id').allTextContents()).sort()
const planParam = (page) => new URL(page.url()).searchParams.get('plan')

async function expectFilteredBoard(page) {
  await expect(planChip(page)).toHaveText(`${PLAN} · ${PLAN_TITLE} ×`)
  await expect(page.locator('.card .card__id')).toHaveCount(OPEN.length)
  expect(await cardIds(page)).toEqual(OPEN)
  expect(planParam(page)).toBe(PLAN)
}

async function expectNoSideScroll(page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(scroll).toBeLessThanOrEqual(client)
}

test("the pill opens the closed Plan's board, which survives a reload until the chip is cleared", async ({ page }) => {
  await page.goto(`/${OPEN[0].toLowerCase()}`)
  const pill = page.getByRole('link', { name: `From Plan ${PLAN} · 1 of 3 done` })
  await expect(pill).toBeVisible()
  await captureScreenshot(page, 'plan-filter-item-pill-desktop')
  await pill.click()
  await expectFilteredBoard(page)
  await expect(page.locator('.board__meta')).toHaveText(`2 items from Plan ${PLAN}`)
  await captureScreenshot(page, 'plan-filter-board-desktop')

  await page.reload()
  await expectFilteredBoard(page)

  await page.getByRole('button', { name: 'Clear the Plan filter' }).click()
  await expect(planChip(page)).toHaveCount(0)
  expect(planParam(page)).toBeNull()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Plan' })).toBeVisible()
  await expect(planChip(page)).toHaveCount(0)
  expect(planParam(page)).toBeNull()
})

test('at 390px the chip, the card chip and the pill fit with no sideways scroll', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto(`/?plan=${PLAN}`)
  await expectFilteredBoard(page)
  await expect(page.getByRole('link', { name: `From Plan ${PLAN}`, exact: true }).first()).toBeVisible()
  await expectNoSideScroll(page)
  await captureScreenshot(page, 'plan-filter-board-phone')

  await page.goto(`/${OPEN[0].toLowerCase()}`)
  await expect(page.getByRole('link', { name: `From Plan ${PLAN} · 1 of 3 done` })).toBeVisible()
  await expectNoSideScroll(page)
  await captureScreenshot(page, 'plan-filter-item-pill-phone')
})
