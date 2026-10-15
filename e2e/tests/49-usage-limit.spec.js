// HZ-422: what a usage limit leaves on the item page, end to end through the
// real server. One item waits for every model's limit to reset; another's
// Architecture review ran on a fallback model. Both are seeded straight into
// the DB (fixtures/seed.js), and the texts must survive a reload, which proves
// they come from the database rather than client state. The wait is far in the
// future and the second item sits at a gate, so the mock farm never kicks either.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const WAIT_ID = 'UL-E2E-1'
const FELL_ID = 'UL-E2E-2'
const IMPLEMENT = requiredStepIndex('Specialist agent implements')
const ARCH = requiredStepIndex('Architecture review')
const GATE = requiredStepIndex('Review before execution')
const WAIT_TEXT = 'Waiting for usage limits to reset, earliest 2099-01-01 14:00 UTC'
const NOTE = 'fell back from Claude · Opus 5.5: usage limit until 2026-10-12 14:00 UTC'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(WAIT_ID)) return
    insertItem(db, { id: WAIT_ID, title: 'E2E fixture — every model usage-limited', cursor: IMPLEMENT })
    db.prepare('UPDATE work_item SET usage_wait_until = ? WHERE id = ?').run('2099-01-01T14:00:00.000Z', WAIT_ID)

    insertItem(db, { id: FELL_ID, title: 'E2E fixture — ran on a fallback model', cursor: GATE })
    const runId = insertStepRun(db, {
      itemId: FELL_ID,
      stepIndex: ARCH,
      attempt: 1,
      agent: STEPS[ARCH].agent,
      output: 'architecture review done',
      startedAt: '2026-10-12 12:00:00',
      endedAt: '2026-10-12 12:30:00',
    })
    db.prepare(
      "UPDATE step_run SET provider = 'muse', model = 'muse-spark-1.3', fallback_from = 'claude:claude-opus-5-5', fallback_reset_at = '2026-10-12T14:00:00.000Z' WHERE id = ?",
    ).run(runId)
  } finally {
    db.close()
  }
})

const stepCard = (page, index) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: STEPS[index].label }) })

test('an item whose every model is usage-limited says it is waiting for the reset, after a reload too', async ({ page }) => {
  await page.goto(`/${WAIT_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(WAIT_ID)
  await expect(page.getByText(WAIT_TEXT)).toBeVisible({ timeout: 10_000 })
  await captureScreenshot(page, 'usage-limit-wait')

  await page.reload()
  await expect(page.getByText(WAIT_TEXT)).toBeVisible({ timeout: 10_000 })
})

test('a step that ran on a fallback model names the model and what it fell back from, after a reload too', async ({ page }) => {
  await page.goto(`/${FELL_ID.toLowerCase()}`)
  const provider = stepCard(page, ARCH).locator('.step-card__provider')
  await expect(provider.getByText('Ran on Muse (muse-spark-1.3)')).toBeVisible({ timeout: 10_000 })
  await expect(provider.getByText(NOTE)).toBeVisible()

  await page.reload()
  await expect(stepCard(page, ARCH).locator('.step-card__provider').getByText(NOTE)).toBeVisible({ timeout: 10_000 })
})
