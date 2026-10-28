// HZ-94: a paused item must say why it paused, end to end — not just in the
// unit tests for pauseReason.js/Tracker.jsx. These fixtures reproduce the
// exact pause-event text server/src/orchestrator.js's failFarmRun() writes
// (see its `reasonTag` and auto-retry event text), written directly to the
// DB like every other seed fixture in this suite (see fixtures/seed.js) so
// the item never gets kicked by the mock-agent farm before the assertions
// run — paused = 1 keeps it that way regardless.
//
// HZ-454: the other banner variants (unknown reason, required input
// incomplete, LS-98, HZ-366, HZ-373) only checked how the banner renders one
// event, so they live in ui/src/components/Tracker.pauseBanner.test.jsx. This
// spec keeps the one journey through the real server: banner, then Resume.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'PAUSE-1', title: 'E2E fixture — paused on turn_cap', cursor: 0, paused: 1 })
    // Two retries under the same reason, then the exhausted-budget pause —
    // mirrors orchestrator-auto-retry.test.mjs's AR-2 shape.
    insertEvent(db, {
      itemId: 'PAUSE-1',
      color: '#DFA200',
      text: 'transient failure (turn_cap): agent ran out of turns mid-step — auto-retrying (1/3)',
    })
    insertEvent(db, {
      itemId: 'PAUSE-1',
      color: '#DFA200',
      text: 'transient failure (turn_cap): agent ran out of turns mid-step — auto-retrying (2/3)',
    })
    insertEvent(db, {
      itemId: 'PAUSE-1',
      text: 'agent step failed (turn_cap): agent ran out of turns mid-step — auto-retry budget (3) exhausted; item paused, resume to retry',
    })
  } finally {
    db.close()
  }
})

test('a turn_cap pause states its category, cause and attempts used, alongside Resume and the activity feed', async ({
  page,
}) => {
  await page.goto('/pause-1')
  await expect(page.locator('.tracker__id')).toHaveText('PAUSE-1')

  const banner = page.locator('.pause-banner')
  await expect(banner.locator('.pause-banner__title')).toHaveText('Ran out of turns')
  await expect(banner.locator('.pause-banner__detail')).toContainText('agent ran out of turns mid-step')
  await expect(banner.locator('.pause-banner__meta')).toContainText('Auto-retried 2 times — retry budget exhausted')
  await expect(banner.locator('.pause-banner__meta')).toContainText('Resume to retry')

  // The banner adds explanation — it doesn't replace what was already there.
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
  await expect(page.locator('.activity-row__text').first()).toContainText('agent step failed')

  // Resuming clears the pause state, and the banner goes with it.
  await page.getByRole('button', { name: 'Resume work' }).click()
  await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.pause-banner')).toHaveCount(0)
})
