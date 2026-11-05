// HZ-731 metric 4, end to end: an item at Implement (a Task at Execute) held
// by a blocking ask reads Blocked on the board, and its page says what it
// waits for — the open ask by title, then the item that ask filed, as a
// link, until that item merges. Then the line and the Blocked pill are gone.
// Each state is seeded straight into the DB, as File it and the merge leave
// it, and read after a reload; nothing kicks these items, so none runs.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, insertAsk, insertAskReview, insertDependency } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX, EXECUTE_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ARCH = requiredStepIndex('Architecture review')
const ID = 'HZ-E2E-HOLD'
const TASK_ID = 'HZ-E2E-HOLD-TASK'
const FILED_ID = 'HZ-E2E-HOLD-PREREQ'
const ASK_TITLE = 'Land the schema migration first'
const IMPLEMENT = STEPS[IMPLEMENT_STEP_INDEX].label
const EXECUTE = STEPS[EXECUTE_STEP_INDEX].label

// An open blocking ask, reviewed so the review sweep (HZ-729) leaves it be.
function seedAsk(db, itemId) {
  const stepRunId = insertStepRun(db, {
    itemId,
    stepIndex: ARCH,
    attempt: 1,
    agent: 'Architect',
    output: 'reviewed',
    artifact: '## Verdict\n**pass**',
    startedAt: '2026-11-05 09:00:00',
    endedAt: '2026-11-05 09:05:00',
  })
  const askId = insertAsk(db, { itemId, stepRunId, stepIndex: ARCH, kind: 'blocking', title: ASK_TITLE, why: 'the migration must land first' })
  insertAskReview(db, { askId, verdict: 'escalate', reasons: ['Needs the owner’s call.'] })
  return askId
}

function withDb(fn) {
  const db = openDb(DB_PATH)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

test.beforeAll(() =>
  withDb((db) => {
    if (db.prepare('SELECT id FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — Implement held by a blocking ask', cursor: IMPLEMENT_STEP_INDEX })
    insertItem(db, { id: TASK_ID, title: 'E2E fixture — Execute held by a blocking ask', cursor: EXECUTE_STEP_INDEX, kind: STEPS[EXECUTE_STEP_INDEX].itemKind })
    insertItem(db, { id: FILED_ID, title: ASK_TITLE, cursor: 6 })
    seedAsk(db, ID)
    seedAsk(db, TASK_ID)
  }),
)

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })
const holdLine = (page) => page.getByRole('alert', { name: 'Blocking asks' }).getByTestId('ask-start-hold')

test('Implement waits for the open ask, then for the item it filed, and both the line and Blocked clear once that item merges', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(card(page, ID).locator('.status-pill')).toHaveText('Blocked')

  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expect(holdLine(page)).toHaveText(`Waiting for ask “${ASK_TITLE}” before “${IMPLEMENT}”`)
  await expect(holdLine(page)).not.toContainText(/\bstep \d+\b/i)
  await testInfo.attach('hold-open-ask', { body: await holdLine(page).screenshot(), contentType: 'image/png' })

  // File it: the ask is filed and the new item is a dependency.
  withDb((db) => {
    db.prepare("UPDATE ask SET status = 'filed', filed_item_id = ?, resolved_by = 'Owner' WHERE item_id = ? AND kind = 'blocking'").run(FILED_ID, ID)
    insertDependency(db, { itemId: ID, dependsOnId: FILED_ID })
  })
  await page.reload()
  await expect(holdLine(page)).toHaveText(`Waiting for ${FILED_ID} to merge or close before “${IMPLEMENT}”`)
  await expect(holdLine(page).getByRole('link', { name: FILED_ID })).toBeVisible()
  await expect(page.getByText(`This item needs “${ASK_TITLE}” filed first`)).toHaveCount(0)
  await testInfo.attach('hold-filed-item', { body: await holdLine(page).screenshot(), contentType: 'image/png' })

  // The filed item merges.
  withDb((db) => db.prepare("UPDATE work_item SET merged_at = datetime('now') WHERE id = ?").run(FILED_ID))
  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expect(page.getByTestId('ask-start-hold')).toHaveCount(0)
  await page.goto('/')
  await expect(card(page, ID)).toBeVisible()
  await expect(card(page, ID).locator('.status-pill')).not.toHaveText('Blocked')
})

test('a Task at Execute shows the same hold, by the step’s name', async ({ page }) => {
  await page.goto(`/${TASK_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(TASK_ID)
  await expect(holdLine(page)).toHaveText(`Waiting for ask “${ASK_TITLE}” before “${EXECUTE}”`)
  await page.goto('/')
  await expect(card(page, TASK_ID).locator('.status-pill')).toHaveText('Blocked')
})
