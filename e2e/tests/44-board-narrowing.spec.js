// HZ-443: the board's Waiting on me, Priority and Kind controls through the
// real server — waiting_since from SQLite rows (a gate's last run end, a rule
// block's blockedAt, a pause's paused_at), parsed by the browser, sorted, and
// every choice still there after a real page reload, with the wait measured
// from the server's time rather than restarted by the reload.
//
// Rows are seeded directly (fixtures/seed.js), so the orchestrator never kicks
// them. One test: the suite shares one time budget.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const STORAGE_KEY = 'horizon.boardView'

// SQLite's own datetime('now') form: UTC, no zone suffix.
const sqliteAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  if (STEPS[ACCEPT_GATE_INDEX].kind !== 'gate' || STEPS[ACCEPT_GATE_INDEX].phase !== STEPS[IMPLEMENT_STEP_INDEX].phase) {
    throw new Error('44-board-narrowing: Accept and implement no longer share a board column')
  }
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get('WN-GATE')) return
    // Every fixture is a Low, trivial change, so one Priority and one Kind chip
    // narrow the board to these four whatever other specs have seeded.
    const seed = (id, title, cursor, extra = {}) => {
      insertItem(db, { id, title: `E2E fixture — ${title}`, cursor, priority: PRIORITY.LOW, ...extra })
      db.prepare("UPDATE work_item SET lane = 'trivial' WHERE id = ?").run(id)
    }
    seed('WN-GATE', 'waiting at a gate', ACCEPT_GATE_INDEX)
    insertStepRun(db, { itemId: 'WN-GATE', stepIndex: ACCEPT_GATE_INDEX - 1, attempt: 1, agent: 'Eng', startedAt: sqliteAgo(330), endedAt: sqliteAgo(310) })

    seed('WN-RULE', 'blocked by a rule', IMPLEMENT_STEP_INDEX)
    db.prepare("UPDATE work_item SET rule_block_json = json_object('rule', 'guardrail 1', 'needs', 'A release.', 'runId', 1, 'blockedAt', ?) WHERE id = ?").run(
      sqliteAgo(190),
      'WN-RULE',
    )

    seed('WN-PAUSED', 'paused', IMPLEMENT_STEP_INDEX, { paused: 1 })
    db.prepare('UPDATE work_item SET paused_at = ? WHERE id = ?').run(sqliteAgo(70), 'WN-PAUSED')

    seed('WN-RUNNING', 'agent running', IMPLEMENT_STEP_INDEX)
    insertStepRun(db, { itemId: 'WN-RUNNING', stepIndex: IMPLEMENT_STEP_INDEX, attempt: 1, agent: 'Eng', status: 'active', startedAt: sqliteAgo(20) })
  } finally {
    db.close()
  }
})

const fixtureIds = async (page) =>
  (await page.locator('.card .card__id').allTextContents()).filter((id) => id.startsWith('WN-'))
const waitOf = (page, id) =>
  page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) }).locator('.card__waiting')
const chip = (page, group, name) => page.getByRole('group', { name: group }).getByRole('button', { name, exact: true })

test('Waiting on me, a Priority and a Kind narrow and sort the board, and every choice survives a reload', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY)
  await page.reload()
  await expect(page.getByText('E2E fixture — agent running')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Waiting on me', exact: true }).click()
  await chip(page, 'Priority', PRIORITY.LOW).click()
  await chip(page, 'Kind', 'Trivial').click()
  await expect(page.getByText('E2E fixture — agent running')).toHaveCount(0)
  await expect.poll(() => fixtureIds(page)).toEqual(['WN-GATE', 'WN-RULE', 'WN-PAUSED'])
  await expect(waitOf(page, 'WN-GATE')).toHaveText('waiting 5h')
  await expect(waitOf(page, 'WN-RULE')).toHaveText('waiting 3h')
  await expect(waitOf(page, 'WN-PAUSED')).toHaveText('waiting 1h')

  await page.getByRole('button', { name: 'Longest wait' }).click()
  await expect.poll(() => fixtureIds(page)).toEqual(['WN-PAUSED', 'WN-RULE', 'WN-GATE'])

  await page.reload()
  await expect(waitOf(page, 'WN-PAUSED')).toHaveText('waiting 1h', { timeout: 10_000 })
  for (const button of [page.getByRole('button', { name: 'Waiting on me', exact: true }), chip(page, 'Priority', PRIORITY.LOW), chip(page, 'Kind', 'Trivial')]) {
    await expect(button).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(page.getByRole('button', { name: 'Most recent' })).toBeVisible()
  await expect.poll(() => fixtureIds(page)).toEqual(['WN-PAUSED', 'WN-RULE', 'WN-GATE'])
  await expect(waitOf(page, 'WN-GATE')).toHaveText('waiting 5h')
  await expect(waitOf(page, 'WN-RULE')).toHaveText('waiting 3h')
  await expect(page.getByText('E2E fixture — agent running')).toHaveCount(0)

  // HZ-601: each choice is one removable chip, and Filters · N counts them.
  // Removing a chip clears only its own filter.
  const bar = page.getByRole('group', { name: 'Active filters' })
  await expect(bar.locator('.board__chip-label')).toHaveText(['Waiting on me', `Priority: ${PRIORITY.LOW}`, 'Kind: Trivial'])
  await expect(bar.locator('.board__filterbar-count')).toHaveText('Filters · 3')
  await bar.getByRole('button', { name: `Remove Priority: ${PRIORITY.LOW} filter` }).click()
  await expect(bar.locator('.board__chip-label')).toHaveText(['Waiting on me', 'Kind: Trivial'])
  await expect(bar.locator('.board__filterbar-count')).toHaveText('Filters · 2')
  await expect(chip(page, 'Priority', PRIORITY.LOW)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('E2E fixture — agent running')).toHaveCount(0)
  await bar.getByRole('button', { name: 'Remove Waiting on me filter' }).click()
  await bar.getByRole('button', { name: 'Remove Kind: Trivial filter' }).click()
  await expect(page.locator('.board__chip')).toHaveCount(0)
  await expect(page.getByText('E2E fixture — agent running')).toBeVisible()

  // Leave the shared board as other specs expect it.
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY)
})
