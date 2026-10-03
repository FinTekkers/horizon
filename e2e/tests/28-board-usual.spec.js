// HZ-230: an active Board card shows how long its step usually takes after the
// HZ-228 elapsed label ('8m · usually ~10m'), and 'running long' past twice
// that. The real chain end to end: step_run history, through the server's
// durationEstimates (HZ-229) on the snapshot, into the card — ticked by the
// Board's one clock with no reload, and surviving one.
//
// Rows are seeded directly (fixtures/seed.js), so the orchestrator never
// kicks them. The deploy step, not spec 26's summary step, so that spec's
// fixtures stay untouched; 20 runs fill the estimate's whole sample window,
// so a mock agent's short run elsewhere in the suite can't move the median.
// One consolidated journey: the suite shares one time budget.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, DEPLOY_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SAMPLES = 20

// SQLite's own datetime('now') form: UTC, no zone suffix.
const sqliteAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  if (STEPS[DEPLOY_STEP_INDEX].kind !== 'agent') {
    throw new Error('28-board-usual: DEPLOY_STEP_INDEX no longer points at an agent step')
  }
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get('US-ACTIVE')) return
    // Closed history: 20 finished 10-minute deploys.
    insertItem(db, { id: 'US-HISTORY', title: 'E2E fixture — usual duration history', cursor: STEPS.length })
    for (let attempt = 1; attempt <= SAMPLES; attempt++) {
      const start = 200 + attempt * 15
      insertStepRun(db, {
        itemId: 'US-HISTORY',
        stepIndex: DEPLOY_STEP_INDEX,
        attempt,
        agent: 'DevOps',
        startedAt: sqliteAgo(start),
        endedAt: sqliteAgo(start - 10),
      })
    }
    insertItem(db, { id: 'US-ACTIVE', title: 'E2E fixture — usual duration active', cursor: DEPLOY_STEP_INDEX })
    insertStepRun(db, { itemId: 'US-ACTIVE', stepIndex: DEPLOY_STEP_INDEX, attempt: 1, agent: 'DevOps', status: 'active', startedAt: sqliteAgo(8) })
  } finally {
    db.close()
  }
})

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

test('an active card shows the usual time, turns to running long past twice it, and keeps that across a reload', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  const elapsed = card(page, 'US-ACTIVE').locator('.card__elapsed')
  await expect(elapsed).toHaveText(/· [89]m · usually ~10m$/, { timeout: 10_000 })
  await expect(elapsed.locator('.card__usual--long')).toHaveCount(0)
  expect(await elapsed.textContent()).not.toMatch(/\b(left|remaining|ETA|done in)\b/i)

  // 8m in, past 2 × 10m.
  await page.clock.fastForward('14:00')
  await expect(elapsed).toHaveText(/· 2[23]m · running long$/)
  await expect(elapsed.locator('.card__usual')).toHaveClass(/card__usual--long/)
  expect(await elapsed.textContent()).not.toMatch(/\b(left|remaining|ETA|done in)\b/i)

  await page.reload()
  await expect(elapsed).toHaveText(/· 2\dm · running long$/, { timeout: 10_000 })
})
