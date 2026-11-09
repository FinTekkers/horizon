// HZ-814: a Task's run changed a database, and the Task page shows what
// changed as a table — table, before, after, change, inserted, updated,
// deleted — on the Execute card, then on Verify & report, with a link to it
// from Review & close. The summary arrives the way the farm sends it: a job
// progress frame POSTed to the farm callback with the suite's farm secret
// (the e2e server has no farm), so the server's whitelist is on the path.
//
// The fixture is written straight to the DB (fixtures/seed.js) with an
// active Execute run no mock agent owns. Moving it on to Review & close is a
// DB write too: the run closes `done` with the view it stored.
//
// Earlier specs rotate the admin's gate PIN, so this one sets its own and
// afterAll PIN-verifies the shared session again for the specs after it.

import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX, TASK_REVIEW_CLOSE_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SERVER = `http://localhost:${process.env.HORIZON_E2E_PORT}`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '814814'
const ITEM = 'TK-E2E-DB-CHANGES'
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
let runId = null

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC').get(ITEM, EXECUTE_STEP_INDEX)
    if (seeded) {
      runId = seeded.id
      return
    }
    insertItem(db, { id: ITEM, title: 'E2E fixture — a Task whose run changed a database', cursor: EXECUTE_STEP_INDEX, kind: 'task' })
    runId = Number(
      insertStepRun(db, {
        itemId: ITEM,
        stepIndex: EXECUTE_STEP_INDEX,
        attempt: 1,
        agent: STEPS[EXECUTE_STEP_INDEX].agent,
        status: 'active',
        startedAt: sqliteNow(),
      }),
    )
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const DB_CHANGES = {
  source: 'pg_stat',
  tables: [
    { table: 'prices', status: 'ok', before: 10, after: 11, inserted: 3, updated: 0, deleted: 2 },
    { table: 'public.positions', status: 'ok', before: 5, after: 5, inserted: 0, updated: 4, deleted: 0 },
    { table: 'audit', status: 'failed', reason: 'snapshot_timeout' },
  ],
}
const COLUMNS = ['table', 'before', 'after', 'change', 'inserted', 'updated', 'deleted']

const cardFor = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })
const changesTable = (scope) => scope.getByRole('table', { name: /database changes/i })

async function expectTable(table) {
  await expect(table).toBeVisible({ timeout: 15_000 })
  const headers = (await table.getByRole('columnheader').allTextContents()).map((h) => h.trim().toLowerCase())
  expect(headers).toEqual(COLUMNS)
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).getByRole('cell')).toHaveText(['prices', '10', '11', '+1', '3', '0', '2'])
  // The unchanged table shows change 0.
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['public.positions', '5', '5', '0', '0', '4', '0'])
  await expect(rows.nth(2).getByRole('cell')).toHaveText(['audit', 'could not be counted'])
}

test('the Execute card shows the run’s database changes as a table, one row per declared table', async ({ page, request }) => {
  const res = await request.post(`${SERVER}/api/farm/steps/${runId}/progress`, {
    headers: FARM,
    data: {
      status: 'running',
      elapsedS: 12,
      budgetS: 600,
      startedAt: new Date(Date.now() - 12_000).toISOString(),
      updatedAt: new Date().toISOString(),
      commands: [{ command: 'scripts/backfill.sh', status: 'done', exit_code: 0 }],
      logTail: ['db changes: 2 table(s) counted, 1 failed'],
      // Stripped by the server's whitelist: never reaches the page.
      dbChanges: { ...DB_CHANGES, dsn: 'postgresql://user:hunter2@db/mdi' },
    },
  })
  expect(res.status()).toBe(200)

  await page.goto(`/${ITEM.toLowerCase()}`)
  await expectTable(changesTable(cardFor(page, 'Execute')))
  await expect(page.getByText(/hunter2/)).toHaveCount(0)
})

test('Verify & report shows the same table, Review & close links to it, and a reload keeps both', async ({ page }) => {
  const db = openDb(DB_PATH)
  try {
    // The job finished: its run closes with the view it stored, and the
    // item moves on to the last gate.
    db.prepare("UPDATE step_run SET status = 'done', output = '1 command(s) run, 1 passed, 0 failed', ended_at = ? WHERE id = ?").run(sqliteNow(), runId)
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(TASK_REVIEW_CLOSE_GATE_INDEX, ITEM)
  } finally {
    db.close()
  }

  await page.goto(`/${ITEM.toLowerCase()}`)
  await expectTable(changesTable(cardFor(page, 'Verify & report')))

  const link = cardFor(page, 'Review & close').getByRole('link', { name: /Database changes/ })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/#db-changes$/)
  const executeTable = changesTable(cardFor(page, 'Execute'))
  await expect(executeTable).toBeInViewport()

  await page.reload()
  await expectTable(changesTable(cardFor(page, 'Execute')))
  await expectTable(changesTable(cardFor(page, 'Verify & report')))
})
