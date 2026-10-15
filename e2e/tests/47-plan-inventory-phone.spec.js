// HZ-462 metric 3: on a 375px phone a Plan item's wide Inventory table
// scrolls sideways inside its own wrapper, and the page itself never gets
// wider than the screen. The real chain: a done Inventory step_run whose
// artifact carries the fenced block 447a appends, through the item stream's
// stepOutputs, rendered by the Tracker.
//
// Rows are seeded directly (fixtures/seed.js), so the orchestrator never
// kicks them: the item waits at the Approve the design gate.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { kindStepIndex, PLAN_INVENTORY_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { FENCE_INFO } from '../../domain/js/planInventory.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'PLAN-INV-462'
const DESIGN_GATE_INDEX = kindStepIndex('Approve the design', 'plan')

// Refs never wrap (.data-table__ref), so these are what make the table wider
// than a phone.
const longRef = (n) => `server/src/a/deliberately/long/path/to/a/module/number-${n}/index.js:129`
const BLOCK = {
  repos: [
    {
      repo: 'acme/api',
      has: ['A REST API over SQLite'],
      gaps: ['No retention job'],
      evidence: [{ kind: 'file', ref: longRef(1), note: 'the work_item table' }],
    },
    {
      repo: 'acme/web',
      has: ['A React board'],
      gaps: [],
      evidence: [{ kind: 'file', ref: longRef(2), note: 'the board' }],
    },
  ],
  key_facts: [{ topic: 'storage', fact: 'Items live in one SQLite file', evidence: [{ kind: 'file', ref: longRef(3), note: 'db' }] }],
}
const ARTIFACT = `## Current state\n\nTwo repos.\n\n\`\`\`${FENCE_INFO}\n${JSON.stringify(BLOCK, null, 2)}\n\`\`\``

const sqliteAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — Plan with a wide Inventory', kind: 'plan', cursor: DESIGN_GATE_INDEX })
    insertStepRun(db, {
      itemId: ID,
      stepIndex: PLAN_INVENTORY_STEP_INDEX,
      attempt: 1,
      agent: 'Architect',
      output: 'Inventoried 2 repos',
      artifact: ARTIFACT,
      startedAt: sqliteAgo(30),
      endedAt: sqliteAgo(20),
    })
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('DELETE FROM step_run WHERE item_id = ?').run(ID)
    db.prepare('DELETE FROM event WHERE item_id = ?').run(ID)
    db.prepare('DELETE FROM work_item WHERE id = ?').run(ID)
  } finally {
    db.close()
  }
})

test('at 375px the wide Inventory table scrolls in its wrapper and the page does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/${ID.toLowerCase()}`)
  const table = page.getByRole('table', { name: 'Current state per repo' })
  await expect(table).toBeVisible()
  await expect(page.getByRole('table', { name: 'Key facts' })).toBeVisible()
  const wrap = table.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " data-table-wrap ")][1]')
  const { scrollWidth, clientWidth } = await wrap.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  expect(scrollWidth).toBeGreaterThan(clientWidth)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await table.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'plan-inventory-phone')
})
