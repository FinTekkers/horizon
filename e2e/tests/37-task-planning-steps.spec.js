// HZ-383: a Task's three planning steps run and show their output on the
// existing step cards — the agent output link with the one-line summary, and
// the usual "View full artifact ↗" link — with no new UI. Demo mode runs them
// through the mock path, which returns an artifact for each.
//
// The fixture is seeded paused at Assess, so no mock agent starts it until
// this spec resumes it.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { kindStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'TK-E2E-1'
const ASSESS = kindStepIndex('Assess', 'task')
const LABELS = ['Assess', 'Run plan', 'Impact review']

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — a task plans its run', cursor: ASSESS, paused: 1, kind: 'task' })
  } finally {
    db.close()
  }
})

const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}$`) }) })

test("a task's planning steps run and each card shows its summary and artifact links", async ({ page, request }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  await page.getByRole('button', { name: 'Resume work' }).click()

  // The three steps run back to back; the last one to finish is Impact review.
  await expect(page.locator('.activity-row__text', { hasText: 'completed “Impact review”' })).toBeVisible({
    timeout: 15_000,
  })
  for (const label of LABELS) {
    await expect(stepCard(page, label).getByRole('link', { name: 'View full artifact ↗' })).toBeVisible()
    await expect(stepCard(page, label).getByRole('link', { name: 'See agent output ↗' })).toBeVisible()
  }
  // The one-line summary is in the activity feed, as for every other step.
  await expect
    .poll(async () => (await page.locator('.activity-row__text').allTextContents()).join('\n'))
    .toContain('assessed the task: found the scripts it needs; no new code needed (mock)')

  await captureScreenshot(page, 'task-planning-steps')

  // The Assess artifact link opens the stored artifact.
  const [artifactPage] = await Promise.all([
    page.waitForEvent('popup'),
    stepCard(page, 'Assess').getByRole('link', { name: 'View full artifact ↗' }).click(),
  ])
  await artifactPage.waitForLoadState()
  await expect(artifactPage.locator('article')).toContainText('Scripts found')
  await artifactPage.close()

  // The Run plan artifact carries its machine-readable block.
  const runPlanIndex = kindStepIndex('Run plan', 'task')
  const artifact = await request.get(`/api/items/${ID}/artifacts/${runPlanIndex}`)
  expect(artifact.ok()).toBeTruthy()
  expect(await artifact.text()).toContain('budget_minutes')

  // Still there after a reload.
  await page.reload()
  for (const label of LABELS) {
    await expect(stepCard(page, label).getByRole('link', { name: 'View full artifact ↗' })).toBeVisible({ timeout: 10_000 })
  }
})
