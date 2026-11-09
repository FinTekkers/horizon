// HZ-820 metric 5, end to end: a soft ask Horizon dismissed when its item
// closed shows on the item page under "Closed with the item", with the reason
// and File it but no Dismiss. Filing it from there files the ask, and after a
// reload it is gone from the list and the row reads filed. It never shows on
// /follow-ups, which lists open asks only.
//
// The item has no repo, so File it files a local item (spawn.js demo mode):
// the suite runs with no GitHub token.

import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertProjectRepo, insertStepRun, insertAsk, insertAskReview, setGatePinDirect } from '../fixtures/seed.js'
import { endIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN (23-project-enabled); this spec sets its own.
const GATE_PIN = '820417'
const ID = 'HZ-E2E-PARENT-CLOSED'
// Unique to this spec, so project_repo's UNIQUE columns never clash.
const REPO = 'E2E-Org/parent-closed-asks'
const ARCH = requiredStepIndex('Architecture review')
const ASK_TITLE = 'Document the ledger export format'
const REASON = 'Parent item closed'

function withDb(fn) {
  const db = openDb(DB_PATH)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

let askId = null

test.beforeAll(() =>
  withDb((db) => {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    const existing = db.prepare('SELECT id FROM ask WHERE item_id = ?').get(ID)
    if (existing) {
      askId = existing.id
      return
    }
    const project = insertProject(db, { name: 'E2E Parent closed asks' })
    insertProjectRepo(db, { projectId: project, repo: REPO, prefix: 'EPC' })
    insertItem(db, { id: ID, title: 'E2E fixture — a closed item with a soft ask', cursor: endIndex('change'), project_id: project })
    const stepRunId = insertStepRun(db, {
      itemId: ID,
      stepIndex: ARCH,
      attempt: 1,
      agent: 'Architect',
      output: 'reviewed',
      artifact: '## Verdict\n**pass**',
      startedAt: '2026-11-08 09:00:00',
      endedAt: '2026-11-08 09:05:00',
    })
    askId = insertAsk(db, { itemId: ID, stepRunId, stepIndex: ARCH, title: ASK_TITLE, repo: REPO, why: 'the export format is undocumented' })
    // As the close left it: dismissed by Horizon with the parent reason.
    db.prepare("UPDATE ask SET status = 'dismissed', resolved_by = 'Horizon', dismiss_reason = ?, resolved_at = datetime('now') WHERE id = ?").run(REASON, askId)
    insertAskReview(db, { askId, verdict: 'accept', reasons: ['Fits the project rules.'] })
  }),
)

// Any project_repo row left behind is polled for the rest of the suite.
test.afterAll(() => withDb((db) => db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)))

const closedList = (page) => page.getByRole('region', { name: 'Suggested follow-ups' }).getByRole('list', { name: 'Closed with the item' })

test('the closed ask is not on /follow-ups; on the item page it can be filed, and after a reload it reads filed', async ({ page }, testInfo) => {
  await page.goto('/follow-ups')
  await expect(page.locator('.follow-ups')).toBeVisible()
  await expect(page.locator('.follow-ups')).not.toContainText(ASK_TITLE)

  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  const followUps = page.getByRole('region', { name: 'Suggested follow-ups' })
  await expect(followUps).toContainText('Closed with the item')
  const card = closedList(page).getByTestId('ask-card').filter({ hasText: ASK_TITLE })
  await expect(card).toHaveCount(1)
  await expect(card).toContainText(`Closed: ${REASON}`)
  await expect(card.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  const fileIt = card.getByRole('button', { name: 'File it' })
  await expect(fileIt).toBeEnabled()
  await testInfo.attach('closed-with-the-item', { body: await followUps.screenshot(), contentType: 'image/png' })

  await fileIt.click()
  await answerPinDialog(page, GATE_PIN)
  await expect(page.getByTestId('parent-closed-ask-row')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expect(page.getByTestId('parent-closed-ask-row')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Suggested follow-ups' })).toHaveCount(0)
  const row = withDb((db) => db.prepare('SELECT status, filed_item_id FROM ask WHERE id = ?').get(askId))
  expect(row.status).toBe('filed')
  expect(row.filed_item_id).toBeTruthy()
})
