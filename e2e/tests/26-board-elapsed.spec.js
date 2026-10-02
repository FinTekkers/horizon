// HZ-228: every active Board card shows how long it has been in its current
// state. The real chain end to end: a SQLite-format step_run time, through
// listItems' state_since, parsed by a browser in a non-UTC zone (local-time
// parsing would be hours off), ticked by the Board's one clock with no
// reload. Plus the layout guardrail (one line, no overflow, in both themes and
// on a phone) and no timer on paused or closed cards.
//
// Rows are seeded directly (fixtures/seed.js), so the orchestrator never
// kicks them. Two consolidated journeys: the suite shares one time budget.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PHONE = { width: 375, height: 667 }
const GATE_INDEX = IMPLEMENT_STEP_INDEX - 1
// The PM's summary step: its elapsed name is one of the longest.
const SUMMARY_INDEX = GATE_INDEX - 1

// SQLite's own datetime('now') form: UTC, no zone suffix.
const sqliteAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace('T', ' ').slice(0, 19)

test.use({ timezoneId: 'America/New_York' })

test.beforeAll(() => {
  if (STEPS[GATE_INDEX].kind !== 'gate' || STEPS[SUMMARY_INDEX].kind !== 'agent') {
    throw new Error('26-board-elapsed: fixture step indexes no longer point at a gate and an agent step')
  }
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get('EL-GATE')) return
    insertItem(db, { id: 'EL-GATE', title: 'E2E fixture — elapsed at a gate', cursor: GATE_INDEX })
    insertStepRun(db, { itemId: 'EL-GATE', stepIndex: SUMMARY_INDEX, attempt: 1, agent: 'PM', startedAt: sqliteAgo(40), endedAt: sqliteAgo(25) })

    insertItem(db, { id: 'EL-LONG', title: 'E2E fixture — elapsed long label', cursor: SUMMARY_INDEX })
    insertStepRun(db, { itemId: 'EL-LONG', stepIndex: SUMMARY_INDEX, attempt: 1, agent: 'PM', status: 'active', startedAt: sqliteAgo(65) })

    insertItem(db, { id: 'EL-PAUSED', title: 'E2E fixture — elapsed paused', cursor: IMPLEMENT_STEP_INDEX, paused: 1 })
    insertStepRun(db, { itemId: 'EL-PAUSED', stepIndex: IMPLEMENT_STEP_INDEX, attempt: 1, agent: 'Eng', status: 'active', startedAt: sqliteAgo(10) })

    insertItem(db, { id: 'EL-CLOSED', title: 'E2E fixture — elapsed closed', cursor: STEPS.length })
    insertStepRun(db, { itemId: 'EL-CLOSED', stepIndex: STEPS.length - 2, attempt: 1, agent: 'DevOps', startedAt: sqliteAgo(30), endedAt: sqliteAgo(20) })
  } finally {
    db.close()
  }
})

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })
const minutesOf = (text) => Number(/· (\d+)m$/.exec(text)?.[1])

test('a gate card shows the server-derived time in a non-UTC browser, ticks each minute without a reload, and survives one', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('/')
  const elapsed = card(page, 'EL-GATE').locator('.card__elapsed')
  await expect(elapsed).toHaveText(/^Waiting on you · 2[456]m$/, { timeout: 10_000 })
  const first = minutesOf(await elapsed.textContent())

  await page.clock.fastForward('01:00')
  await expect(elapsed).toHaveText(`Waiting on you · ${first + 1}m`)

  await page.reload()
  await expect(elapsed).toHaveText(/^Waiting on you · 2[4-7]m$/, { timeout: 10_000 })
  expect(minutesOf(await elapsed.textContent())).toBeGreaterThanOrEqual(first)
})

test('the elapsed line stays on one line at card width in light, dark and phone layouts; paused and closed cards show none', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.board__filter-chip', { hasText: 'Closed' }).click()
  const long = card(page, 'EL-LONG')
  await expect(long.locator('.card__elapsed')).toHaveText('Summarizing reviews · 1h 05m', { timeout: 10_000 })

  await expect(card(page, 'EL-PAUSED')).toBeVisible()
  await expect(card(page, 'EL-PAUSED').locator('.card__elapsed')).toHaveCount(0)
  await expect(card(page, 'EL-CLOSED')).toBeVisible()
  await expect(card(page, 'EL-CLOSED').locator('.card__elapsed')).toHaveCount(0)

  async function expectOneLine(label) {
    const line = long.locator('.card__elapsed')
    const { scroll, client, height, lineHeight } = await line.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5,
    }))
    expect(scroll, `${label}: elapsed line overflows`).toBeLessThanOrEqual(client)
    expect(height, `${label}: elapsed line wraps`).toBeLessThanOrEqual(lineHeight + 1)
    // The status row is untouched: as tall as with the elapsed line hidden.
    const rowHeights = await long.evaluate((el) => {
      const row = () => el.querySelector('.card__status-row').getBoundingClientRect().height
      const elapsedLine = el.querySelector('.card__elapsed')
      const shown = row()
      elapsedLine.style.display = 'none'
      const hidden = row()
      elapsedLine.style.display = ''
      return { shown, hidden }
    })
    expect(rowHeights.shown, `${label}: status row height changed`).toBe(rowHeights.hidden)
  }

  await expectOneLine('light')
  await page.locator('.topbar__avatar').click()
  await page.getByRole('switch', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('.usermenu__scrim').click()
  await expectOneLine('dark')
  await captureScreenshot(page, 'board-elapsed-dark')

  await page.setViewportSize(PHONE)
  await long.scrollIntoViewIfNeeded()
  await expectOneLine('phone')

  // Leave the shared storage state as other specs expect it: light mode.
  await page.setViewportSize({ width: 1024, height: 640 })
  await page.locator('.topbar__avatar').click()
  await page.getByRole('switch', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
})
