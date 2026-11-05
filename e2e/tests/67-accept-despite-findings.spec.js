// HZ-710: "Accept despite review findings" end to end. An item the automated
// review sent back to "Specialist agent implements" lists the findings it
// would accept despite, next to the button. Confirming with the gate PIN moves
// it to "Accept the code" — an approve logged as a move — where it still waits
// for a human: nothing merges. A reload shows the same, from the server.
//
// The item sits paused at implement, so nothing dispatches. The spec sets its
// own gate PIN (earlier specs rotate it); setGatePinDirect locks the shared
// session, so the first gate request opens the PIN dialog, and afterAll
// verifies the shared session again for the specs after this one.

import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'HZ-E2E-ACCEPT-DESPITE'
const GATE_PIN = '710710'
const FINDING = { file: 'server/src/report.js', line: 42, detail: 'the export skips the header row' }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — accept despite review findings', cursor: IMPLEMENT_STEP_INDEX, paused: 1 })
      db.prepare('UPDATE work_item SET fix_findings_json = ?, review_cycle_count = 1 WHERE id = ?').run(JSON.stringify([FINDING]), ID)
      insertStepRun(db, {
        itemId: ID,
        stepIndex: REVIEW_STEP_INDEX,
        attempt: 1,
        agent: STEPS[REVIEW_STEP_INDEX].agent,
        output: 'review rejected',
        artifact: '## Verdict\n**fail**: the export skips the header row',
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

test('the findings show before the PIN, and the item lands at Accept the code, not merged', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const button = page.getByRole('button', { name: 'Accept despite review findings' })
  await expect(button).toBeVisible({ timeout: 15_000 })
  const findings = page.getByRole('list', { name: 'Outstanding review findings' })
  await expect(findings.getByRole('listitem')).toHaveText([`${FINDING.file}:${FINDING.line} — ${FINDING.detail}`])

  await button.click()
  await answerPinDialog(page, GATE_PIN)
  await expect(page.getByText(/Forwarded by .* with the failing review/)).toBeVisible({ timeout: 15_000 })

  await page.reload()
  await expect(page.getByText(/Forwarded by .* with the failing review/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Accept despite review findings' })).toHaveCount(0)
  const item = await itemFromServer(page)
  expect(item.cursor).toBe(ACCEPT_GATE_INDEX)
  expect(item.currentStepKey).toBe('change.accept-code')
  expect(item.merged_at ?? null).toBeNull()
})
