// HO-844: "Accept with exceptions" end to end. A Task paused at Review &
// close whose stored Verify outcome is done_proof_incomplete, naming metric
// lines 2 and 3 as lacking proof, offers the button. The dialog lists both
// lines; Close stays disabled while a reason is blank or only spaces. With
// both reasons and the gate PIN the item closes, and the closed item lists
// both exceptions — after a reload too, so they come from the server, as
// GET /api/items shows.
//
// The spec sets its own gate PIN (earlier specs rotate it); setGatePinDirect
// locks the shared session, so the first gate request opens the PIN dialog,
// and afterAll verifies the shared session again for the specs after this one.

import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertVerifyOutcome, setGatePinDirect } from '../fixtures/seed.js'
import { TASK_REVIEW_CLOSE_GATE_INDEX, VERIFY_REPORT_STEP_INDEX, endIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'HZ-E2E-ACCEPT-EXCEPTIONS'
const GATE_PIN = '844844'
const LINES = ['The backfill job exits 0.', 'Every row has a region.', 'The dashboard shows the new totals.']
const METRIC = LINES.map((line, i) => `${i + 1}. ${line}`).join('\n')
const REASONS = { 2: 'Row counts were checked by hand in the SQL console.', 3: 'The dashboard needs the staging login; checked by the owner.' }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, {
        id: ID,
        title: 'E2E fixture — accept with exceptions',
        cursor: TASK_REVIEW_CLOSE_GATE_INDEX,
        kind: 'task',
        metric: METRIC,
        paused: 1,
      })
      insertVerifyOutcome(db, {
        itemId: ID,
        stepIndex: VERIFY_REPORT_STEP_INDEX,
        outcome: 'done_proof_incomplete',
        openLines: [2, 3],
        startedAt: '2026-11-01 10:00:00',
        endedAt: '2026-11-01 10:00:30',
      })
    }
    setGatePinDirect(db, 'admin@example.com', GATE_PIN)
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const itemFromServer = async (page) => {
  const res = await page.request.get('/api/items')
  return (await res.json()).items.find((it) => it.id === ID)
}

test('the owner closes the Task naming each open line with a reason, and the closed item lists them', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const button = page.getByRole('button', { name: 'Accept with exceptions' })
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()

  const dialog = page.getByRole('dialog', { name: 'Accept with exceptions' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`Line 2: ${LINES[1]}`)).toBeVisible()
  await expect(dialog.getByText(`Line 3: ${LINES[2]}`)).toBeVisible()
  await expect(dialog.getByText(`Line 1: ${LINES[0]}`)).toHaveCount(0)
  const close = dialog.getByRole('button', { name: 'Close with exceptions' })
  await expect(close).toBeDisabled()

  await dialog.getByLabel('Reason for metric line 2').fill(REASONS[2])
  await dialog.getByLabel('Reason for metric line 3').fill('   ')
  await expect(close).toBeDisabled()
  await dialog.getByLabel('Reason for metric line 3').fill(REASONS[3])
  await expect(close).toBeEnabled()
  await close.click()
  await answerPinDialog(page, GATE_PIN)
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const list = page.getByRole('region', { name: 'Accepted with exceptions' })
  const expected = [`Line 2: ${LINES[1]} — ${REASONS[2]}`, `Line 3: ${LINES[2]} — ${REASONS[3]}`]
  await expect(list.getByRole('listitem')).toHaveText(expected, { timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Accept with exceptions' })).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('region', { name: 'Accepted with exceptions' }).getByRole('listitem')).toHaveText(expected, { timeout: 15_000 })

  const item = await itemFromServer(page)
  expect(item.cursor).toBe(endIndex('task'))
  expect(item.exceptions.map((e) => [e.lineId, e.metricLine, e.reason])).toEqual([
    ['2', LINES[1], REASONS[2]],
    ['3', LINES[2], REASONS[3]],
  ])
})
