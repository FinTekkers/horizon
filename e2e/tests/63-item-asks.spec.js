// HZ-728 metric 5, end to end: the item page lists the item's open asks —
// kind, title and why — read-only, with agent-written text rendered as text.
// A superseded ask is not shown, and an item with no open asks has no panel.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, insertAsk } from '../fixtures/seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'HZ-E2E-ASKS'
const EMPTY_ID = 'HZ-E2E-NO-ASKS'
const ARCH = requiredStepIndex('Architecture review')
const QA_PLAN = requiredStepIndex('QA reviews the test plan')
const SCRIPT_TITLE = '<script>alert(1)</script>'

const BLOCKING = { kind: 'blocking', title: 'Publish script must use the bot identity', why: "Architecture review: 'commits under the owner identity'" }
const SOFT = { kind: 'soft', title: SCRIPT_TITLE, why: "Architecture review: 'escape <b>this</b> too'" }
const SUPERSEDED = { kind: 'soft', status: 'superseded', title: 'An ask from an earlier run', why: "Architecture review: 'old'" }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT id FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — an item with open asks', cursor: QA_PLAN })
      const stepRunId = insertStepRun(db, {
        itemId: ID,
        stepIndex: ARCH,
        attempt: 1,
        agent: 'Architect',
        output: 'reviewed',
        artifact: '## Verdict\n**pass**',
        startedAt: '2026-11-03 09:00:00',
        endedAt: '2026-11-03 09:05:00',
      })
      for (const ask of [SUPERSEDED, BLOCKING, SOFT]) insertAsk(db, { itemId: ID, stepRunId, stepIndex: ARCH, ...ask })
    }
    if (!db.prepare('SELECT id FROM work_item WHERE id = ?').get(EMPTY_ID)) {
      insertItem(db, { id: EMPTY_ID, title: 'E2E fixture — an item with no open asks', cursor: QA_PLAN })
    }
  } finally {
    db.close()
  }
})

async function expectAsks(page) {
  const panel = page.getByRole('region', { name: 'Asks' })
  await expect(panel).toBeVisible()
  const rows = panel.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  // Newest first: the soft ask was stored last.
  await expect(rows.nth(0)).toContainText('Soft')
  await expect(rows.nth(0)).toContainText(SCRIPT_TITLE)
  await expect(rows.nth(0)).toContainText(SOFT.why)
  await expect(rows.nth(1)).toContainText('Blocking')
  await expect(rows.nth(1)).toContainText(BLOCKING.title)
  await expect(rows.nth(1)).toContainText(BLOCKING.why)
  await expect(panel).not.toContainText(SUPERSEDED.title)
  // Read-only: nothing to file, dismiss or edit.
  for (const role of ['button', 'textbox', 'link', 'checkbox', 'combobox']) await expect(panel.getByRole(role)).toHaveCount(0)
  // Agent text is text: no element was made from it.
  await expect(panel.locator('script, b')).toHaveCount(0)
  return panel
}

test('the item page lists open asks with kind, title and why, read-only and escaped, across a reload', async ({ page }, testInfo) => {
  let alerted = false
  page.on('dialog', async (dialog) => {
    alerted = true
    await dialog.dismiss()
  })
  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  const panel = await expectAsks(page)
  await testInfo.attach('item-page-asks', { body: await panel.screenshot(), contentType: 'image/png' })

  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expectAsks(page)
  expect(alerted).toBe(false)
})

test('an item with no open asks shows no asks panel', async ({ page }) => {
  await page.goto(`/${EMPTY_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(EMPTY_ID)
  await expect(page.getByRole('region', { name: 'Asks' })).toHaveCount(0)
})
