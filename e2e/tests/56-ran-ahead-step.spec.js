// HZ-561 metrics 1 and 2, on the real item payload: an item automated review
// sent back to "Specialist agent implements" shows the review step's last
// outcome and links that attempt's artifact, not the queued look.
//
// Both items sit paused at implement, so nothing dispatches. Item A's review
// ran once and rejected (fix_findings_json set, as the review-reject path
// leaves it); item B's review ran twice. insertItem has no field for
// fix_findings_json, so it is set with a direct UPDATE.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID_A = 'HZ-E2E-RANAHEAD-A'
const ID_B = 'HZ-E2E-RANAHEAD-B'
const REVIEW = STEPS[REVIEW_STEP_INDEX]
const FINDINGS = JSON.stringify([{ file: 'ui/src/App.jsx', summary: 'missing empty state' }])

function seedSentBack(db, id, attempts) {
  insertItem(db, { id, title: `E2E fixture — review sent ${id.slice(-1)} back to implement`, cursor: IMPLEMENT_STEP_INDEX, paused: 1 })
  db.prepare('UPDATE work_item SET fix_findings_json = ? WHERE id = ?').run(FINDINGS, id)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    insertStepRun(db, {
      itemId: id,
      stepIndex: REVIEW_STEP_INDEX,
      attempt,
      agent: REVIEW.agent,
      output: `review attempt ${attempt} rejected`,
      artifact: `## Verdict\n**fail**: marker-review-a${attempt}`,
      startedAt: `2026-10-20 10:0${attempt}:00`,
      endedAt: `2026-10-20 10:0${attempt}:30`,
    })
  }
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID_A)) return
    seedSentBack(db, ID_A, 1)
    seedSentBack(db, ID_B, 2)
  } finally {
    db.close()
  }
})

const reviewStep = (page) =>
  page.locator('.step', { has: page.locator('.step-card__label', { hasText: REVIEW.label }) })

test('a review that sent the item back shows its outcome and opens attempt 1’s artifact', async ({ page }) => {
  await page.goto(`/${ID_A.toLowerCase()}`)
  const step = reviewStep(page)
  await expect(step.locator('.step-card__meta')).toHaveText('Failed, sent back · attempt 1', { timeout: 15_000 })
  await expect(step.getByText('Queued', { exact: true })).toHaveCount(0)

  const link = step.getByRole('link', { name: 'View attempt 1 ↗' })
  const [artifact] = await Promise.all([page.waitForEvent('popup'), link.click()])
  await expect(artifact).toHaveURL(new RegExp(`/artifacts/${REVIEW_STEP_INDEX}/1$`))
  await expect(artifact.locator('article')).toContainText('marker-review-a1')
  await artifact.close()

  // From the server, not tab state: a reload shows the same.
  await page.reload()
  await expect(step.locator('.step-card__meta')).toHaveText('Failed, sent back · attempt 1', { timeout: 15_000 })
  await expect(step.getByRole('link', { name: 'View attempt 1 ↗' })).toHaveAttribute(
    'href',
    new RegExp(`/artifacts/${REVIEW_STEP_INDEX}/1$`),
  )

  // Metric 5: the sent-back item on desktop, then on phone.
  await step.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'ran-ahead-desktop')
  await page.setViewportSize({ width: 375, height: 667 })
  await step.scrollIntoViewIfNeeded()
  await expect(step.locator('.step-card__meta')).toBeVisible()
  await expect(step.getByRole('link', { name: 'View attempt 1 ↗' })).toBeVisible()
  await captureScreenshot(page, 'ran-ahead-phone')
})

test('with two review attempts it shows attempt 2 and opens attempt 2’s artifact', async ({ page }) => {
  await page.goto(`/${ID_B.toLowerCase()}`)
  const step = reviewStep(page)
  await expect(step.locator('.step-card__meta')).toHaveText('Failed, sent back · attempt 2', { timeout: 15_000 })

  const link = step.getByRole('link', { name: 'View attempt 2 ↗' })
  const [artifact] = await Promise.all([page.waitForEvent('popup'), link.click()])
  await expect(artifact).toHaveURL(new RegExp(`/artifacts/${REVIEW_STEP_INDEX}/2$`))
  await expect(artifact.locator('article')).toContainText('marker-review-a2')
  await expect(artifact.locator('article')).not.toContainText('marker-review-a1')
  // Earlier attempts stay reachable from the artifact page.
  await expect(artifact.locator('.attempts a', { hasText: 'attempt 1' })).toBeVisible()
})
