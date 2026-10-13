// HZ-435 metric 4: a trivial item's page shows its lane, and the rows its lane
// skips read "Skipped — trivial lane", through the real server: the lane comes
// from the stored column via GET /api/items, not from a hand-built item. An
// unlabelled item beside it shows no badge and skips nothing.
//
// Both are seeded paused at Draft implementation plan, so nothing runs them.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { requiredStepIndex, STEPS } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const TRIVIAL = 'HZ-E2E-TRIVIAL'
const FULL = 'HZ-E2E-FULL-LANE'
const SKIPPED = [
  'Plan options & trade-offs (pros / cons)',
  'Approve the high-level design',
  'Architecture review',
  'Summarize reviews & recommend',
]
const PLAN = requiredStepIndex('Draft implementation plan')

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(TRIVIAL)) return
    insertItem(db, { id: TRIVIAL, title: 'E2E fixture — a trivial item', cursor: PLAN, paused: 1 })
    db.prepare("UPDATE work_item SET lane = 'trivial' WHERE id = ?").run(TRIVIAL)
    insertItem(db, { id: FULL, title: 'E2E fixture — an unlabelled item', cursor: PLAN, paused: 1 })
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const id of [TRIVIAL, FULL]) {
      db.prepare('DELETE FROM event WHERE item_id = ?').run(id)
      db.prepare('DELETE FROM work_item WHERE id = ?').run(id)
    }
  } finally {
    db.close()
  }
})

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${escape(label)}$`) }) })

async function expectTrivialLane(page) {
  await expect(page.locator('.tracker__meta').getByText('trivial', { exact: true })).toBeVisible({ timeout: 15_000 })
  for (const label of SKIPPED) {
    await expect(stepCard(page, label).getByText('Skipped — trivial lane')).toBeVisible()
  }
  await expect(stepCard(page, STEPS[PLAN].label).getByText(/Skipped/)).toHaveCount(0)
}

test('a trivial item shows its lane and its skipped rows, before and after a reload', async ({ page, request }) => {
  const items = (await (await request.get('/api/items')).json()).items
  expect(items.find((it) => it.id === TRIVIAL).lane).toBe('trivial')
  expect(items.find((it) => it.id === FULL).lane).toBeNull()

  await page.goto(`/${TRIVIAL.toLowerCase()}`)
  await expectTrivialLane(page)
  await stepCard(page, SKIPPED[0]).scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'trivial-lane-skipped-rows')

  await page.reload()
  await expectTrivialLane(page)
})

test('an unlabelled item shows no lane badge and skips nothing', async ({ page }) => {
  await page.goto(`/${FULL.toLowerCase()}`)
  await expect(stepCard(page, SKIPPED[0])).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('lane-badge')).toHaveCount(0)
  await expect(page.getByText('Skipped — trivial lane')).toHaveCount(0)
})
