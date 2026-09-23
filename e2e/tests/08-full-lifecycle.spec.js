import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
// Derived, not hardcoded — see global-setup.js's E2E-4 fixture for the same pattern.
import { STEPS } from '../../server/src/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB

const GATES = [
  'Approve & prioritize this work',
  'Approve the high-level design',
  'Review before execution',
  'Accept the code',
  'Review the work & close',
]

test('one item travels the full lifecycle from creation to closed', async ({ request, page }) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E full lifecycle',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  const { id } = await res.json()

  await page.goto(`/${id.toLowerCase()}`)

  for (const label of GATES) {
    await expect(page.locator('.step-card--awaiting')).toContainText(label, { timeout: 15_000 })
    await page.locator('.btn-gate-approve').click()
    // Each approve now pauses on the explicit confirm dialog (HZ-38) before
    // the request fires — it must name this exact gate, not a generic one.
    await expect(page.locator('.composer__sub')).toContainText(label)
    await page.locator('.composer__submit').click()
  }

  // Approving the closing gate ('Review the work & close') is the one that
  // finishes the item — it must bounce the user back to the board (HZ-62)
  // rather than stranding them on a now-closed item page.
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.locator('.status-pill')).toContainText('Closed')

  await captureScreenshot(page, 'full-lifecycle')
})

test('approving the closing gate with comments also returns to the board', async ({ page }) => {
  // "Approve with comments" is a second, independent call site (App.jsx's
  // ComposerModal path, distinct from the plain-approve confirm dialog above)
  // — it must be wired to the same post-approval navigation.
  const id = 'FINAL-GATE-COMMENTS'
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id, title: 'E2E final gate via approve-with-comments', cursor: STEPS.length - 1 })
  } finally {
    db.close()
  }

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Review the work & close', { timeout: 10_000 })
  await page.locator('.btn-gate-feedback').click()
  await page.locator('.composer__input').fill('Ship it.')
  await page.locator('.composer__submit').click()

  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.locator('.status-pill')).toContainText('Closed')
})
