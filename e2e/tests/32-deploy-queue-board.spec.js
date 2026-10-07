// HZ-333: an item waiting in its deploy target's queue shows on the board as
// waiting for the next deploy of that target, with the time its window
// closes. The queue lives in the database (deploy_batch/deploy_queue_entry),
// so the label survives a reload. Rows are seeded directly, so the
// orchestrator never kicks the item; nothing here needs a gate PIN.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { DEPLOY_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'DQ-E2E-1'
const TITLE = 'E2E fixture — waiting in the deploy queue'
// Twenty minutes ahead, on a whole minute, in SQLite's UTC form.
const closes = new Date(Math.ceil((Date.now() + 20 * 60_000) / 60_000) * 60_000)
const closesSql = closes.toISOString().replace('T', ' ').slice(0, 19)
const closesHHMM = closes.toISOString().slice(11, 16)

test.use({ timezoneId: 'UTC' })

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: TITLE, cursor: DEPLOY_STEP_INDEX, repo: 'FinTekkers/horizon', pr: 990 })
    const batchId = db
      .prepare("INSERT INTO deploy_batch (target, repo, status, window_closes_at) VALUES ('horizon', 'FinTekkers/horizon', 'open', ?)")
      .run(closesSql).lastInsertRowid
    db.prepare("INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id) VALUES (?, 'horizon', ?, ?)").run(
      ID,
      'c'.repeat(40),
      batchId,
    )
  } finally {
    db.close()
  }
})

test('a queued item reads "waiting for next <target> deploy" with the window close time, before and after a reload', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.card', { has: page.locator('.card__title', { hasText: TITLE }) })
  const label = card.locator('.card__deploy-queue')
  await expect(label).toHaveText(`waiting for next horizon deploy · window closes ${closesHHMM}`, { timeout: 10_000 })
  await expect(label).toBeVisible()

  await page.reload()
  await expect(label).toHaveText(`waiting for next horizon deploy · window closes ${closesHHMM}`, { timeout: 10_000 })
})
